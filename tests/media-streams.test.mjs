import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Writable} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,utimes,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {MediaStreams,PREVIEW_CHUNK} from '../src/media-streams.mjs';
import {MediaCache} from '../src/media-cache.mjs';
import {sniffMedia,mediaPath,statMedia,streamMedia,hashMedia,receiveMedia} from '../src/media-files.mjs';
import {captureDirectorySnapshot} from '../src/source-sync-files.mjs';
import {mediaPathMatches,mediaKindFromName,formatBytes,previewableUrl,webAddresses,inlineCodeMediaPath,messageFolders} from '../public/media.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
/** A response stand-in that discards bytes, for driving a relay directly. */
const sink=()=>Object.assign(new Writable({write(chunk,encoding,callback){callback();}}),{writeHead(){},headersSent:false});
const mp4Head=()=>Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypisom'),Buffer.alloc(8)]);
/** A deterministic file larger than the old 20 MB attachment and sync limits. */
function bigVideo(size=25*1024*1024) {
  const bytes=Buffer.alloc(size);for(let i=0;i<size;i+=4096)bytes.writeUInt32BE(i>>>0,i);
  mp4Head().copy(bytes,0);return bytes;
}

/** Home's relay and the Worker's file functions in one process, joined by a real loopback HTTP server. */
async function harness({capable=true,cache=false,uploadDelay=0}={}) {
  const root=await mkdtemp(join(tmpdir(),'wb-media-')),source=join(root,'server'),target=join(root,'mac');
  await mkdir(join(source,'out'),{recursive:true});await mkdir(target,{recursive:true});
  const db=new Store(':memory:'),onlineNodes=new Set(['srv','mac']);
  db.put('projects',{id:'p1',name:'media'});
  db.put('workers',{id:'srv',name:'Server',capabilities:{mediaStream:capable?1:0}});db.put('workers',{id:'mac',name:'Mac',capabilities:{mediaStream:1}});
  db.put('workspaces',{id:'p1:srv',projectId:'p1',nodeId:'srv',localRoot:source});db.put('workspaces',{id:'p1:mac',projectId:'p1',nodeId:'mac',localRoot:target});
  let base='',statShift=0;const ranges=[];
  const query=async({nodeId},action,input)=>{
    if(!onlineNodes.has(nodeId))throw new Error('offline');
    if(action==='media_stat'){const info=await statMedia({root:input.root,path:input.file});return statShift?{...info,mtimeMs:info.mtimeMs+statShift}:info;}
    if(action==='media_hash')return hashMedia({root:input.root,path:input.file,version:input.version});
    if(action==='media_receive')return receiveMedia({url:base+input.path,size:input.size,sha256:input.sha256,name:input.name,transferId:input.transferId,workspace:input.workspace});
    if(action==='media_stream'){
      ranges.push([input.start,input.end]);
      const info=await statMedia({root:input.root,path:input.file}),v=input.version;
      if(info.size!==v.size||info.mtimeMs!==v.mtimeMs||info.ino!==v.ino||info.dev!==v.dev)throw new Error('file_changed');
      setImmediate(()=>void streamMedia({root:input.root,path:input.file,version:v,start:input.start,end:input.end,url:base+input.path,secret:input.secret,...(uploadDelay?{fetchImpl:(url,options)=>fetch(url,{...options,body:(async function*(){for await(const chunk of options.body){await new Promise(r=>setTimeout(r,uploadDelay));yield chunk;}})()})}:{})}).catch(()=>{}));
      return {accepted:true};
    }
    throw new Error('unknown action');
  };
  const mediaCache=cache?new MediaCache({dir:join(root,'home-cache'),...(typeof cache==='object'?cache:{})}):null;
  const media=new MediaStreams({db,query,online:id=>onlineNodes.has(id),cache:mediaCache});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://x');let m;
    if((m=url.pathname.match(/^\/api\/worker\/media-streams\/([a-f0-9-]{36})$/)))return void media.receive(req,res,m[1]);
    if((m=url.pathname.match(/^\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)))return void media.serve(req,res,m[1],{download:url.searchParams.get('download')==='1'});
    // Home decodes the whole path before matching, as here.
    if((m=decodeURIComponent(url.pathname).match(/^\/preview\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.+)$/)))return void media.preview(req,res,m[1],m[2]);
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const run={id:'r1',projectId:'p1',nodeId:'srv',workspace:source,projectRoot:source};
  return {root,source,target,db,media,mediaCache,onlineNodes,base,run,ranges,shiftStat:ms=>{statShift=ms;},close:async()=>{server.close();await rm(root,{recursive:true,force:true});}};
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
    const left=Date.parse(first.expiresAt)-Date.now();
    assert.ok(left>86400000&&left<=2*86400000,'the link lasts through the next day, never 10 days: it is the only credential');
    const response=await fetch(h.base+first.url,{headers:{Range:'bytes=0-9'}});
    assert.equal(response.headers.get('cache-control'),'private, max-age=864000, immutable');await response.arrayBuffer();
    await utimes(path,new Date(),new Date(Date.now()+5000));
    assert.notEqual((await h.media.describe(source())).url,first.url,'a new version is a new link');
  } finally {await h.close();}
});

