// Register the service worker (installable PWA + offline + server updates).
// Needs a secure context: HTTPS in the field, localhost on the dev machine.
// The Qt desktop / native APK already serve the app locally, so a SW there only
// adds update lag — skip it (and tear down any previously-installed one).
// Kept in a separate file (not inline) so the page can ship a strict CSP without
// needing 'unsafe-inline' for scripts.
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (/QtWebEngine|FMPAndroid|FMPiOS/i.test(navigator.userAgent)) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
  } else {
    // Auto-reload ONCE when a new service worker takes control, so an app update
    // (new app.js AND the matching engine/*.py, atomically from the new cache) lands
    // on the very next moment instead of lingering across 2-3 manual relaunches — the
    // cause of "I updated but the new feature shows nothing". Only fires on an UPDATE
    // (a controller already existed), never on the first-ever install.
    if (navigator.serviceWorker.controller) {
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    }
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
