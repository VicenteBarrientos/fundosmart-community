import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createOfflineOutbox,
  OfflineNetworkError,
  offlineOutboxStorageKey,
} from "../src/modules/potreros/sync/offline-outbox.ts";

const pageSource = await readFile(
  new URL("../src/modules/potreros/PotrerosPage.tsx", import.meta.url),
  "utf8",
);

const POTRERO = {
  id: "potrero-offline-integration",
  fieldId: "field-a",
  name: "Potrero offline",
  sector: "Norte",
  areaHectares: 1,
  coordinates: [[-40, -73], [-40, -72.9], [-40.1, -73]],
  soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
  lastActivity: "Creado ahora",
  status: "Disponible",
  updatedAt: "2026-07-20T12:00:00.000Z",
};

const ACTIVITY = {
  id: "activity-offline-integration",
  potreroId: POTRERO.id,
  type: "maintenance",
  occurredAt: "2026-07-20",
  description: "Manejo offline",
  quantity: null,
  unit: null,
  costClp: null,
  createdAt: "2026-07-20T12:00:00.000Z",
  updatedAt: "2026-07-20T12:00:00.000Z",
};

test("PotrerosPage drains one scope outbox and treats the server snapshot as absolute truth", () => {
  const paddockSync = section("const synchronize = useCallback", "const synchronizeActivities = useCallback");
  const activitySync = section("const synchronizeActivities = useCallback", "const saveSubdivisionDraftNow = useCallback");

  assert.match(pageSource, /offlineOutboxStorageKey\(offlineScope\)/);
  assert.match(pageSource, /new Map<string, ReturnType<typeof createOfflineOutbox>>\(\)/);
  assert.match(pageSource, /createOfflineOutbox\(window\.localStorage, outboxStorageKey\)/);
  assert.match(pageSource, /outboxesRef\.current\.get\(outboxStorageKey\)/);
  assert.match(pageSource, /activeOfflineScopeRef\.current !== requestedScope/);
  assert.match(paddockSync, /\.synchronize\(applyOfflineOutboxOperation, \(\) => fetchPotreros\(\)\)/);
  assert.match(paddockSync, /setPotreros\(remote\)/);
  assert.doesNotMatch(paddockSync, /localOnly|remoteIds|migrated|merged|persistPotrero/);
  assert.match(activitySync, /\.synchronize\(applyOfflineOutboxOperation, \(\) => fetchActivities\(\)\)/);
  assert.match(activitySync, /setActivities\(remote\)/);
  assert.doesNotMatch(activitySync, /localOnly|remoteIds|migrated|merged|persistActivity/);
  assert.match(pageSource, /applyPotreroOutboxOperation\(operation\)/);
  assert.match(pageSource, /applyActivityOutboxOperation\(operation\)/);
});

