import test from 'node:test';
import assert from 'node:assert/strict';
import {taskActivity,idleDays} from '../public/conversation-task-state.js';

const task={id:'t69',status:'in_progress',ownerRoleId:'gpt'};
test('an unfinished task nobody is on shows as waiting', () => {
  assert.equal(taskActivity(task,{requests:[],runs:[]}),'waiting');
  assert.equal(taskActivity({...task,status:'done'},{}),null);
  assert.equal(taskActivity({...task,status:'todo'},{}),null);
});
test('an open linked call or the owner working on it makes it active; the owner busy with another task does not', () => {
  assert.equal(taskActivity(task,{requests:[{id:'r1',conversationTaskId:'t69',status:'waiting_call'}]}),'active');
  assert.equal(taskActivity(task,{requests:[{id:'r1',conversationTaskId:'t69',status:'succeeded'}]}),'waiting');
  const other={id:'r2',conversationTaskId:'t101',status:'running'};
  assert.equal(taskActivity(task,{requests:[other],runs:[{roleId:'gpt',status:'running',requestId:'r2'}]}),'waiting','busy with T101');
  assert.equal(taskActivity(task,{requests:[],runs:[{roleId:'gpt',status:'running',requestId:'rx'}]}),'active','an unlinked turn of the owner counts');
});
test('days since the last change', () => {
  const now=Date.parse('2026-11-26T12:00:00Z');
  assert.equal(idleDays('2026-11-23T03:30:57Z',now),3);assert.equal(idleDays('2026-11-26T02:00:00Z',now),0);assert.equal(idleDays(null,now),0);
});
