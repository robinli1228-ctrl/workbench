// Opening the page: the service worker answers the owner's own page from its cached copy on a browser that page marked,
// and checks the network's answer behind it; every other navigation still goes to the network first. When access as the
// owner has ended, the mark and the copies the page saved are removed before the page is opened again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker({ owner = false, until = null, network, navigate = true }) {
  const stores = new Map(), handlers = {}, navigated = [], fetched = [], dropped = [], posted = [];
  const open = async name => { if (!stores.has(name)) stores.set(name, new Map()); const store = stores.get(name); return { match: async key => store.get(key), put: async (key, value) => void store.set(key, value), addAll: async () => {} }; };
  const caches = { open, has: async name => stores.has(name), delete: async name => stores.delete(name), keys: async () => [...stores.keys()] };
  const client = { url: 'https://wb.example/', postMessage: message => posted.push(message), ...(navigate ? { navigate: async url => { navigated.push(url); } } : {}) };
  const self = { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: 'https://wb.example' }, skipWaiting() {}, clients: { claim: async () => {}, get: async id => id === 'c1' ? client : null, matchAll: async () => [client] } };
  const indexedDB = { deleteDatabase: name => { dropped.push(name); const request = {}; queueMicrotask(() => request.onsuccess?.()); return request; } };
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  runInNewContext(source, { self, caches, indexedDB, URL, Response, Promise, Date, Number, AbortSignal, Error, fetch: async (target, options) => { fetched.push([typeof target === 'string' ? target : target.url, options || null]); return network(); } });
  const cacheName = /const CACHE = '([^']+)'/.exec(source)[1];
  return { handlers, navigated, fetched, stores, dropped, posted, async ready() { (await open(cacheName)).put('/', 'CACHED PAGE'); if (owner) (await open('agent-workbench-owner')).put('/owner', new Response(JSON.stringify({ until }))); },
    async navigate(url) { const waits = []; let answer; handlers.fetch({ request: { method: 'GET', url, mode: 'navigate' }, resultingClientId: 'c1', respondWith: value => { answer = value; }, waitUntil: value => waits.push(value) }); const response = await answer; await Promise.all(waits); return response; } };
}
const page = (status = 200, type = 'basic') => ({ ok: status >= 200 && status < 300, status, type });
const COPIES = ['agent-workbench-boot', 'agent-workbench-history'];

test('a marked browser opens the owner page from the cache at once and keeps it when the network agrees', async () => {
  const w = worker({ owner: true, network: async () => page(200) }); await w.ready();
  assert.equal(await w.navigate('https://wb.example/'), 'CACHED PAGE');
  assert.equal(w.fetched.length, 1, 'the network answer is still checked behind the cached page');
  assert.equal(w.fetched[0][1].redirect, 'manual'); assert.deepEqual(w.navigated, []); assert.ok(w.stores.has('agent-workbench-owner')); assert.deepEqual(w.dropped, []);
});

test('when access as the owner has ended, the mark and the saved copies go and the page opens again from the network', async () => {
  for (const answer of [page(401), page(410), page(0, 'opaqueredirect'), page(302)]) {
    const w = worker({ owner: true, network: async () => answer }); await w.ready();
    assert.equal(await w.navigate('https://wb.example/'), 'CACHED PAGE');
    assert.deepEqual(w.navigated, ['https://wb.example/']); assert.ok(!w.stores.has('agent-workbench-owner')); assert.deepEqual(w.dropped, COPIES);
    // The reload now goes to the network first.
    assert.equal(await w.navigate('https://wb.example/'), answer);
  }
});

test('Home restarting or a gateway error leaves the cached page, the mark and the copies alone', async () => {
  for (const answer of [page(502), page(503), page(500), page(404)]) {
    const w = worker({ owner: true, network: async () => answer }); await w.ready();
    assert.equal(await w.navigate('https://wb.example/'), 'CACHED PAGE');
    assert.deepEqual(w.navigated, []); assert.ok(w.stores.has('agent-workbench-owner')); assert.deepEqual(w.dropped, []);
  }
});

test('a mark past the end of its login is not used: the copies go and the network answers', async () => {
  const fresh = page(401), w = worker({ owner: true, until: Date.now() - 1000, network: async () => fresh }); await w.ready();
  assert.equal(await w.navigate('https://wb.example/'), fresh);
  assert.ok(!w.stores.has('agent-workbench-owner')); assert.deepEqual(w.dropped, COPIES);
  const valid = worker({ owner: true, until: Date.now() + 3600000, network: async () => page(200) }); await valid.ready();
  assert.equal(await valid.navigate('https://wb.example/'), 'CACHED PAGE');
});

test('a browser that cannot reopen a page from the worker is asked to reload itself', async () => {
  const w = worker({ owner: true, navigate: false, network: async () => page(401) }); await w.ready();
  await w.navigate('https://wb.example/');
  // (The message object comes from the worker's own realm: compare its content.)
  assert.equal(JSON.stringify(w.posted), JSON.stringify([{ type: 'wb-reopen' }])); assert.deepEqual(w.dropped, COPIES);
});

test('an unmarked browser, a share address and other pages go to the network first; offline falls back to the cached page', async () => {
  const fresh = page(200), guest = worker({ network: async () => fresh }); await guest.ready();
  assert.equal(await guest.navigate('https://wb.example/'), fresh);
  const shared = worker({ owner: true, network: async () => fresh }); await shared.ready();
  assert.equal(await shared.navigate('https://wb.example/?share=group&mode=ro&projectId=p1'), fresh, 'a share address is never answered from the cache');
  assert.equal(await shared.navigate('https://wb.example/document.html'), fresh, 'another page is not answered with the app page');
  const offline = worker({ network: async () => { throw new Error('offline'); } }); await offline.ready();
  assert.equal(await offline.navigate('https://wb.example/'), 'CACHED PAGE');
  const marked = worker({ owner: true, network: async () => { throw new Error('offline'); } }); await marked.ready();
  assert.equal(await marked.navigate('https://wb.example/'), 'CACHED PAGE'); assert.deepEqual(marked.navigated, []); assert.ok(marked.stores.has('agent-workbench-owner'), 'offline keeps the cached page and the mark');
});
