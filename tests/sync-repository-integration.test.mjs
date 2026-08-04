import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { buildPaddockGeometryVersion } from "../src/modules/potreros/sync/geographic-sync-rules.mjs";

const root = process.cwd();
const actor = {
  membershipId: "operator-a",
  organizationId: "org-a",
  email: "operator-a@example.com",
  displayName: "Operator A",
  role: "operator",
  fieldIds: ["field-a"],
};

let sqlite;
let d1;
let vite;
let syncRepository;
let geographicProjection;
let featureRepository;
let jobDispatcher;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.exec(`
    INSERT OR IGNORE INTO organizations (id, name) VALUES ('org-a', 'A'), ('org-b', 'B');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('field-a', 'org-a', 'A', 'Osorno', 0, 1, '[]'),
      ('field-b', 'org-b', 'B', 'Osorno', 0, 1, '[]');
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('operator-a', 'org-a', 'operator-a@example.com', 'operator-a@example.com', 'Operator A', 'operator', 'active', 'fixture');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('scope-operator-a-field-a', 'operator-a', 'field-a', 'fixture');
    INSERT INTO livestock_lots
      (id, field_id, name, category, animal_count, entry_date, status, tracking_mode)
    VALUES
      ('lot-a', 'field-a', 'Vacas A', 'dairy_cow', 2, '2026-01-01', 'active', 'individual'),
      ('lot-b', 'field-b', 'Vacas B', 'dairy_cow', 1, '2026-01-01', 'active', 'individual');
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status) VALUES
      ('cow-a1', 'lot-a', 'A-1', 'female', 'active'),
      ('cow-a2', 'lot-a', 'A-2', 'female', 'active'),
      ('cow-b1', 'lot-b', 'B-1', 'female', 'active');
    INSERT INTO potreros
      (id, field_id, name, sector, area_hectares, coordinates, hole_kinds, last_activity, status, updated_at)
    VALUES
      ('paddock-a1', 'field-a', 'A 1', 'Norte', 1, '{"outer":[[-40.6,-73.2],[-40.6,-73.19],[-40.59,-73.19]],"holes":[]}', '[]', 'Sin actividad', 'Disponible', '2026-07-21T10:00:00.000Z'),
      ('paddock-a2', 'field-a', 'A 2', 'Sur', 1, '{"outer":[[-40.61,-73.2],[-40.61,-73.19],[-40.6,-73.19]],"holes":[]}', '[]', 'Sin actividad', 'Disponible', '2026-07-21T10:00:00.000Z'),
      ('paddock-b1', 'field-b', 'B 1', 'Norte', 1, '{"outer":[[-40.7,-73.3],[-40.7,-73.29],[-40.69,-73.29]],"holes":[]}', '[]', 'Sin actividad', 'Disponible', '2026-07-21T10:00:00.000Z');
  `);
  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_SYNC_TEST_ENV__ = { DB: d1 };
  const virtualWorkers = "\0fundosmart-sync-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-sync-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_SYNC_TEST_ENV__";
      },
    }],
  });
  [syncRepository, geographicProjection, featureRepository, jobDispatcher] = await Promise.all([
    vite.ssrLoadModule("/src/modules/sync/server/sync-repository.ts"),
    vite.ssrLoadModule("/src/modules/potreros/server/geographic-sync-projection.ts"),
    vite.ssrLoadModule("/src/modules/access/server/feature-flag-repository.ts"),
    vite.ssrLoadModule("/src/modules/sync/server/job-dispatcher.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_SYNC_TEST_ENV__;
});

test("push applies once, replays exactly and pull never crosses tenant scope", async () => {
  const input = {
    id: "01J00000000000000000000010",
    fieldId: "field-a",
    entity: "field_observation",
    entityId: "observation-a",
    op: "append",
    payload: { value: 12, note: "offline" },
    clientTs: "2026-07-21T12:00:00.000Z",
  };
  const first = await syncRepository.pushSyncMutations(actor, [input]);
  assert.deepEqual(first.results[0], {
    id: input.id,
    status: "applied",
    replay: false,
    eventId: `event:${input.id}`,
    serverVersion: input.id,
    conflictReason: null,
  });
  const replay = await syncRepository.pushSyncMutations(actor, [input]);
  assert.equal(replay.results[0].replay, true);
  assert.equal(replay.results[0].status, "applied");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_mutations WHERE id=?").get(input.id).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(input.id).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:${input.id}`).count, 1);

  const reused = await syncRepository.pushSyncMutations(actor, [{ ...input, payload: { value: 99 } }]);
  assert.equal(reused.results[0].status, "rejected");
  assert.match(reused.results[0].conflictReason, /ULID/iu);
  const outOfScope = await syncRepository.pushSyncMutations(actor, [{
    ...input,
    id: "01J00000000000000000000011",
    fieldId: "field-b",
  }]);
  assert.equal(outOfScope.results[0].status, "rejected");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_mutations WHERE id='01J00000000000000000000011'").get().count, 0);

  sqlite.exec(`
    INSERT INTO sync_mutations
      (id, organization_id, field_id, actor, entity, entity_id, op, payload, client_ts, applied_at, status, event_id, server_version)
    VALUES
      ('01J00000000000000000000012', 'org-b', 'field-b', 'operator-b@example.com', 'field_observation', 'observation-b', 'append', '{}', '2026-07-21T12:00:00.000Z', CURRENT_TIMESTAMP, 'applied', 'event:other', '01J00000000000000000000012');
    INSERT INTO domain_events
      (id, organization_id, field_id, type, entity, entity_id, payload, source_mutation_id, actor)
    VALUES
      ('event:other', 'org-b', 'field-b', 'field_observation.created', 'field_observation', 'observation-b', '{}', '01J00000000000000000000012', 'operator-b@example.com');
  `);
  const pull = await syncRepository.pullSyncEvents({ actor, cursor: 0, limit: 100 });
  assert.deepEqual(pull.events.map((event) => event.id), [`event:${input.id}`]);
  assert.equal(pull.nextCursor, pull.events[0].sequence);
  const empty = await syncRepository.pullSyncEvents({ actor, cursor: pull.nextCursor, limit: 100 });
  assert.deepEqual(empty, { events: [], nextCursor: pull.nextCursor });
});

test("pull reauthorizes membership identity, organization, role and field scope in its final query", async (t) => {
  const pull = () => syncRepository.pullSyncEvents({ actor, cursor: 0, fieldId: "field-a", limit: 100 });
  const restore = () => {
    sqlite.prepare(`
      UPDATE organization_memberships
      SET organization_id='org-a', normalized_email=?, user_email=?, role='operator', status='active'
      WHERE id=?
    `).run(actor.email, actor.email, actor.membershipId);
    restoreActorFieldScope();
  };

  await t.test("suspension", async () => {
    sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(actor.membershipId);
    try {
      await assertPullAccessRevoked(pull);
    } finally {
      restore();
    }
  });

  await t.test("normalized email change", async () => {
    sqlite.prepare("UPDATE organization_memberships SET normalized_email='changed@example.com' WHERE id=?").run(actor.membershipId);
    try {
      await assertPullAccessRevoked(pull);
    } finally {
      restore();
    }
  });

  await t.test("organization change", async () => {
    sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=?").run(actor.membershipId);
    sqlite.prepare("UPDATE organization_memberships SET organization_id='org-b' WHERE id=?").run(actor.membershipId);
    try {
      await assertPullAccessRevoked(pull);
    } finally {
      restore();
    }
  });

  await t.test("field scope removal", async () => {
    sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=? AND field_id='field-a'").run(actor.membershipId);
    try {
      await assertPullAccessRevoked(pull);
    } finally {
      restore();
    }
  });

  await t.test("admin downgrade to viewer without scope", async () => {
    sqlite.prepare("UPDATE organization_memberships SET role='admin' WHERE id=?").run(actor.membershipId);
    sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=? AND field_id='field-a'").run(actor.membershipId);
    try {
      assert.ok((await pull()).events.length > 0, "the persisted admin role must grant current organization-wide access");
      sqlite.prepare("UPDATE organization_memberships SET role='viewer' WHERE id=?").run(actor.membershipId);
      await assertPullAccessRevoked(pull);
    } finally {
      restore();
    }
  });

  await t.test("cross-tenant field", async () => {
    await assertPullAccessRevoked(() => syncRepository.pullSyncEvents({
      actor: { ...actor, fieldIds: ["field-a", "field-b"] },
      cursor: 0,
      fieldId: "field-b",
      limit: 100,
    }));
  });
});

test("editable sync records a conflict without overwriting the server version", async () => {
  const create = {
    id: "01J00000000000000000000020",
    fieldId: "field-a",
    entity: "field_note",
    entityId: "note-a",
    op: "create",
    payload: { text: "primera" },
    clientTs: "2026-07-21T12:10:00.000Z",
  };
  assert.equal((await syncRepository.pushSyncMutations(actor, [create])).results[0].status, "applied");
  const conflict = {
    ...create,
    id: "01J00000000000000000000021",
    op: "update",
    payload: { text: "conflicto" },
    clientTs: "2026-07-21T12:11:00.000Z",
    expectedVersion: "01J00000000000000000000999",
  };
  const rejected = (await syncRepository.pushSyncMutations(actor, [conflict])).results[0];
  assert.equal(rejected.status, "conflict");
  assert.equal(rejected.serverVersion, create.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(conflict.id).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:${conflict.id}`).count, 1);

  const update = {
    ...conflict,
    id: "01J00000000000000000000022",
    payload: { text: "segunda" },
    clientTs: "2026-07-21T12:12:00.000Z",
    expectedVersion: create.id,
  };
  const applied = (await syncRepository.pushSyncMutations(actor, [update])).results[0];
  assert.equal(applied.status, "applied");
  assert.equal(applied.serverVersion, update.id);
});

test("offline livestock captures project idempotently and never cross field or tenant scope", async () => {
  const base = {
    fieldId: "field-a",
    op: "append",
    clientTs: "2026-07-21T13:00:00.000Z",
  };
  const captures = [
    {
      ...base,
      id: "01J00000000000000000000030",
      entity: "livestock_weighing",
      entityId: "weighing-a",
      payload: { lotId: "lot-a", recordedAt: "2026-07-21", notes: "Terreno", entries: [{ animalId: "cow-a1", weightKg: 512.5 }] },
    },
    {
      ...base,
      id: "01J00000000000000000000031",
      entity: "livestock_health",
      entityId: "health-a",
      payload: {
        animalId: "cow-a1", eventType: "treatment", occurredAt: "2026-07-21", status: "completed",
        condition: "Cojera", productName: "Producto A", activeIngredient: null, doseAmount: null,
        doseUnit: null, route: null, withdrawalMilkUntil: null, withdrawalMeatUntil: null,
        professional: null, notes: "Captura offline",
      },
    },
    {
      ...base,
      id: "01J00000000000000000000032",
      entity: "livestock_estrus",
      entityId: "estrus-a",
      payload: { animalId: "cow-a1", occurredAt: "2026-07-21", method: "visual", result: "confirmado", sireIdentifier: null, notes: "Captura offline" },
    },
    {
      ...base,
      id: "01J00000000000000000000033",
      entity: "livestock_movement",
      entityId: "movement-a",
      payload: { animalIds: ["cow-a1", "cow-a2"], occurredAt: "2026-07-21", destinationRup: "RUP-DEST-1", notes: "Preparar FMA", state: "pending_fma" },
    },
  ];
  const first = await syncRepository.pushSyncMutations(actor, captures);
  assert.deepEqual(first.results.map((entry) => entry.status), ["applied", "applied", "applied", "applied"]);
  const replay = await syncRepository.pushSyncMutations(actor, captures);
  assert.deepEqual(replay.results.map((entry) => [entry.status, entry.replay]), captures.map(() => ["applied", true]));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_weighings WHERE animal_id='cow-a1' AND recorded_at='2026-07-21'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_health_events WHERE id=?").get(`health-offline:${captures[1].id}`).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_reproductive_events WHERE id=?").get(`repro-offline:${captures[2].id}`).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id IN (?, ?, ?, ?)").get(...captures.map((entry) => entry.id)).count, 4);

  const changedWeight = {
    ...captures[0],
    id: "01J00000000000000000000034",
    entityId: "weighing-conflict",
    payload: { ...captures[0].payload, entries: [{ animalId: "cow-a1", weightKg: 600 }] },
  };
  const conflict = (await syncRepository.pushSyncMutations(actor, [changedWeight])).results[0];
  assert.equal(conflict.status, "conflict");
  assert.equal(sqlite.prepare("SELECT weight_kg AS weight FROM livestock_weighings WHERE animal_id='cow-a1' AND recorded_at='2026-07-21'").get().weight, 512.5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(changedWeight.id).count, 0);

  const crossTenantMovement = {
    ...captures[3],
    id: "01J00000000000000000000035",
    entityId: "movement-cross-tenant",
    payload: { ...captures[3].payload, animalIds: ["cow-b1"] },
  };
  const isolated = (await syncRepository.pushSyncMutations(actor, [crossTenantMovement])).results[0];
  assert.equal(isolated.status, "conflict");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(crossTenantMovement.id).count, 0);
});

test("paddock geometry sync is atomic, versioned, replayable and tenant-isolated", async () => {
  const firstGeometry = { outer: [[-40.6, -73.2], [-40.6, -73.188], [-40.589, -73.188]], holes: [] };
  const initialUpdates = [{ id: "paddock-a1", expectedVersion: "2026-07-21T10:00:00.000Z", geometry: firstGeometry, holeKinds: [] }];
  const mutation = {
    id: "01J00000000000000000000060",
    fieldId: "field-a",
    entity: "paddock_geometry",
    entityId: "paddock-a1",
    op: "update",
    payload: { capturedAt: "2026-07-21T14:00:00.000Z", source: "gps", updates: initialUpdates },
    clientTs: "2026-07-21T14:00:00.000Z",
    expectedVersion: buildPaddockGeometryVersion(initialUpdates),
  };
  const first = (await syncRepository.pushSyncMutations(actor, [mutation])).results[0];
  assert.equal(first.status, "applied");
  assert.match(first.serverVersion, /^paddock-geometry-v1:/u);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT coordinates FROM potreros WHERE id='paddock-a1'").get().coordinates), firstGeometry);
  const event = sqlite.prepare("SELECT payload FROM domain_events WHERE source_mutation_id=?").get(mutation.id);
  assert.deepEqual(JSON.parse(event.payload).projection.paddocks[0].geometry, firstGeometry);
  assert.deepEqual((await syncRepository.pushSyncMutations(actor, [mutation])).results[0], { ...first, replay: true });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(mutation.id).count, 1);

  const staleGeometry = { outer: [[-40.6, -73.2], [-40.6, -73.187], [-40.588, -73.187]], holes: [] };
  const staleUpdates = [{ ...initialUpdates[0], geometry: staleGeometry }];
  const stale = {
    ...mutation,
    id: "01J00000000000000000000061",
    payload: { ...mutation.payload, capturedAt: "2026-07-21T14:01:00.000Z", updates: staleUpdates },
    clientTs: "2026-07-21T14:01:00.000Z",
    expectedVersion: buildPaddockGeometryVersion(staleUpdates),
  };
  const lww = (await syncRepository.pushSyncMutations(actor, [stale])).results[0];
  assert.equal(lww.status, "applied");
  assert.match(lww.serverVersion, /^paddock-geometry-v1:/u);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT coordinates FROM potreros WHERE id='paddock-a1'").get().coordinates), staleGeometry);
  const lwwEvent = JSON.parse(sqlite.prepare("SELECT payload FROM domain_events WHERE source_mutation_id=?").get(stale.id).payload);
  assert.deepEqual(lwwEvent.resolution, {
    policy: "paddock-geometry-lww-v1",
    disposition: "newer-client",
    clientTs: stale.clientTs,
    comparedClientTs: mutation.clientTs,
    replacedVersion: first.serverVersion,
  });

  const currentUpdatedAt = sqlite.prepare("SELECT updated_at AS updatedAt FROM potreros WHERE id='paddock-a1'").get().updatedAt;
  const futureUpdates = [{ ...initialUpdates[0], expectedVersion: currentUpdatedAt, geometry: firstGeometry }];
  const futureClock = {
    ...mutation,
    id: "01J00000000000000000000066",
    payload: { ...mutation.payload, capturedAt: "2099-01-01T00:00:00.000Z", updates: futureUpdates },
    clientTs: "2099-01-01T00:00:00.000Z",
    expectedVersion: buildPaddockGeometryVersion(futureUpdates),
  };
  const futureConflict = (await syncRepository.pushSyncMutations(actor, [futureClock])).results[0];
  assert.equal(futureConflict.status, "conflict");
  assert.match(futureConflict.conflictReason, /client_ts/iu);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT coordinates FROM potreros WHERE id='paddock-a1'").get().coordinates), staleGeometry);

  const discardedOlder = {
    ...mutation,
    id: "01J00000000000000000000065",
    payload: { ...mutation.payload, capturedAt: "2026-07-21T14:00:30.000Z", updates: [{ ...initialUpdates[0], geometry: firstGeometry }] },
    clientTs: "2026-07-21T14:00:30.000Z",
  };
  const conflict = (await syncRepository.pushSyncMutations(actor, [discardedOlder])).results[0];
  assert.equal(conflict.status, "conflict");
  assert.match(conflict.conflictReason, /client_ts/iu);
  const conflictAudit = JSON.parse(sqlite.prepare("SELECT after FROM audit_log WHERE id=?").get(`audit:${discardedOlder.id}`).after);
  assert.equal(conflictAudit.clientTs, discardedOlder.clientTs);
  assert.match(conflictAudit.reason, /client_ts/iu);

  const crossTenantUpdates = [{ id: "paddock-b1", expectedVersion: "2026-07-21T10:00:00.000Z", geometry: firstGeometry, holeKinds: [] }];
  const crossTenant = (await syncRepository.pushSyncMutations(actor, [{
    ...mutation,
    id: "01J00000000000000000000062",
    entityId: "paddock-b1",
    payload: { ...mutation.payload, updates: crossTenantUpdates },
    expectedVersion: buildPaddockGeometryVersion(crossTenantUpdates),
  }])).results[0];
  assert.equal(crossTenant.status, "conflict");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT coordinates FROM potreros WHERE id='paddock-b1'").get().coordinates), {
    outer: [[-40.7, -73.3], [-40.7, -73.29], [-40.69, -73.29]], holes: [],
  });

  const invalid = (await syncRepository.pushSyncMutations(actor, [{
    ...mutation,
    id: "01J00000000000000000000063",
    payload: { ...mutation.payload, trustedAreaHectares: 999 },
  }])).results[0];
  assert.equal(invalid.status, "rejected");
  assert.match(invalid.conflictReason, /campos no permitidos/iu);
});

test("a pending paddock projection is finalized from its atomic marker after an interrupted response", async () => {
  const geometry = { outer: [[-40.61, -73.2], [-40.61, -73.188], [-40.599, -73.188]], holes: [] };
  const updates = [{ id: "paddock-a2", expectedVersion: "2026-07-21T10:00:00.000Z", geometry, holeKinds: [] }];
  const mutation = {
    id: "01J00000000000000000000064",
    fieldId: "field-a",
    entity: "paddock_geometry",
    entityId: "paddock-a2",
    op: "update",
    payload: { capturedAt: "2026-07-21T14:02:00.000Z", source: "map", updates },
    clientTs: "2026-07-21T14:02:00.000Z",
    expectedVersion: buildPaddockGeometryVersion(updates),
  };
  sqlite.prepare(`
    INSERT INTO sync_mutations
      (id, organization_id, field_id, actor, entity, entity_id, op, payload, client_ts, expected_version, status)
    VALUES (?, 'org-a', 'field-a', ?, 'paddock_geometry', 'paddock-a2', 'update', ?, ?, ?, 'pending')
  `).run(mutation.id, actor.email, JSON.stringify(mutation.payload), mutation.clientTs, mutation.expectedVersion);
  const projected = await geographicProjection.applyGeographicSyncMutation(actor, mutation);
  assert.equal(projected.action, "applied");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:geo:${mutation.id}`).count, 1);
  const laterGeometry = { outer: [[-40.61, -73.2], [-40.61, -73.187], [-40.598, -73.187]], holes: [] };
  sqlite.prepare("UPDATE potreros SET coordinates=?, updated_at='2026-07-21T14:02:02.000Z' WHERE id='paddock-a2'").run(JSON.stringify(laterGeometry));
  const recovered = (await syncRepository.pushSyncMutations(actor, [mutation])).results[0];
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.replay, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(mutation.id).count, 1);
  assert.equal(sqlite.prepare("SELECT updated_at AS updatedAt FROM potreros WHERE id='paddock-a2'").get().updatedAt, "2026-07-21T14:02:02.000Z");
  const recoveredEvent = JSON.parse(sqlite.prepare("SELECT payload FROM domain_events WHERE source_mutation_id=?").get(mutation.id).payload);
  assert.deepEqual(recoveredEvent.projection.paddocks[0].geometry, geometry);
});

