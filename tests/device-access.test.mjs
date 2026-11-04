// wb device for roles and Sessions-page CLIs: a read and a write level per device in the project or session settings
// decide what the Worker may touch; writes create folders, land whole and stay inside the scope, credentials and keys
// stay refused whatever the level.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {deviceAccessFor,deviceAccessList,deviceScope,normalizeDeviceAccess,DEFAULT_DEVICE_ACCESS} from '../src/device-access.mjs';
import {deviceWrite,deviceList,deviceRead} from '../src/device-read.mjs';

test('levels per device: defaults, cleanup of stored values, and the scope each level gives', () => {
  const db=new Store(':memory:');
  db.put('workspaces',{id:'p1:mac',projectId:'p1',nodeId:'mac',localRoot:'/xxxxx/p1'});
  db.put('repositoryWorkspaces',{id:'r1',projectId:'p1',nodeId:'mac',localRoot:'/xxxxx/repo1'});
  db.put('workspaces',{id:'p2:mac',projectId:'p2',nodeId:'mac',localRoot:'/xxxxx/p2'});
  assert.deepEqual(deviceAccessFor(null,'mac'),DEFAULT_DEVICE_ACCESS,'unset: read everything, write the project folder');
  assert.deepEqual(normalizeDeviceAccess({mac:{read:'none',write:'nope'},'':{read:'all'},srv:'x'}),{mac:{read:'none'}});
  assert.deepEqual(deviceAccessFor({deviceAccess:{mac:{read:'none'}}},'mac'),{read:'none',write:'project'});
  assert.equal(deviceScope(db,'none',{projectId:'p1',nodeId:'mac'}),null);
  assert.deepEqual(deviceScope(db,'project',{projectId:'p1',nodeId:'mac'}),{all:false,roots:['/xxxxx/p1','/xxxxx/repo1'],base:'/xxxxx/p1'});
  assert.equal(deviceScope(db,'project',{projectId:'p1',nodeId:'srv'}),null,'no project folder on that device');
  assert.deepEqual(deviceScope(db,'platform',{projectId:'p1',nodeId:'mac'}).roots,['/xxxxx/p1','/xxxxx/repo1','/xxxxx/p2'],'every project folder on the device');
  assert.deepEqual(deviceScope(db,'all',{projectId:'p1',nodeId:'mac'}),{all:true,roots:[],base:'/xxxxx/p1'});
  assert.deepEqual(deviceScope(db,'project',{nodeId:'srv',folder:'/xxxxx/session'}),{all:false,roots:['/xxxxx/session'],base:'/xxxxx/session'},'a session folder counts as its project folder');
});

async function layout(t){
  const base=await realpath(await mkdtemp(join(tmpdir(),'wb-devaccess-'))),project=join(base,'project'),outside=join(base,'outside');
  await mkdir(project);await mkdir(outside);t.after(()=>rm(base,{recursive:true,force:true}));
  const scope={all:false,roots:[project],base:project};
  return {base,project,outside,scope};
}
const code=async promise=>{try{await promise;return 'ok';}catch(error){return error.code||error.message;}};

