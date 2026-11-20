self.addEventListener('push', (event) => {
  let data = { title: 'AntiHunter', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    data.body = event.data ? event.data.text() : '';
  }
  event.waitUntil(
    self.registration.showNotification(String(data.title), {
      body: String(data.body),
      icon: '/logo111.png',
      tag: 'ahcc-alert',
      renotify: true,
      data: { url: typeof data.url === 'string' && /^\/(?![/\\])/.test(data.url) ? data.url : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => 'navigate' in client);
      return existing
        ? existing.navigate(target).then((client) => client?.focus())
        : self.clients.openWindow(target);
    }),
  );
});
