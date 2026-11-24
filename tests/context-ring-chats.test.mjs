import test from 'node:test';
import assert from 'node:assert/strict';
import {contextForRole} from '../public/context-usage.js';

const role={id:'r1',projectId:'p',nodeId:'n',runtime:'claude',model:'m'};
const run=sessionId=>({id:`run-${sessionId}`,roleId:'r1',projectId:'p',nodeId:'n',roleSessionId:sessionId,roleSnapshot:{runtime:'claude',model:'m'},model:'m',createdAt:'2026-11-24T00:00:00.000Z',
  contextUsage:{usedTokens:50000,limitTokens:200000,model:'m',observedAt:'2026-11-24T00:00:01.000Z'}});

test('the context ring reads the role session of a non-default group chat', () => {
  const session={id:'s-chat',roleId:'r1',projectId:'p',conversationId:'chat-2',groupConversationId:'chat-2',nodeId:'n',runtime:'claude',status:'idle'};
  assert.equal(contextForRole(role,{roleSessions:[session],runs:[run('s-chat')]}).percent,25);
});

test('the default chat still works and a review session of the chat is not used', () => {
  const main={id:'s-main',roleId:'r1',projectId:'p',conversationId:'p',groupConversationId:'p',nodeId:'n',runtime:'claude',status:'idle'};
  assert.equal(contextForRole(role,{roleSessions:[main],runs:[run('s-main')]}).percent,25);
  const review={id:'s-review',roleId:'r1',projectId:'p',conversationId:'p:review:t1',groupConversationId:'p',nodeId:'n',runtime:'claude',status:'idle'};
  assert.equal(contextForRole(role,{roleSessions:[review],runs:[run('s-review')]}).percent,null);
});