test('Home keeps a full copy of a relayed file by version, serves it again without the device, and drops partial copies', async () => {
  const h=await harness({cache:true});
  const until=async check=>{for(let i=0;i<100&&!(await check());i++)await new Promise(r=>setTimeout(r,20));};
  try {
    const bytes=bigVideo(512*1024);await writeFile(join(h.source,'out','shot.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/shot.mp4')),t=h.media.verify(info.ticket);
    assert.equal(sha(Buffer.from(await (await fetch(h.base+info.url)).arrayBuffer())),sha(bytes));
    await until(async()=>Boolean(await h.mediaCache.lookup(t)));
    assert.ok(await h.mediaCache.lookup(t),'a whole-file read leaves a copy keyed by version');
    h.onlineNodes.delete('srv');
    const offline=await fetch(h.base+info.url,{headers:{Range:'bytes=1000-1999'}});
    assert.equal(offline.status,206,'the copy answers while the device is offline');
    assert.deepEqual(Buffer.from(await offline.arrayBuffer()),bytes.subarray(1000,2000));
    h.onlineNodes.add('srv');
    // A range read is relayed and settles, and is not turned into a background download of the whole file.
    const clip=bigVideo(1024*1024);await writeFile(join(h.source,'out','clip.mp4'),clip);
    const clipInfo=await h.media.describe(h.media.sourceForRun(h.run,'out/clip.mp4')),clipTicket=h.media.verify(clipInfo.ticket);
    const settled=h.media.relay(clipTicket,0,99,sink(),206,{},{});
    assert.equal(await Promise.race([settled.then(()=>'settled'),new Promise(r=>setTimeout(()=>r('hung'),5000))]),'settled','a relay without a cache writer settles');
    await new Promise(r=>setTimeout(r,300));assert.equal(await h.mediaCache.lookup(clipTicket),null,'no background copy of a range read');
    // A file the device reports as changed at the end of the read is not kept.
    const other=bigVideo(256*1024);await writeFile(join(h.source,'out','changing.mp4'),other);
    const changing=await h.media.describe(h.media.sourceForRun(h.run,'out/changing.mp4'));
    h.shiftStat(5000);await (await fetch(h.base+changing.url)).arrayBuffer();await new Promise(r=>setTimeout(r,300));h.shiftStat(0);
    assert.equal(await h.mediaCache.lookup(h.media.verify(changing.ticket)),null,'a version that no longer matches leaves no copy');
    // A removed device's files are not served from the copy.
    h.db.put('removedDevices',{id:'srv'});h.onlineNodes.delete('srv');
    assert.equal((await fetch(h.base+info.url,{headers:{Range:'bytes=0-9'}})).status,503);
    h.db.remove('removedDevices','srv');h.onlineNodes.add('srv');
    // An interrupted write, or one whose file stream failed, leaves nothing behind and does not hang.
    const w=await h.mediaCache.writer({n:'x',r:'/',p:'a',s:10,m:1,i:1,d:1});w.write(Buffer.alloc(4));assert.equal(await w.finish(true),false);
    const broken=await h.mediaCache.writer({n:'y',r:'/',p:'b',s:10,m:1,i:1,d:1});
    await rm(join(h.root,'home-cache'),{recursive:true,force:true});broken.write(Buffer.alloc(10));
    assert.equal(await Promise.race([broken.finish(true),new Promise(r=>setTimeout(()=>r('hung'),3000))]),false,'a failed stream finishes as not kept');
    assert.ok(await h.mediaCache.writer({n:'z',r:'/',p:'c',s:1,m:1,i:1,d:1}),'the folder is made again for the next copy');
  } finally {await h.close();}
});

