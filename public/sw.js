// Minimal service worker. Intentionally does not intercept fetches or cache
// anything yet - registered from index.html for future PWA/offline support.
//
// This file previously rewrote every navigated HTML response to inject a
// Clear/New Job button and its script via string replacement before
// </body>. That worked, but meant the button existed nowhere in the actual
// served HTML - only assembled at runtime inside this worker - which is a
// real problem for a codebase that has already spent significant time
// untangling "what's actually live vs what's in the repo" (dead JS files,
// stale deploys, etc). It also had a real first-load gap: a service worker
// only controls a page after it's installed and the page reloads under it,
// so first-time visitors never saw the injected button on their first load.
//
// The Clear/New Job button now lives directly in public/index.html as a
// normal button with a normal event listener - visible in plain
// view-source, no injection, no timing gap.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
