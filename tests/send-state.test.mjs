// Composer send lifecycle: Send stays locked while a send is in flight or its outcome is unknown; only a confirmed
// absence re-enables it, and a 4xx rejection is a definite failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEND_LABELS, uncertainSend, sendStateOf, sendLocked } from '../public/send-state.js';

test('outcome is unknown for network loss, timeouts and server errors; a 4xx is definite', () => {
  assert.equal(uncertainSend({ isNetworkError: true }), true);
  assert.equal(uncertainSend({ status: 502 }), true);
  assert.equal(uncertainSend({ status: 500 }), true);
  assert.equal(uncertainSend({ status: 408 }), true);
  assert.equal(uncertainSend(new Error('no status')), true);
  for (const status of [400, 403, 404, 409, 413, 422, 429]) assert.equal(uncertainSend({ status }), false, String(status));
});

test('state follows the frozen payload; restored drafts never come back as sendable', () => {
  assert.equal(sendStateOf({}), null);
  assert.equal(sendStateOf({ pending: { clientMessageId: 'a' } }, true), 'sending');
  assert.equal(sendStateOf({ pending: { clientMessageId: 'a' }, sendState: 'sending' }), 'checking', 'a reload loses the request but keeps the id');
  assert.equal(sendStateOf({ pending: { clientMessageId: 'a' } }), 'checking', 'drafts saved by older versions');
  assert.equal(sendStateOf({ pending: { clientMessageId: 'a' }, sendState: 'offline' }), 'offline');
  assert.equal(sendStateOf({ pending: { clientMessageId: 'a' }, sendState: 'failed' }), 'failed');
  assert.equal(sendStateOf({ sendState: 'failed' }), null, 'no payload, nothing to lock');
});

test('only an idle draft or a confirmed absence may press Send', () => {
  assert.equal(sendLocked(null), false);
  assert.equal(sendLocked('failed'), false);
  for (const state of ['sending', 'checking', 'offline']) assert.equal(sendLocked(state), true, state);
  assert.equal(SEND_LABELS.failed, 'Retry send');
  assert.equal(SEND_LABELS.sending, 'Sending…');
});