test('the media cache drops copies unused for 10 days, then the least recently used beyond its limit', async () => {
  const dir=await mkdtemp(join(tmpdir(),'wb-media-cache-'));let now=Date.parse('2026-10-22T00:00:00Z');
  try {
    const cache=new MediaCache({dir,limitBytes:250,clock:()=>now});
    const put=async(name,size,daysAgo)=>{const t={n:name,r:'/',p:name,s:size,m:1,i:1,d:1},w=await cache.writer(t);w.write(Buffer.alloc(size));await w.finish(true);const at=new Date(now-daysAgo*86400000);await utimes(join(dir,cache.key(t)),at,at);return t;};
    const old=await put('old',100,11),a=await put('a',100,3),b=await put('b',100,2),c=await put('c',100,1);
    const result=await cache.sweep();
    assert.equal(result.deleted,2,'the 11-day-old copy, then the least recently used one to get under 250 bytes');
    assert.deepEqual(await Promise.all([old,a,b,c].map(async t=>Boolean(await cache.lookup(t)))),[false,false,true,true]);
    assert.deepEqual(await cache.stats(),{count:2,bytes:200,limitBytes:250,maxAgeDays:10});
  } finally {await rm(dir,{recursive:true,force:true});}
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
  // Wildcards name files to come or many files (an instruction: put after-*.png in the folder), never one file to open.
  assert.deepEqual(paths('下放 11 张 after-*.png 和 shot-?.jpg、out/{a,b}.mp4，以及 real.png'),['real.png']);
  assert.deepEqual(paths('https://example.com/video.mp4 and notes.md and src/app.js'),[]);
  assert.equal(mediaKindFromName('a.mkv'),'video');assert.equal(mediaKindFromName('a.flac'),'audio');assert.equal(mediaKindFromName('a.zip'),'file');
  assert.equal(formatBytes(25*1024*1024),'25 MB');assert.equal(formatBytes(1536),'1.5 KB');
});

