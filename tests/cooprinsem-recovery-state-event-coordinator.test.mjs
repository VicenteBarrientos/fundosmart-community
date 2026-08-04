import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import {
  readIsolatedRecoveryEvents,
  verifyIsolatedRecoveryEventChain,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import { buildRecoveryPreparationStatements } from "../src/modules/integraciones/cooprinsem/server/recovery-job-preparation.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import {
  coordinateIsolatedRecoveryLeaseEvent,
  coordinateIsolatedRecoveryPreparationEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const NOW = "2026-07-18T15:00:00.000Z";
const T1 = "2026-07-18T15:00:01.000Z";
const T30 = "2026-07-18T15:00:30.000Z";
const T91 = "2026-07-18T15:01:31.000Z";
const T92 = "2026-07-18T15:01:32.000Z";
const TOKEN_HASH = "a".repeat(64);
const BACKUP_HASH = "b".repeat(64);
const SNAPSHOT_HASH = "c".repeat(64);
const PLAN_HASH = "d".repeat(64);

test("preparacion y evento prepared se confirman y reproducen juntos", async () => {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const first = coordinateIsolatedRecoveryPreparationEvent(db, preparationInput(recoverySpec()));
  assert.equal(first.changed, true);
  assert.equal(first.reason, "committed");
  assert.equal(first.event.sequenceNumber, 0);
  assert.equal(first.event.eventType, "prepared");
  assert.equal(db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-1'").get().status, "consumed");
  assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_objects").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) AS count FROM audit_log").get().count, 1);

  const replay = coordinateIsolatedRecoveryPreparationEvent(db, preparationInput(recoverySpec({ jobId: "recovery-retry" })));
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  assert.equal(replay.recoveryJobId, "recovery-1");
  assert.equal(replay.event.eventSha256, first.event.eventSha256);
  assert.equal(readEvents(db).length, 1);
  assert.equal(verifyChain(db).valid, true);
  db.close();
});

test("si falla el evento se revierten token, trabajo, objetos y auditoria", async () => {
  const db = await migratedDatabase();
  seedConfirmation(db);
  db.exec(`
    CREATE TRIGGER force_prepared_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'prepared'
    BEGIN SELECT RAISE(ABORT, 'forced prepared event failure'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryPreparationEvent(db, preparationInput(recoverySpec())), /forced prepared/);
  assert.equal(db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-1'").get().status, "active");
  for (const table of ["restore_recovery_jobs", "restore_recovery_objects", "restore_recovery_events", "audit_log"]) {
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
  }
  db.close();
});

test("confirmacion invalida no deja efectos y un trabajo sin evento no se repara", async () => {
  const invalidDb = await migratedDatabase();
  seedConfirmation(invalidDb, "2026-07-18T14:59:59.000Z");
  const invalid = coordinateIsolatedRecoveryPreparationEvent(invalidDb, preparationInput(recoverySpec()));
  assert.equal(invalid.changed, false);
  assert.equal(invalid.reason, "confirmation_invalid");
  assert.equal(invalidDb.prepare("SELECT count(*) AS count FROM restore_recovery_jobs").get().count, 0);
  invalidDb.close();

  const legacyDb = await migratedDatabase();
  seedConfirmation(legacyDb);
  executeBatch(legacyDb, buildRecoveryPreparationStatements(recoverySpec(), TOKEN_HASH));
  const inconsistent = coordinateIsolatedRecoveryPreparationEvent(legacyDb, preparationInput(recoverySpec()));
  assert.equal(inconsistent.changed, false);
  assert.equal(inconsistent.reason, "evidence_inconsistent");
  assert.equal(legacyDb.prepare("SELECT count(*) AS count FROM restore_recovery_events").get().count, 0);
  const conflict = coordinateIsolatedRecoveryPreparationEvent(legacyDb, preparationInput(recoverySpec({ expectedRowCount: 43 })));
  assert.equal(conflict.reason, "preparation_conflict");
  legacyDb.close();
});

test("claim, renew, recovery y release avanzan estado y diario atomicamente", async () => {
  const db = await preparedDatabase();
  let checkpoint = readCheckpoint(db);
  let head = readEvents(db).at(-1);

  const claimed = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput("claim", checkpoint, head, "worker-a", T1));
  assert.equal(claimed.changed, true);
  assert.equal(claimed.event.eventType, "lease_claimed");
  checkpoint = claimed.checkpoint;
  head = claimed.event;

  const renewed = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput("renew", checkpoint, head, "worker-a", T30));
  assert.equal(renewed.event.eventType, "lease_renewed");
  assert.equal(renewed.checkpoint.leaseExpiresAt, "2026-07-18T15:01:30.000Z");
  checkpoint = renewed.checkpoint;
  head = renewed.event;

  const recovered = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput("claim", checkpoint, head, "worker-b", T91));
  assert.equal(recovered.event.eventType, "lease_recovered");
  assert.equal(recovered.checkpoint.attemptCount, 2);
  checkpoint = recovered.checkpoint;
  head = recovered.event;

  const released = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput("release", checkpoint, head, "worker-b", T92));
  assert.equal(released.event.eventType, "lease_released");
  assert.equal(released.checkpoint.leaseToken, null);
  assert.equal(released.checkpoint.leaseExpiresAt, null);

  const events = readEvents(db);
  assert.deepEqual(events.map((event) => event.eventType), [
    "prepared", "lease_claimed", "lease_renewed", "lease_recovered", "lease_released",
  ]);
  assert.deepEqual(events.map((event) => event.jobAttemptCount), [0, 1, 1, 2, 2]);
  assert.equal(verifyChain(db).valid, true);
  assert.doesNotMatch(JSON.stringify(events), /worker-a|worker-b|leaseToken|leaseExpiresAt/);
  db.close();
});

test("replay exacto no duplica y una carrera con otro propietario pierde", async () => {
  const db = await preparedDatabase();
  const expected = readCheckpoint(db);
  const head = readEvents(db).at(-1);
  const input = leaseInput("claim", expected, head, "worker-a", T1);
  const first = coordinateIsolatedRecoveryLeaseEvent(db, input);
  const replay = coordinateIsolatedRecoveryLeaseEvent(db, input);
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  const loser = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput("claim", expected, head, "worker-b", T1));
  assert.equal(loser.changed, false);
  assert.equal(loser.reason, "state_conflict");
  assert.equal(readEvents(db).length, 2);
  assert.equal(readCheckpoint(db).leaseToken, "worker-a");
  db.close();
});

test("un fallo o cabeza stale del diario revierte tambien el lease", async () => {
  const db = await preparedDatabase();
  const preparedHead = readEvents(db).at(-1);
  const claimed = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput(
    "claim", readCheckpoint(db), preparedHead, "worker-a", T1,
  ));
  const before = claimed.checkpoint;
  db.exec(`
    CREATE TRIGGER force_renew_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'lease_renewed'
    BEGIN SELECT RAISE(ABORT, 'forced renew event failure'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryLeaseEvent(db, leaseInput(
    "renew", before, claimed.event, "worker-a", T30,
  )), /forced renew/);
  assert.deepEqual(pickLease(readCheckpoint(db)), pickLease(before));
  assert.equal(readEvents(db).length, 2);
  db.exec("DROP TRIGGER force_renew_event_failure");

  const stale = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput(
    "renew", before, preparedHead, "worker-a", T30,
  ));
  assert.equal(stale.changed, false);
  assert.equal(stale.reason, "evidence_inconsistent");
  assert.deepEqual(pickLease(readCheckpoint(db)), pickLease(before));
  assert.equal(readEvents(db).length, 2);
  db.close();
});

