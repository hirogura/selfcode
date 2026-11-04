/* selfcode 通知用 Service Worker */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// 通知クリックで selfcode のタブを前面に出す
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) {
      if ("focus" in c) {
        try { return c.focus(); } catch {}
      }
    }
    return self.clients.openWindow("/");
  })());
});