test('development and test service addresses open in the viewer; other sites keep opening a new tab', () => {
  const home='http://127.0.0.1:4310';
  assert.equal(previewableUrl('http://localhost:8081/waybill?id=1',home),'http://localhost:8081/waybill?id=1');
  assert.equal(previewableUrl('http://192.0.2.10/',home),'http://192.0.2.10/');
  assert.equal(previewableUrl('https://test.example.com:2888/app',home),'https://test.example.com:2888/app');
  assert.equal(previewableUrl('http://printer.local/',home),'http://printer.local/');
  assert.equal(previewableUrl('http://[::1]:5173/',home),'http://[::1]:5173/');
  for(const other of ['https://github.com/xxxxx/xxxxx/pull/1','http://127.0.0.1:4310/api/state','http://user:pw@localhost:8081/','javascript:alert(1)','file:///etc/hosts','not a url'])
    assert.equal(previewableUrl(other,home),null,other);
  assert.equal(mediaKindFromName('out/site/index.html'),'web');assert.equal(mediaKindFromName('diagram.svg'),'web');
  assert.deepEqual(mediaPathMatches('打开 out/site/index.html 看看').map(m=>m.path),['out/site/index.html']);
  // Addresses in text, IPv6 included, lose trailing punctuation; other sites are not picked up.
  assert.deepEqual(webAddresses('看 http://[::1]:8080/，或 http://localhost:5173/a?b=1. 以及 https://github.com/xxxxx/xxxxx',home).map(a=>a.address),['http://[::1]:8080/','http://localhost:5173/a?b=1']);
  // Inline code holding a web address is not a device path, even when it ends in .html or .png.
  assert.equal(inlineCodeMediaPath('https://github.com/xxxxx/xxxxx/blob/main/index.html'),null);
  assert.equal(inlineCodeMediaPath('http://127.0.0.1:4317/shot.png'),null);
  assert.equal(inlineCodeMediaPath(' out/site/index.html '),'out/site/index.html');
  // A folder with a space in its name ("TMS AI") keeps the whole path in inline code; a command with a second path or an option does not.
  assert.equal(inlineCodeMediaPath('/xxxxx/TMS AI/.workbench/docs/report/TMS-AI-COVERAGE.html'),'/xxxxx/TMS AI/.workbench/docs/report/TMS-AI-COVERAGE.html');
  assert.equal(inlineCodeMediaPath('~/Desktop/Screen Shot 2026-11-03 17.50.12.png'),'~/Desktop/Screen Shot 2026-11-03 17.50.12.png');
  assert.equal(inlineCodeMediaPath('open /tmp/a.png'),null);
  assert.equal(inlineCodeMediaPath('/tmp/a b/x.png -v'),null);
  assert.equal(inlineCodeMediaPath('see a.png and b.png'),null);
  assert.equal(inlineCodeMediaPath('/tmp/a b/*.png'),null);
});

test('a web page previews with the files it loads by relative path, and its ticket reads nothing outside its folder', async () => {
  const h=await harness();
  try {
    const site=join(h.source,'out','site');
    await mkdir(join(site,'css'),{recursive:true});await mkdir(join(site,'.secret'),{recursive:true});
    await writeFile(join(site,'index.html'),'<link rel="stylesheet" href="css/app.css"><script src="app.js"></script><p>hi</p>');
    await writeFile(join(site,'css','app.css'),'p{color:red}');await writeFile(join(site,'app.js'),'console.log(1)');
    await writeFile(join(site,'.secret','key.txt'),'secret');await writeFile(join(h.source,'out','outside.txt'),'outside');
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/site/index.html'));
    assert.equal(info.kind,'web');assert.match(info.previewUrl,/^\/preview\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/);
    const page=await fetch(h.base+info.previewUrl);
    assert.equal(page.status,200);assert.equal(page.headers.get('content-type'),'text/html; charset=utf-8');
    assert.equal(page.headers.get('content-security-policy'),null);assert.equal(page.headers.get('cache-control'),'no-store');
    assert.match(await page.text(),/<p>hi<\/p>/);
    const folder=h.base+info.previewUrl.replace(/index\.html$/,'');
    const css=await fetch(folder+'css/app.css');assert.equal(css.headers.get('content-type'),'text/css; charset=utf-8');assert.equal(await css.text(),'p{color:red}');
    const js=await fetch(folder+'app.js');assert.equal(js.headers.get('content-type'),'text/javascript; charset=utf-8');assert.equal(await js.text(),'console.log(1)');
    // Hidden folders stay blocked by the Worker's path checks, and an encoded ".." cannot climb out of the page's folder.
    for(const [path,status] of [['.secret/key.txt',400],['css%2F..%2F..%2Foutside.txt',400],['missing.css',404]]){
      const response=await fetch(folder+path);assert.equal(response.status,status,path);await response.text();
    }
    // A folder ticket is not a file ticket, and a file ticket is not a folder ticket.
    const folderTicket=info.previewUrl.split('/')[2];
    for(const url of [`/media/${folderTicket}`,`/preview/${info.ticket}/index.html`]){const response=await fetch(h.base+url);assert.equal(response.status,401,url);await response.text();}
  } finally {await h.close();}
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

async function until(predicate) {
  for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}
  assert.fail('condition did not settle');
}

// Regression: preview ranges used to be discarded, so preview then download fetched the same bytes twice.
test('preview then download reuses a verified prefix and fetches only missing bytes', async () => {
  const h=await harness({cache:true});
  try {
    const bytes=bigVideo(14*1024*1024);await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    let response=await fetch(h.base+info.url,{headers:{Range:'bytes=0-'}});
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(0,8*1024*1024));
    await until(()=>h.mediaCache.writing.size===0);
    response=await fetch(h.base+info.url,{headers:{Range:'bytes=0-999'}});
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(0,1000));
    response=await fetch(h.base+info.downloadUrl);
    assert.equal(response.status,200);assert.equal(Number(response.headers.get('content-length')),bytes.length);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    await until(()=>h.mediaCache.writing.size===0);
    assert.deepEqual(h.ranges,[[0,8388607],[8388608,14680063]],'no repeated source bytes');
    h.onlineNodes.delete('srv');
    response=await fetch(h.base+info.downloadUrl);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes,'completed copy remains readable offline');
  } finally {await h.close();}
});