test('writes create folders, append, land whole in parts, and stay inside the scope', async t => {
  const {project,outside,scope}=await layout(t);
  const written=await deviceWrite({scope,path:'notes/day/a.md',content:'第一行\n'});
  assert.equal(written.path,join(project,'notes','day','a.md'));assert.equal(await readFile(written.path,'utf8'),'第一行\n');
  await deviceWrite({scope,path:'notes/day/a.md',content:'第二行\n',append:true});
  assert.equal(await readFile(written.path,'utf8'),'第一行\n第二行\n');
  // A write in parts: nothing replaces the file until the last part; then the whole text is there.
  const uploadId='0123456789abcdef';
  await deviceWrite({scope,path:'big.txt',content:'aaa',uploadId,part:0,last:false});
  await deviceWrite({scope,path:'big.txt',content:'bbb',uploadId,part:1,last:false});
  assert.equal(await code(readFile(join(project,'big.txt'))),'ENOENT','not in place before the last part');
  await deviceWrite({scope,path:'big.txt',content:'ccc',uploadId,part:2,last:true});
  assert.equal(await readFile(join(project,'big.txt'),'utf8'),'aaabbbccc');
  assert.deepEqual((await readdir(project)).filter(name=>name.startsWith('.wb-write-')),[],'no temporary file left');
  // Outside the scope, through a link, credentials and keys, too large: refused.
  assert.equal(await code(deviceWrite({scope,path:join(outside,'x.txt'),content:'x'})),'outside_allowed_folders');
  await symlink(outside,join(project,'link'));
  assert.equal(await code(deviceWrite({scope,path:'link/x.txt',content:'x'})),'outside_allowed_folders','a linked folder does not lead out');
  assert.equal(await code(deviceWrite({scope,path:'.ssh/config',content:'x'})),'secret_path');
  assert.equal(await code(deviceWrite({scope,path:'.env',content:'x'})),'secret_path');
  assert.equal(await code(deviceWrite({scope,path:'huge.txt',content:'x'.repeat(1024*1024+1)})),'content_too_large');
  assert.equal(await code(deviceWrite({scope:{all:false,roots:[],base:null},path:'/xxxxx/a.txt',content:'x'})),'no_writable_folders');
});

test('the whole device reaches any folder but still not credentials; ls looks several levels down by name', async t => {
  const {project,outside,scope}=await layout(t);
  const all={all:true,roots:[],base:project};
  await deviceWrite({scope:all,path:join(outside,'deep','x.log'),content:'ERROR one\nok\n'});
  assert.match((await deviceRead({scope:all,path:join(outside,'deep','x.log'),match:'ERROR'})).content,/ERROR one/);
  assert.equal(await code(deviceRead({scope,path:join(outside,'deep','x.log')})),'outside_allowed_folders','the project level does not reach it');
  assert.equal(await code(deviceWrite({scope:all,path:join(outside,'.ssh','id_ed25519'),content:'x'})),'secret_path');
  await mkdir(join(project,'.worktrees','run-1','logs'),{recursive:true});await writeFile(join(project,'.worktrees','run-1','logs','app.log'),'started');
  await writeFile(join(project,'readme.md'),'x');
  const found=await deviceList({scope,path:'.',name:'*.log',depth:4});
  assert.deepEqual(found.items.map(item=>item.name),['.worktrees/run-1/logs/app.log'],'a log under a worktree, found in one request');
  assert.equal(await code(deviceList({scope,path:'.',depth:9})),'invalid_depth');
});

test('writes never reach the owner read-only folders, need an absolute path without a base, and broken uploads leave nothing', async t => {
  const {base,project,outside,scope}=await layout(t);
  // A folder the device owner opened for reading only (WORKER_READ_ROOTS) stays read-only.
  await writeFile(join(outside,'r.txt'),'x');
  assert.equal((await deviceRead({scope,readRoots:[outside],path:join(outside,'r.txt')})).content,'x');
  assert.equal(await code(deviceWrite({scope,readRoots:[outside],path:join(outside,'w.txt'),content:'x'})),'outside_allowed_folders');
  // A base outside the roots is ignored: relative paths need a base Home names inside them.
  const noBase={all:false,roots:[project],base:base};
  assert.equal(await code(deviceWrite({scope:noBase,path:'a.txt',content:'x'})),'absolute_path_required');
  assert.equal((await deviceWrite({scope:noBase,path:join(project,'a.txt'),content:'x'})).path,join(project,'a.txt'));
  // A later part without the first one, and an aborted upload.
  assert.equal(await code(deviceWrite({scope,path:'lost.txt',content:'b',uploadId:'aaaaaaaaaaaaaaaa',part:1,last:true})),'upload_missing');
  await deviceWrite({scope,path:'gone.txt',content:'a',uploadId:'bbbbbbbbbbbbbbbb',part:0,last:false});
  assert.equal((await deviceWrite({scope,path:'gone.txt',content:'',uploadId:'bbbbbbbbbbbbbbbb',abort:true})).aborted,true);
  assert.deepEqual((await readdir(project)).filter(name=>name.startsWith('.wb-write-')||name==='gone.txt'||name==='lost.txt'),[]);
  // Folders Home denies (its own data, the install) stay closed even on the whole device.
  assert.equal(await code(deviceRead({scope:{all:true,roots:[],base:project,deny:[outside]},path:join(outside,'r.txt')})),'outside_allowed_folders');
});