test("landmark sync closes create, update, archive, conflict and exact replay", async () => {
  const create = {
    id: "01J00000000000000000000070",
    fieldId: "field-a",
    entity: "field_landmark",
    entityId: "landmark-a",
    op: "create",
    payload: {
      action: "upsert", kind: "bebedero", geometryType: "point", geometry: [[-40.6, -73.2]], name: "Bebedero A", notes: "GPS",
    },
    clientTs: "2026-07-21T14:10:00.000Z",
    expectedVersion: null,
  };
  const created = (await syncRepository.pushSyncMutations(actor, [create])).results[0];
  assert.equal(created.status, "applied");
  assert.equal(created.serverVersion, "1");
  assert.deepEqual((await syncRepository.pushSyncMutations(actor, [create])).results[0], { ...created, replay: true });
  assert.equal(sqlite.prepare("SELECT version FROM field_landmarks WHERE id='landmark-a'").get().version, 1);

  const update = {
    ...create,
    id: "01J00000000000000000000071",
    op: "update",
    payload: { ...create.payload, name: "Bebedero norte" },
    clientTs: "2026-07-21T14:11:00.000Z",
    expectedVersion: "1",
  };
  assert.equal((await syncRepository.pushSyncMutations(actor, [update])).results[0].serverVersion, "2");
  const stale = (await syncRepository.pushSyncMutations(actor, [{
    ...update,
    id: "01J00000000000000000000072",
    payload: { ...update.payload, name: "Valor obsoleto" },
  }])).results[0];
  assert.equal(stale.status, "conflict");
  assert.equal(stale.serverVersion, "2");
  assert.equal(sqlite.prepare("SELECT name FROM field_landmarks WHERE id='landmark-a'").get().name, "Bebedero norte");

  const archive = {
    ...update,
    id: "01J00000000000000000000073",
    payload: { action: "archive" },
    clientTs: "2026-07-21T14:12:00.000Z",
    expectedVersion: "2",
  };
  const archived = (await syncRepository.pushSyncMutations(actor, [archive])).results[0];
  assert.equal(archived.status, "applied");
  assert.equal(archived.serverVersion, "3");
  assert.ok(sqlite.prepare("SELECT deleted_at AS deletedAt FROM field_landmarks WHERE id='landmark-a'").get().deletedAt);
  const pulled = await syncRepository.pullSyncEvents({ actor, cursor: 0, fieldId: "field-a", limit: 100 });
  const landmarkEvents = pulled.events.filter(({ entity }) => entity === "field_landmark");
  assert.deepEqual(landmarkEvents.map(({ type }) => type), ["field_landmark.created", "field_landmark.updated", "field_landmark.archived"]);
  assert.equal(landmarkEvents.at(-1).payload.projection.landmark.version, 3);
});

