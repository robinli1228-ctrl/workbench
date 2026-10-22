import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,utimes,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {MediaStreams,PREVIEW_CHUNK} from '../src/media-streams.mjs';
import {sniffMedia,mediaPath,statMedia,streamMedia,hashMedia,receiveMedia} from '../src/media-files.mjs';
import {captureDirectorySnapshot} from '../src/source-sync-files.mjs';
import {mediaPathMatches,mediaKindFromName,formatBytes} from '../public/media.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const mp4Head=()=>Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypisom'),Buffer.alloc(8)]);
/** A deterministic file larger than the old 20 MB attachment and sync limits. */
function bigVideo(size=25*1024*1024) {
  const bytes=Buffer.alloc(size);for(let i=0;i<size;i+=4096)bytes.writeUInt32BE(i>>>0,i);
  mp4Head().copy(bytes,0);return bytes;
}

/** Home's relay and the Worker's file functions in one process, joined by a real loopback HTTP server. */
async function harness({capable=true}={}) {
  const root=await mkdtemp(join(tmpdir(),'wb-media-')),source=join(root,'server'),target=join(root,'mac');
  await mkdir(join(source,'out'),{recursive:true});await mkdir(target,{recursive:true});
  const db=new Store(':memory:'),onlineNodes=new Set(['srv','mac']);
  db.put('projects',{id:'p1',name:'media'});
  db.put('workers',{id:'srv',name:'Server',capabilities:{mediaStream:capable?1:0}});db.put('workers',{id:'mac',name:'Mac',capabilities:{mediaStream:1}});
  db.put('workspaces',{id:'p1:srv',projectId:'p1',nodeId:'srv',localRoot:source});db.put('workspaces',{id:'p1:mac',projectId:'p1',nodeId:'mac',localRoot:target});
  let base='';
  const query=async({nodeId},action,input)=>{
    if(!onlineNodes.has(nodeId))throw new Error('offline');
    if(action==='media_stat')return statMedia({root:input.root,path:input.file});
    if(action==='media_hash')return hashMedia({root:input.root,path:input.file,version:input.version});
    if(action==='media_receive')return receiveMedia({url:base+input.path,size:input.size,sha256:input.sha256,name:input.name,transferId:input.transferId,workspace:input.workspace});
    if(action==='media_stream'){
      const info=await statMedia({root:input.root,path:input.file}),v=input.version;
      if(info.size!==v.size||info.mtimeMs!==v.mtimeMs||info.ino!==v.ino||info.dev!==v.dev)throw new Error('file_changed');
      setImmediate(()=>void streamMedia({root:input.root,path:input.file,version:v,start:input.start,end:input.end,url:base+input.path,secret:input.secret}).catch(()=>{}));
      return {accepted:true};
    }
    throw new Error('unknown action');
  };
  const media=new MediaStreams({db,query,online:id=>onlineNodes.has(id)});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://x');let m;
    if((m=url.pathname.match(/^\/api\/worker\/media-streams\/([a-f0-9-]{36})$/)))return void media.receive(req,res,m[1]);
    if((m=url.pathname.match(/^\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)))return void media.serve(req,res,m[1],{download:url.searchParams.get('download')==='1'});
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const run={id:'r1',projectId:'p1',nodeId:'srv',workspace:source,projectRoot:source};
  return {root,source,target,db,media,onlineNodes,base,run,close:async()=>{server.close();await rm(root,{recursive:true,force:true});}};
}

test('media type comes from header bytes, not the file name', () => {
  assert.equal(sniffMedia(mp4Head(),'clip.mp4').mime,'video/mp4');
  assert.equal(sniffMedia(Buffer.concat([Buffer.from([0,0,0,0x14]),Buffer.from('ftypqt  ')]),'clip.mov').mime,'video/quicktime');
  assert.equal(sniffMedia(Buffer.from([0x1a,0x45,0xdf,0xa3,0,0]),'clip.webm').mime,'video/webm');
  assert.equal(sniffMedia(Buffer.from('ID3\x04\x00'),'song.mp3').kind,'audio');
  assert.equal(sniffMedia(Buffer.from('%PDF-1.7'),'doc.pdf').kind,'pdf');
  const disguised=sniffMedia(Buffer.from('<html><script>alert(1)</script>'),'video.mp4');
  assert.deepEqual(disguised,{mime:'application/octet-stream',kind:'file'});
});

