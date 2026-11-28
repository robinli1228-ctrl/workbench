// Opening the page: the service worker answers the owner's own page from its cached copy on a browser that page marked,
// and checks the network's answer behind it; every other navigation still goes to the network first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker({ owner = false, network }) {
  const stores = new Map(), handlers = {}, navigated = [], fetched = [];
  const open = async name => { if (!stores.has(name)) stores.set(name, new Map()); const store = stores.get(name); return { match: async key => store.get(key), put: async (key, value) => void store.set(key, value), addAll: async () => {} }; };
  const caches = { open, has: async name => stores.has(name), delete: async name => stores.delete(name), keys: async () => [...stores.keys()] };
  const client = { url: 'https://wb.example/', navigate: async url => { navigated.push(url); } };
  const self = { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: 'https://wb.example' }, skipWaiting() {}, clients: { claim: async () => {}, get: async id => id === 'c1' ? client : null, matchAll: async () => [client] } };
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  runInNewContext(source, { self, caches, URL, Response, Promise, fetch: async (target, options) => { fetched.push([typeof target === 'string' ? target : target.url, options || null]); return network(); } });
  const cacheName = /const CACHE = '([^']+)'/.exec(source)[1];
  return { handlers, navigated, fetched, stores, async ready() { (await open(cacheName)).put('/', 'CACHED PAGE'); if (owner) (await open('agent-workbench-owner')).put('/owner', '1'); },
    async navigate(url) { const waits = []; let answer; handlers.fetch({ request: { method: 'GET', url, mode: 'navigate' }, resultingClientId: 'c1', respondWith: value => { answer = value; }, waitUntil: value => waits.push(value) }); const response = await answer; await Promise.all(waits); return response; } };
}
const page = (status = 200, type = 'basic') => ({ ok: status >= 200 && status < 300, status, type });

test('a marked browser opens the owner page from the cache at once and keeps it when the network agrees', async () => {
  const w = worker({ owner: true, network: async () => page(200) }); await w.ready();
  assert.equal(await w.navigate('https://wb.example/'), 'CACHED PAGE');
  assert.equal(w.fetched.length, 1, 'the network answer is still checked behind the cached page');
  assert.equal(w.fetched[0][1].redirect, 'manual'); assert.deepEqual(w.navigated, []); assert.ok(w.stores.has('agent-workbench-owner'));
});

test('when the gateway has something else to show, the mark is dropped and the page opens again from the network', async () => {
  for (const answer of [page(401), page(410), page(0, 'opaqueredirect')]) {
    const w = worker({ owner: true, network: async () => answer }); await w.ready();
    assert.equal(await w.navigate('https://wb.example/'), 'CACHED PAGE');
    assert.deepEqual(w.navigated, ['https://wb.example/']); assert.ok(!w.stores.has('agent-workbench-owner'));
    // The reload now goes to the network first.
    assert.equal(await w.navigate('https://wb.example/'), answer);
  }
});

test('an unmarked browser and any share address go to the network first; offline falls back to the cached page', async () => {
  const fresh = page(200), guest = worker({ network: async () => fresh }); await guest.ready();
  assert.equal(await guest.navigate('https://wb.example/'), fresh);
  const shared = worker({ owner: true, network: async () => fresh }); await shared.ready();
  assert.equal(await shared.navigate('https://wb.example/?share=group&mode=ro&projectId=p1'), fresh, 'a share address is never answered from the cache');
  const offline = worker({ network: async () => { throw new Error('offline'); } }); await offline.ready();
  assert.equal(await offline.navigate('https://wb.example/'), 'CACHED PAGE');
  const marked = worker({ owner: true, network: async () => { throw new Error('offline'); } }); await marked.ready();
  assert.equal(await marked.navigate('https://wb.example/'), 'CACHED PAGE'); assert.deepEqual(marked.navigated, []); assert.ok(marked.stores.has('agent-workbench-owner'), 'offline keeps the cached page and the mark');
});
