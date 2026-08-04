import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  buildSyncPullPath,
  buildSyncPushBatches,
  classifyOfflineResponse,
  classifySyncPushResult,
  createOfflineMutationId,
  nextOfflineRetryAt,
  offlinePartitionKey,
  selectReadyOfflineMutations,
} from "../src/modules/offline/domain/offline-rules.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const personalFieldA = {
  accountMode: "personal",
  organizationId: "org-a",
  userSubject: "user-a",
  fieldId: "field-a",
};

test("offline partition keys include mode, organization, subject and field", () => {
  const key = offlinePartitionKey(personalFieldA);
  for (const value of ["personal", "org-a", "user-a", "field-a"]) assert.match(key, new RegExp(value));
  assert.notEqual(key, offlinePartitionKey({ ...personalFieldA, accountMode: "demo" }));
  assert.notEqual(key, offlinePartitionKey({ ...personalFieldA, organizationId: "org-b" }));
  assert.notEqual(key, offlinePartitionKey({ ...personalFieldA, userSubject: "user-b" }));
  assert.notEqual(key, offlinePartitionKey({ ...personalFieldA, fieldId: "field-b" }));
});

test("offline mutation ids are monotonic ULIDs without UUID ambiguity", () => {
  const id = createOfflineMutationId(1_721_561_600_000, new Uint8Array(10));
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal(id, createOfflineMutationId(1_721_561_600_000, new Uint8Array(10)));
  assert.notEqual(id, createOfflineMutationId(1_721_561_600_001, new Uint8Array(10)));
});

test("only due mutations from the exact active partition are eligible", () => {
  const entry = (overrides) => ({
    mutationId: overrides.mutationId,
    partition: overrides.partition ?? personalFieldA,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2026-07-21T12:00:00.000Z",
    nextAttemptAt: overrides.nextAttemptAt ?? null,
  });
  const ready = selectReadyOfflineMutations([
    entry({ mutationId: "pending" }),
    entry({ mutationId: "due", status: "error", nextAttemptAt: "2026-07-21T12:00:01.000Z" }),
    entry({ mutationId: "later", status: "error", nextAttemptAt: "2026-07-21T12:10:00.000Z" }),
    entry({ mutationId: "conflict", status: "conflict" }),
    entry({ mutationId: "other-user", partition: { ...personalFieldA, userSubject: "user-b" } }),
    entry({ mutationId: "demo", partition: { ...personalFieldA, accountMode: "demo" } }),
  ], personalFieldA, "2026-07-21T12:00:02.000Z");

  assert.deepEqual(ready.map(({ mutationId }) => mutationId), ["due", "pending"]);
});

test("409 is retained as conflict unless exact replay is independently proven", () => {
  assert.deepEqual(
    classifyOfflineResponse({ status: 409, attempts: 1, nowIso: "2026-07-21T12:00:00.000Z" }),
    { status: "conflict", nextAttemptAt: null, reason: "El servidor informó un conflicto que requiere revisión." },
  );
  assert.deepEqual(
    classifyOfflineResponse({ status: 409, attempts: 1, nowIso: "2026-07-21T12:00:00.000Z", exactReplay: true }),
    { status: "applied", nextAttemptAt: null, reason: null },
  );
  assert.equal(nextOfflineRetryAt(1, "2026-07-21T12:00:00.000Z"), "2026-07-21T12:00:02.000Z");
  assert.equal(nextOfflineRetryAt(2, "2026-07-21T12:00:00.000Z"), "2026-07-21T12:00:04.000Z");
  assert.equal(nextOfflineRetryAt(20, "2026-07-21T12:00:00.000Z"), "2026-07-21T12:05:00.000Z");
});

test("428 keeps the offline payload retryable until legal acceptance is refreshed", async () => {
  assert.deepEqual(
    classifyOfflineResponse({ status: 428, attempts: 2, nowIso: "2026-07-21T12:00:00.000Z" }),
    {
      status: "error",
      nextAttemptAt: "2026-07-21T12:00:04.000Z",
      reason: "Debes revisar la versión legal vigente; la captura sigue guardada y se reintentará después.",
    },
  );

  const capture = await source("public/offline-capture.js");
  assert.match(capture, /response\.status === 401 \|\| response\.status === 403 \|\| response\.status === 428/);
  assert.match(capture, /response\.status === 428[\s\S]+captura sigue guardada/);
  assert.doesNotMatch(capture, /response\.status === 428[\s\S]{0,120}(?:delete|remove)/i);
});

test("Phase 0 push is bounded and pull resumes by field cursor", () => {
  const mutations = Array.from({ length: 101 }, (_, index) => ({ id: `mutation-${index}`, fieldId: "field-a" }));
  assert.deepEqual(buildSyncPushBatches(mutations).map(({ mutations: batch }) => batch.length), [50, 50, 1]);
  assert.equal(buildSyncPullPath(personalFieldA, 27, 75), "/api/sync?cursor=27&fieldId=field-a&limit=75");
});