test("every paddock and activity CRUD operation uses executeOrQueue and keeps queued state locally", () => {
  assert.equal(pageSource.match(/getOfflineOutbox\(\)\.executeOrQueue\(/g)?.length, 6);

  const createPotrero = section("async function savePotrero", "async function saveActivity");
  const createActivity = section("async function saveActivity", "async function updateActivity");
  const updateActivity = section("async function updateActivity", "async function deleteManagedActivity");
  const deleteActivity = section("async function deleteManagedActivity", "async function refreshPotrerosAfterActivity");
  const refreshAfterActivity = section("async function refreshPotrerosAfterActivity", "async function updatePotrero");
  const updatePotrero = section("async function updatePotrero", "async function deleteSelectedPotrero");
  const deletePotrero = section("async function deleteSelectedPotrero", "async function updateFundo");

  assertMutation(createPotrero, "create", "potrero");
  assertMutation(createActivity, "create", "activity");
  assertMutation(updateActivity, "update", "activity");
  assertMutation(deleteActivity, "delete", "activity");
  assertMutation(updatePotrero, "update", "potrero");
  assertMutation(deletePotrero, "delete", "potrero");

  assert.ok(createPotrero.indexOf("setPotreros((current) => [created, ...current])") < createPotrero.indexOf("executeOrQueue"));
  assert.ok(createActivity.indexOf("setActivities((current) => [created, ...current])") < createActivity.indexOf("executeOrQueue"));
  assert.match(createPotrero, /result\.status === "applied"[\s\S]+?result\.value/);
  assert.match(createActivity, /result\.status === "applied"[\s\S]+?result\.value/);
  assert.match(updateActivity, /result\.status === "applied" \? result\.value : activity/);
  assert.match(updatePotrero, /result\.status === "applied" \? result\.value : potrero/);
  assertRefreshIsBestEffort(createActivity);
  assertRefreshIsBestEffort(updateActivity);
  assertRefreshIsBestEffort(deleteActivity);
  assert.match(createActivity, /setSyncError\(syncFailureMessage\(error\)\);\s+throw error;/);
  assert.match(refreshAfterActivity, /await synchronize\(\)/);
  assert.doesNotMatch(refreshAfterActivity, /fetchPotreros\(\)/);
  for (const mutation of [createPotrero, createActivity, updateActivity, deleteActivity, updatePotrero, deletePotrero]) {
    assert.match(mutation, /set[A-Za-z]+SyncState\([^\n]*"offline"/);
    assert.match(mutation, /setSyncError\(syncFailureMessage\(error\)\)/);
  }
});

test("an offline create replays exactly once before the authoritative remote fetch", async () => {
  const outbox = createOfflineOutbox(new MemoryStorage(), "integration-outbox");
  const result = await outbox.executeOrQueue(
    operation("create", "potrero", POTRERO),
    async () => {
      throw new OfflineNetworkError("network unavailable");
    },
  );
  assert.deepEqual(result, { status: "queued" });

  let releaseReplay;
  const replayGate = new Promise((resolve) => {
    releaseReplay = resolve;
  });
  let replayCount = 0;
  let fetchCount = 0;
  const replay = async () => {
    replayCount += 1;
    await replayGate;
  };
  const fetchRemote = async () => {
    fetchCount += 1;
    assert.deepEqual(outbox.list(), []);
    return [];
  };

  const first = outbox.synchronize(replay, fetchRemote);
  const concurrent = outbox.synchronize(replay, fetchRemote);
  await Promise.resolve();
  releaseReplay();
  assert.deepEqual(await Promise.all([first, concurrent]), [[], []]);
  assert.equal(replayCount, 1);
  assert.equal(fetchCount, 2);

  await outbox.synchronize(replay, fetchRemote);
  assert.equal(replayCount, 1);
  assert.equal(fetchCount, 3);
});

test("updates and deletes replay in order, while 4xx and replay failures are never discarded", async () => {
  const outbox = createOfflineOutbox(new MemoryStorage(), "integration-outbox");
  await outbox.executeOrQueue(operation("update", "potrero", POTRERO), rejectOffline);
  await outbox.executeOrQueue(
    operation("delete", "activity", { id: ACTIVITY.id, updatedAt: ACTIVITY.updatedAt }),
    rejectOffline,
  );

  await assert.rejects(
    outbox.executeOrQueue(operation("update", "activity", ACTIVITY), async () => {
      throw new Error("409 conflict");
    }),
    /409 conflict/,
  );
  assert.deepEqual(outbox.list().map(({ entity, op }) => `${entity}:${op}`), [
    "potrero:update",
    "activity:delete",
  ]);

  await assert.rejects(outbox.drain(async () => {
    throw new Error("replay conflict");
  }), /replay conflict/);
  assert.deepEqual(outbox.list().map(({ entity, op }) => `${entity}:${op}`), [
    "potrero:update",
    "activity:delete",
  ]);

  const replayed = [];
  await outbox.drain(async ({ entity, op }) => replayed.push(`${entity}:${op}`));
  assert.deepEqual(replayed, ["potrero:update", "activity:delete"]);
  assert.deepEqual(outbox.list(), []);
});

test("remote deletion cannot resurrect from cache and scope changes cannot mix queues", async () => {
  const storage = new MemoryStorage();
  const first = createOfflineOutbox(storage, offlineOutboxStorageKey("membership-a:field-a"));
  const second = createOfflineOutbox(storage, offlineOutboxStorageKey("membership-b:field-a"));
  first.enqueue(operation("create", "potrero", POTRERO));

  assert.equal(first.list().length, 1);
  assert.deepEqual(second.list(), []);

  const cachedSnapshot = [POTRERO];
  const remoteSnapshot = await second.synchronize(
    async () => assert.fail("another scope must not replay the first scope queue"),
    async () => [],
  );
  assert.equal(cachedSnapshot.length, 1);
  assert.deepEqual(remoteSnapshot, []);
  assert.equal(first.list().length, 1);
  assert.deepEqual(second.list(), []);
});

function assertMutation(source, op, entity) {
  assert.match(source, new RegExp(`op: "${op}"[\\s\\S]+?entity: "${entity}"`));
  assert.match(source, /queuedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /executeOrQueue\([\s\S]+?\}, \(\) =>/);
}

function assertRefreshIsBestEffort(source) {
  const catchIndex = source.indexOf("} catch (error)");
  const refreshIndex = source.lastIndexOf("await refreshPotrerosAfterActivity()");
  assert.notEqual(catchIndex, -1);
  assert.ok(refreshIndex > catchIndex, "derived paddock refresh must run outside the mutation failure boundary");
}

function operation(op, entity, payload) {
  return { op, entity, payload, queuedAt: "2026-07-20T12:05:00.000Z" };
}

async function rejectOffline() {
  throw new OfflineNetworkError("network unavailable");
}

function section(start, end) {
  const startIndex = pageSource.indexOf(start);
  const endIndex = pageSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return pageSource.slice(startIndex, endIndex);
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  setItem(key, value) {
    this.#values.set(key, value);
  }
}
