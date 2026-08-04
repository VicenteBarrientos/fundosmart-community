import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  decideSyncMutation,
  stableStringify,
  validateSyncBatch,
  validateSyncMutation,
} from "../src/modules/sync/domain/sync-rules.mjs";
import { dispatchScheduledCandidates } from "../src/modules/sync/domain/job-dispatcher.mjs";
import {
  featureForCapability,
  roleHasCapability,
} from "../src/modules/access/domain/access-rules.mjs";

const root = process.cwd();
const mutation = {
  id: "01J00000000000000000000000",
  fieldId: "field-a",
  entity: "field_observation",
  entityId: "observation-a",
  op: "append",
  payload: { note: "Sin señal", value: 7 },
  clientTs: "2026-07-21T12:00:00.000Z",
  expectedVersion: null,
};

test("sync validates bounded ULID batches and rejects client-side finance", () => {
  assert.equal(validateSyncBatch([mutation]), null);
  assert.match(validateSyncBatch([]), /al menos una/iu);
  assert.match(validateSyncBatch(Array.from({ length: 51 }, () => mutation)), /hasta 50/iu);
  assert.equal(validateSyncMutation(mutation), null);
  assert.match(validateSyncMutation({ ...mutation, id: "not-an-ulid" }), /ULID/iu);
  assert.match(validateSyncMutation({ ...mutation, entity: "financial_expense" }), /financieras/iu);
  assert.match(validateSyncMutation({ ...mutation, entity: "field_note", op: "update" }), /versión/iu);
  assert.equal(stableStringify({ z: 1, a: { d: 2, b: 1 } }), '{"a":{"b":1,"d":2},"z":1}');
});

test("sync accepts the four bounded append-only livestock capture contracts", () => {
  const payloads = {
    livestock_weighing: { lotId: "lot-a", recordedAt: "2026-07-21", entries: [{ animalId: "cow-a", weightKg: 500 }] },
    livestock_health: { animalId: "cow-a", eventType: "treatment", occurredAt: "2026-07-21" },
    livestock_estrus: { animalId: "cow-a", occurredAt: "2026-07-21" },
    livestock_movement: { animalIds: ["cow-a"], occurredAt: "2026-07-21", destinationRup: "RUP-2" },
  };
  for (const [entity, payload] of Object.entries(payloads)) {
    assert.equal(validateSyncMutation({ ...mutation, entity, entityId: `${entity}-a`, payload }), null, entity);
    assert.match(validateSyncMutation({ ...mutation, entity, entityId: `${entity}-a`, payload, op: "update", expectedVersion: mutation.id }), /anexos/iu, entity);
  }
  assert.match(validateSyncMutation({ ...mutation, entity: "livestock_weighing", payload: { ...payloads.livestock_weighing, entries: [] } }), /entre 1 y 40/iu);
  assert.match(validateSyncMutation({ ...mutation, entity: "livestock_movement", payload: { ...payloads.livestock_movement, animalIds: Array(46).fill("cow-a") } }), /entre 1 y 45/iu);
});

test("sync decisions are idempotent, tenant-scoped and conflict-aware", () => {
  assert.deepEqual(decideSyncMutation({
    mutation,
    existing: null,
    latestVersion: null,
    allowedFieldIds: ["field-a"],
  }), { action: "apply", reason: null });

  const applied = { ...mutation, status: "applied", conflictReason: null };
  assert.deepEqual(decideSyncMutation({
    mutation,
    existing: applied,
    latestVersion: null,
    allowedFieldIds: ["field-a"],
  }), { action: "replay", reason: null });
  assert.equal(decideSyncMutation({
    mutation: { ...mutation, payload: { note: "otro valor" } },
    existing: applied,
    latestVersion: null,
    allowedFieldIds: ["field-a"],
  }).action, "reject");
  assert.equal(decideSyncMutation({
    mutation,
    existing: null,
    latestVersion: null,
    allowedFieldIds: ["field-b"],
  }).action, "reject");

  const note = {
    ...mutation,
    id: "01J00000000000000000000001",
    entity: "field_note",
    entityId: "note-a",
    op: "update",
    expectedVersion: "01J00000000000000000000002",
  };
  assert.deepEqual(decideSyncMutation({
    mutation: note,
    existing: null,
    latestVersion: "01J00000000000000000000003",
    allowedFieldIds: ["field-a"],
  }), { action: "conflict", reason: "La nota cambió desde la última sincronización." });
});

