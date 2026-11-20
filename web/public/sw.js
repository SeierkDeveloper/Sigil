// Sigil's service worker. It keeps the app shell (pages and their scripts,
// styles and fonts) so the site opens offline, and it receives what the phone's
// share sheet sends to /capture. It never caches an API answer: the vault's own
// offline copy is ciphertext the page keeps in IndexedDB, and only when the
// owner turns it on.

const VERSION = "sigil-shell-v1";
const SHELL = ["/vault", "/capture", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------- the share sheet

const SHARE_DB = "sigil-share";

function shareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("items");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function keepShared(item) {
  const db = await shareDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction("items", "readwrite");
    t.objectStore("items").put(item, "pending");
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
}

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("photo").filter((f) => f && typeof f === "object" && f.size > 0);
    await keepShared({
      title: String(form.get("title") || ""),
      text: String(form.get("text") || ""),
      url: String(form.get("url") || ""),
      photo: files[0] || null,
      at: new Date().toISOString(),
    });
  } catch {
    // Nothing usable arrived; the capture screen opens empty.
  }
  return Response.redirect("/capture?shared=1", 303);
}

// ---------------------------------------------------------------- fetching

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (!sameOrigin(url)) return;

  if (req.method === "POST" && url.pathname === "/capture") {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== "GET") return;
  // The API and the search model are never kept here.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/models/")) return;

  // Built files never change under the same name: the cached copy is the right one.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/vendor/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: the network first, so they are always current; the last copy when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(url.pathname)) || (url.pathname.startsWith("/vault") ? caches.match("/vault") : undefined) || (await caches.match("/vault")) || Response.error()),
    );
  }
});