test('ranged responses carry stable validators and honor If-Range', async () => {
  const h=await harness();
  try {
    const bytes=bigVideo(64*1024);await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    let r=await fetch(h.base+info.url,{headers:{Range:'bytes=0-99'}});
    const tag=r.headers.get('etag'),date=r.headers.get('last-modified');await r.arrayBuffer();
    assert.match(tag||'',/^"[^"\r\n]+"$/);assert.ok(Number.isFinite(Date.parse(date)));
    r=await fetch(h.base+info.url,{headers:{Range:'bytes=100-199','If-Range':tag}});
    assert.equal(r.status,206);assert.equal(r.headers.get('etag'),tag);assert.equal((await r.arrayBuffer()).byteLength,100);
    for(const value of ['"old-version"',`W/${tag}`,'invalid-date',date]){
      r=await fetch(h.base+info.url,{headers:{Range:'bytes=100-199','If-Range':value}});
      assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
    }
  } finally {await h.close();}
});


test('a viewer cancelled while waiting for a relay slot never starts an upload', async () => {
  const h=await harness();
  try {
    await writeFile(join(h.source,'out','demo.mp4'),bigVideo(4096));
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4'));
    const release=await Promise.all(Array.from({length:4},()=>h.media.slot('srv'))),out=sink();
    const pending=h.media.relay(h.media.verify(info.ticket),0,4095,out,200,{});
    out.destroy();release.forEach(f=>f());
    await pending;
    assert.deepEqual(h.ranges,[]);
  } finally {await h.close();}
});


test('an interrupted download retains verified bytes and the retry resumes at the saved prefix', async () => {
  const h=await harness({cache:true,uploadDelay:5});
  try {
    const bytes=bigVideo(14*1024*1024);await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4')),ticket=h.media.verify(info.ticket),abort=new AbortController();
    const first=await fetch(h.base+info.downloadUrl,{signal:abort.signal});
    const reader=first.body.getReader();await reader.read();abort.abort();await reader.cancel().catch(()=>{});
    await until(()=>h.mediaCache.writing.size===0);
    const prefix=await h.mediaCache.prefix(ticket);
    assert.ok(prefix&&prefix.size>0&&prefix.size<bytes.length);
    assert.equal(await h.mediaCache.lookup(ticket),null,'partial bytes do not masquerade as a full offline copy');
    const retry=await fetch(h.base+info.downloadUrl);
    assert.deepEqual(Buffer.from(await retry.arrayBuffer()),bytes);
    assert.deepEqual(h.ranges,[[0,14680063],[prefix.size,14680063]]);
    await until(()=>h.mediaCache.writing.size===0);
  } finally {await h.close();}
});

