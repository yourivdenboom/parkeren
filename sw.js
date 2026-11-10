// Service worker: ontvangt meldingen, ook als de app dicht is.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: "Parkeren", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(m.title || "Parkeren", {
      body: m.body || "",
      tag: m.tag || undefined,
      icon: "icon-192.png",
      badge: "icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  })());
});
