import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("the installable manifest opens the protected product in standalone mode", async () => {
  const manifest = JSON.parse(await source("public/manifest.webmanifest"));

  assert.equal(manifest.id, "/app");
  assert.equal(manifest.start_url, "/app");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "es-CL");
  assert.ok(manifest.icons.some((icon) => icon.purpose.includes("maskable")));
  assert.deepEqual(manifest.icons.map((icon) => icon.src), [
    "/fundosmart-ultra-min-app-icon-192.png",
    "/fundosmart-ultra-min-app-icon-512.png",
    "/fundosmart-ultra-min-app-icon-maskable-512.png",
  ]);
  assert.doesNotMatch(JSON.stringify(manifest), /favicon\.svg|icon-maskable\.png/);
});

test("the service worker keeps private documents and APIs out of Cache Storage", async () => {
  const worker = await source("public/sw.js");
  const navigationBranch = worker.slice(
    worker.indexOf('if (request.mode === "navigate")'),
    worker.indexOf("if (isPublicAsset"),
  );

  // The shell cache must stay versioned and never regress below the hardened v2,
  // so stale entries from a leakier worker are always purged on activate.
  // Pinning an exact version here would break on every legitimate cache bump.
  const cacheVersion = /CACHE_VERSION = "v(\d+)"/.exec(worker);
  assert.ok(cacheVersion, "the shell cache must stay versioned");
  assert.ok(Number(cacheVersion[1]) >= 2, `cache version regressed to v${cacheVersion?.[1]}`);
  assert.match(worker, /key\.startsWith\(CACHE_PREFIX\) && key !== SHELL_CACHE/);
  assert.match(worker, /key\.startsWith\(LEGACY_CACHE_PREFIX\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /request\.mode === "navigate"[\s\S]+?fetch\(request\)\.catch\(\(\) => offlineResponse\(\)\)/);
  assert.doesNotMatch(navigationBranch, /cache\.put\(request/);
  assert.doesNotMatch(worker, /\["font", "image", "script", "style"\]/);
  assert.doesNotMatch(worker, /caches\.match\(/);
  assert.match(worker, /response\.ok && response\.type === "basic" && !hasPrivateCacheDirective\(response\)/);
});

test("the service worker only intercepts explicit public asset paths", async () => {
  const harness = await serviceWorkerHarness({ cacheControl: "public, max-age=31536000, immutable" });

  assert.equal(harness.dispatchFetch({
    destination: "image",
    url: "https://fundosmart.com/app/private-animal-photo.png",
  }), null);
  assert.equal(harness.fetchCount(), 0);
  assert.deepEqual(harness.cacheWrites, []);

  const publicResponse = harness.dispatchFetch({
    destination: "script",
    url: "https://fundosmart.com/assets/app-content-hash.js",
  });
  assert.ok(publicResponse);
  await publicResponse;
  assert.equal(harness.fetchCount(), 1);
  assert.deepEqual(harness.cacheWrites, ["https://fundosmart.com/assets/app-content-hash.js"]);
});

test("explicit Cache Storage writes still honor private and no-store responses", async () => {
  for (const cacheControl of ["private, max-age=300", "public, no-store"]) {
    const harness = await serviceWorkerHarness({ cacheControl });
    const response = harness.dispatchFetch({
      destination: "script",
      url: "https://fundosmart.com/assets/session-specific.js",
    });

    assert.ok(response);
    await response;
    assert.deepEqual(harness.cacheWrites, [], cacheControl);
  }
});

test("the application registers a static cold-capture shell only on HTTPS", async () => {
  const [layout, registration, offlinePage] = await Promise.all([
    source("app/layout.tsx"),
    source("src/core/offline/ServiceWorkerRegistration.tsx"),
    source("public/offline.html"),
  ]);

  assert.match(layout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(layout, /fundosmart-ultra-min-apple-touch-icon\.png/);
  assert.match(layout, /fundosmart-ultra-min-favicon\.svg/);
  assert.match(layout, /<ServiceWorkerRegistration \/>/);
  assert.match(registration, /window\.location\.protocol !== "https:"/);
  assert.match(registration, /register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.doesNotMatch(offlinePage, /userName|organizationId|membershipId|fetch\(/);
  assert.match(offlinePage, /<meta content="noindex,nofollow" name="robots">/);
  assert.deepEqual([...offlinePage.matchAll(/<script[^>]+src="([^"]+)"/gu)].map((match) => match[1]), ["/offline-capture.js"]);
  assert.doesNotMatch(offlinePage, /https?:\/\/|stylesheet|__next|_rsc/iu);
});

test("offline field caches are partitioned by membership, role, and field scope", async () => {
  const [route, page] = await Promise.all([
    source("app/(producto)/potreros/page.tsx"),
    source("src/modules/potreros/PotrerosPage.tsx"),
  ]);

  assert.match(route, /access\.membershipId, access\.role, \.\.\.\[\.\.\.access\.fieldIds\]\.sort\(\)/);
  assert.match(route, /offlineScope=\{offlineScope\}/);
  assert.match(page, /offlineStorageKey\("potreros-v4", offlineScope\)/);
  assert.match(page, /offlineStorageKey\("activities-v3", offlineScope\)/);
  assert.match(page, /for \(const key of LEGACY_STORAGE_KEYS\) window\.localStorage\.removeItem\(key\)/);
  assert.match(page, /setNetworkOnline\(window\.navigator\.onLine\)/);
  assert.match(page, /!networkOnline \|\| paddockSyncState === "offline"/);
});

test("the mobile shell reports connectivity and keeps primary modules thumb-reachable", async () => {
  const shell = await source("src/core/layout/AppShell.tsx");

  assert.match(shell, /window\.navigator\.onLine/);
  assert.match(shell, /aria-label="Navegación rápida"/);
  assert.match(shell, /Sin conexión: el caché disponible sigue visible/);
  assert.match(shell, /\["summary", "potreros", "ganado", "leche"\]/);
  for (const label of ["Resumen", "Ganado", "Leche"]) assert.match(shell, new RegExp(`label: "${label}"`));
  assert.match(shell, /\? "Potreros" : item\.label/);
  assert.match(shell, />Más<\/span>/);
});

async function serviceWorkerHarness({ cacheControl }) {
  const listeners = new Map();
  const cacheWrites = [];
  let networkFetchCount = 0;
  const cache = {
    async addAll() {},
    async match() {
      return undefined;
    },
    async put(request) {
      cacheWrites.push(request.url);
    },
  };
  const response = {
    headers: new Headers({ "Cache-Control": cacheControl }),
    ok: true,
    type: "basic",
    clone() {
      return this;
    },
  };
  const context = {
    Headers,
    URL,
    caches: {
      async delete() {
        return true;
      },
      async keys() {
        return [];
      },
      async open() {
        return cache;
      },
    },
    fetch: async () => {
      networkFetchCount += 1;
      return response;
    },
    self: {
      clients: { async claim() {} },
      location: { origin: "https://fundosmart.com" },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      async skipWaiting() {},
    },
  };
  vm.runInNewContext(await source("public/sw.js"), context);

  return {
    cacheWrites,
    fetchCount: () => networkFetchCount,
    dispatchFetch({ destination, url }) {
      let responsePromise = null;
      listeners.get("fetch")({
        request: { destination, method: "GET", mode: "cors", url },
        respondWith(value) {
          responsePromise = Promise.resolve(value);
        },
      });
      return responsePromise;
    },
  };
}