test("a suspension immediately before the geometry batch leaves no projection or ledger", async () => {
  const current = sqlite.prepare("SELECT coordinates, updated_at AS updatedAt FROM potreros WHERE id='paddock-a1'").get();
  const geometry = { outer: [[-40.6, -73.2], [-40.6, -73.186], [-40.587, -73.186]], holes: [] };
  const updates = [{ id: "paddock-a1", expectedVersion: current.updatedAt, geometry, holeKinds: [] }];
  const mutation = {
    id: "01J00000000000000000000080",
    fieldId: "field-a",
    entity: "paddock_geometry",
    entityId: "paddock-a1",
    op: "update",
    payload: { capturedAt: "2026-07-22T10:00:00.000Z", source: "gps", updates },
    clientTs: "2026-07-22T10:00:00.000Z",
    expectedVersion: buildPaddockGeometryVersion(updates),
  };
  armBeforeNextBatch(/UPDATE potreros/iu, () => {
    sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(actor.membershipId);
  });
  let result;
  try {
    result = (await syncRepository.pushSyncMutations(actor, [mutation])).results[0];
  } finally {
    sqlite.prepare("UPDATE organization_memberships SET status='active' WHERE id=?").run(actor.membershipId);
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(result, mutation.id);
  assert.equal(sqlite.prepare("SELECT coordinates FROM potreros WHERE id='paddock-a1'").get().coordinates, current.coordinates);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:geo:${mutation.id}`).count, 0);
});

test("field-scope removal immediately before the landmark batch leaves no landmark operation or audit", async () => {
  const mutation = {
    id: "01J00000000000000000000081",
    fieldId: "field-a",
    entity: "field_landmark",
    entityId: "landmark-revoked-a",
    op: "create",
    payload: {
      action: "upsert", kind: "bebedero", geometryType: "point", geometry: [[-40.605, -73.205]], name: "No guardar", notes: "Revocado",
    },
    clientTs: "2026-07-22T10:01:00.000Z",
    expectedVersion: null,
  };
  armBeforeNextBatch(/INSERT INTO field_landmark_operations/iu, () => {
    sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=? AND field_id=?").run(actor.membershipId, mutation.fieldId);
  });
  let result;
  try {
    result = (await syncRepository.pushSyncMutations(actor, [mutation])).results[0];
  } finally {
    restoreActorFieldScope();
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(result, mutation.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmarks WHERE id=?").get(mutation.entityId).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations WHERE id=?").get(mutation.id).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit-field-landmark-${mutation.id}`).count, 0);
});

