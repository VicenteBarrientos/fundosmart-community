import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("cold start serves the shell, writes exact IndexedDB partitions and reconnects data before photos", async () => {
  const cachedAssets = [];
  const offlineMarker = { kind: "offline-shell" };
  const workerListeners = new Map();
  const cache = {
    async addAll(assets) { cachedAssets.push(...assets); },
    async match(request) { return request === "/offline.html" ? offlineMarker : null; },
    async put() {},
  };
  const worker = await readFile(new URL("public/sw.js", root), "utf8");
  vm.runInNewContext(worker, {
    URL,
    fetch: async () => { throw new Error("offline"); },
    caches: { async open() { return cache; }, async keys() { return []; }, async delete() {} },
    self: {
      location: { origin: "https://fundosmart.com" },
      clients: { async claim() {}, async matchAll() { return []; } },
      addEventListener(type, listener) { workerListeners.set(type, listener); },
      async skipWaiting() {},
    },
  });
  let installation;
  workerListeners.get("install")({ waitUntil(value) { installation = value; } });
  await installation;
  assert.ok(cachedAssets.includes("/offline.html"));
  assert.ok(cachedAssets.includes("/offline-capture.js"));
  let navigation;
  workerListeners.get("fetch")({
    request: { method: "GET", mode: "navigate", url: "https://fundosmart.com/app/ganado" },
    respondWith(value) { navigation = value; },
  });
  assert.equal(await navigation, offlineMarker);

  const database = new MemoryIndexedDb();
  const scope = "membership-a.operator.field-a";
  const session = {
    version: 1,
    audience: "fundosmart-offline-v1",
    sessionId: "session-a",
    token: "payload.signature",
    accountMode: "personal",
    membershipId: "membership-a",
    organizationId: "organization-a",
    userSubject: "a".repeat(64),
    role: "operator",
    fieldIds: ["field-a"],
    issuedAt: "2026-07-22T09:00:00.000Z",
    expiresAt: "2026-07-22T15:00:00.000Z",
  };
  const partition = { accountMode: "personal", organizationId: "organization-a", userSubject: "a".repeat(64), fieldId: "field-a" };
  const partitionKey = [partition.accountMode, partition.organizationId, partition.userSubject, partition.fieldId].map(encodeURIComponent).join("|");
  database.seed("sessions", { id: `session|${encodeURIComponent(scope)}`, scope, session });
  database.seed("readModels", {
    id: `read-model|${partitionKey}|livestock-field-reference-v1`, partition, name: "livestock-field-reference-v1", cursor: 0,
    value: {
      version: 1,
      animals: [{ id: "cow-a", tag: "DIIO-001", sex: "female", status: "active", lotId: "lot-a" }],
      lots: [{ id: "lot-a", name: "Lote A", fieldId: "field-a", trackingMode: "individual" }],
    },
  });
  database.seed("readModels", {
    id: `read-model|${partitionKey}|paddock-geography-v1`, partition, name: "paddock-geography-v1", cursor: 0,
    value: { fieldId: "field-a", paddocks: [], landmarks: [] },
  });

  const calls = [];
  const online = { onLine: false };
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/api/offline/session") return Response.json({ session });
    if (url === "/api/sync") {
      const body = JSON.parse(init.body);
      return Response.json({ results: body.mutations.map(({ id }) => ({ id, status: "applied", replay: false, conflictReason: null })) });
    }
    if (url === "/api/offline/attachments") {
      const attachmentId = init.body.get("attachmentId");
      return Response.json({ attachment: { objectKey: `offline/organization-a/field-a/${attachmentId}`, sha256: "b".repeat(64) } }, { status: 201 });
    }
    throw new Error(`unexpected ${url}`);
  };
  let clock = Date.parse("2026-07-22T10:00:00.000Z");
  let random = 0;
  const shell = await readFile(new URL("public/offline-capture.js", root), "utf8");
  const context = { Blob, FormData, Response, Uint8Array, console, indexedDB: database, navigator: online };
  context.crypto = { getRandomValues(bytes) { bytes.fill(0); bytes[bytes.length - 1] = random += 1; return bytes; } };
  context.fetch = fetcher;
  context.globalThis = context;
  vm.runInNewContext(shell, context);
  const runtime = context.FundoSmartOfflineCapture.createRuntime({
    indexedDB: database,
    navigator: online,
    fetch: fetcher,
    FormData,
    now: () => clock += 1,
    randomBytes: () => { const bytes = new Uint8Array(10); bytes[9] = random += 1; return bytes; },
  });
  const [selected] = await runtime.loadContexts();
  assert.ok(selected.captureAllowed);

  const common = { contextKey: selected.key, animalId: "cow-a", lotId: "lot-a", date: "2026-07-22", detail: "Control", product: "Producto A", destinationRup: "RUP-DESTINO" };
  const siblingScope = "membership-b.operator.field-b";
  database.seed("sessions", {
    id: `session|${encodeURIComponent(siblingScope)}`,
    scope: siblingScope,
    session: { ...session, membershipId: "membership-b", organizationId: "organization-b", userSubject: "b".repeat(64), fieldIds: ["field-b"] },
  });
  assert.equal((await runtime.loadContexts()).length, 2);
  await assert.rejects(runtime.queueLivestockCapture({ ...common, contextKey: "", entity: "livestock_weighing", weightKg: 500 }), /Selecciona/iu);
  await runtime.queueLivestockCapture({ ...common, entity: "livestock_weighing", weightKg: 512.5 });
  const photo = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  Object.defineProperty(photo, "name", { value: "evidencia.jpg" });
  await runtime.queueLivestockCapture({ ...common, entity: "livestock_health", file: photo });
  await runtime.queueLivestockCapture({ ...common, entity: "livestock_estrus" });
  await runtime.queueLivestockCapture({ ...common, entity: "livestock_movement" });
  await runtime.queueLandmark({ contextKey: selected.key, kind: "bebedero", name: "Bebedero GPS", notes: "shell", latitude: -40.57, longitude: -73.14 });

  const queued = database.values("mutations");
  assert.deepEqual(queued.map((entry) => JSON.parse(entry.body).mutations[0].entity).sort(), [
    "field_landmark", "livestock_estrus", "livestock_health", "livestock_movement", "livestock_weighing",
  ]);
  assert.ok(queued.every((entry) => entry.scope === scope && entry.partition.fieldId === "field-a" && entry.id.includes(partitionKey)));
  assert.equal(database.values("attachments").length, 1);
  assert.equal(calls.length, 0, "cold capture must not attempt network writes");

  online.onLine = true;
  const result = await runtime.flush(selected.key);
  assert.equal(result.sent, 5);
  assert.equal(result.uploaded, 1);
  assert.ok(database.values("mutations").every((entry) => entry.status === "applied"));
  assert.equal(database.values("attachments")[0].status, "applied");
  assert.equal(database.values("attachments")[0].blob, null);
  const syncCallIndexes = calls.map(({ url }, index) => url === "/api/sync" ? index : -1).filter((index) => index >= 0);
  const attachmentCallIndex = calls.findIndex(({ url }) => url === "/api/offline/attachments");
  assert.ok(attachmentCallIndex > Math.max(...syncCallIndexes), "the immutable original uploads only after every data push");
  assert.ok(calls.filter(({ url }) => url === "/api/sync").every(({ init }) => init.credentials === "same-origin" && init.headers["Idempotency-Key"].startsWith("sync:")));
});

