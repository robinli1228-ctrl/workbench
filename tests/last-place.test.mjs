import test from 'node:test';
import assert from 'node:assert/strict';
import {restorePlace,savePlace} from '../public/last-place.js';

const memory=(entries={})=>{const map=new Map(Object.entries(entries));return {getItem:key=>map.has(key)?map.get(key):null,setItem:(key,value)=>map.set(key,String(value)),map};};

test('a fresh tab opens where the app was left; a tab with its own place keeps it', () => {
  const tab=memory({'agent-workbench.navigation-mode':'sessions','agent-workbench.native-session':'node-1/claude/abc'}),local=memory();
  savePlace(tab,local);
  const fresh=memory();
  assert.equal(restorePlace(fresh,local),true);
  assert.equal(fresh.getItem('agent-workbench.native-session'),'node-1/claude/abc');
  assert.equal(fresh.getItem('agent-workbench.navigation-mode'),'sessions');
  const own=memory({'agent-workbench.navigation-mode':'groups'});
  assert.equal(restorePlace(own,local),false);
  assert.equal(own.getItem('agent-workbench.native-session'),null);
});

test('a damaged copy is ignored', () => {
  const fresh=memory();
  assert.equal(restorePlace(fresh,memory({'agent-workbench.last-place':'{bad'})),false);
  assert.equal(restorePlace(fresh,memory({'agent-workbench.last-place':'{"agent-workbench.project":7}'})),false);
  assert.equal(fresh.map.size,0);
  const local=memory({'agent-workbench.last-place':'{"agent-workbench.project":"p1"}'});savePlace(memory(),local);
  assert.equal(local.getItem('agent-workbench.last-place'),'{"agent-workbench.project":"p1"}');
});