test("a role downgrade immediately before the weighing batch leaves weights and lot summary unchanged", async () => {
  const mutation = {
    id: "01J00000000000000000000082",
    fieldId: "field-a",
    entity: "livestock_weighing",
    entityId: "weighing-revoked-a",
    op: "append",
    payload: { lotId: "lot-a", recordedAt: "2026-07-22", notes: "No guardar", entries: [{ animalId: "cow-a2", weightKg: 488 }] },
    clientTs: "2026-07-22T10:02:00.000Z",
  };
  const lotBefore = sqlite.prepare("SELECT average_weight_kg AS averageWeightKg, updated_at AS updatedAt FROM livestock_lots WHERE id='lot-a'").get();
  armBeforeNextBatch(/INSERT INTO livestock_weighings/iu, () => {
    sqlite.prepare("UPDATE organization_memberships SET role='viewer' WHERE id=?").run(actor.membershipId);
  });
  let result;
  try {
    result = (await syncRepository.pushSyncMutations(actor, [mutation])).results[0];
  } finally {
    sqlite.prepare("UPDATE organization_memberships SET role='operator' WHERE id=?").run(actor.membershipId);
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(result, mutation.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_weighings WHERE animal_id='cow-a2' AND recorded_at='2026-07-22'").get().count, 0);
  assert.deepEqual({ ...sqlite.prepare("SELECT average_weight_kg AS averageWeightKg, updated_at AS updatedAt FROM livestock_lots WHERE id='lot-a'").get() }, { ...lotBefore });
});

test("health and estrus batches fail closed when membership or scope changes immediately before commit", async () => {
  const health = {
    id: "01J00000000000000000000083",
    fieldId: "field-a",
    entity: "livestock_health",
    entityId: "health-revoked-a",
    op: "append",
    payload: {
      animalId: "cow-a2", eventType: "treatment", occurredAt: "2026-07-22", status: "completed",
      condition: "Control", productName: "Producto B", activeIngredient: null, doseAmount: null,
      doseUnit: null, route: null, withdrawalMilkUntil: null, withdrawalMeatUntil: null,
      professional: null, notes: "No guardar",
    },
    clientTs: "2026-07-22T10:03:00.000Z",
  };
  armBeforeNextBatch(/INSERT INTO livestock_health_events/iu, () => {
    sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(actor.membershipId);
  });
  let healthResult;
  try {
    healthResult = (await syncRepository.pushSyncMutations(actor, [health])).results[0];
  } finally {
    sqlite.prepare("UPDATE organization_memberships SET status='active' WHERE id=?").run(actor.membershipId);
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(healthResult, health.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_health_events WHERE id=?").get(`health-offline:${health.id}`).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:health-offline:${health.id}`).count, 0);

  const estrus = {
    id: "01J00000000000000000000084",
    fieldId: "field-a",
    entity: "livestock_estrus",
    entityId: "estrus-revoked-a",
    op: "append",
    payload: { animalId: "cow-a2", occurredAt: "2026-07-22", method: "visual", result: "confirmado", sireIdentifier: null, notes: "No guardar" },
    clientTs: "2026-07-22T10:04:00.000Z",
  };
  armBeforeNextBatch(/INSERT INTO livestock_reproductive_events/iu, () => {
    sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=? AND field_id=?").run(actor.membershipId, estrus.fieldId);
  });
  let estrusResult;
  try {
    estrusResult = (await syncRepository.pushSyncMutations(actor, [estrus])).results[0];
  } finally {
    restoreActorFieldScope();
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(estrusResult, estrus.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_reproductive_events WHERE id=?").get(`repro-offline:${estrus.id}`).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:repro-offline:${estrus.id}`).count, 0);
});

test("revocation before final applied or conflict ledgers rejects movement and field-note outcomes", async () => {
  const movement = {
    id: "01J00000000000000000000085",
    fieldId: "field-a",
    entity: "livestock_movement",
    entityId: "movement-revoked-a",
    op: "append",
    payload: { animalIds: ["cow-a2"], occurredAt: "2026-07-22", destinationRup: "RUP-DEST-2", notes: "No cerrar", state: "pending_fma" },
    clientTs: "2026-07-22T10:05:00.000Z",
  };
  armBeforeNextBatch(/INSERT INTO domain_events/iu, () => {
    sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(actor.membershipId);
  });
  let movementResult;
  try {
    movementResult = (await syncRepository.pushSyncMutations(actor, [movement])).results[0];
  } finally {
    sqlite.prepare("UPDATE organization_memberships SET status='active' WHERE id=?").run(actor.membershipId);
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(movementResult, movement.id);

  const createdNote = {
    id: "01J00000000000000000000086",
    fieldId: "field-a",
    entity: "field_note",
    entityId: "note-revocation-a",
    op: "create",
    payload: { text: "base" },
    clientTs: "2026-07-22T10:06:00.000Z",
  };
  assert.equal((await syncRepository.pushSyncMutations(actor, [createdNote])).results[0].status, "applied");
  const conflict = {
    ...createdNote,
    id: "01J00000000000000000000087",
    op: "update",
    payload: { text: "stale" },
    clientTs: "2026-07-22T10:07:00.000Z",
    expectedVersion: "01J00000000000000000000999",
  };
  armBeforeNextBatch(/sync\.mutation\.conflict/iu, () => {
    sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=? AND field_id=?").run(actor.membershipId, conflict.fieldId);
  });
  let conflictResult;
  try {
    conflictResult = (await syncRepository.pushSyncMutations(actor, [conflict])).results[0];
  } finally {
    restoreActorFieldScope();
    d1.beforeNextBatch = null;
  }
  assertRejectedWithoutLedger(conflictResult, conflict.id);
});

test("50 offline captures replay across five lost-response cycles exactly once in D1", async () => {
  const captures = Array.from({ length: 50 }, (_, index) => {
    const id = deterministicCaptureUlid(index);
    return {
      id,
      fieldId: "field-a",
      entity: "livestock_health",
      entityId: `health-load-${index + 1}`,
      op: "append",
      clientTs: new Date(Date.parse("2026-07-23T10:00:00.000Z") + index * 1000).toISOString(),
      payload: {
        animalId: "cow-a1",
        eventType: "treatment",
        occurredAt: "2026-07-23",
        status: "completed",
        condition: `Control sanitario ${index + 1}`,
        productName: "Producto A",
        activeIngredient: null,
        doseAmount: null,
        doseUnit: null,
        route: null,
        withdrawalMilkUntil: null,
        withdrawalMeatUntil: null,
        professional: null,
        notes: "Carga FS09-R1",
      },
    };
  });
  const expectedMutationIds = captures.map(({ id }) => id).sort();

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const batch = captures.slice(cycle * 10, cycle * 10 + 10);
    await assert.rejects(async () => {
      await syncRepository.pushSyncMutations(actor, batch);
      throw new Error("simulated transport loss after D1 commit");
    }, /transport loss after D1 commit/u);
    assert.deepEqual(
      batch.map(({ id }) => sqlite.prepare("SELECT status FROM sync_mutations WHERE id=?").get(id)?.status),
      batch.map(() => "applied"),
      "the commit must be durable before the simulated transport drops its response",
    );
    const recovered = await syncRepository.pushSyncMutations(actor, batch);
    assert.deepEqual(recovered.results.map(({ status, replay }) => [status, replay]), batch.map(() => ["applied", true]));
  }

  const ledgerIds = sqlite.prepare(`
    SELECT id FROM sync_mutations
    WHERE id LIKE '01K000000000000000000000%'
    ORDER BY id
  `).all().map(({ id }) => id);
  const projectionIds = sqlite.prepare(`
    SELECT id FROM livestock_health_events
    WHERE id LIKE 'health-offline:01K000000000000000000000%'
    ORDER BY id
  `).all().map(({ id }) => id.slice("health-offline:".length));
  const eventIds = sqlite.prepare(`
    SELECT source_mutation_id AS id FROM domain_events
    WHERE source_mutation_id LIKE '01K000000000000000000000%'
    ORDER BY source_mutation_id
  `).all().map(({ id }) => id);
  const projectionAuditIds = sqlite.prepare(`
    SELECT id FROM audit_log
    WHERE id LIKE 'audit:health-offline:01K000000000000000000000%'
    ORDER BY id
  `).all().map(({ id }) => id.slice("audit:health-offline:".length));
  const appliedAuditIds = sqlite.prepare(`
    SELECT id FROM audit_log
    WHERE id LIKE 'audit:01K000000000000000000000%'
    ORDER BY id
  `).all().map(({ id }) => id.slice("audit:".length));

  assert.deepEqual(ledgerIds, expectedMutationIds);
  assert.deepEqual(projectionIds, expectedMutationIds);
  assert.deepEqual(eventIds, expectedMutationIds);
  assert.deepEqual(projectionAuditIds, expectedMutationIds);
  assert.deepEqual(appliedAuditIds, expectedMutationIds);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM sync_mutations
    WHERE id LIKE '01K000000000000000000000%' AND status <> 'applied'
  `).get().count, 0);
});

test("feature flags are audited and field overrides take precedence", async () => {
  const owner = { ...actor, role: "owner" };
  sqlite.prepare(`
    INSERT OR IGNORE INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('feature-owner-safety', 'org-a', 'feature-owner-safety@example.com',
       'feature-owner-safety@example.com', 'Feature owner safety', 'owner', 'active', 'fixture')
  `).run();
  const restoreOwner = () => {
    sqlite.prepare(`
      UPDATE organization_memberships
      SET organization_id='org-a', normalized_email=?, user_email=?, role='owner', status='active'
      WHERE id=?
    `).run(owner.email, owner.email, owner.membershipId);
    sqlite.prepare("UPDATE fields SET is_demo=0 WHERE id='field-a'").run();
  };
  restoreOwner();
  try {
    await featureRepository.setOrganizationFeatureFlag({ actor: owner, feature: "analitica", fieldId: null, enabled: true });
    assert.equal(await featureRepository.isFeatureEnabled(owner, "analitica", "field-a"), true);
    await featureRepository.setOrganizationFeatureFlag({ actor: owner, feature: "analitica", fieldId: "field-a", enabled: false });
    assert.equal(await featureRepository.isFeatureEnabled(owner, "analitica", "field-a"), false);
    assert.equal(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE entity_type='organization_feature_flag' AND organization_id='org-a'
    `).get().count, 2);
    await assert.rejects(
      featureRepository.setOrganizationFeatureFlag({ actor: owner, feature: "analitica", fieldId: "field-b", enabled: true }),
      /FIELD_SCOPE_CONFLICT/u,
    );

    const rejectedFlagId = featureRepository.featureFlagId("org-a", "field-a", "pastoreo");
    const rejectedAuditCount = () => sqlite.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE entity_type='organization_feature_flag' AND entity_id=?
    `).get(rejectedFlagId).count;
    const scenarios = [
      {
        label: "suspension",
        revoke: () => sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(owner.membershipId),
        restore: restoreOwner,
      },
      {
        label: "role downgrade",
        revoke: () => sqlite.prepare("UPDATE organization_memberships SET role='operator' WHERE id=?").run(owner.membershipId),
        restore: restoreOwner,
      },
      {
        label: "email change",
        revoke: () => sqlite.prepare("UPDATE organization_memberships SET normalized_email='changed-feature@example.com' WHERE id=?").run(owner.membershipId),
        restore: restoreOwner,
      },
      {
        label: "organization change",
        revoke: () => sqlite.prepare("UPDATE organization_memberships SET organization_id='org-b' WHERE id=?").run(owner.membershipId),
        restore: restoreOwner,
      },
      {
        label: "same-email replacement",
        revoke: () => sqlite.exec(`
          UPDATE organization_memberships
          SET status='suspended', normalized_email='replaced-feature@example.com'
          WHERE id='operator-a';
          INSERT INTO organization_memberships
            (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
          VALUES
            ('feature-owner-replacement', 'org-a', 'operator-a@example.com', 'operator-a@example.com',
             'Feature owner replacement', 'owner', 'active', 'fixture');
        `),
        restore: () => {
          sqlite.prepare("DELETE FROM organization_memberships WHERE id='feature-owner-replacement'").run();
          restoreOwner();
        },
      },
      {
        label: "demo conversion",
        revoke: () => sqlite.prepare("UPDATE fields SET is_demo=1 WHERE id='field-a'").run(),
        restore: restoreOwner,
      },
    ];
    for (const scenario of scenarios) {
      const auditCountBefore = rejectedAuditCount();
      armBeforeNextBatch(/organization_feature_flag/iu, scenario.revoke);
      try {
        await assert.rejects(
          featureRepository.setOrganizationFeatureFlag({
            actor: owner,
            feature: "pastoreo",
            fieldId: "field-a",
            enabled: true,
          }),
          (error) => error.code === "FEATURE_FLAG_ACCESS_CHANGED",
          scenario.label,
        );
      } finally {
        d1.beforeNextBatch = null;
        scenario.restore();
      }
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM organization_feature_flags WHERE id=?").get(rejectedFlagId).count, 0);
      assert.equal(rejectedAuditCount(), auditCountBefore);
    }

    sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(owner.membershipId);
    try {
      await assert.rejects(
        featureRepository.listOrganizationFeatureFlags(owner),
        (error) => error.code === "FEATURE_FLAG_ACCESS_CHANGED",
      );
    } finally {
      restoreOwner();
    }
  } finally {
    d1.beforeNextBatch = null;
    sqlite.prepare(`
      UPDATE organization_memberships
      SET organization_id='org-a', normalized_email=?, user_email=?, role='operator', status='active'
      WHERE id=?
    `).run(actor.email, actor.email, actor.membershipId);
    sqlite.prepare("DELETE FROM organization_memberships WHERE id='feature-owner-replacement'").run();
    sqlite.prepare("UPDATE fields SET is_demo=0 WHERE id='field-a'").run();
  }
});

function armBeforeNextBatch(expectedStatement, mutateAccess) {
  assert.equal(d1.beforeNextBatch, null);
  d1.beforeNextBatch = (statements) => {
    assert.ok(statements.some(({ sql }) => expectedStatement.test(sql)), `El batch no incluyo ${expectedStatement}.`);
    mutateAccess();
  };
}

function restoreActorFieldScope() {
  sqlite.prepare(`
    INSERT OR IGNORE INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('scope-operator-a-field-a', ?, 'field-a', 'fixture')
  `).run(actor.membershipId);
}

function assertRejectedWithoutLedger(result, mutationId) {
  assert.equal(result.status, "rejected");
  assert.equal(result.eventId, null);
  assert.equal(result.serverVersion, null);
  assert.match(result.conflictReason, /membresia|acceso/iu);
  assert.equal(sqlite.prepare("SELECT status FROM sync_mutations WHERE id=?").get(mutationId).status, "pending");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE source_mutation_id=?").get(mutationId).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id=?").get(`audit:${mutationId}`).count, 0);
}

async function assertPullAccessRevoked(operation) {
  await assert.rejects(operation, (cause) => {
    assert.ok(cause instanceof syncRepository.SyncRequestError);
    assert.equal(cause.status, 403);
    assert.match(cause.message, /membresia|acceso/iu);
    assert.doesNotMatch(cause.message, /offline|observation|event:/iu);
    return true;
  });
}

test("database dispatcher leases and reschedules an observed probe exactly once", async () => {
  sqlite.exec(`
    DELETE FROM scheduled_jobs;
    INSERT INTO scheduled_jobs (id, type, payload, due_at, interval_seconds)
    VALUES ('probe-a', 'system.probe', '{}', '2026-07-21T11:00:00.000Z', 3600)
  `);
  const observed = [];
  const now = new Date("2026-07-21T12:00:00.000Z");
  const first = await jobDispatcher.runDueScheduledJobs({
    now,
    execute: async (job) => observed.push(`job.dispatcher.${job.type}`),
  });
  assert.deepEqual(first, { claimed: 1, completed: 1, failures: 0, superseded: 0 });
  assert.deepEqual(observed, ["job.dispatcher.system.probe"]);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT due_at AS dueAt, attempt_count AS attemptCount, lease_owner AS leaseOwner,
      lease_expires_at AS leaseExpiresAt, last_error_type AS lastErrorType
    FROM scheduled_jobs WHERE id='probe-a'
  `).get() }, {
    dueAt: "2026-07-21T13:00:00.000Z",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorType: null,
  });
  assert.deepEqual(await jobDispatcher.runDueScheduledJobs({ now, execute: async () => {} }), {
    claimed: 0,
    completed: 0,
    failures: 0,
    superseded: 0,
  });
});

test("database dispatcher rejects a payload snapshot changed before claim", async () => {
  sqlite.exec(`
    DELETE FROM scheduled_jobs;
    INSERT INTO scheduled_jobs (id, type, payload, due_at, interval_seconds, updated_at)
    VALUES (
      'probe-stale', 'system.probe', '{"revision":"old"}',
      '2026-07-21T11:00:00.000Z', 3600, '2026-07-21T11:00:00.000Z'
    )
  `);
  const selectedAt = new Date("2026-07-21T12:00:00.000Z");
  const claimedAt = new Date("2026-07-21T12:00:01.000Z");
  const observed = [];
  let changed = false;
  const stale = await jobDispatcher.runDueScheduledJobs({
    now: selectedAt,
    clock: () => {
      if (!changed) {
        changed = true;
        sqlite.prepare(`
          UPDATE scheduled_jobs
          SET payload = '{"revision":"new"}', due_at = '2026-07-21T11:30:00.000Z',
            interval_seconds = 7200, attempt_count = 3, updated_at = ?
          WHERE id = 'probe-stale'
        `).run(claimedAt.toISOString());
      }
      return claimedAt;
    },
    execute: async (job) => observed.push(job.payload),
  });
  assert.deepEqual(stale, { claimed: 0, completed: 0, failures: 0, superseded: 0 });
  assert.deepEqual(observed, []);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT payload, due_at AS dueAt, interval_seconds AS intervalSeconds,
      attempt_count AS attemptCount, lease_owner AS leaseOwner
    FROM scheduled_jobs WHERE id = 'probe-stale'
  `).get() }, {
    payload: '{"revision":"new"}',
    dueAt: "2026-07-21T11:30:00.000Z",
    intervalSeconds: 7200,
    attemptCount: 3,
    leaseOwner: null,
  });

  const refreshed = await jobDispatcher.runDueScheduledJobs({
    now: claimedAt,
    clock: () => claimedAt,
    execute: async (job) => observed.push(job.payload),
  });
  assert.deepEqual(refreshed, { claimed: 1, completed: 1, failures: 0, superseded: 0 });
  assert.deepEqual(observed, [{ revision: "new" }]);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT due_at AS dueAt, attempt_count AS attemptCount FROM scheduled_jobs WHERE id = 'probe-stale'
  `).get() }, {
    dueAt: "2026-07-21T14:00:01.000Z",
    attemptCount: 0,
  });
});

