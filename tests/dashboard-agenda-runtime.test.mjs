import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const ownerA = {
  membershipId: "agenda-owner-a",
  organizationId: "agenda-org-a",
  email: "owner-a@example.com",
  displayName: "Owner A",
  role: "owner",
  fieldIds: ["agenda-field-a1", "agenda-field-a2"],
};
const operatorA1 = {
  membershipId: "agenda-operator-a1",
  organizationId: "agenda-org-a",
  email: "operator-a1@example.com",
  displayName: "Operador A1",
  role: "operator",
  fieldIds: ["agenda-field-a1"],
};
const managerA = {
  membershipId: "agenda-manager-a",
  organizationId: "agenda-org-a",
  email: "manager-a@example.com",
  displayName: "Manager A",
  role: "manager",
  fieldIds: ["agenda-field-a1", "agenda-field-a2"],
};
const ownerB = {
  membershipId: "agenda-owner-b",
  organizationId: "agenda-org-b",
  email: "owner-b@example.com",
  displayName: "Owner B",
  role: "owner",
  fieldIds: ["agenda-field-b1"],
};
const baseTime = new Date("2026-07-27T16:00:00.000Z");

let sqlite;
let d1;
let vite;
let repository;
let http;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle")))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
    .sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.exec(`
    INSERT INTO organizations (id, name, kind, plan_code) VALUES
      ('agenda-org-a', 'Organización A', 'shared', 'legacy'),
      ('agenda-org-b', 'Organización B', 'shared', 'legacy');
    INSERT INTO fields (
      id, organization_id, name, location, is_demo, area_hectares, coordinates
    ) VALUES
      ('agenda-field-a1', 'agenda-org-a', 'Campo A1', 'Osorno', 0, 10, '[]'),
      ('agenda-field-a2', 'agenda-org-a', 'Campo A2', 'Osorno', 0, 12, '[]'),
      ('agenda-field-b1', 'agenda-org-b', 'Campo B1', 'Puerto Montt', 0, 9, '[]');
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by
    ) VALUES
      ('agenda-owner-a', 'agenda-org-a', 'owner-a@example.com', 'owner-a@example.com', 'Owner A', 'owner', 'active', 'test'),
      ('agenda-manager-a', 'agenda-org-a', 'manager-a@example.com', 'manager-a@example.com', 'Manager A', 'manager', 'active', 'test'),
      ('agenda-operator-a1', 'agenda-org-a', 'operator-a1@example.com', 'operator-a1@example.com', 'Operador A1', 'operator', 'active', 'test'),
      ('agenda-operator-a2', 'agenda-org-a', 'operator-a2@example.com', 'operator-a2@example.com', 'Operador A2', 'operator', 'active', 'test'),
      ('agenda-viewer-a1', 'agenda-org-a', 'viewer-a1@example.com', 'viewer-a1@example.com', 'Viewer A1', 'viewer', 'active', 'test'),
      ('agenda-owner-b', 'agenda-org-b', 'owner-b@example.com', 'owner-b@example.com', 'Owner B', 'owner', 'active', 'test');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by) VALUES
      ('agenda-access-a1', 'agenda-operator-a1', 'agenda-field-a1', 'test'),
      ('agenda-access-manager-a1', 'agenda-manager-a', 'agenda-field-a1', 'test'),
      ('agenda-access-manager-a2', 'agenda-manager-a', 'agenda-field-a2', 'test'),
      ('agenda-access-a2', 'agenda-operator-a2', 'agenda-field-a2', 'test'),
      ('agenda-access-viewer-a1', 'agenda-viewer-a1', 'agenda-field-a1', 'test');
  `);

  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_AGENDA_TEST_ENV__ = { DB: d1 };
  const virtualWorkers = "\0fundosmart-agenda-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-agenda-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_AGENDA_TEST_ENV__";
        }
      },
    }],
  });
  [repository, http] = await Promise.all([
    vite.ssrLoadModule("/src/modules/dashboard/agenda-repository.ts"),
    vite.ssrLoadModule("/src/modules/dashboard/agenda-http.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_AGENDA_TEST_ENV__;
});

test("lists only states and eligible assignees inside the actor field scope", async () => {
  await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: mutation(1, { fieldId: "agenda-field-a1" }),
    now: baseTime,
    idFactory: uuidFactory(100),
  });
  await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: mutation(2, { fieldId: "agenda-field-a2", itemKey: "ganado:weighing:cow-a2" }),
    now: new Date(baseTime.getTime() + 1_000),
    idFactory: uuidFactory(200),
  });

  const scoped = await repository.listAgendaManagement(operatorA1);
  assert.deepEqual(scoped.states.map((state) => state.fieldId), ["agenda-field-a1"]);
  assert.deepEqual(
    scoped.assignees.map((entry) => entry.id),
    ["agenda-manager-a", "agenda-operator-a1", "agenda-owner-a"],
  );
  assert.equal(scoped.assignees.some((entry) => entry.id === "agenda-viewer-a1"), false);
  assert.equal(scoped.assignees.some((entry) => entry.id === "agenda-operator-a2"), false);
});

