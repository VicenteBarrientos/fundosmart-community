import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfflineOutbox,
  OfflineNetworkError,
  offlineOutboxStorageKey,
} from "../src/modules/potreros/sync/offline-outbox.ts";

const POTRERO = {
  id: "potrero-offline-1",
  fieldId: "field-a",
  name: "Offline",
  sector: "Norte",
  areaHectares: 1,
  coordinates: [[-40, -73], [-40, -72.9], [-40.1, -73]],
  soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
  lastActivity: "Creado · ahora",
  status: "Disponible",
};

const ACTIVITY = {
  id: "activity-offline-1",
  potreroId: POTRERO.id,
  type: "maintenance",
  occurredAt: "2026-07-20",
  description: "Creada sin conexión",
  quantity: null,
  unit: null,
  costClp: null,
  createdAt: "2026-07-20T12:00:00.000Z",
};

test("only transport failures enter the tenant-scoped outbox", async () => {
  const storage = new MemoryStorage();
  const key = offlineOutboxStorageKey("membership-a:operator:field-a");
  const outbox = createOfflineOutbox(storage, key);
  const operation = {
    op: "create",
    entity: "potrero",
    payload: POTRERO,
    queuedAt: "2026-07-20T12:00:00.000Z",
  };
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new TypeError("network unavailable");
    };
    const queued = await outbox.executeOrQueue(operation, async () => {
      try {
        return await fetch("https://example.invalid/api/potreros");
      } catch (cause) {
        throw new OfflineNetworkError("No fue posible guardar el potrero.", cause);
      }
    });
    assert.deepEqual(queued, { status: "queued" });
    assert.deepEqual(outbox.list(), [operation]);

    globalThis.fetch = async () => Response.json({ error: "conflict" }, { status: 409 });
    await assert.rejects(
      outbox.executeOrQueue(
        { ...operation, op: "update", queuedAt: "2026-07-20T12:01:00.000Z" },
        async () => {
          const response = await fetch("https://example.invalid/api/potreros");
          if (!response.ok) throw new Error("conflict");
        },
      ),
      /conflict/,
    );
    assert.deepEqual(outbox.list(), [operation]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.notEqual(key, offlineOutboxStorageKey("membership-b:operator:field-a"));
});

test("contiguous local mutations compact without changing cross-entity order", () => {
  const storage = new MemoryStorage();
  const outbox = createOfflineOutbox(storage, "outbox");
  outbox.enqueue({
    op: "create",
    entity: "potrero",
    payload: POTRERO,
    queuedAt: "2026-07-20T12:00:00.000Z",
  });
  outbox.enqueue({
    op: "update",
    entity: "potrero",
    payload: { ...POTRERO, name: "Offline actualizado" },
    queuedAt: "2026-07-20T12:01:00.000Z",
  });
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0].op, "create");
  assert.equal(outbox.list()[0].payload.name, "Offline actualizado");
  assert.equal(outbox.list()[0].queuedAt, "2026-07-20T12:00:00.000Z");

  outbox.enqueue({
    op: "create",
    entity: "activity",
    payload: ACTIVITY,
    queuedAt: "2026-07-20T12:02:00.000Z",
  });
  outbox.enqueue({
    op: "delete",
    entity: "potrero",
    payload: { id: POTRERO.id, updatedAt: "local-version" },
    queuedAt: "2026-07-20T12:03:00.000Z",
  });
  assert.deepEqual(outbox.list().map(({ entity, op }) => `${entity}:${op}`), [
    "potrero:create",
    "activity:create",
    "potrero:delete",
  ]);

  const transient = createOfflineOutbox(new MemoryStorage(), "transient");
  transient.enqueue({
    op: "create",
    entity: "potrero",
    payload: POTRERO,
    queuedAt: "2026-07-20T12:00:00.000Z",
  });
  transient.enqueue({
    op: "delete",
    entity: "potrero",
    payload: { id: POTRERO.id, updatedAt: "local-version" },
    queuedAt: "2026-07-20T12:01:00.000Z",
  });
  assert.deepEqual(transient.list(), []);
});

test("reconnection drains in order and then returns the server snapshot without a local merge", async () => {
  const storage = new MemoryStorage();
  const outbox = createOfflineOutbox(storage, "outbox");
  outbox.enqueue({
    op: "create",
    entity: "potrero",
    payload: POTRERO,
    queuedAt: "2026-07-20T12:00:00.000Z",
  });
  outbox.enqueue({
    op: "create",
    entity: "activity",
    payload: ACTIVITY,
    queuedAt: "2026-07-20T12:01:00.000Z",
  });

  const events = [];
  const remote = [{ ...POTRERO, id: "server-potrero", name: "Servidor" }];
  const result = await outbox.synchronize(
    async ({ entity, op }) => events.push(`${entity}:${op}`),
    async () => {
      events.push("remote");
      assert.deepEqual(outbox.list(), []);
      return remote;
    },
  );

  assert.deepEqual(events, ["potrero:create", "activity:create", "remote"]);
  assert.strictEqual(result, remote);
  assert.deepEqual(outbox.list(), []);
});

test("a failed replay remains at the head and blocks later operations", async () => {
  const outbox = createOfflineOutbox(new MemoryStorage(), "outbox");
  outbox.enqueue({
    op: "create",
    entity: "potrero",
    payload: POTRERO,
    queuedAt: "2026-07-20T12:00:00.000Z",
  });
  outbox.enqueue({
    op: "create",
    entity: "activity",
    payload: ACTIVITY,
    queuedAt: "2026-07-20T12:01:00.000Z",
  });

  const attempts = [];
  await assert.rejects(
    outbox.drain(async (operation) => {
      attempts.push(operation.payload.id);
      throw new Error("server conflict");
    }),
    /server conflict/,
  );
  assert.deepEqual(attempts, [POTRERO.id]);
  assert.deepEqual(outbox.list().map(({ payload }) => payload.id), [POTRERO.id, ACTIVITY.id]);
});

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
