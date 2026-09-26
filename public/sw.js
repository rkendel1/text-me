/* Text Me service worker: owner notifications that open the exact live conversation. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Text Me', body: event.data && event.data.text() }; }
  const title = data.title || 'Text Me';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag,
    renotify: Boolean(data.renotify),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    // Shown where the platform supports it (not on iOS); the tap itself always deep-links.
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin);
  // The action is only an intent: the page runs it as an authenticated, owner-scoped command.
  if (event.action === 'take_over' || event.action === 'reply') target.searchParams.set('intent', event.action);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'open', url: target.pathname + target.search });
      return;
    }
    await self.clients.openWindow(target.pathname + target.search);
  })());
});