test("feature capabilities require both an explicit role grant and a known module", () => {
  assert.equal(roleHasCapability("operator", "trazabilidad:write"), true);
  assert.equal(roleHasCapability("viewer", "trazabilidad:write"), false);
  assert.equal(roleHasCapability("manager", "benchmarking:write"), false);
  assert.equal(roleHasCapability("owner", "benchmarking:write"), true);
  assert.equal(featureForCapability("pastoreo:read"), "pastoreo");
  assert.equal(featureForCapability("operate"), null);
});

test("dispatcher claims due work once and reports observable success and failure", async () => {
  const observations = [];
  const finished = [];
  const candidates = [
    { id: "busy", type: "system.probe" },
    { id: "ok", type: "system.probe" },
    { id: "fail", type: "system.probe" },
  ];
  const result = await dispatchScheduledCandidates(candidates, {
    claim: async (job) => job.id === "busy" ? null : { candidate: job, claim: `lease:${job.id}` },
    execute: async (job) => {
      observations.push(`job.dispatcher.${job.type}:${job.id}`);
      if (job.id === "fail") throw new TypeError("synthetic failure");
    },
    succeed: async (job, lease) => {
      finished.push(`success:${job.id}:${lease}`);
      return "completed";
    },
    fail: async (job, lease, cause) => {
      finished.push(`failure:${job.id}:${lease}:${cause.name}`);
      return "failed";
    },
  });
  assert.deepEqual(result, { claimed: 2, completed: 1, failures: 1, superseded: 0 });
  assert.deepEqual(observations, ["job.dispatcher.system.probe:ok", "job.dispatcher.system.probe:fail"]);
  assert.deepEqual(finished, ["success:ok:lease:ok", "failure:fail:lease:fail:TypeError"]);
});

test("dispatcher treats lost success and failure leases as superseded and continues", async () => {
  const observations = [];
  const succeeded = [];
  const failed = [];
  const candidates = [
    { id: "stale-success" },
    { id: "stale-failure" },
    { id: "next" },
  ];
  const result = await dispatchScheduledCandidates(candidates, {
    claim: async (candidate) => ({ candidate, claim: `lease:${candidate.id}` }),
    execute: async (candidate) => {
      observations.push(candidate.id);
      if (candidate.id === "stale-failure") throw new TypeError("synthetic failure");
    },
    succeed: async (candidate) => {
      succeeded.push(candidate.id);
      return candidate.id === "stale-success" ? "superseded" : "completed";
    },
    fail: async (candidate) => {
      failed.push(candidate.id);
      return "superseded";
    },
  });
  assert.deepEqual(result, { claimed: 3, completed: 1, failures: 0, superseded: 2 });
  assert.deepEqual(observations, ["stale-success", "stale-failure", "next"]);
  assert.deepEqual(succeeded, ["stale-success", "next"]);
  assert.deepEqual(failed, ["stale-failure"]);
});