test('prefixes survive restart, obey cached-read authorization, and count toward eviction', async () => {
  const h=await harness({cache:true});
  try {
    const bytes=bigVideo(4096);await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4')),ticket=h.media.verify(info.ticket);
    await (await fetch(h.base+info.url,{headers:{Range:'bytes=0-1023'}})).arrayBuffer();
    await until(()=>h.mediaCache.writing.size===0);
    const restarted=new MediaCache({dir:join(h.root,'home-cache'),limitBytes:512});h.media.cache=restarted;
    h.onlineNodes.delete('srv');
    let r=await fetch(h.base+info.url,{headers:{Range:'bytes=500-999'}});
    assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(500,1000));
    assert.equal((await fetch(h.base+info.downloadUrl)).status,503,'missing suffix still requires the source');
    h.media.canReadCached=()=>false;
    assert.equal((await fetch(h.base+info.url,{headers:{Range:'bytes=0-99'}})).status,403);
    assert.equal((await restarted.stats()).bytes,1024);
    await restarted.sweep();assert.equal(await restarted.prefix(ticket),null);
  } finally {await h.close();}
});

test('a range beyond the prefix leaves no hole, and changed sources cannot publish new cached bytes', async () => {
  const h=await harness({cache:true});
  try {
    const bytes=bigVideo(4096);await writeFile(join(h.source,'out','demo.mp4'),bytes);
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4')),ticket=h.media.verify(info.ticket);
    await (await fetch(h.base+info.url,{headers:{Range:'bytes=1000-1999'}})).arrayBuffer();
    await until(()=>h.mediaCache.writing.size===0);assert.equal(await h.mediaCache.prefix(ticket),null);
    h.shiftStat(1);
    await (await fetch(h.base+info.url,{headers:{Range:'bytes=0-999'}})).arrayBuffer();
    await until(()=>h.mediaCache.writing.size===0);assert.equal(await h.mediaCache.prefix(ticket),null);
  } finally {await h.close();}
});


test('a failed extension preserves the previously verified prefix', async () => {
  const h=await harness({cache:true});
  try {
    await writeFile(join(h.source,'out','demo.mp4'),bigVideo(4096));
    const info=await h.media.describe(h.media.sourceForRun(h.run,'out/demo.mp4')),ticket=h.media.verify(info.ticket);
    await (await fetch(h.base+info.url,{headers:{Range:'bytes=0-999'}})).arrayBuffer();
    await until(()=>h.mediaCache.writing.size===0);
    h.shiftStat(1);
    await (await fetch(h.base+info.url,{headers:{Range:'bytes=0-1999'}})).arrayBuffer();
    await until(()=>h.mediaCache.writing.size===0);
    assert.equal((await h.mediaCache.prefix(ticket)).size,1000);
    assert.deepEqual(h.ranges,[[0,999],[1000,1999]]);
  } finally {await h.close();}
});

test('a bare file name can be found in the folder of another path in the same message', () => {
  assert.deepEqual(messageFolders('Input: reuse .workbench/docs/plan-20261119/PLAN.md section 6 and REPORT.html in the same folder'),['.workbench/docs/plan-20261119']);
  assert.deepEqual(messageFolders('see /xxxxx/a/b.png and C:\\xxxxx\\c.pdf'),['/xxxxx/a','C:\\xxxxx']);
  assert.deepEqual(messageFolders('https://github.com/xxxxx/xxxxx/blob/main/index.html T89/T91 src/*.js .git/.hidden REPORT.html'),[]);
});
