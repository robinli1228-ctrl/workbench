const CACHE = 'agent-workbench-static-release-ui-wait-v101';
const STATIC = [
  '/', '/styles.css', '/app.js', '/native-sessions.js', '/list-order.js', '/select-controls.js', '/mention-input.js', '/context-usage.js', '/manifest.webmanifest', '/app-icon.png', '/app-icon-192.png',
  '/platform-admin.js', '/project-space.js', '/token-usage.js', '/run-log-data.js', '/room.js',
  '/markdown.js', '/project-settings.js', '/role-icons.js', '/settings-page.js',
  '/supervisor-settings.js', '/role-templates.js', '/role-switch.js', '/role-history.js', '/project-setup.js', '/history-view.js', '/scheduled-jobs.js',
  '/git-version.js', '/plan-dock.js', '/agent-codex.png', '/agent-antigravity.png',
  '/document.html', '/document.js', '/workspace-inspector.js', '/state-data.js', '/execution-progress.js', '/live-scene.js',
  '/i18n.js', '/locales/zh.js', '/locales/native-takeover-zh.js', '/browser-token.js', '/source-sync.js',
  '/output-language.js', '/vendor/opencc-t2cn.js', '/cli-recovery.js', '/session-queue.js'
];
const staticPaths = new Set(STATIC);
// These large optional images are cached only if requested, so first install cannot starve state/chat reads over SSH.
const precache = STATIC.filter(path => !['/app-icon.png', '/agent-codex.png'].includes(path));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(precache)).then(() => self.skipWaiting()));
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