test("50 captures survive five connectivity cycles, lost responses and runtime reopen", async () => {
  const database = new MemoryIndexedDb();
  const online = { onLine: false };
  const scope = "membership-a.operator.field-a";
  const session = {
    version: 1,
    audience: "fundosmart-offline-v1",
    sessionId: "session-a",
    token: "payload.signature",
    accountMode: "personal",
    membershipId: "membership-a",
    organizationId: "organization-a",
    userSubject: "a".repeat(64),
    role: "operator",
    fieldIds: ["field-a"],
    issuedAt: "2026-07-22T09:00:00.000Z",
    expiresAt: "2026-07-22T15:00:00.000Z",
  };
  const partition = {
    accountMode: "personal",
    organizationId: "organization-a",
    userSubject: "a".repeat(64),
    fieldId: "field-a",
  };
  const partitionKey = [
    partition.accountMode,
    partition.organizationId,
    partition.userSubject,
    partition.fieldId,
  ].map(encodeURIComponent).join("|");
  database.seed("sessions", { id: `session|${encodeURIComponent(scope)}`, scope, session });
  database.seed("readModels", {
    id: `read-model|${partitionKey}|livestock-field-reference-v1`,
    partition,
    name: "livestock-field-reference-v1",
    cursor: 0,
    value: {
      version: 1,
      animals: [{ id: "cow-a", tag: "DIIO-001", sex: "female", status: "active", lotId: "lot-a" }],
      lots: [{ id: "lot-a", name: "Lote A", fieldId: "field-a", trackingMode: "individual" }],
    },
  });

  const committed = new Map();
  const requestAttempts = new Map();
  const lostResponseCommitCounts = new Set([10, 20, 30, 40]);
  const lostMutationIds = [];
  const fetcher = async (url, init = {}) => {
    if (url === "/api/offline/session") return Response.json({ session });
    assert.equal(url, "/api/sync");
    assert.equal(init.credentials, "same-origin");
    assert.match(init.headers["Idempotency-Key"], /^sync:[0-9A-HJKMNP-TV-Z]{26}:0$/u);
    const body = JSON.parse(init.body);
    assert.equal(body.mutations.length, 1);
    const [mutation] = body.mutations;
    const canonicalPayload = JSON.stringify(mutation);
    const previous = committed.get(mutation.id);
    const replay = previous !== undefined;
    if (replay) assert.equal(previous, canonicalPayload, "a retry must preserve the exact mutation payload");
    else committed.set(mutation.id, canonicalPayload);
    requestAttempts.set(mutation.id, (requestAttempts.get(mutation.id) ?? 0) + 1);

    if (!replay && lostResponseCommitCounts.delete(committed.size)) {
      lostMutationIds.push(mutation.id);
      throw new Error("simulated response loss after server commit");
    }
    return Response.json({
      results: [{
        id: mutation.id,
        status: "applied",
        replay,
        conflictReason: null,
      }],
    });
  };

  let clock = Date.parse("2026-07-22T10:00:00.000Z");
  let random = 0;
  const shell = await readFile(new URL("public/offline-capture.js", root), "utf8");
  const context = { Blob, FormData, Response, Uint8Array, console, indexedDB: database, navigator: online };
  context.crypto = { getRandomValues(bytes) { bytes.fill(0); bytes[bytes.length - 1] = random += 1; return bytes; } };
  context.fetch = fetcher;
  context.globalThis = context;
  vm.runInNewContext(shell, context);
  const createRuntime = () => context.FundoSmartOfflineCapture.createRuntime({
    indexedDB: database,
    navigator: online,
    fetch: fetcher,
    FormData,
    now: () => clock += 1,
    randomBytes: () => {
      const bytes = new Uint8Array(10);
      bytes[9] = random += 1;
      return bytes;
    },
  });

  let runtime = createRuntime();
  let [selected] = await runtime.loadContexts();
  const captureIds = [];
  for (let index = 0; index < 50; index += 1) {
    const queued = await runtime.queueLivestockCapture({
      contextKey: selected.key,
      entity: "livestock_health",
      animalId: "cow-a",
      date: "2026-07-22",
      detail: `Control sanitario ${index + 1}`,
      product: "Producto A",
    });
    captureIds.push(queued.mutationId);
  }
  assert.equal(new Set(captureIds).size, 50);
  assert.ok(captureIds.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)));
  assert.deepEqual({ ...await runtime.summarize(selected.key) }, { pending: 50, conflicts: 0, attachments: 0 });

  const sentByCycle = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    online.onLine = true;
    sentByCycle.push((await runtime.flush(selected.key)).sent);
    online.onLine = false;
    runtime = createRuntime();
    [selected] = await runtime.loadContexts();
  }

  assert.deepEqual(sentByCycle, [9, 10, 10, 10, 11]);
  assert.equal(committed.size, 50);
  assert.deepEqual([...committed.keys()], captureIds);
  assert.deepEqual(lostMutationIds, [captureIds[9], captureIds[19], captureIds[29], captureIds[39]]);
  assert.equal([...requestAttempts.values()].reduce((total, attempts) => total + attempts, 0), 54);
  assert.ok(lostMutationIds.every((id) => requestAttempts.get(id) === 2));
  assert.ok(captureIds.filter((id) => !lostMutationIds.includes(id)).every((id) => requestAttempts.get(id) === 1));
  assert.deepEqual({ ...await runtime.summarize(selected.key) }, { pending: 0, conflicts: 0, attachments: 0 });
  assert.ok(database.values("mutations").every((entry) => entry.status === "applied"));
});