test("persists an auditable action once and replays the same operation idempotently", async () => {
  const input = mutation(10, {
    itemKey: "ganado:weighing:cow-idempotent",
    reason: "Pesaje confirmado en terreno",
  });
  const first = await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: input,
    now: new Date(baseTime.getTime() + 10_000),
    idFactory: uuidFactory(300),
  });
  const replay = await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: input,
    now: new Date(baseTime.getTime() + 20_000),
    idFactory: uuidFactory(400),
  });

  assert.equal(first.replay, false);
  assert.equal(first.state.status, "completed");
  assert.equal(replay.replay, true);
  assert.equal(replay.state.id, first.state.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_operations WHERE id = ?").get(input.operationId).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_events WHERE operation_id = ?").get(input.operationId).count, 1);

  await assert.rejects(
    repository.mutateAgendaTask({
      actor: ownerA,
      mutation: { ...input, reason: "Contenido diferente" },
    }),
    (error) => error.code === "AGENDA_IDEMPOTENCY_COLLISION" && error.status === 409,
  );
});

test("versions assignment and reopening while preserving lifecycle semantics", async () => {
  const itemKey = "ganado:weighing:cow-lifecycle";
  const completed = await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: mutation(20, { itemKey }),
    now: new Date(baseTime.getTime() + 30_000),
    idFactory: uuidFactory(500),
  });
  const assigned = await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: mutation(21, {
      action: "assign",
      itemKey,
      expectedVersion: completed.state.version,
      reason: null,
      assigneeMembershipId: "agenda-operator-a1",
    }),
    now: new Date(baseTime.getTime() + 31_000),
    idFactory: uuidFactory(600),
  });
  const reopened = await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: mutation(22, {
      action: "reopen",
      itemKey,
      expectedVersion: assigned.state.version,
      reason: null,
    }),
    now: new Date(baseTime.getTime() + 32_000),
    idFactory: uuidFactory(700),
  });

  assert.equal(assigned.state.status, "completed");
  assert.equal(assigned.state.assigneeName, "Operador A1");
  assert.equal(assigned.state.resolutionReason, "Trabajo confirmado");
  assert.equal(reopened.state.status, "open");
  assert.equal(reopened.state.assigneeMembershipId, "agenda-operator-a1");
  assert.equal(reopened.state.resolutionReason, null);
  assert.equal(reopened.state.version, 3);
});