test("Phase 0 closes a batch only when every exact result is applied", () => {
  assert.deepEqual(classifySyncPushResult(["a", "b"], [
    { id: "a", status: "applied", replay: false },
    { id: "b", status: "applied", replay: true },
  ]), { status: "applied", nextAttemptAt: null, reason: null });
  assert.deepEqual(classifySyncPushResult(["a", "b"], [
    { id: "a", status: "applied" },
    { id: "b", status: "conflict", conflictReason: "La nota cambió." },
  ]), { status: "conflict", nextAttemptAt: null, reason: "La nota cambió." });
  assert.equal(classifySyncPushResult(["a", "b"], [{ id: "a", status: "applied" }]).status, "error");
  assert.equal(classifySyncPushResult(["a"], [{ id: "other", status: "applied" }]).status, "error");
});

test("the queue retains conflicts and partitions outbox, read models and cursors", async () => {
  const queue = await source("src/core/offline/mutation-queue.ts");

  assert.match(queue, /status:\s*"conflict"/);
  assert.match(queue, /exactReplay:\s*false/);
  assert.match(queue, /response\.clone\(\)\.json\(\)/);
  assert.doesNotMatch(queue, /deleteMutation|\.delete\(mutation\.id\)/);
  assert.match(queue, /organizationId:\s*`organization-by-membership:/);
  assert.match(queue, /userSubject:\s*`membership-subject:/);
  assert.match(queue, /fieldIds\.includes\(partition\.fieldId\)/);
  assert.match(queue, /mutation\|\$\{offlinePartitionKey\(partition\)\}/);
  assert.match(queue, /read-model\|\$\{offlinePartitionKey\(partition\)\}/);
  assert.match(queue, /cursor\|\$\{offlinePartitionKey\(partition\)\}/);
  assert.match(queue, /credentials:\s*"same-origin"/);
  assert.match(queue, /"Idempotency-Key": syncing\.mutationId/);
  assert.match(queue, /V1 records are deliberately quarantined/);
});

test("the service worker cannot replay mutations with the active cookie", async () => {
  const worker = await source("public/sw.js");
  assert.doesNotMatch(worker, /fetch\(mutation\.url/);
  assert.doesNotMatch(worker, /response\.status === 409/);
  assert.doesNotMatch(worker, /objectStore\([^)]*\)\.delete/);
  assert.match(worker, /fundosmart:offline-sync-request/);

  const listeners = new Map();
  const messages = [];
  const context = {
    URL,
    caches: { async delete() {}, async keys() { return []; }, async open() { return { async addAll() {} }; } },
    self: {
      clients: {
        async claim() {},
        async matchAll() { return [{ postMessage(message) { messages.push(message); } }]; },
      },
      location: { origin: "https://fundosmart.com" },
      addEventListener(type, listener) { listeners.set(type, listener); },
      async skipWaiting() {},
    },
  };
  vm.runInNewContext(worker, context);
  let work;
  listeners.get("sync")({ tag: "fundosmart-mutations", waitUntil(value) { work = value; } });
  await work;
  assert.equal(JSON.stringify(messages), JSON.stringify([{ type: "fundosmart:offline-sync-request" }]));
});

test("terrain capture uses the signed direct partition and all four Phase 2 entities", async () => {
  const [terrain, queue, sessionRoute, attachmentRoute, attachmentRepository] = await Promise.all([
    source("src/modules/ganado/components/TerrenoSection.tsx"),
    source("src/core/offline/mutation-queue.ts"),
    source("app/api/offline/session/route.ts"),
    source("app/api/offline/attachments/route.ts"),
    source("src/modules/offline/server/offline-attachment-repository.ts"),
  ]);

  assert.match(terrain, /offlinePartitionFromSession\(activeSession, input\.fieldId\)/u);
  assert.match(terrain, /refreshOfflineSession\(offlineScope\)/u);
  for (const entity of ["livestock_weighing", "livestock_health", "livestock_estrus", "livestock_movement"]) {
    assert.match(terrain, new RegExp(`entity: "${entity}"`, "u"));
  }
  assert.match(terrain, /resolveOfflineConflict/u);
  assert.match(terrain, /queueOfflineAttachment/u);
  assert.doesNotMatch(terrain, /cacheOfflineTileRegion|Descargar mapa cercano/u);
  assert.match(terrain, /capturas y fotos pendientes se conservan localmente/u);
  assert.match(queue, /SESSION_STORE = "sessions"/u);
  assert.match(queue, /ATTACHMENT_STORE = "attachments"/u);
  assert.match(queue, /partition\.organizationId === session\.organizationId/u);
  assert.match(queue, /partition\.userSubject === session\.userSubject/u);
  assert.match(sessionRoute, /authorizeApiAccess\("operate"\)/u);
  assert.match(sessionRoute, /OFFLINE_SESSION_SECRET/u);
  assert.doesNotMatch(sessionRoute, /token.*email|email.*token/iu);
  assert.match(attachmentRoute, /authorizeApiAccess\("operate", fieldId\)/u);
  assert.match(attachmentRoute, /preserveOfflineAttachment/u);
  assert.match(attachmentRepository, /input\.bucket\.put/u);
  assert.match(attachmentRepository, /etagDoesNotMatch: "\*"/u);
});