test("phase 0 migration is additive, tenant-constrained and protects its ledgers", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.exec(`
    INSERT OR IGNORE INTO organizations (id, name) VALUES ('org-a', 'A'), ('org-b', 'B');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('field-a', 'org-a', 'A', 'Osorno', 0, 1, '[]'),
      ('field-b', 'org-b', 'B', 'Osorno', 0, 1, '[]');
  `);

  sqlite.exec(`
    INSERT INTO organization_feature_flags
      (id, organization_id, field_id, feature, enabled, created_by, updated_by)
    VALUES ('feature:org-a:*:analitica', 'org-a', NULL, 'analitica', 1, 'owner-a', 'owner-a');
  `);
  assert.throws(() => sqlite.exec(`
    INSERT INTO organization_feature_flags
      (id, organization_id, field_id, feature, enabled, created_by, updated_by)
    VALUES ('duplicate-global', 'org-a', NULL, 'analitica', 1, 'owner-a', 'owner-a');
  `), /UNIQUE/iu);
  assert.throws(() => sqlite.exec(`
    INSERT INTO organization_feature_flags
      (id, organization_id, field_id, feature, enabled, created_by, updated_by)
    VALUES ('cross-tenant', 'org-a', 'field-b', 'pastoreo', 1, 'owner-a', 'owner-a');
  `), /FOREIGN KEY/iu);

  sqlite.prepare(`
    INSERT INTO sync_mutations
      (id, organization_id, field_id, actor, entity, entity_id, op, payload, client_ts)
    VALUES (?, 'org-a', 'field-a', 'operator-a@example.com', 'field_observation', 'observation-a', 'append', '{}', '2026-07-21T12:00:00.000Z')
  `).run(mutation.id);
  sqlite.prepare(`
    INSERT INTO domain_events
      (id, organization_id, field_id, type, entity, entity_id, payload, source_mutation_id, actor)
    VALUES ('event-a', 'org-a', 'field-a', 'field_observation.created', 'field_observation', 'observation-a', '{}', ?, 'operator-a@example.com')
  `).run(mutation.id);
  sqlite.prepare("UPDATE sync_mutations SET status='applied', applied_at=CURRENT_TIMESTAMP, event_id='event-a', server_version=? WHERE id=?")
    .run(mutation.id, mutation.id);
  assert.throws(() => sqlite.prepare("UPDATE sync_mutations SET payload='{}' WHERE id=?").run(mutation.id), /append_only/iu);
  assert.throws(() => sqlite.prepare("DELETE FROM sync_mutations WHERE id=?").run(mutation.id), /append_only/iu);
  assert.throws(() => sqlite.exec("UPDATE domain_events SET entity_id='changed' WHERE id='event-a'"), /append_only/iu);
  assert.throws(() => sqlite.exec("DELETE FROM domain_events WHERE id='event-a'"), /append_only/iu);
  assert.throws(() => sqlite.exec(`
    INSERT INTO scheduled_jobs (id, type, due_at, interval_seconds) VALUES ('too-fast', 'system.probe', CURRENT_TIMESTAMP, 59)
  `), /scheduled_jobs_interval_check/iu);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  sqlite.close();
});

test("sync APIs and scheduled dispatcher remain behind the shared security boundary", async () => {
  const [route, featureRoute, worker, observability, migration, journal] = await Promise.all([
    source("app/api/sync/route.ts"),
    source("app/api/configuracion/funcionalidades/route.ts"),
    source("worker/index.ts"),
    source("worker/observability.mjs"),
    source("drizzle/0001_public_invariants.sql"),
    source("drizzle/meta/_journal.json"),
  ]);
  assert.match(route, /authorizeApiAccess\("view"\)/u);
  assert.match(route, /authorizeApiAccess\("operate"\)/u);
  assert.match(route, /pullSyncEvents/u);
  assert.match(route, /pushSyncMutations/u);
  assert.match(featureRoute, /authorizeApiAccess\("manage_members"\)/u);
  assert.match(worker, /runDueScheduledJobs/u);
  assert.match(worker, /runObservedScheduledOperation/u);
  assert.match(worker, /job\.dispatcher/u);
  assert.match(observability, /api\.sync/u);
  assert.match(observability, /api\.features/u);
  assert.match(migration, /domain_events_no_update/u);
  assert.match(migration, /sync_mutations_request_immutable/u);
  assert.match(journal, /"idx": 0[\s\S]+"tag": "0000_public_schema"/u);
});

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}