test("rejects stale versions, cross-field assignees and cross-tenant writes", async () => {
  const itemKey = "ganado:weighing:cow-conflict";
  const created = await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: mutation(30, { itemKey }),
    now: new Date(baseTime.getTime() + 40_000),
    idFactory: uuidFactory(800),
  });

  await assert.rejects(
    repository.mutateAgendaTask({
      actor: ownerA,
      mutation: mutation(31, {
        action: "reopen",
        itemKey,
        expectedVersion: created.state.version + 1,
        reason: null,
      }),
    }),
    (error) => error.code === "AGENDA_VERSION_CONFLICT",
  );
  await assert.rejects(
    repository.mutateAgendaTask({
      actor: ownerA,
      mutation: mutation(32, {
        action: "assign",
        itemKey,
        expectedVersion: created.state.version,
        reason: null,
        assigneeMembershipId: "agenda-operator-a2",
      }),
    }),
    (error) => error.code === "AGENDA_ASSIGNEE_UNAVAILABLE",
  );
  await assert.rejects(
    repository.mutateAgendaTask({
      actor: ownerB,
      mutation: mutation(33, { fieldId: "agenda-field-a1", itemKey }),
    }),
    (error) => error.code === "AGENDA_FIELD_NOT_FOUND",
  );
});

test("revalidates current write access inside the atomic batch", async () => {
  sqlite.prepare("UPDATE organization_memberships SET status = 'suspended' WHERE id = 'agenda-operator-a1'").run();
  try {
    await assert.rejects(
      repository.mutateAgendaTask({
        actor: operatorA1,
        mutation: mutation(40, { itemKey: "ganado:weighing:cow-revoked" }),
        now: new Date(baseTime.getTime() + 50_000),
        idFactory: uuidFactory(900),
      }),
      (error) => error.code === "AGENDA_ACCESS_CHANGED",
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key = 'ganado:weighing:cow-revoked'").get().count,
      0,
    );
  } finally {
    sqlite.prepare("UPDATE organization_memberships SET status = 'active' WHERE id = 'agenda-operator-a1'").run();
  }
});

test("commits one multi-field batch and preserves chained state order", async () => {
  const itemA1 = "ganado:weighing:batch-atomic-a1";
  const itemA2 = "ganado:weighing:batch-atomic-a2";
  const chainItem = "ganado:weighing:batch-chain";
  const inputs = [
    mutation(1000, { fieldId: "agenda-field-a1", itemKey: itemA1 }),
    mutation(1001, { fieldId: "agenda-field-a2", itemKey: itemA2 }),
    mutation(1002, { fieldId: "agenda-field-a1", itemKey: chainItem }),
    mutation(1003, {
      action: "assign",
      fieldId: "agenda-field-a1",
      itemKey: chainItem,
      expectedVersion: 1,
      reason: null,
      assigneeMembershipId: "agenda-operator-a1",
    }),
    mutation(1004, {
      action: "reopen",
      fieldId: "agenda-field-a1",
      itemKey: chainItem,
      expectedVersion: 2,
      reason: null,
    }),
    mutation(1005, {
      fieldId: "agenda-field-a1",
      itemKey: "ganado:weighing:batch-sentinel-a1",
    }),
    mutation(1006, {
      fieldId: "agenda-field-a2",
      itemKey: "ganado:weighing:batch-sentinel-a2",
    }),
  ];
  const batchCallsBefore = d1.batchCalls;
  const results = await repository.batchMutateAgendaTasks({
    actor: ownerA,
    mutations: inputs,
    now: new Date(baseTime.getTime() + 100_000),
    idFactory: uuidFactory(10_000),
  });

  assert.equal(d1.batchCalls, batchCallsBefore + 1);
  assert.deepEqual(
    results.map(({ replay }) => replay),
    [false, false, false, false, false, false, false],
  );
  assert.deepEqual(results.map(({ state }) => state.version), [1, 1, 1, 2, 3, 1, 1]);
  assert.equal(results[3].state.assigneeName, "Operador A1");
  assert.equal(results[4].state.status, "open");
  assert.ok(results[2].state.updatedAt < results[3].state.updatedAt);
  assert.ok(results[3].state.updatedAt < results[4].state.updatedAt);
  assert.deepEqual(
    d1.lastBatchBindingCounts.slice(-2),
    [96, 16],
    "seven writes must be split into two sentinels under D1's 100-binding limit",
  );

  const finalChain = sqlite.prepare(`
    SELECT status, assignee_membership_id AS assigneeMembershipId, version
    FROM agenda_task_states
    WHERE organization_id = ? AND field_id = ? AND item_key = ?
  `).get(ownerA.organizationId, "agenda-field-a1", chainItem);
  assert.deepEqual({ ...finalChain }, {
    status: "open",
    assigneeMembershipId: "agenda-operator-a1",
    version: 3,
  });
  assert.equal(countOperations(inputs.map(({ operationId }) => operationId)), 7);
  assert.equal(countEvents(inputs.map(({ operationId }) => operationId)), 7);
});

