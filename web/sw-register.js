// Register the service worker (installable PWA + offline + server updates).
// Needs a secure context: HTTPS in the field, localhost on the dev machine.
// The Qt desktop / native APK already serve the app locally, so a SW there only
// adds update lag — skip it (and tear down any previously-installed one).
// Kept in a separate file (not inline) so the page can ship a strict CSP without
// needing 'unsafe-inline' for scripts.
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (/QtWebEngine|FMPAndroid/i.test(navigator.userAgent)) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
  } else {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
