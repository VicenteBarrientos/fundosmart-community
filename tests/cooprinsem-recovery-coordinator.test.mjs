import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import { coordinateIsolatedRecoveryProgress } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-coordinator.mjs";
import {
  claimIsolatedRecoveryLease,
  readIsolatedRecoveryCheckpoint,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import {
  commitIsolatedRecoveryObjectState,
  readIsolatedRecoveryObject,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-simulator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T12:00:00.000Z";
const T1 = "2026-07-18T12:00:01.000Z";
const T2 = "2026-07-18T12:00:02.000Z";
const T3 = "2026-07-18T12:00:03.000Z";
const T4 = "2026-07-18T12:00:04.000Z";

test("verificar un objeto y avanzar el trabajo comparten transaccion e idempotencia", async () => {
  const db = await recoveryDatabase();
  claim(db, "worker-a", T0, 300_000);
  copyObject(db, "import-1", "private/import-1", T1);
  const firstInput = coordinationInput(db, "verify", "import-1", T2);
  const first = coordinateIsolatedRecoveryProgress(db, firstInput);
  assert.equal(first.changed, true);
  assert.equal(first.object.status, "verified");
  assert.equal(first.job.copiedObjectCount, 1);
  assert.equal(first.job.objectCursorImportJobId, "import-1");
  const replay = coordinateIsolatedRecoveryProgress(db, firstInput);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");

  copyObject(db, "import-2", "private/import-2", T3);
  const final = coordinateIsolatedRecoveryProgress(db, {
    ...coordinationInput(db, "verify", "import-2", T4),
    transitionToApplying: true,
  });
  assert.equal(final.changed, true);
  assert.equal(final.job.status, "applying");
  assert.equal(final.job.copiedObjectCount, 2);
  assert.equal(final.object.status, "verified");
  db.close();
});

test("un fallo del checkpoint revierte la verificacion del objeto", async () => {
  const db = await recoveryDatabase();
  claim(db, "worker-a", T0, 300_000);
  copyObject(db, "import-1", "private/import-1", T1);
  db.exec(`
    CREATE TRIGGER force_checkpoint_failure
    BEFORE UPDATE OF copied_object_count ON restore_recovery_jobs
    WHEN NEW.copied_object_count > OLD.copied_object_count
    BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryProgress(db, coordinationInput(db, "verify", "import-1", T2)), /forced checkpoint failure/);
  assert.equal(readObject(db, "import-1").status, "copied");
  const job = readJob(db);
  assert.equal(job.copiedObjectCount, 0);
  assert.equal(job.objectCursorImportJobId, null);
  db.close();
});

test("el propietario perdido no coordina y el nuevo puede reanudar", async () => {
  const db = await recoveryDatabase();
  claim(db, "worker-a", T0, 60_000);
  copyObject(db, "import-1", "private/import-1", T1);
  const stale = coordinationInput(db, "verify", "import-1", T2);
  claim(db, "worker-b", "2026-07-18T12:01:01.000Z", 60_000);
  const rejected = coordinateIsolatedRecoveryProgress(db, {
    ...stale,
    now: "2026-07-18T12:01:02.000Z",
  });
  assert.equal(rejected.changed, false);
  assert.equal(rejected.reason, "lease_lost");
  assert.equal(readObject(db, "import-1").status, "copied");
  const resumed = coordinateIsolatedRecoveryProgress(db, coordinationInput(
    db, "verify", "import-1", "2026-07-18T12:01:03.000Z", "worker-b",
  ));
  assert.equal(resumed.changed, true);
  assert.equal(resumed.job.copiedObjectCount, 1);
  db.close();
});

test("compensar objeto y progreso inverso es atomico y ordenado", async () => {
  const db = await recoveryDatabase();
  db.prepare(`
    UPDATE restore_recovery_jobs
    SET status = 'compensating', copied_object_count = 2,
      object_cursor_import_job_id = 'import-2'
    WHERE id = 'recovery-1'
  `).run();
  seedVerified(db, "import-1", "private/import-1", false);
  seedVerified(db, "import-2", "private/import-2", false);
  claim(db, "worker-a", T0, 300_000);
  assert.throws(() => coordinateIsolatedRecoveryProgress(db, coordinationInput(db, "compensate", "import-1", T1)), /orden inverso/);
  const second = coordinateIsolatedRecoveryProgress(db, coordinationInput(db, "compensate", "import-2", T2));
  assert.equal(second.changed, true);
  assert.equal(second.job.compensatedObjectCount, 1);
  assert.equal(second.job.compensationCursorImportJobId, "import-2");
  const first = coordinateIsolatedRecoveryProgress(db, coordinationInput(db, "compensate", "import-1", T3));
  assert.equal(first.changed, true);
  assert.equal(first.job.compensatedObjectCount, 2);
  assert.equal(first.job.compensationCursorImportJobId, "import-1");
  assert.deepEqual([readObject(db, "import-1").status, readObject(db, "import-2").status], ["compensated", "compensated"]);
  db.close();
});

test("el coordinador no toca R2, no expone claves y queda fuera del Worker", async () => {
  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-coordinator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|INSERT INTO import_jobs|copy_original|apply_next_batch/);
  assert.doesNotMatch(route, /isolated-recovery-coordinator|coordinateIsolatedRecoveryProgress/);
  assert.doesNotMatch(worker, /coordinateIsolatedRecoveryProgress|isolated-recovery-coordinator/);
  assert.match(workerSchema, /restore_recovery_jobs_execution_disabled_check/);
});

async function migratedDatabase(maximumPrefix = null) {
  const db = new DatabaseSync(":memory:");
  const migrations = (await readdir(path.join(root, "drizzle")))
    .filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql")
    .sort();
  for (const name of migrations) {
    if (maximumPrefix && name.slice(0, 4) > maximumPrefix) break;
    await applyMigration(db, name);
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

async function applyMigration(db, name) {
  db.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
}

async function recoveryDatabase() {
  const db = await migratedDatabase();
  seedScopeAndJob(db);
  seedPendingObject(db, "object-1", "import-1", 0);
  seedPendingObject(db, "object-2", "import-2", 1);
  return db;
}

function seedScopeAndJob(db) {
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(T0);
  db.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)").run(T0);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, consumed_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'consumed', ?, ?, ?, ?)
  `).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T12:15:00.000Z", T0, T0, T0);
  db.prepare(`
    INSERT INTO restore_recovery_jobs (
      id, organization_id, field_id, confirmation_token_id, actor_email, backup_sha256,
      snapshot_sha256, plan_sha256, status, execution_enabled, expected_row_count,
      prepared_at, created_at, updated_at
    ) VALUES ('recovery-1', 'org-fundosmart', 'field-1', 'confirmation-1', 'owner@example.com',
      ?, ?, ?, 'copying', 0, 42, ?, ?, ?)
  `).run("b".repeat(64), "c".repeat(64), "d".repeat(64), T0, T0, T0);
}

function seedPendingObject(db, id, importJobId, sequenceNumber) {
  db.prepare(`
    INSERT INTO restore_recovery_objects (
      id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes,
      status, was_preexisting, attempt_count, created_at, updated_at
    ) VALUES (?, 'recovery-1', ?, ?, ?, 10, 'pending', 0, 0, ?, ?)
  `).run(id, importJobId, sequenceNumber, String(sequenceNumber + 1).repeat(64), T0, T0);
}

function seedVerified(db, importJobId, key, wasPreexisting) {
  db.prepare(`
    UPDATE restore_recovery_objects
    SET status = 'verified', destination_object_key = ?, was_preexisting = ?,
      attempt_count = 1, copied_at = ?, verified_at = ?, updated_at = ?
    WHERE recovery_job_id = 'recovery-1' AND import_job_id = ?
  `).run(key, wasPreexisting ? 1 : 0, T1, T2, T2, importJobId);
}

function claim(db, leaseToken, now, ttlMs) {
  return claimIsolatedRecoveryLease(db, { jobId: "recovery-1", leaseToken, now, ttlMs, guard });
}

function copyObject(db, importJobId, key, now) {
  const expected = readObject(db, importJobId);
  return commitIsolatedRecoveryObjectState(db, {
    jobId: "recovery-1",
    importJobId,
    leaseToken: "worker-a",
    expectedJobAttemptCount: 1,
    now,
    expected: objectState(expected),
    next: objectState({ ...expected, status: "copied", destinationObjectKey: key, attemptCount: expected.attemptCount + 1 }),
    guard,
  });
}

function coordinationInput(db, operation, importJobId, now, leaseToken = "worker-a") {
  return {
    operation,
    jobId: "recovery-1",
    importJobId,
    leaseToken,
    now,
    expectedJob: readJob(db),
    expectedObject: objectState(readObject(db, importJobId)),
    guard,
  };
}

function readJob(db) {
  return readIsolatedRecoveryCheckpoint(db, { jobId: "recovery-1", guard });
}

function readObject(db, importJobId) {
  return readIsolatedRecoveryObject(db, { jobId: "recovery-1", importJobId, guard });
}

function objectState(object) {
  return {
    status: object.status,
    destinationObjectKey: object.destinationObjectKey,
    wasPreexisting: object.wasPreexisting,
    attemptCount: object.attemptCount,
    lastErrorCode: object.lastErrorCode,
    copiedAt: object.copiedAt,
    verifiedAt: object.verifiedAt,
    compensatedAt: object.compensatedAt,
  };
}