test("database dispatcher gives a later candidate a full fresh lease after a slow job", async () => {
  sqlite.exec(`
    DELETE FROM scheduled_jobs;
    INSERT INTO scheduled_jobs (id, type, payload, due_at, interval_seconds, updated_at) VALUES
      ('probe-slow', 'system.probe', '{}', '2026-07-21T11:00:00.000Z', 3600, '2026-07-21T11:00:00.000Z'),
      ('traceability-later', 'traceability.reconcile.v1', '{}', '2026-07-21T11:01:00.000Z', 21600, '2026-07-21T11:00:00.000Z')
  `);
  const selectedAt = new Date("2026-07-21T12:00:00.000Z");
  let current = selectedAt;
  let competingResult = null;
  let leaseDuringExecution = null;
  const observed = [];
  const first = await jobDispatcher.runDueScheduledJobs({
    now: selectedAt,
    clock: () => new Date(current),
    execute: async (job) => {
      observed.push(job.id);
      if (job.id === "probe-slow") {
        current = new Date("2026-07-21T12:05:01.000Z");
        return;
      }
      leaseDuringExecution = { ...sqlite.prepare(`
        SELECT lease_expires_at AS leaseExpiresAt, last_started_at AS lastStartedAt
        FROM scheduled_jobs WHERE id = 'traceability-later'
      `).get() };
      competingResult = await jobDispatcher.runDueScheduledJobs({
        now: new Date(current),
        clock: () => new Date(current),
        execute: async () => assert.fail("a second dispatcher must not execute the fresh lease"),
      });
    },
  });
  assert.deepEqual(first, { claimed: 2, completed: 2, failures: 0, superseded: 0 });
  assert.deepEqual(competingResult, { claimed: 0, completed: 0, failures: 0, superseded: 0 });
  assert.deepEqual(observed, ["probe-slow", "traceability-later"]);
  assert.deepEqual(leaseDuringExecution, {
    leaseExpiresAt: "2026-07-21T12:10:01.000Z",
    lastStartedAt: "2026-07-21T12:05:01.000Z",
  });
});