test('ls without a device lists every device with what the caller may actually do there', () => {
  const db=new Store(':memory:');
  db.put('workers',{id:'mac',name:'Mac',capabilities:{deviceRead:3}});
  db.put('workers',{id:'srv',name:'Server',capabilities:{deviceRead:3}});
  db.put('workers',{id:'old',name:'Old',capabilities:{deviceRead:2}});
  db.put('workspaces',{id:'p1:mac',projectId:'p1',nodeId:'mac',localRoot:'/xxxxx/p1'});
  const online=id=>id!=='srv';
  // A role of p1: the project folder exists only on the Mac, so "write project folder" means nothing on the server.
  assert.deepEqual(deviceAccessList(db,{deviceAccess:{mac:{write:'all'}}},{projectId:'p1',online}),[
    {device:'Mac',id:'mac',online:true,read:'all',write:'all'},
    {device:'Server',id:'srv',online:false,read:'all',write:'none'},
    {device:'Old',id:'old',online:false,read:'all',write:'none'},
  ],'offline and not-yet-upgraded devices are not reachable');
  // A session writes its own folder on its own device.
  const session=deviceAccessList(db,{},{folder:id=>id==='srv'?'/xxxxx/session':null,online});
  assert.deepEqual(session.map(d=>[d.id,d.write]),[['mac','none'],['srv','project'],['old','none']]);
});

test('match finds lines anywhere in a large log with their byte offsets; a deep ls does not walk .git or node_modules', async t => {
  const {project,scope}=await layout(t);
  // An early error far before the last 512 KiB, a multi-byte line before a later one, and plenty of noise in between.
  const noise='INFO 一切正常 '.repeat(8)+'\n',early='ERROR 早期故障 A\n';
  const text=early+noise.repeat(20000)+'ERROR late B\n'+noise.repeat(10);
  await writeFile(join(project,'big.log'),text);
  const found=await deviceRead({scope,path:'big.log',match:'error'});
  assert.equal(found.mode,'match');assert.equal(found.matches,2);
  const lines=found.content.split('\n');
  assert.deepEqual(lines.map(line=>line.replace(/^\d+: /,'')),['ERROR 早期故障 A','ERROR late B']);
  const lateAt=Number(lines[1].split(':')[0]);
  assert.equal(lateAt,Buffer.byteLength(early+noise.repeat(20000)),'the offset is in bytes, multi-byte text included');
  assert.equal((await deviceRead({scope,path:'big.log',offset:lateAt,limit:12})).content,'ERROR late B');
  assert.equal((await deviceRead({scope,path:'big.log',match:'error',tail:1})).content.replace(/^\d+: /,''),'ERROR late B','the last tail hits');
  // Deep ls: dependency and version-control folders are listed but not walked.
  for(const folder of ['.git/objects','node_modules/pkg','src/logs'])await mkdir(join(project,folder),{recursive:true});
  await writeFile(join(project,'node_modules','pkg','x.log'),'x');await writeFile(join(project,'src','logs','y.log'),'y');
  const deep=await deviceList({scope,path:'.',name:'*.log',depth:4});
  assert.deepEqual(deep.items.map(item=>item.name),['big.log','src/logs/y.log']);
  assert.deepEqual(deep.skipped,['node_modules'],'.git is not even listed: it can hold credentials');
  assert.deepEqual((await deviceList({scope,path:'node_modules',name:'*.log',depth:3})).items.map(item=>item.name),['pkg/x.log'],'pointed inside, it is walked');
});