test('paths stay inside the allowed root: no escapes, hidden folders, credentials or links out', async () => {
  const root=await mkdtemp(join(tmpdir(),'wb-media-path-'));
  try {
    await mkdir(join(root,'.workbench','docs'),{recursive:true});await mkdir(join(root,'.ssh'));
    await writeFile(join(root,'.workbench','docs','a.mp4'),mp4Head());await writeFile(join(root,'.ssh','id_rsa'),'x');await writeFile(join(root,'secret-token.mp4'),'x');
    const outside=await mkdtemp(join(tmpdir(),'wb-media-out-'));await writeFile(join(outside,'b.mp4'),'x');await symlink(join(outside,'b.mp4'),join(root,'link.mp4'));
    assert.equal((await mediaPath(root,'.workbench/docs/a.mp4')).relativePath,'.workbench/docs/a.mp4');
    for(const bad of ['../x.mp4','.ssh/id_rsa','secret-token.mp4','link.mp4',join(outside,'b.mp4')])
      await assert.rejects(mediaPath(root,bad),/invalid_media_path|media_missing/,bad);
    await rm(outside,{recursive:true,force:true});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('a 25 MB video streams in ranges and downloads in full through the relay', async () => {
  const h=await harness();
  try {
    const bytes=bigVideo();await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    assert.equal(info.available,true);assert.equal(info.kind,'video');assert.equal(info.size,bytes.length);assert.equal(info.playable,true);
    // The first open-ended range is capped so the player starts quickly and seeks cheaply.
    let response=await fetch(h.base+info.url,{headers:{Range:'bytes=0-'}});
    assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes 0-${PREVIEW_CHUNK-1}/${bytes.length}`);
    assert.equal(response.headers.get('content-type'),'video/mp4');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(0,PREVIEW_CHUNK)));
    response=await fetch(h.base+info.url,{headers:{Range:'bytes=20000000-20000099'}});
    assert.equal(response.status,206);assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(20000000,20000100)));
    response=await fetch(h.base+info.url,{headers:{Range:'bytes=-100'}});
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(bytes.length-100)));
    response=await fetch(h.base+info.url,{headers:{Range:`bytes=${bytes.length}-`}});assert.equal(response.status,416);
    response=await fetch(h.base+info.downloadUrl);
    assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment; filename\*=UTF-8''demo\.mp4$/);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(bytes));
  } finally {await h.close();}
});

test('tickets pin one file version and expire; device state is reported, never guessed', async () => {
  const h=await harness();
  try {
    const path=join(h.source,'out','demo.mp4');await writeFile(path,bigVideo(1024*1024));
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    assert.equal((await fetch(`${h.base}/media/forged.ticket`)).status,401);
    const expired=h.media.sign({...h.media.verify(info.ticket),x:Date.now()-1});
    assert.equal((await fetch(`${h.base}/media/${expired}`)).status,401);
    await utimes(path,new Date(),new Date(Date.now()+5000));
    const changed=await fetch(h.base+info.url,{headers:{Range:'bytes=0-9'}});
    assert.equal(changed.status,409);assert.equal((await changed.json()).code,'file_changed');
    h.onlineNodes.delete('srv');
    assert.equal((await fetch(h.base+info.url)).status,503);
    assert.deepEqual(await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4')),{available:false,reason:'source_offline',name:'demo.mp4',sourceNodeId:'srv'});
  } finally {await h.close();}
  const old=await harness({capable:false});
  try {
    await writeFile(join(old.source,'out','a.mp4'),mp4Head());
    assert.equal((await old.media.describe(old.media.sourceForRun(old.run,'out/a.mp4'))).reason,'worker_upgrade');
  } finally {await old.close();}
});

test('one file version keeps one link for the day, cached 10 days; a changed file gets a new link', async () => {
  const h=await harness();
  try {
    const path=join(h.source,'out','shot.mp4');await writeFile(path,bigVideo(64*1024));
    const source=()=>h.media.sourceForRun(h.run,'out/shot.mp4');
    const first=await h.media.describe(source()),again=await h.media.describe(source());
    assert.equal(again.url,first.url,'describing the same version twice yields the same link');
    assert.ok(Date.parse(first.expiresAt)-Date.now()>=10*86400000,'the link outlives the 10-day browser cache');
    const response=await fetch(h.base+first.url,{headers:{Range:'bytes=0-9'}});
    assert.equal(response.headers.get('cache-control'),'private, max-age=864000, immutable');await response.arrayBuffer();
    await utimes(path,new Date(),new Date(Date.now()+5000));
    assert.notEqual((await h.media.describe(source())).url,first.url,'a new version is a new link');
  } finally {await h.close();}
});

test('a disguised file is served only as a download, never inline', async () => {
  const h=await harness();
  try {
    await writeFile(join(h.source,'out','evil.mp4'),'<html><script>alert(1)</script></html>');
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/evil.mp4'));
    assert.equal(info.kind,'file');assert.equal(info.playable,false);
    const response=await fetch(h.base+info.url);
    assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.match(response.headers.get('content-disposition'),/^attachment/);
  } finally {await h.close();}
});

test('run and native paths resolve only inside their own roots', async () => {
  const h=await harness();
  try {
    assert.equal(h.media.sourceForRun(h.run,'out/a.mp4').root,h.source);
    assert.equal(h.media.sourceForRun(h.run,join(h.source,'out','a.mp4')).root,h.source);
    assert.throws(()=>h.media.sourceForRun(h.run,'/etc/passwd'),/invalid_media_path/);
    assert.throws(()=>h.media.sourceForNative('srv',{workspace:h.source},'/tmp/elsewhere.mp4'),/invalid_media_path/);
    assert.equal(h.media.sourceForNative('srv',{workspace:h.source},'out/a.mp4').root,h.source);
  } finally {await h.close();}
});

test('send to device copies a large file, verifies SHA-256 and becomes the offline fallback', async () => {
  const h=await harness();
  try {
    const bytes=bigVideo(21*1024*1024);await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    const id=randomUUID(),started=await h.media.transfer('p1',{clientTransferId:id,ticket:info.ticket,nodeId:'mac'});
    assert.equal(started.status,'hashing');
    await h.media.transfers.get(id);
    const done=h.db.get('mediaTransfers',id);
    assert.equal(done.status,'completed',done.error);assert.equal(done.sha256,sha(bytes));assert.equal(done.received,bytes.length);
    assert.equal(sha(await readFile(join(h.target,done.path))),sha(bytes));
    assert.match(done.path,/^\.workbench\/tmp\/media\/[a-f0-9-]{36}\/demo\.mp4$/);
    assert.equal((await h.media.transfer('p1',{clientTransferId:id,ticket:info.ticket,nodeId:'mac'})).status,'completed','a retry with the same ID is idempotent');
    h.onlineNodes.delete('srv');
    const fallback=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    assert.equal(fallback.available,true);assert.equal(fallback.sourceNodeId,'mac');assert.equal(fallback.copyOf.nodeId,'srv');
  } finally {await h.close();}
});

test('a receive with the wrong SHA-256 leaves no file behind', async () => {
  const h=await harness();
  try {
    const bytes=bigVideo(256*1024);await writeFile(join(h.source,'out','a.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/a.mp4'));
    const transferId=randomUUID();
    await assert.rejects(receiveMedia({url:h.base+info.downloadUrl,size:bytes.length,sha256:'0'.repeat(64),name:'a.mp4',transferId,workspace:h.target}),/media_receive_failed/);
    assert.deepEqual(await readdir(join(h.target,'.workbench','tmp','media',transferId)),[]);
  } finally {await h.close();}
});

test('auto-sync skips a new oversize file instead of failing the batch, but still fences a synchronized one', async () => {
  const root=await mkdtemp(join(tmpdir(),'wb-media-sync-'));
  try {
    await writeFile(join(root,'notes.md'),'hello');await writeFile(join(root,'big.mp4'),Buffer.alloc(21*1024*1024));
    const snapshot=await captureDirectorySnapshot({root,repositoryId:'scope',generation:1,scopePolicy:{}});
    assert.ok(snapshot.entries['notes.md']);assert.equal(snapshot.entries['big.mp4'],undefined);
    assert.deepEqual(snapshot.excluded.find(e=>e.path==='big.mp4'),{path:'big.mp4',reason:'oversize',size:21*1024*1024});
    await assert.rejects(captureDirectorySnapshot({root,repositoryId:'scope',generation:1,scopePolicy:{},baselineEntries:{'big.mp4':{hash:'a'.repeat(64),size:1,executable:false}}}),/file_too_large/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('chat text turns media paths into cards and leaves URLs and documents alone', () => {
  const paths=text=>mediaPathMatches(text).map(m=>m.path);
  assert.deepEqual(paths('已生成 /srv/project/out/demo.mp4，请查看'),['/srv/project/out/demo.mp4']);
  assert.deepEqual(paths('see outputs/clip.webm and ./a/b.png (preview)'),['outputs/clip.webm','./a/b.png']);
  assert.deepEqual(paths('报告在 .workbench/docs/report.pdf。'),['.workbench/docs/report.pdf']);
  assert.deepEqual(paths('final.MOV'),['final.MOV']);
  assert.deepEqual(paths('https://example.com/video.mp4 and notes.md and src/app.js'),[]);
  assert.equal(mediaKindFromName('a.mkv'),'video');assert.equal(mediaKindFromName('a.flac'),'audio');assert.equal(mediaKindFromName('a.zip'),'file');
  assert.equal(formatBytes(25*1024*1024),'25 MB');assert.equal(formatBytes(1536),'1.5 KB');
});

test('a bare file name missing from the folder is found in its outputs or artifacts folder, and plays from there', async () => {
  const h=await harness();
  try {
    const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(40,7)]);
    await mkdir(join(h.source,'outputs'),{recursive:true});await mkdir(join(h.source,'artifacts'),{recursive:true});
    await writeFile(join(h.source,'outputs','shot.png'),png);await writeFile(join(h.source,'artifacts','report.pdf'),Buffer.from('%PDF-1.7\n%%EOF\n'));
    await writeFile(join(h.source,'both.png'),png);await writeFile(join(h.source,'outputs','both.png'),Buffer.concat([png,png]));
    assert.equal((await statMedia({root:h.source,path:'shot.png'})).relativePath,'outputs/shot.png');
    assert.equal((await statMedia({root:h.source,path:'report.pdf'})).relativePath,'artifacts/report.pdf');
    assert.equal((await statMedia({root:h.source,path:'both.png'})).relativePath,'both.png','the folder itself comes first');
    await assert.rejects(statMedia({root:h.source,path:'missing.png'}),/media_missing/);
    await assert.rejects(statMedia({root:h.source,path:'sub/shot.png'}),/media_missing/,'a path with a folder is never rerouted');
    await assert.rejects(statMedia({root:h.source,path:'.env'}),/invalid_media_path/,'blocked names stay blocked');
    // The card and the player use the path that was found.
    const info=await h.media.describe(h.media.sourceForRun(h.run,'shot.png'));
    assert.equal(info.available,true);assert.equal(info.kind,'image');assert.equal(info.size,png.length);
    const response=await fetch(h.base+info.url);
    assert.equal(response.status,200);assert.ok(Buffer.from(await response.arrayBuffer()).equals(png));
  } finally {await h.close();}
});
