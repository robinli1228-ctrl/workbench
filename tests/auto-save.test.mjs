// Settings on the page apply on change: one save at a time, the newest values follow, unchanged or invalid values are not sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoSave } from '../public/auto-save.js';

function fakeForm() {
  const listeners = {}, form = { value: 'a', valid: true, reported: 0,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    checkValidity: () => form.valid, reportValidity: () => { form.reported++; } };
  form.fire = name => listeners[name]?.({ preventDefault() {}, key: '', target: null });
  return form;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a change saves once; the same value is not sent again', async () => {
  const form = fakeForm(), sent = [];
  autoSave(form, async () => { sent.push(form.value); }, { snapshot: () => form.value });
  form.fire('change'); await tick();
  assert.deepEqual(sent, []);
  form.value = 'b'; form.fire('change'); await tick();
  form.fire('change'); await tick();
  assert.deepEqual(sent, ['b']);
});

test('a change made while a save runs is saved right after, with the newest value', async () => {
  const form = fakeForm(), sent = [];let release;
  autoSave(form, () => { sent.push(form.value); return sent.length === 1 ? new Promise(resolve => { release = resolve; }) : undefined; }, { snapshot: () => form.value });
  form.value = 'b'; form.fire('change'); await tick();
  form.value = 'c'; form.fire('change'); form.value = 'd'; form.fire('change'); await tick();
  assert.deepEqual(sent, ['b']);
  release(); await tick(); await tick();
  assert.deepEqual(sent, ['b', 'd']);
});

test('a failed save is tried again on the next change; an invalid form sends nothing', async () => {
  const form = fakeForm(), sent = [];let fail = true;
  autoSave(form, async () => { sent.push(form.value); if (fail) return false; }, { snapshot: () => form.value });
  form.value = 'b'; form.fire('change'); await tick();
  fail = false; form.fire('change'); await tick();
  assert.deepEqual(sent, ['b', 'b']);
  form.valid = false; form.value = 'x'; form.fire('change'); await tick();
  assert.deepEqual(sent, ['b', 'b']);
  assert.equal(form.reported, 1);
});

test('reset takes values loaded from the server as already saved', async () => {
  const form = fakeForm(), sent = [];
  const saver = autoSave(form, async () => { sent.push(form.value); }, { snapshot: () => form.value });
  form.value = 'server'; saver.reset(); form.fire('change'); await tick();
  assert.deepEqual(sent, []);
});