test("mixes persisted and intra-batch replays without duplicate audit", async () => {
  const persisted = mutation(1100, {
    itemKey: "ganado:weighing:batch-persisted-replay",
  });
  await repository.mutateAgendaTask({
    actor: ownerA,
    mutation: persisted,
    now: new Date(baseTime.getTime() + 110_000),
    idFactory: uuidFactory(11_000),
  });
  const planned = mutation(1101, {
    itemKey: "ganado:weighing:batch-planned-replay",
  });
  const later = mutation(1102, {
    fieldId: "agenda-field-a2",
    itemKey: "ganado:weighing:batch-later-new",
  });

  const batchCallsBefore = d1.batchCalls;
  const results = await repository.batchMutateAgendaTasks({
    actor: ownerA,
    mutations: [persisted, planned, { ...planned }, later],
    now: new Date(baseTime.getTime() + 111_000),
    idFactory: uuidFactory(11_100),
  });
  assert.equal(d1.batchCalls, batchCallsBefore + 1);
  assert.deepEqual(results.map(({ replay }) => replay), [true, false, true, false]);
  assert.deepEqual(results[2].state, results[1].state);
  assert.equal(countOperations([
    persisted.operationId,
    planned.operationId,
    later.operationId,
  ]), 3);
  assert.equal(countEvents([
    persisted.operationId,
    planned.operationId,
    later.operationId,
  ]), 3);

  const replayOnlyBatchCalls = d1.batchCalls;
  const replayOnly = await repository.batchMutateAgendaTasks({
    actor: ownerA,
    mutations: [persisted, persisted],
  });
  assert.equal(d1.batchCalls, replayOnlyBatchCalls);
  assert.deepEqual(replayOnly.map(({ replay }) => replay), [true, true]);
});

test("replans a concurrent replay without reallocating later write IDs", async () => {
  const concurrent = mutation(1150, {
    itemKey: "ganado:weighing:batch-concurrent-replay",
  });
  const later = mutation(1151, {
    fieldId: "agenda-field-a2",
    itemKey: "ganado:weighing:batch-concurrent-later",
  });
  let allocatedIdCount = 0;
  const stableFactory = () => {
    const value = uuid(11_500 + allocatedIdCount);
    allocatedIdCount += 1;
    return value;
  };

  d1.interceptNextBatch(async () => {
    const originalDatabase = globalThis.__FUNDOSMART_AGENDA_TEST_ENV__.DB;
    globalThis.__FUNDOSMART_AGENDA_TEST_ENV__.DB = new TestD1Database(sqlite);
    try {
      await repository.mutateAgendaTask({
        actor: ownerA,
        mutation: concurrent,
        now: new Date(baseTime.getTime() + 115_000),
        idFactory: uuidFactory(11_900),
      });
    } finally {
      globalThis.__FUNDOSMART_AGENDA_TEST_ENV__.DB = originalDatabase;
    }
  });

  const batchCallsBefore = d1.batchCalls;
  const results = await repository.batchMutateAgendaTasks({
    actor: ownerA,
    mutations: [concurrent, later],
    now: new Date(baseTime.getTime() + 115_000),
    idFactory: stableFactory,
  });

  assert.equal(d1.batchCalls, batchCallsBefore + 2);
  assert.deepEqual(results.map(({ replay }) => replay), [true, false]);
  assert.equal(
    results[1].state.id,
    `agenda-state-${uuid(11_502)}`,
    "the retry must reuse the ID allocated to the later state during the first plan",
  );
  assert.equal(
    sqlite.prepare("SELECT id FROM agenda_task_events WHERE operation_id = ?")
      .get(later.operationId).id,
    `agenda-event-${uuid(11_503)}`,
    "the retry must reuse the event ID allocated during the first plan",
  );
  assert.equal(allocatedIdCount, 4, "a retry must not consume fresh state or event IDs");
  assert.equal(countOperations([concurrent.operationId, later.operationId]), 2);
  assert.equal(countEvents([concurrent.operationId, later.operationId]), 2);
});

