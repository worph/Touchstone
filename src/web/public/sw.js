/**
 * The push service worker. It has exactly one job.
 *
 * Everything Touchstone knows is already on the Activity page, so this does not cache,
 * does not intercept fetches, and does not try to make the app work offline — an app whose
 * whole content is "what is happening right now" has nothing useful to serve from a cache.
 * It shows the notification and opens the page it points at.
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Touchstone', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Touchstone';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      // Same tag replaces rather than stacks: a bench that fails twice is one notification,
      // for the same reason it is one alert.
      tag: payload.tag || 'touchstone',
      data: { url: payload.url || '/activity' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/activity';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
