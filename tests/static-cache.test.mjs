// Page files carry an ETag and answer 304 when unchanged, and the service worker's cache name carries a fingerprint of the
// page files, so a cache-first worker never serves code older than its version.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import net from 'node:net';

async function until(fn){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('isolated Home condition timeout');}

test('static files revalidate with ETag and the service worker cache name follows the files', async t => {
  const root=fileURLToPath(new URL('../',import.meta.url)),data=await mkdtemp(join(tmpdir(),'xxxxx-static-'));let home,log='';
  t.after(async()=>{if(home&&home.exitCode===null&&home.signalCode===null){home.kill('SIGTERM');await until(()=>home.exitCode!==null||home.signalCode!==null);}await rm(data,{recursive:true,force:true});});
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const {address,port}=socket.address();await new Promise(r=>socket.close(r));const url=`http://${address}:${port}`;
  home=spawn(process.execPath,['src/home.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOST:address,PORT:String(port),DATA_DIR:data,API_TOKEN:randomUUID(),WORKER_TOKEN:randomUUID(),LANG:'en'},stdio:['ignore','pipe','pipe']});
  home.stdout.on('data',chunk=>{log+=chunk;});home.stderr.on('data',chunk=>{log+=chunk;});
  try{await until(async()=>{try{return(await fetch(url+'/healthz')).status===200;}catch{return false;}});}catch(error){throw Error(error.message+' '+log);}

  const first=await fetch(url+'/app.js');
  const etag=first.headers.get('etag');
  assert.equal(first.status,200);assert.match(etag||'',/^W\/"[\w-]{22}"$/);assert.equal(first.headers.get('cache-control'),'no-cache');
  await first.arrayBuffer();
  const again=await fetch(url+'/app.js',{headers:{'If-None-Match':etag}});
  assert.equal(again.status,304,'an unchanged file is not sent again');assert.equal(again.headers.get('etag'),etag);
  assert.equal((await fetch(url+'/app.js',{headers:{'If-None-Match':etag.slice(2)}})).status,304,'a strong form of the same validator also matches');
  const other=await fetch(url+'/app.js',{headers:{'If-None-Match':'"stale"'}});
  assert.equal(other.status,200);await other.arrayBuffer();

  const worker=await (await fetch(url+'/sw.js')).text();
  const source=await readFile(join(root,'public','sw.js'),'utf8');
  const declared=source.match(/^const CACHE = '([^']+)'/m)[1];
  const served=worker.match(/^const CACHE = '([^']+)'/m)[1];
  assert.match(served,new RegExp(`^${declared}-[0-9a-f]{12}$`),'the served cache name adds the page-file fingerprint');
  assert.equal((await (await fetch(url+'/sw.js')).text()).match(/^const CACHE = '([^']+)'/m)[1],served,'stable while files are unchanged');
  const build=served.slice(declared.length+1);
  assert.equal((await (await fetch(url+'/healthz')).json()).build,build,'Home reports the same build it stamps into the worker');
  assert.match(await (await fetch(url+'/')).text(),new RegExp(`<meta name="workbench-build" content="${build}">`),'the page states which build it is');
  // Every precached path must be served, or one 404 fails the whole install and leaves users on old code.
  const precached=[...source.matchAll(/'(\/[^']*)'/g)].map(m=>m[1]).filter(path=>path==='/'||/\.[a-z]+$/.test(path));
  for(const path of precached){const response=await fetch(url+path);assert.equal(response.status,200,path);await response.arrayBuffer();}
});