test("rejects an intra-batch idempotency collision before any write", async () => {
  const first = mutation(1200, {
    itemKey: "ganado:weighing:batch-idempotency-collision",
  });
  const batchCallsBefore = d1.batchCalls;
  await assert.rejects(
    repository.batchMutateAgendaTasks({
      actor: ownerA,
      mutations: [
        first,
        { ...first, reason: "Contenido diferente dentro del lote" },
      ],
      idFactory: uuidFactory(12_000),
    }),
    (error) => error.code === "AGENDA_IDEMPOTENCY_COLLISION",
  );
  assert.equal(d1.batchCalls, batchCallsBefore);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key = ?")
      .get(first.itemKey).count,
    0,
  );
  assert.equal(countOperations([first.operationId]), 0);
  assert.equal(countEvents([first.operationId]), 0);
});

test("rolls back the first field when a later field scope is revoked after planning", async () => {
  const first = mutation(1300, {
    fieldId: "agenda-field-a1",
    itemKey: "ganado:weighing:batch-revoked-a1",
  });
  const second = mutation(1301, {
    fieldId: "agenda-field-a2",
    itemKey: "ganado:weighing:batch-revoked-a2",
  });
  d1.interceptNextBatch(() => {
    sqlite.prepare(`
      DELETE FROM membership_field_access
      WHERE membership_id = 'agenda-manager-a' AND field_id = 'agenda-field-a2'
    `).run();
  });
  try {
    await assert.rejects(
      repository.batchMutateAgendaTasks({
        actor: managerA,
        mutations: [first, second],
        now: new Date(baseTime.getTime() + 130_000),
        idFactory: uuidFactory(13_000),
      }),
      (error) => error.code === "AGENDA_ACCESS_CHANGED",
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key IN (?, ?)")
        .get(first.itemKey, second.itemKey).count,
      0,
    );
    assert.equal(countOperations([first.operationId, second.operationId]), 0);
    assert.equal(countEvents([first.operationId, second.operationId]), 0);
  } finally {
    sqlite.prepare(`
      INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
      VALUES ('agenda-access-manager-a2', 'agenda-manager-a', 'agenda-field-a2', 'test')
    `).run();
  }
});

test("rolls back earlier writes when a later assignee is revoked after planning", async () => {
  const first = mutation(1350, {
    itemKey: "ganado:weighing:batch-assignee-first",
  });
  const second = mutation(1351, {
    action: "assign",
    itemKey: "ganado:weighing:batch-assignee-revoked",
    reason: null,
    assigneeMembershipId: "agenda-operator-a1",
  });
  d1.interceptNextBatch(() => {
    sqlite.prepare(`
      UPDATE organization_memberships
      SET status = 'suspended'
      WHERE id = 'agenda-operator-a1'
    `).run();
  });
  try {
    await assert.rejects(
      repository.batchMutateAgendaTasks({
        actor: ownerA,
        mutations: [first, second],
        now: new Date(baseTime.getTime() + 135_000),
        idFactory: uuidFactory(13_500),
      }),
      (error) => error.code === "AGENDA_ACCESS_CHANGED",
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key IN (?, ?)")
        .get(first.itemKey, second.itemKey).count,
      0,
    );
    assert.equal(countOperations([first.operationId, second.operationId]), 0);
    assert.equal(countEvents([first.operationId, second.operationId]), 0);
  } finally {
    sqlite.prepare(`
      UPDATE organization_memberships
      SET status = 'active'
      WHERE id = 'agenda-operator-a1'
    `).run();
  }
});

