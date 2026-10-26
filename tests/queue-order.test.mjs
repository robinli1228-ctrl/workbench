// Dragging queued items reorders only those items; priority ranks and other projects' positions are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRoleQueue, reorderedQueueKeys, queueKey } from '../src/rooms.mjs';

const at = minute => new Date(Date.UTC(2026, 9, 16, 8, minute)).toISOString();
const task = (id, minute, extra = {}) => ({ id, createdAt: at(minute), roleId: id, ...extra });

test('queue runs in arrival order until the user reorders it', () => {
  const tasks = [task('b', 2), task('a', 1), task('c', 3)];
  assert.deepEqual(orderRoleQueue(tasks, () => false).map(t => t.id), ['a', 'b', 'c']);
});

test('reordering permutes the existing keys of the dragged items only', () => {
  const a = task('a', 1), b = task('b', 2), other = task('x', 3), c = task('c', 4);
  const keys = new Map(reorderedQueueKeys([a, b, c], ['c', 'a', 'b']));
  const after = [a, b, c, other].map(t => keys.has(t.id) ? { ...t, queueOrder: keys.get(t.id) } : t);
  assert.deepEqual(orderRoleQueue(after, () => false).map(t => t.id), ['c', 'a', 'x', 'b'], 'other project item keeps its slot between the reordered keys');
  assert.ok(queueKey(after.find(t => t.id === 'c')) < queueKey(after.find(t => t.id === 'a')));
});

test('steering still comes before a manual order', () => {
  const steer = task('s', 9, { steering: true }), early = task('e', 1, { queueOrder: 0 });
  assert.equal(orderRoleQueue([early, steer], () => false)[0].id, 's');
});

test('reorder rejects duplicates and unknown items', () => {
  const a = task('a', 1), b = task('b', 2);
  assert.throws(() => reorderedQueueKeys([a, b], ['a', 'a']));
  assert.throws(() => reorderedQueueKeys([a, b], ['a', 'z']));
});
