// Recent outputs come from Home's kept list at once; the slow device check runs behind it, one per project, and its
// result replaces the list (also across a Home restart).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {RecentOutputs} from '../src/recent-outputs-cache.mjs';

const P='p1';
function env(){
  const db=new Store(':memory:');db.put('projects',{id:P,name:'demo'});
  let calls=0,release=()=>{},fail=null;
  const kept=[];const compute=async(projectId,options)=>{kept.push(options.kept);calls++;const n=calls;await new Promise(resolve=>{release=resolve;});if(fail)throw new Error(fail);return {items:[{name:`v${n}.md`}],partial:false};};
  let now=Date.parse('2026-11-01T10:00:00.000Z');
  const outputs=new RecentOutputs({db,compute,clock:()=>now,timings:{waitMs:200}});
  return {db,outputs,kept,calls:()=>calls,release:()=>release(),fail:m=>{fail=m;},tick:ms=>{now+=ms;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('the first request waits for the check; later ones get the kept list at once', async () => {
  const e=env();
  const first=e.outputs.get(P);await flush();e.release();
  assert.deepEqual((await first).items.map(i=>i.name),['v1.md']);
  const again=await e.outputs.get(P);
  assert.equal(again.refreshing,false,'a fresh list is not checked again');assert.equal(e.calls(),1);
  assert.equal(again.checkedAt,'2026-11-01T10:00:00.000Z');
  // A Home restart keeps the list.
  const restarted=new RecentOutputs({db:e.db,compute:async()=>{throw new Error('not called');}});
  assert.deepEqual((await restarted.get(P)).items.map(i=>i.name),['v1.md']);
});

test('a stale list is shown at once while one background check runs; wait returns the new list', async () => {
  const e=env();const first=e.outputs.get(P);await flush();e.release();await first;
  e.tick(30000);e.db.put('runs',{id:'r1',projectId:P,updatedAt:'2026-11-01T10:00:30.000Z'});
  assert.equal((await e.outputs.get(P)).refreshing,false,'a run changed, but the list is under a minute old');
  e.tick(40000);
  const shown=await e.outputs.get(P);
  assert.deepEqual(shown.items.map(i=>i.name),['v1.md'],'the kept list, without waiting');assert.equal(shown.refreshing,true);
  await e.outputs.get(P);await e.outputs.get(P);assert.equal(e.calls(),2,'requests during a check join it');
  const waited=e.outputs.get(P,{wait:true});await flush();e.release();
  const updated=await waited;assert.deepEqual(updated.items.map(i=>i.name),['v2.md']);assert.equal(updated.refreshing,false);
  e.tick(70000);assert.equal((await e.outputs.get(P)).refreshing,false,'no run changed: kept up to five minutes');
  e.tick(5*60000);assert.equal((await e.outputs.get(P)).refreshing,true,'then checked again anyway');
});

test('a failed check keeps the previous list and says so; wait gives up after its limit', async () => {
  const e=env();const first=e.outputs.get(P);await flush();e.release();await first;
  e.tick(6*60000);const started=Date.now(),slow=await e.outputs.get(P,{wait:true});
  assert.ok(Date.now()-started>=150);assert.equal(slow.refreshing,true,'still checking when the wait ends');
  e.fail('device offline');e.release();await flush();
  const after=await e.outputs.get(P);
  assert.deepEqual(after.items.map(i=>i.name),['v1.md']);assert.equal(after.checkError,'device offline');
  e.fail(null);
  assert.equal((await e.outputs.get(P)).refreshing,false,'not retried at once, though the list is six minutes old');
  e.tick(60001);assert.equal((await e.outputs.get(P)).refreshing,true,'retried after a minute');
});

test('a refresh during a check checks once more after it; unreadable files and new messages make a list stale', async () => {
  const e=env();const first=e.outputs.get(P);await flush();e.release();await first;
  e.tick(70000);await e.outputs.get(P,{refresh:true});
  await e.outputs.get(P,{refresh:true});await e.outputs.get(P,{refresh:true});
  e.release();await flush();await flush();
  assert.equal(e.calls(),3,'the running check, then one more for the refreshes made during it');
  assert.equal((await e.outputs.get(P)).refreshing,true);e.release();await flush();await flush();
  assert.equal((await e.outputs.get(P)).refreshing,false);
  assert.deepEqual(e.kept.map(k=>k?.map(i=>i.name)??null),[null,null,null],'refreshes read every file again');
  // A message (a reply naming a file) changes the project's stamp.
  e.tick(61000);e.db.put('roomMessages',{id:'m1',projectId:P,text:'[a](a.md)',createdAt:'2026-11-01T10:03:00.000Z'});
  assert.equal((await e.outputs.get(P)).refreshing,true);e.release();await flush();await flush();
  assert.deepEqual(e.kept.at(-1).map(i=>i.name),['v3.md'],'a background check passes the kept list on');
  // A list with a file that could not be read is checked again after a minute, without any change.
  e.db.put('recentOutputCaches',{...e.db.get('recentOutputCaches',P),result:{items:[{name:'x.md',error:'device offline'}]}});
  assert.equal((await e.outputs.get(P)).refreshing,false);
  e.tick(61000);assert.equal((await e.outputs.get(P)).refreshing,true);
});

test('without a kept list a failed check is the answer; deleting the project drops the list', async () => {
  const e=env();e.fail('project missing');
  const first=e.outputs.get(P);await flush();e.release();
  await assert.rejects(first,/project missing/);
  e.fail(null);const second=e.outputs.get(P);await flush();e.release();await second;
  e.db.deleteProject(P);
  assert.equal(e.db.get('recentOutputCaches',P),null);
});