test("database dispatcher treats a stolen completion lease as superseded and continues", async () => {
  sqlite.exec(`
    DELETE FROM scheduled_jobs;
    INSERT INTO scheduled_jobs (id, type, payload, due_at, interval_seconds, updated_at) VALUES
      ('probe-stolen', 'system.probe', '{}', '2026-07-21T11:00:00.000Z', 3600, '2026-07-21T11:00:00.000Z'),
      ('probe-next', 'system.probe', '{}', '2026-07-21T11:01:00.000Z', 3600, '2026-07-21T11:00:00.000Z')
  `);
  const selectedAt = new Date("2026-07-21T12:00:00.000Z");
  let current = selectedAt;
  const observed = [];
  const result = await jobDispatcher.runDueScheduledJobs({
    now: selectedAt,
    clock: () => new Date(current),
    execute: async (job) => {
      observed.push(job.id);
      if (job.id !== "probe-stolen") return;
      current = new Date("2026-07-21T12:00:01.000Z");
      sqlite.prepare(`
        UPDATE scheduled_jobs
        SET lease_owner = 'new-runner', lease_expires_at = '2026-07-21T12:05:01.000Z', updated_at = ?
        WHERE id = 'probe-stolen'
      `).run(current.toISOString());
    },
  });
  assert.deepEqual(result, { claimed: 2, completed: 1, failures: 0, superseded: 1 });
  assert.deepEqual(observed, ["probe-stolen", "probe-next"]);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
      attempt_count AS attemptCount, last_error_type AS lastErrorType
    FROM scheduled_jobs WHERE id = 'probe-stolen'
  `).get() }, {
    leaseOwner: "new-runner",
    leaseExpiresAt: "2026-07-21T12:05:01.000Z",
    attemptCount: 0,
    lastErrorType: null,
  });
  assert.equal(sqlite.prepare("SELECT lease_owner FROM scheduled_jobs WHERE id = 'probe-next'").get().lease_owner, null);
});

test("database dispatcher treats a stolen failure lease as superseded and continues", async () => {
  sqlite.exec(`
    DELETE FROM scheduled_jobs;
    INSERT INTO scheduled_jobs (id, type, payload, due_at, interval_seconds, updated_at) VALUES
      ('probe-failure-stolen', 'system.probe', '{}', '2026-07-21T11:00:00.000Z', 3600, '2026-07-21T11:00:00.000Z'),
      ('probe-after-failure', 'system.probe', '{}', '2026-07-21T11:01:00.000Z', 3600, '2026-07-21T11:00:00.000Z')
  `);
  const selectedAt = new Date("2026-07-21T12:00:00.000Z");
  let current = selectedAt;
  const observed = [];
  const result = await jobDispatcher.runDueScheduledJobs({
    now: selectedAt,
    clock: () => new Date(current),
    execute: async (job) => {
      observed.push(job.id);
      if (job.id !== "probe-failure-stolen") return;
      current = new Date("2026-07-21T12:00:01.000Z");
      sqlite.prepare(`
        UPDATE scheduled_jobs
        SET lease_owner = 'new-failure-runner', lease_expires_at = '2026-07-21T12:05:01.000Z', updated_at = ?
        WHERE id = 'probe-failure-stolen'
      `).run(current.toISOString());
      throw new TypeError("synthetic failure");
    },
  });
  assert.deepEqual(result, { claimed: 2, completed: 1, failures: 0, superseded: 1 });
  assert.deepEqual(observed, ["probe-failure-stolen", "probe-after-failure"]);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
      attempt_count AS attemptCount, last_error_type AS lastErrorType
    FROM scheduled_jobs WHERE id = 'probe-failure-stolen'
  `).get() }, {
    leaseOwner: "new-failure-runner",
    leaseExpiresAt: "2026-07-21T12:05:01.000Z",
    attemptCount: 0,
    lastErrorType: null,
  });
  assert.equal(sqlite.prepare("SELECT lease_owner FROM scheduled_jobs WHERE id = 'probe-after-failure'").get().lease_owner, null);
});

