const CACHE = 'agent-workbench-static-source-sync-v45';
const STATIC = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest', '/app-icon.png', '/app-icon-192.png',
  '/platform-admin.js', '/project-space.js', '/token-usage.js', '/run-log-data.js', '/room.js',
  '/markdown.js', '/project-settings.js', '/role-icons.js', '/settings-page.js',
  '/supervisor-settings.js', '/role-switch.js', '/role-history.js', '/project-setup.js', '/history-view.js', '/scheduled-jobs.js',
  '/git-version.js', '/plan-dock.js', '/agent-codex.png', '/agent-antigravity.png',
  '/document.html', '/document.js', '/workspace-inspector.js', '/state-data.js',
  '/i18n.js', '/locales/zh.js', '/browser-token.js', '/source-sync.js'
];
const staticPaths = new Set(STATIC);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('agent-workbench-static-') && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Cache public static assets only; APIs carrying chats, tasks and credentials always go to Home.
  if (url.origin !== self.location.origin || !staticPaths.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(url.pathname, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      throw error;
    }
  })());
});
