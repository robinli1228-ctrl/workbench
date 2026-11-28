const CACHE = 'agent-workbench-static-v221-release-259';
const STATIC = [
  '/device-transport.js',
  '/native-side-ask.js', '/group-side-ask.js', '/source-sync-audit.js',
  '/conversation-tasks.js', '/conversation-task-state.js',
  '/remote-access-settings.js',
  '/share-mode.js', '/jump-to-bottom.js', '/last-place.js', '/auto-save.js', '/boot-cache.js', '/share-settings.js',
  '/group-conversations.js',
  '/model-usage.js',
  '/quota-state.js',
  '/chat-card-state.js',
  '/project-team-copy.js',
  '/create-folder.js',
  '/native-session-groups.js',
  '/native-agent-switch.js',
  '/native-history-timeline.js',
  '/native-transcript.js',
  '/pasted-text.js',
  '/side-preview.js',
  '/history-prompt.js',
  '/history-cache.js',
  '/data-settings.js',
  '/', '/styles.css', '/delivery-summary.js', '/app.js', '/native-sessions.js', '/list-order.js', '/select-controls.js', '/mention-input.js', '/context-usage.js', '/manifest.webmanifest', '/app-icon.png', '/app-icon-192.png', '/retired-commands.js',
  '/platform-admin.js', '/configuration-information.js', '/project-space.js', '/platform-memory.js', '/token-usage.js', '/run-log-data.js', '/room.js', '/ask-card.js',
  '/markdown.js', '/media.js', '/local-browser.js', '/device-access.js', '/project-settings.js', '/role-icons.js', '/settings-page.js',
  '/supervisor-settings.js', '/elapsed.js', '/send-state.js', '/permission-scope.js', '/role-templates.js', '/role-switch.js', '/role-history.js', '/project-setup.js', '/history-view.js', '/scheduled-jobs.js',
  '/git-version.js', '/agent-codex.png', '/agent-antigravity.png',
  '/document.html', '/document.js', '/workspace-inspector.js', '/concurrent-writes.js', '/state-data.js', '/execution-progress.js', '/live-scene.js',
  '/i18n.js', '/locales/zh.js', '/locales/native-takeover-zh.js', '/browser-token.js', '/source-sync.js',
  '/output-language.js', '/vendor/opencc-t2cn.js', '/cli-recovery.js', '/session-queue.js', '/question-answer.js', '/load-bar.js'
];
const staticPaths = new Set(STATIC);
// These large optional images are cached only if requested, so first install cannot starve state/chat reads over SSH.
const precache = STATIC.filter(path => !['/app-icon.png', '/agent-codex.png'].includes(path));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(precache)).catch(async error => {
    // A failed install must not leave an empty cache that looks ready to the page.
    await caches.delete(CACHE);
    throw error;
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('agent-workbench-static-') && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

const OWNER = 'agent-workbench-owner';
/** The owner's page from the cache when this browser is marked for it and the address is the plain page; else the network. */
async function openPage(event, request, url) {
  const cache = await caches.open(CACHE);
  const cached = !url.search && await caches.has(OWNER) ? await cache.match('/') : null;
  if (!cached) return fetch(request).catch(async () => (await cache.match('/')) || Response.error());
  event.waitUntil(checkPage(event.resultingClientId, url));
  return cached;
}
/**
 * The network's answer for the page just opened from the cache. Anything but the page itself (the login page, a share
 * notice, a redirect to a share address) means the gateway has something else to show: the mark is dropped and the
 * page is opened again, this time from the network. Offline, the cached page stands.
 */
async function checkPage(clientId, url) {
  let response;
  try { response = await fetch(url.href, { credentials: 'include', redirect: 'manual', cache: 'no-store', headers: { accept: 'text/html' } }); }
  catch { return; }
  if (response.ok) return;
  await caches.delete(OWNER);
  const wanted = clientId ? await self.clients.get(clientId) : null;
  const pages = wanted ? [wanted] : (await self.clients.matchAll({ type: 'window' })).filter(client => { const at = new URL(client.url); return at.pathname === '/' && !at.search; });
  for (const client of pages) await client.navigate(client.url).catch(() => {});
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Cache public static assets only; APIs carrying chats, tasks and credentials always go to Home.
  if (url.origin !== self.location.origin || !staticPaths.has(url.pathname)) return;
  // Opening the page: through remote access the gateway answers a navigation itself (a share link's address, the owner
  // leaving a share address, the notice for an expired link, the login page), so a navigation goes to the network first and
  // the cached page is only the offline fallback. The one exception is the owner's own page on a browser that page marked
  // (see boot-cache.js): it opens from the cached copy at once, and the network answer is checked behind it.
  if (request.mode === 'navigate') {
    event.respondWith(openPage(event, request, url));
    return;
  }
  // Cache first: Home puts a fingerprint of every page file into CACHE, so a changed file always arrives as a new service
  // worker with a fresh cache, and a cached copy is never stale within its version. Only files missing from the cache
  // (optional images, or a precache that failed) go to the network.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(url.pathname, response.clone()).catch(() => {});
    return response;
  })());
});