test("rolls back earlier writes when a later state wins a concurrent create", async () => {
  const first = mutation(1400, {
    itemKey: "ganado:weighing:batch-cas-first",
  });
  const second = mutation(1401, {
    itemKey: "ganado:weighing:batch-cas-second",
  });
  d1.interceptNextBatch(() => {
    sqlite.prepare(`
      INSERT INTO agenda_task_states (
        id, organization_id, field_id, item_key, signal_revision, source,
        status, assignee_membership_id, scheduled_for, resolution_reason,
        version, last_operation_id, created_by_membership_id,
        updated_by_membership_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, 1, ?, ?, ?, ?, ?)
    `).run(
      "agenda-state-concurrent-create",
      ownerA.organizationId,
      "agenda-field-a1",
      second.itemKey,
      second.signalRevision,
      second.source,
      uuid(1499),
      ownerA.membershipId,
      ownerA.membershipId,
      "2026-07-27T16:02:19.000Z",
      "2026-07-27T16:02:19.000Z",
    );
  });

  await assert.rejects(
    repository.batchMutateAgendaTasks({
      actor: ownerA,
      mutations: [first, second],
      now: new Date(baseTime.getTime() + 140_000),
      idFactory: uuidFactory(14_000),
    }),
    (error) => error.code === "AGENDA_VERSION_CONFLICT",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key = ?")
      .get(first.itemKey).count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key = ?")
      .get(second.itemKey).count,
    1,
  );
  assert.equal(countOperations([first.operationId, second.operationId]), 0);
  assert.equal(countEvents([first.operationId, second.operationId]), 0);
});

test("rolls back states and receipts when the final audit event fails", async () => {
  const first = mutation(1500, {
    itemKey: "ganado:weighing:batch-event-first",
  });
  const second = mutation(1501, {
    itemKey: "ganado:weighing:batch-event-second",
  });
  sqlite.exec(`
    CREATE TRIGGER agenda_test_fail_last_event
    BEFORE INSERT ON agenda_task_events
    FOR EACH ROW WHEN NEW.operation_id = '${second.operationId}'
    BEGIN
      SELECT RAISE(ABORT, 'AGENDA_TASK_EVENT_TEST_FAILURE');
    END;
  `);
  try {
    await assert.rejects(
      repository.batchMutateAgendaTasks({
        actor: ownerA,
        mutations: [first, second],
        now: new Date(baseTime.getTime() + 150_000),
        idFactory: uuidFactory(15_000),
      }),
      /AGENDA_TASK_EVENT_TEST_FAILURE/u,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM agenda_task_states WHERE item_key IN (?, ?)")
        .get(first.itemKey, second.itemKey).count,
      0,
    );
    assert.equal(countOperations([first.operationId, second.operationId]), 0);
    assert.equal(countEvents([first.operationId, second.operationId]), 0);
  } finally {
    sqlite.exec("DROP TRIGGER agenda_test_fail_last_event");
  }
});