test("el coordinador no persiste secretos ni entra en API, Worker o R2", async () => {
  const db = await preparedDatabase();
  const coordinated = coordinateIsolatedRecoveryLeaseEvent(db, leaseInput(
    "claim", readCheckpoint(db), readEvents(db).at(-1), "worker-secret", T1,
  ));
  assert.equal("leaseToken" in coordinated.event, false);
  assert.equal("leaseExpiresAt" in coordinated.event, false);
  assert.throws(() => coordinateIsolatedRecoveryLeaseEvent(db, {
    ...leaseInput("renew", coordinated.checkpoint, coordinated.event, "worker-secret", T30),
    guard: { target: "production_d1", productWritesEnabled: false },
  }), /SQLite aislado/);

  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-state-event-coordinator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|copy_original|apply_next_batch|INSERT INTO import_jobs/);
  assert.doesNotMatch(route, /isolated-recovery-state-event-coordinator|coordinateIsolatedRecoveryLeaseEvent/);
  assert.doesNotMatch(worker, /coordinateIsolatedRecoveryPreparationEvent|coordinateIsolatedRecoveryLeaseEvent/);
  assert.match(workerSchema, /restore_recovery_events_hashes_check/);
  db.close();
});

async function preparedDatabase() {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const prepared = coordinateIsolatedRecoveryPreparationEvent(db, preparationInput(recoverySpec()));
  assert.equal(prepared.changed, true);
  return db;
}

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql").sort()) {
    db.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function seedConfirmation(db, expiresAt = "2026-07-18T15:15:00.000Z") {
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(NOW);
  db.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)").run(NOW);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(TOKEN_HASH, BACKUP_HASH, SNAPSHOT_HASH, PLAN_HASH, expiresAt, NOW, NOW);
}

function recoverySpec(overrides = {}) {
  return prepareRecoveryJobSpec({
    jobId: overrides.jobId ?? "recovery-1",
    confirmationTokenId: "confirmation-1",
    binding: {
      actorEmail: "owner@example.com",
      organizationId: "org-fundosmart",
      fieldId: "field-1",
      backupSha256: BACKUP_HASH,
      snapshotSha256: SNAPSHOT_HASH,
      planSha256: PLAN_HASH,
    },
    originalFiles: [
      { importJobId: "import-1", sha256: "e".repeat(64), fileSizeBytes: 10 },
      { importJobId: "import-2", sha256: "f".repeat(64), fileSizeBytes: 20 },
    ],
    expectedRowCount: overrides.expectedRowCount ?? 42,
    now: NOW,
  });
}

function preparationInput(spec) {
  return { spec, tokenSha256: TOKEN_HASH, guard };
}

function leaseInput(operation, expectedCheckpoint, expectedJournalHead, leaseToken, now, ttlMs = 60_000) {
  return {
    operation,
    jobId: "recovery-1",
    leaseToken,
    now,
    ttlMs: operation === "release" ? undefined : ttlMs,
    expectedCheckpoint,
    expectedJournalHead,
    guard,
  };
}

function readCheckpoint(db) {
  return readIsolatedRecoveryCheckpoint(db, { jobId: "recovery-1", guard });
}

function readEvents(db) {
  return readIsolatedRecoveryEvents(db, { recoveryJobId: "recovery-1", guard });
}

function verifyChain(db) {
  return verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard });
}

function executeBatch(db, statements) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) db.prepare(statement.sql).run(...statement.params);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function pickLease(checkpoint) {
  return {
    attemptCount: checkpoint.attemptCount,
    leaseToken: checkpoint.leaseToken,
    leaseExpiresAt: checkpoint.leaseExpiresAt,
    updatedAt: checkpoint.updatedAt,
  };
}