test("database dispatcher anchors real execution failure backoff to the failure clock", async () => {
  sqlite.exec(`
    DELETE FROM scheduled_jobs;
    INSERT INTO scheduled_jobs (id, type, payload, due_at, interval_seconds, updated_at)
    VALUES ('probe-failure', 'system.probe', '{}', '2026-07-21T11:00:00.000Z', 3600, '2026-07-21T11:00:00.000Z')
  `);
  const selectedAt = new Date("2026-07-21T12:00:00.000Z");
  let current = selectedAt;
  const result = await jobDispatcher.runDueScheduledJobs({
    now: selectedAt,
    clock: () => new Date(current),
    execute: async () => {
      current = new Date("2026-07-21T12:02:00.000Z");
      throw new TypeError("synthetic failure");
    },
  });
  assert.deepEqual(result, { claimed: 1, completed: 0, failures: 1, superseded: 0 });
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT due_at AS dueAt, attempt_count AS attemptCount, lease_owner AS leaseOwner,
      last_completed_at AS lastCompletedAt, last_error_type AS lastErrorType
    FROM scheduled_jobs WHERE id = 'probe-failure'
  `).get() }, {
    dueAt: "2026-07-21T12:03:00.000Z",
    attemptCount: 1,
    leaseOwner: null,
    lastCompletedAt: null,
    lastErrorType: "TypeError",
  });
});

function deterministicCaptureUlid(sequence) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `01K000000000000000000000${alphabet[Math.floor(sequence / 32)]}${alphabet[sequence % 32]}`;
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
    return { results: this.database.prepare(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async raw(options = {}) {
    const statement = this.database.prepare(this.sql);
    statement.setReturnArrays(true);
    const rows = statement.all(...this.bindings);
    return options.columnNames ? [statement.columns().map((column) => column.name), ...rows] : rows;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.beforeNextBatch = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.(statements);
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
  }
}