class MemoryIndexedDb {
  #stores = new Map();
  #version = 0;

  open(_name, version) {
    const request = {};
    queueMicrotask(() => {
      const database = this.#database();
      request.result = database;
      if (version > this.#version) {
        this.#version = version;
        request.onupgradeneeded?.();
      }
      queueMicrotask(() => request.onsuccess?.());
    });
    return request;
  }

  seed(store, value) {
    this.#store(store).set(value.id, structuredClone(value));
  }

  values(store) {
    return [...this.#store(store).values()].map((value) => structuredClone(value));
  }

  #store(name) {
    if (!this.#stores.has(name)) this.#stores.set(name, new Map());
    return this.#stores.get(name);
  }

  #database() {
    const stores = this.#stores;
    const storeByName = (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return stores.get(name);
    };
    return {
      objectStoreNames: { contains(name) { return stores.has(name); } },
      createObjectStore(name) { storeByName(name); },
      close() {},
      transaction(name) {
        const transaction = {
          error: null,
          objectStore() {
            const store = storeByName(name);
            return {
              getAll() { return operation(transaction, () => [...store.values()].map((value) => structuredClone(value))); },
              get(key) { return operation(transaction, () => structuredClone(store.get(key))); },
              put(value) { return operation(transaction, () => { store.set(value.id, structuredClone(value)); return value.id; }); },
            };
          },
        };
        return transaction;
      },
    };
  }
}

function operation(transaction, callback) {
  const request = {};
  queueMicrotask(() => {
    try {
      request.result = callback();
      request.onsuccess?.();
      setTimeout(() => transaction.oncomplete?.(), 0);
    } catch (cause) {
      request.error = cause;
      transaction.error = cause;
      request.onerror?.();
      setTimeout(() => transaction.onerror?.(), 0);
    }
  });
  return request;
}
