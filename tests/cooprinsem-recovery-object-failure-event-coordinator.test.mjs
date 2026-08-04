import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import { coordinateIsolatedRecoveryCheckpointEvent } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-checkpoint-event-coordinator.mjs";
import {
  readIsolatedRecoveryEvents,
  verifyIsolatedRecoveryEventChain,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import {
  coordinateIsolatedRecoveryFailedEvent,
  coordinateIsolatedRecoveryFailureStartEvents,
  coordinateIsolatedRecoveryObjectCopyEvent,
  coordinateIsolatedRecoveryObjectProgressEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-failure-event-coordinator.mjs";
import { readIsolatedRecoveryObject } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-simulator.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import {
  coordinateIsolatedRecoveryLeaseEvent,
  coordinateIsolatedRecoveryPreparationEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T17:00:00.000Z";
const times = Array.from({ length: 15 }, (_, index) => new Date(Date.parse(T0) + (index + 1) * 1_000).toISOString());
const TOKEN_HASH = "a".repeat(64);
const OBJECT_KEY = "private/recovery-1/import-1";

test("copia y verificacion confirman objeto, progreso y evento juntos", async () => {
  const db = await copyingDatabase();
  const copied = copyFirst(db, times[2]);
  assert.equal(copied.changed, true);
  assert.equal(copied.event.eventType, "object_copied");
  assert.equal(copied.object.hasDestinationObjectKey, true);
  assert.equal("destinationObjectKey" in copied.event, false);

  const verified = coordinateIsolatedRecoveryObjectProgressEvent(db, progressInput(
    db, copied.event, "verify", times[3], "worker-a",
  ));
  assert.equal(verified.changed, true);
  assert.equal(verified.event.eventType, "object_verified");
  assert.equal(readObject(db).status, "verified");
  assert.equal(readCheckpoint(db).copiedObjectCount, 1);
  assert.equal(readCheckpoint(db).objectCursorImportJobId, "import-1");
  assert.deepEqual(readEvents(db).slice(-2).map((event) => event.eventType), ["object_copied", "object_verified"]);
  assert.equal(verifyChain(db).valid, true);
  assert.doesNotMatch(JSON.stringify(readEvents(db)), /private\/recovery-1/);
  db.close();
});

test("replay de copia no duplica y otra clave desde el mismo estado pierde", async () => {
  const db = await copyingDatabase();
  const expectedJob = readCheckpoint(db);
  const expectedObject = readObject(db);
  const head = readEvents(db).at(-1);
  const input = copyInput(expectedJob, expectedObject, head, OBJECT_KEY, times[2]);
  const first = coordinateIsolatedRecoveryObjectCopyEvent(db, input);
  const replay = coordinateIsolatedRecoveryObjectCopyEvent(db, input);
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  const loser = coordinateIsolatedRecoveryObjectCopyEvent(db, copyInput(
    expectedJob, expectedObject, head, "private/otra-clave", times[2],
  ));
  assert.equal(loser.changed, false);
  assert.equal(loser.reason, "state_conflict");
  assert.equal(readEvents(db).length, 4);
  assert.equal(readObject(db).destinationObjectKey, OBJECT_KEY);
  db.close();
});

test("falla, inicio de compensacion, limpieza y failed forman una cadena atomica", async () => {
  const db = await copyingDatabase();
  let head = copyFirst(db, times[2]).event;
  const failed = coordinateIsolatedRecoveryFailureStartEvents(db, failureStartInput(db, head, times[3]));
  assert.equal(failed.changed, true);
  assert.deepEqual(failed.events.map((event) => event.eventType), ["object_failed", "compensation_started"]);
  head = failed.events.at(-1);

  const compensated = coordinateIsolatedRecoveryObjectProgressEvent(db, progressInput(
    db, head, "compensate", times[4], "worker-a",
  ));
  assert.equal(compensated.changed, true);
  assert.equal(compensated.event.eventType, "object_compensated");
  head = compensated.event;

  const finalInput = finalizationInput(db, head, times[5]);
  const finalized = coordinateIsolatedRecoveryFailedEvent(db, finalInput);
  assert.equal(finalized.changed, true);
  assert.equal(finalized.events[0].eventType, "failed");
  assert.equal(finalized.job.status, "failed");
  assert.equal(finalized.job.leaseActive, false);
  assert.equal("leaseToken" in finalized.job, false);
  assert.equal(finalized.completedAt, times[5]);
  assert.equal(finalized.job.compensatedObjectCount, 1);
  assert.equal(finalized.job.copiedObjectCount, 0);
  assert.equal(readObject(db).status, "compensated");
  assert.deepEqual(readEvents(db).map((event) => event.eventType), [
    "prepared", "lease_claimed", "checkpoint_advanced", "object_copied",
    "object_failed", "compensation_started", "object_compensated", "failed",
  ]);
  assert.doesNotMatch(JSON.stringify(finalized), /worker-a|private\/recovery-1/);
  assert.equal(verifyChain(db).terminal, true);

  const replay = coordinateIsolatedRecoveryFailedEvent(db, finalInput);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  assert.equal(readEvents(db).length, 8);
  db.close();
});

test("un fallo al registrar object_verified revierte objeto y progreso", async () => {
  const db = await copyingDatabase();
  const copied = copyFirst(db, times[2]);
  const beforeJob = readCheckpoint(db);
  const beforeObject = readObject(db);
  db.exec(`
    CREATE TRIGGER force_verified_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'object_verified'
    BEGIN SELECT RAISE(ABORT, 'forced verified event failure'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryObjectProgressEvent(db, progressInput(
    db, copied.event, "verify", times[3], "worker-a",
  )), /forced verified/);
  assert.deepEqual(readCheckpoint(db), beforeJob);
  assert.deepEqual(readObject(db), beforeObject);
  assert.equal(readEvents(db).at(-1).eventType, "object_copied");
  db.close();
});

test("si falla compensation_started se revierten job, objeto y object_failed", async () => {
  const db = await copyingDatabase();
  const copied = copyFirst(db, times[2]);
  const beforeJob = readCheckpoint(db);
  const beforeObject = readObject(db);
  const eventCount = readEvents(db).length;
  db.exec(`
    CREATE TRIGGER force_compensation_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'compensation_started'
    BEGIN SELECT RAISE(ABORT, 'forced compensation event failure'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryFailureStartEvents(db, failureStartInput(
    db, copied.event, times[3],
  )), /forced compensation/);
  assert.deepEqual(readCheckpoint(db), beforeJob);
  assert.deepEqual(readObject(db), beforeObject);
  assert.equal(db.prepare("SELECT failure_code FROM restore_recovery_jobs WHERE id = 'recovery-1'").get().failure_code, null);
  assert.equal(readEvents(db).length, eventCount);
  db.close();
});

test("si falla el evento failed se conservan compensating, lease y cierre nulo", async () => {
  const db = await compensatedDatabase();
  const before = readCheckpoint(db);
  const head = readEvents(db).at(-1);
  const eventCount = readEvents(db).length;
  db.exec(`
    CREATE TRIGGER force_failed_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'failed'
    BEGIN SELECT RAISE(ABORT, 'forced failed event failure'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryFailedEvent(db, finalizationInput(
    db, head, times[6],
  )), /forced failed/);
  const after = readCheckpoint(db);
  assert.deepEqual(after, before);
  assert.equal(after.status, "compensating");
  assert.equal(after.leaseToken, "worker-a");
  assert.equal(db.prepare("SELECT completed_at FROM restore_recovery_jobs WHERE id = 'recovery-1'").get().completed_at, null);
  assert.equal(readEvents(db).length, eventCount);
  db.close();
});

test("lease perdido no muta y los coordinadores permanecen fuera del producto", async () => {
  const db = await copyingDatabase(60_000);
  const staleJob = readCheckpoint(db);
  const staleObject = readObject(db);
  const staleHead = readEvents(db).at(-1);
  const recovered = coordinateIsolatedRecoveryLeaseEvent(db, {
    operation: "claim", jobId: "recovery-1", leaseToken: "worker-b",
    now: "2026-07-18T17:01:02.000Z", ttlMs: 60_000,
    expectedCheckpoint: staleJob, expectedJournalHead: staleHead, guard,
  });
  assert.equal(recovered.changed, true);
  const lost = coordinateIsolatedRecoveryObjectCopyEvent(db, copyInput(
    staleJob, staleObject, staleHead, OBJECT_KEY, "2026-07-18T17:01:03.000Z", "worker-a",
  ));
  assert.equal(lost.changed, false);
  assert.equal(lost.reason, "lease_lost");
  assert.equal(readObject(db).status, "pending");
  assert.equal(readEvents(db).length, 4);

  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-object-failure-event-coordinator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|copy_original|apply_next_batch|INSERT INTO import_jobs/);
  assert.doesNotMatch(route, /isolated-recovery-object-failure-event-coordinator|coordinateIsolatedRecoveryFailedEvent/);
  assert.doesNotMatch(worker, /coordinateIsolatedRecoveryObjectCopyEvent|coordinateIsolatedRecoveryFailedEvent/);
  assert.match(workerSchema, /restore_recovery_events_hashes_check/);
  db.close();
});

async function compensatedDatabase() {
  const db = await copyingDatabase();
  let head = copyFirst(db, times[2]).event;
  const failed = coordinateIsolatedRecoveryFailureStartEvents(db, failureStartInput(db, head, times[3]));
  head = failed.events.at(-1);
  const compensated = coordinateIsolatedRecoveryObjectProgressEvent(db, progressInput(
    db, head, "compensate", times[4], "worker-a",
  ));
  assert.equal(compensated.changed, true);
  return db;
}

async function copyingDatabase(ttlMs = 300_000) {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const prepared = coordinateIsolatedRecoveryPreparationEvent(db, {
    spec: recoverySpec(), tokenSha256: TOKEN_HASH, guard,
  });
  const claimed = coordinateIsolatedRecoveryLeaseEvent(db, {
    operation: "claim", jobId: "recovery-1", leaseToken: "worker-a", now: times[0], ttlMs,
    expectedCheckpoint: readCheckpoint(db), expectedJournalHead: prepared.event, guard,
  });
  const copying = coordinateIsolatedRecoveryCheckpointEvent(db, {
    jobId: "recovery-1", leaseToken: "worker-a", now: times[1],
    expectedCheckpoint: claimed.checkpoint, expectedJournalHead: claimed.event,
    next: {
      status: "copying", objectCursorImportJobId: null, copiedObjectCount: 0,
      appliedRowCount: 0, verifiedRowCount: 0,
    },
    guard,
  });
  assert.equal(copying.changed, true);
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

function seedConfirmation(db) {
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(T0);
  db.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)").run(T0);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(TOKEN_HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T17:15:00.000Z", T0, T0);
}

function recoverySpec() {
  return prepareRecoveryJobSpec({
    jobId: "recovery-1", confirmationTokenId: "confirmation-1",
    binding: {
      actorEmail: "owner@example.com", organizationId: "org-fundosmart", fieldId: "field-1",
      backupSha256: "b".repeat(64), snapshotSha256: "c".repeat(64), planSha256: "d".repeat(64),
    },
    originalFiles: [{ importJobId: "import-1", sha256: "e".repeat(64), fileSizeBytes: 10 }],
    expectedRowCount: 42,
    now: T0,
  });
}

function copyFirst(db, now) {
  return coordinateIsolatedRecoveryObjectCopyEvent(db, copyInput(
    readCheckpoint(db), readObject(db), readEvents(db).at(-1), OBJECT_KEY, now,
  ));
}

function copyInput(expectedJob, expectedObject, head, destinationObjectKey, now, leaseToken = "worker-a") {
  return {
    jobId: "recovery-1", importJobId: "import-1", leaseToken, now,
    expectedJob, expectedObject, expectedJournalHead: head,
    destinationObjectKey, wasPreexisting: false, guard,
  };
}

function progressInput(db, head, operation, now, leaseToken) {
  return {
    operation, jobId: "recovery-1", importJobId: "import-1", leaseToken, now,
    expectedJob: readCheckpoint(db), expectedObject: readObject(db), expectedJournalHead: head,
    guard,
  };
}

function failureStartInput(db, head, now) {
  return {
    jobId: "recovery-1", importJobId: "import-1", leaseToken: "worker-a", now,
    failureCode: "original_hash_mismatch",
    expectedJob: readCheckpoint(db), expectedObject: readObject(db), expectedJournalHead: head,
    guard,
  };
}

function finalizationInput(db, head, now) {
  return {
    jobId: "recovery-1", leaseToken: "worker-a", now,
    failureCode: "original_hash_mismatch",
    expectedJob: readCheckpoint(db), expectedJournalHead: head, guard,
  };
}

function readCheckpoint(db) {
  return readIsolatedRecoveryCheckpoint(db, { jobId: "recovery-1", guard });
}

function readObject(db) {
  return readIsolatedRecoveryObject(db, { jobId: "recovery-1", importJobId: "import-1", guard });
}

function readEvents(db) {
  return readIsolatedRecoveryEvents(db, { recoveryJobId: "recovery-1", guard });
}

function verifyChain(db) {
  return verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard });
}
