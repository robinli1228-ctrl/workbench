// A slow device link must slow files down, not the platform: uploads are paced to what the link carries, stopped when
// nobody waits for them, and a download keeps going (and resumes) however long it takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {MediaStreams} from '../src/media-streams.mjs';
import {MediaPace,MediaRate,MEDIA_RATE} from '../src/media-pace.mjs';
import {statMedia,streamMedia} from '../src/media-files.mjs';

const mp4=size=>{const bytes=Buffer.alloc(size,7);Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypisom'),Buffer.alloc(8)]).copy(bytes,0);return bytes;};

/** Home's relay with a scripted Worker: `worker.stream` decides what happens to each media_stream request. */
async function harness({timings={},capability=2,stream}={}) {
  const root=await mkdtemp(join(tmpdir(),'wb-slow-'));await mkdir(join(root,'out'));await writeFile(join(root,'out','clip.mp4'),mp4(256*1024));
  const db=new Store(':memory:');db.put('projects',{id:'p1'});
  db.put('workers',{id:'srv',name:'Server',capabilities:{mediaStream:1,...(capability>=2?{mediaPace:1}:{})}});db.put('workspaces',{id:'p1:srv',projectId:'p1',nodeId:'srv',localRoot:root});
  const calls=[];let base='';
  const query=async(target,action,input)=>{
    calls.push({action,input});
    if(action==='media_stat')return statMedia({root:input.root,path:input.file});
    if(action==='media_stream'){await stream?.(input,base);return {accepted:true};}
    if(action==='media_stream_cancel')return {stopped:true};
    if(action==='media_rate')return {rate:input.rate};
    throw new Error('unknown action');
  };
  const media=new MediaStreams({db,query,online:()=>true,timings});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://x');let m;
    if((m=url.pathname.match(/^\/api\/worker\/media-streams\/([a-f0-9-]{36})$/)))return void media.receive(req,res,m[1]);
    if((m=url.pathname.match(/^\/media\/([A-Za-z0-9_.-]+)\/status$/)))return void media.status(req,res,m[1]);
    if((m=url.pathname.match(/^\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)))return void media.serve(req,res,m[1],{download:url.searchParams.get('download')==='1'});
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const info=await media.describe(media.sourceForRun({projectId:'p1',nodeId:'srv',workspace:root,projectRoot:root},'out/clip.mp4'));
  return {root,media,calls,base,info,close:async()=>{server.closeAllConnections?.();server.close();await rm(root,{recursive:true,force:true});}};
}
const upload=(input,base,options={})=>streamMedia({root:input.root,path:input.file,version:input.version,start:input.start,end:input.end,url:base+input.path,secret:input.secret,...options});

test('the shared pace spaces chunks to the rate; Home grows the rate while bytes keep up and halves it when they queue', async () => {
  const pace=new MediaPace({rate:400*1024}),started=Date.now();
  for(let i=0;i<8;i++)await pace.take(25*1024);
  assert.ok(Date.now()-started>=400,`200 KB at 400 KB/s took ${Date.now()-started} ms`);

  const rate=new MediaRate();assert.equal(rate.rate,MEDIA_RATE.start);
  rate.add(MEDIA_RATE.start);assert.equal(rate.sample(200,1000),MEDIA_RATE.start*2,'short round trips and arrivals keeping up: double');
  rate.add(100);rate.disturb();assert.equal(rate.sample(200,1000),null,'no growth from a window with an upload starting or a paused viewer');
  const lan=new MediaRate();lan.add(MEDIA_RATE.start);assert.equal(lan.sample(3,1000),MEDIA_RATE.start*8,'a 3 ms link grows eightfold');
  // The link carries 25 KB/s; control messages now wait 1.8 s behind queued media.
  rate.add(25*1024);assert.equal(rate.sample(2000,1000),12.5*1024,'a queue over a second: half of what arrives');
  rate.add(25*1024);assert.equal(rate.sample(1500,1000),null,'held while it drains');
  rate.add(25*1024);assert.equal(rate.sample(250,1000),25*1024*0.9,'drained: resume just under what arrived');
  rate.add(25*1024*0.9);assert.equal(Math.round(rate.sample(210,1000)),Math.round(25*1024*0.99),'then grow by a tenth, not double');
  // A round trip that does not come back: cut while it is out, and not again when it finally returns.
  const late=new MediaRate({rate:64*1024});late.add(20*1024);
  assert.equal(late.late(1000),null);assert.equal(late.late(2000),5*1024,"half of the 10 KB/s that arrived");assert.equal(late.late(3000),null);
  late.trips.push(200);assert.equal(late.sample(3200,3200),null,'the returning late trip is not cut twice');
});

test('a Worker upload stops when Home cancels it, and by itself when the link takes nothing', async () => {
  const root=await mkdtemp(join(tmpdir(),'wb-slow-up-'));await writeFile(join(root,'a.mp4'),mp4(4*1024*1024));
  // A receiver that accepts the connection but never reads: the link is jammed.
  const sockets=new Set(),server=http.createServer(()=>{});server.on('connection',socket=>{sockets.add(socket);socket.pause();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/up`;
  try {
    const version=await statMedia({root,path:'a.mp4'}),cancel=new AbortController();
    const cancelled=upload({root,file:'a.mp4',version,start:0,end:version.size-1,path:'',secret:'s'},url,{signal:cancel.signal});
    setTimeout(()=>cancel.abort(),100);
    await assert.rejects(cancelled,error=>error.name==='AbortError','Home cancel stops the upload');
    const started=Date.now();
    await assert.rejects(upload({root,file:'a.mp4',version,start:0,end:version.size-1,path:'',secret:'s'},url,{stallMs:400}),/media_stalled/);
    assert.ok(Date.now()-started<5000,'a stalled upload gives up on its own');
  } finally {for(const socket of sockets)socket.destroy();server.close();await rm(root,{recursive:true,force:true});}
});

test('an upload that never arrives: the viewer gets media_timeout, the device is told to stop, and its place is kept until it confirms', async () => {
  let release;const confirmed=new Promise(resolve=>{release=resolve;});
  const h=await harness({timings:{arrivalMs:150,viewStreams:1,slotWaitMs:2000},stream:async()=>{}});
  const query=h.media.query;h.media.query=async(target,action,input,timeout)=>{if(action==='media_stream_cancel'){h.calls.push({action:'cancel_sent'});await confirmed;}return query(target,action,input,timeout);};
  try {
    const first=await fetch(h.base+h.info.url,{headers:{Range:'bytes=0-'}});
    assert.equal(first.status,504);assert.equal((await first.json()).code,'media_timeout');
    assert.ok(h.calls.some(c=>c.action==='cancel_sent'),'Home asked the device to stop');
    // Its only viewing place is still held: a second read waits until the device confirms the stop.
    let second=null;const pending=fetch(h.base+h.info.url,{headers:{Range:'bytes=0-'}}).then(r=>{second=r;return r;});
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(second,null,'no second upload while the first may still be running');
    release();await pending;assert.equal(second.status,504);
    const status=await (await fetch(`${h.base}${h.info.url}/status`)).json();
    assert.equal(status.device,null);assert.equal(status.failures.at(-1).code,'media_timeout');assert.equal(status.failures.at(-1).stage,'arrival');
  } finally {await h.close();}
});

test('an older Worker that cannot be told to stop releases the place at once, as before', async () => {
  const h=await harness({capability:1,timings:{arrivalMs:100,viewStreams:1},stream:async()=>{}});
  try {
    assert.equal((await fetch(h.base+h.info.url,{headers:{Range:'bytes=0-'}})).status,504);
    assert.equal((await fetch(h.base+h.info.url,{headers:{Range:'bytes=0-'}})).status,504);
    assert.ok(!h.calls.some(c=>['media_stream_cancel','media_rate'].includes(c.action)));
    assert.ok(!h.calls.find(c=>c.action==='media_stream').input.rate,'no rate is sent to a Worker that would ignore it');
  } finally {await h.close();}
});

test('a late upload is cut off at once instead of being read to its end', async () => {
  let late;const h=await harness({timings:{arrivalMs:100},stream:async input=>{late=input;}});
  try {
    assert.equal((await fetch(h.base+h.info.url,{headers:{Range:'bytes=0-'}})).status,504);
    let sent=0;const started=Date.now();
    const body=new ReadableStream({pull(controller){if(sent>=64*1024*1024)return controller.close();sent+=1024*1024;controller.enqueue(new Uint8Array(1024*1024));}});
    const response=await fetch(h.base+late.path,{method:'POST',headers:{Authorization:`Bearer ${late.secret}`},body,duplex:'half'}).catch(error=>error);
    assert.ok(response instanceof Error||response.status===410,'refused');
    assert.ok(sent<16*1024*1024,`only ${sent} of 64 MiB offered before the connection closed`);assert.ok(Date.now()-started<3000);
  } finally {await h.close();}
});

test('downloads have their own places, send the paced rate, and resume with If-Range', async () => {
  const h=await harness({timings:{viewStreams:1,slotWaitMs:300},stream:(input,base)=>{setImmediate(()=>void upload(input,base).catch(()=>{}));}});
  try {
    // A viewer holds the only viewing place (its read stays open); a download still starts.
    const hold=new AbortController();const viewing=await fetch(h.base+h.info.url,{headers:{Range:'bytes=0-'},signal:hold.signal});assert.equal(viewing.status,206);
    const download=await fetch(`${h.base}${h.info.url}?download=1`);assert.equal(download.status,200);
    const etag=download.headers.get('etag');assert.ok(etag&&download.headers.get('last-modified'));
    assert.equal((await download.arrayBuffer()).byteLength,256*1024);
    const resumed=await fetch(`${h.base}${h.info.url}?download=1`,{headers:{Range:'bytes=1000-','If-Range':etag}});
    assert.equal(resumed.status,206);assert.equal((await resumed.arrayBuffer()).byteLength,256*1024-1000);
    const changed=await fetch(`${h.base}${h.info.url}?download=1`,{headers:{Range:'bytes=1000-','If-Range':'"other"'}});
    assert.equal(changed.status,200,'a different validator gets the whole file');await changed.arrayBuffer();
    assert.ok(h.calls.filter(c=>c.action==='media_stream').every(c=>c.input.rate>=MEDIA_RATE.min),'every upload request carries the rate');
    hold.abort();
  } finally {await h.close();}
});
