// GitHub Pages cleanup service worker.
// Earlier local builds registered a service worker. The GitHub Pages build does not need one.
// If an older registration exists at this path, this script clears old caches and unregisters itself.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("browser-transcriber-")).map((key) => caches.delete(key)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.navigate(client.url);
  })());
});
