import test from 'node:test';import assert from 'node:assert/strict';
import * as state from '../public/conversation-task-state.js';
const base={hasRects:true,mobile:false,mobilePanel:'chat',ancestors:[]};
test('mobile chat and projects drawers do not fetch even with layout rectangles',()=>{
 for(const mobilePanel of ['chat','projects',undefined])assert.equal(state.taskCardVisible({...base,mobile:true,mobilePanel}),false);
 assert.equal(state.taskCardVisible({...base,mobile:true,mobilePanel:'roles'}),true);
});
test('hidden or invisible ancestors prevent reads on either viewport',()=>{
 for(const hidden of [{hidden:true},{display:'none'},{visibility:'hidden'},{visibility:'collapse'}])assert.equal(state.taskCardVisible({...base,ancestors:[{},hidden]}),false);
 assert.equal(state.taskCardVisible({...base,hasRects:false}),false);
});
test('visible desktop card is independent of mobile panel default and boolean history is translated',async()=>{
 assert.equal(state.taskCardVisible(base),true);
 const {default:zh}=await import('../public/locales/zh.js');assert.equal(zh.Yes,'是');assert.equal(zh.No,'否');
});