test("database triggers keep identity and audit history immutable", () => {
  const stateId = sqlite.prepare(`
    SELECT id FROM agenda_task_states
    WHERE organization_id = 'agenda-org-a'
    ORDER BY created_at LIMIT 1
  `).get().id;
  assert.throws(
    () => sqlite.prepare(`
      UPDATE agenda_task_states
      SET item_key = 'ganado:tampered',
          version = version + 1,
          last_operation_id = '00000000-0000-4000-8000-000000999999',
          updated_at = '2027-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(stateId),
    /AGENDA_TASK_IDENTITY_IMMUTABLE/u,
  );
  assert.throws(
    () => sqlite.prepare("DELETE FROM agenda_task_events WHERE state_id = ?").run(stateId),
    /AGENDA_TASK_EVENT_APPEND_ONLY/u,
  );
  assert.throws(
    () => sqlite.prepare("DELETE FROM agenda_task_states WHERE id = ?").run(stateId),
    /AGENDA_TASK_STATE_APPEND_ONLY/u,
  );
});

test("HTTP helpers reject cross-site and oversized mutation bodies", async () => {
  const sameOrigin = new Request("https://fundosmart.test/api/agenda", {
    method: "POST",
    headers: { Origin: "https://fundosmart.test" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(http.isSameOriginAgendaMutation(sameOrigin), true);
  assert.deepEqual(await http.readAgendaJsonObject(sameOrigin), { ok: true });

  const crossSite = new Request("https://fundosmart.test/api/agenda", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(http.isSameOriginAgendaMutation(crossSite), false);

  const oversized = new Request("https://fundosmart.test/api/agenda", {
    method: "POST",
    headers: { Origin: "https://fundosmart.test" },
    body: JSON.stringify({ reason: "x".repeat(9_000) }),
  });
  const response = await http.readAgendaJsonObject(oversized);
  assert.ok(response instanceof Response);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

function countOperations(operationIds) {
  const placeholders = operationIds.map(() => "?").join(", ");
  return sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agenda_task_operations
    WHERE id IN (${placeholders})
  `).get(...operationIds).count;
}

function countEvents(operationIds) {
  const placeholders = operationIds.map(() => "?").join(", ");
  return sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agenda_task_events
    WHERE operation_id IN (${placeholders})
  `).get(...operationIds).count;
}

function mutation(index, overrides = {}) {
  return {
    action: "complete",
    operationId: uuid(index),
    fieldId: "agenda-field-a1",
    itemKey: "ganado:weighing:cow-default",
    signalRevision: "a".repeat(16),
    source: "ganado",
    expectedVersion: null,
    reason: "Trabajo confirmado",
    scheduledFor: null,
    assigneeMembershipId: null,
    ...overrides,
  };
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function uuidFactory(start) {
  let value = start;
  return () => uuid(value++);
}

class TestD1PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new TestD1PreparedStatement(this.database, this.sql, bindings);
  }

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings),
      success: true,
      meta: {},
    };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.batchTail = Promise.resolve();
    this.batchCalls = 0;
    this.beforeNextBatch = null;
    this.lastBatchBindingCounts = [];
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  interceptNextBatch(callback) {
    assert.equal(this.beforeNextBatch, null, "a batch interceptor is already pending");
    this.beforeNextBatch = callback;
  }

  async batch(statements) {
    const execute = async () => {
      const beforeBatch = this.beforeNextBatch;
      this.beforeNextBatch = null;
      await beforeBatch?.();
      this.lastBatchBindingCounts = statements.map((statement) => statement.bindings.length);
      for (const bindingCount of this.lastBatchBindingCounts) {
        assert.ok(
          bindingCount <= 100,
          `D1 statements cannot exceed 100 bound parameters (received ${bindingCount})`,
        );
      }
      this.batchCalls += 1;
      this.database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/iu.test(statement.sql)
            ? await statement.all()
            : await statement.run());
        }
        this.database.exec("COMMIT");
        return results;
      } catch (cause) {
        this.database.exec("ROLLBACK");
        throw cause;
      }
    };
    const pending = this.batchTail.then(execute, execute);
    this.batchTail = pending.catch(() => undefined);
    return pending;
  }
}
