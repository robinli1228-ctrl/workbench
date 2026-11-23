// The left lists mark a chat or session waiting for the user's answer apart from one that is running.
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceState} from '../src/workspace-state.mjs';

test('runs and native turns waiting for the user stay in the list marks, flagged as waiting', () => {
  const run=(id,projectId,status)=>({id,projectId,nodeId:'n1',status,taskId:id,createdAt:'2026-11-23T00:00:00.000Z'});
  const {state}=workspaceState({projects:[{id:'p1',name:'a'},{id:'p2',name:'b'},{id:'p3',name:'c'}],workers:[{id:'n1',online:true}],roleSessions:[],conversations:[],
    runs:[run('r1','p1','running'),run('r2','p2','waiting_user'),run('r3','p3','succeeded')],tasks:[],requests:[],runReports:[],
    nativeTurnExecutions:[{id:'t1',nodeId:'n1',runtime:'claude',sessionId:'s1',status:'waiting_user'},{id:'t2',nodeId:'n1',runtime:'codex',sessionId:'s2',status:'running'}]},'p1');
  const marks=Object.fromEntries(state.sidebarExecutions.map(m=>[m.id,Boolean(m.waiting)]));
  assert.deepEqual(marks,{'native:t1':true,'native:t2':false,'run:r1':false,'run:r2':true});
});
