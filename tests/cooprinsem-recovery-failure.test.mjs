import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import { coordinateIsolatedRecoveryProgress } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-coordinator.mjs";
import {
  failIsolatedRecoveryObjectAndBeginCompensation,
  finalizeIsolatedRecoveryFailure,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-failure-coordinator.mjs";
import {
  claimIsolatedRecoveryLease,
  readIsolatedRecoveryCheckpoint,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import {
  commitIsolatedRecoveryObjectState,
  readIsolatedRecoveryObject,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-simulator.mjs";
import { planNextRecoveryAction } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T13:00:00.000Z";
const T1 = "2026-07-18T13:00:01.000Z";
const T2 = "2026-07-18T13:00:02.000Z";
const T3 = "2026-07-18T13:00:03.000Z";
const T4 = "2026-07-18T13:00:04.000Z";

test("fallar un objeto creado entra atomicamente en compensacion", async () => {
  const db = await recoveryDatabase(1);
  claim(db, "worker-a", T0, 300_000);
  copyObject(db, "import-1", "private/import-1", T1);
  const input = failureInput(db, "import-1", T2);
  const failed = failIsolatedRecoveryObjectAndBeginCompensation(db, input);
  assert.equal(failed.changed, true);
  assert.equal(failed.job.status, "compensating");
  assert.equal(failed.job.failureCode, "original_hash_mismatch");
  assert.equal(failed.object.status, "failed");
  assert.equal(failed.object.hasDestinationObjectKey, true);
  assert.deepEqual(planNextRecoveryAction(
    { ...readJob(db), executionEnabled: true, leaseToken: null, leaseExpiresAt: null },
    [readObject(db, "import-1")],
    T3,
  ), { action: "compensate_original", importJobId: "import-1", sequenceNumber: 0 });
  const replay = failIsolatedRecoveryObjectAndBeginCompensation(db, input);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  db.close();
});

test("si falla la transicion del trabajo se revierte tambien la falla del objeto", async () => {
  const db = await recoveryDatabase(1);
  claim(db, "worker-a", T0, 300_000);
  copyObject(db, "import-1", "private/import-1", T1);
  db.exec(`
    CREATE TRIGGER force_compensation_transition_failure
    BEFORE UPDATE OF status ON restore_recovery_jobs
    WHEN NEW.status = 'compensating'
    BEGIN SELECT RAISE(ABORT, 'forced compensation transition failure'); END;
  `);
  assert.throws(() => failIsolatedRecoveryObjectAndBeginCompensation(db, failureInput(db, "import-1", T2)), /forced compensation/);
  assert.equal(readObject(db, "import-1").status, "copied");
  assert.equal(readJob(db).status, "copying");
  assert.equal(db.prepare("SELECT failure_code FROM restore_recovery_jobs WHERE id = 'recovery-1'").get().failure_code, null);
  db.close();
});

test("compensar el ultimo objeto permite finalizar failed y limpiar el lease", async () => {
  const db = await recoveryDatabase(1);
  claim(db, "worker-a", T0, 300_000);
  copyObject(db, "import-1", "private/import-1", T1);
  failIsolatedRecoveryObjectAndBeginCompensation(db, failureInput(db, "import-1", T2));
  const compensation = coordinateIsolatedRecoveryProgress(db, {
    operation: "compensate",
    jobId: "recovery-1",
    importJobId: "import-1",
    leaseToken: "worker-a",
    now: T3,
    expectedJob: readJob(db),
    expectedObject: objectState(readObject(db, "import-1")),
    guard,
  });
  assert.equal(compensation.changed, true);
  assert.equal(compensation.job.compensatedObjectCount, 1);
  const finalized = finalizeIsolatedRecoveryFailure(db, finalizationInput(db, T4));
  assert.equal(finalized.changed, true);
  assert.equal(finalized.job.status, "failed");
  assert.equal(finalized.job.leaseActive, false);
  assert.equal(finalized.job.completedAt, T4);
  const replay = finalizeIsolatedRecoveryFailure(db, finalizationInput(db, T4));
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  db.close();
});

test("failed no finaliza con objetos creados pendientes y cerca al propietario perdido", async () => {
  const db = await recoveryDatabase(2);
  db.prepare(`
    UPDATE restore_recovery_jobs SET status = 'compensating', failure_code = 'original_hash_mismatch', copied_object_count = 2
    WHERE id = 'recovery-1'
  `).run();
  seedCreatedState(db, "import-1", "private/import-1", "verified");
  seedCreatedState(db, "import-2", "private/import-2", "verified");
  claim(db, "worker-a", T0, 60_000);
  const second = coordinateIsolatedRecoveryProgress(db, {
    operation: "compensate", jobId: "recovery-1", importJobId: "import-2", leaseToken: "worker-a", now: T1,
    expectedJob: readJob(db), expectedObject: objectState(readObject(db, "import-2")), guard,
  });
  assert.equal(second.changed, true);
  const incomplete = finalizeIsolatedRecoveryFailure(db, finalizationInput(db, T2));
  assert.equal(incomplete.changed, false);
  assert.equal(incomplete.reason, "compensation_incomplete");
  claim(db, "worker-b", "2026-07-18T13:01:01.000Z", 60_000);
  const lost = finalizeIsolatedRecoveryFailure(db, {
    jobId: "recovery-1", leaseToken: "worker-a", expectedJobAttemptCount: 1,
    now: "2026-07-18T13:01:02.000Z", guard,
  });
  assert.equal(lost.changed, false);
  assert.equal(lost.reason, "lease_lost");
  db.close();
});

test("una falla sin objeto creado puede finalizar sin compensacion ficticia", async () => {
  const db = await recoveryDatabase(1);
  claim(db, "worker-a", T0, 300_000);
  const failed = failIsolatedRecoveryObjectAndBeginCompensation(db, failureInput(
    db, "import-1", T1, "original_missing",
  ));
  assert.equal(failed.object.hasDestinationObjectKey, false);
  const finalized = finalizeIsolatedRecoveryFailure(db, finalizationInput(db, T2));
  assert.equal(finalized.changed, true);
  assert.equal(finalized.job.status, "failed");
  assert.equal(finalized.job.compensatedObjectCount, 0);
  db.close();
});

test("el coordinador de fallas no toca R2 ni entra en API o Worker", async () => {
  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-failure-coordinator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|INSERT INTO import_jobs|copy_original|apply_next_batch/);
  assert.doesNotMatch(route, /isolated-recovery-failure-coordinator|finalizeIsolatedRecoveryFailure/);
  assert.doesNotMatch(worker, /failIsolatedRecoveryObjectAndBeginCompensation|finalizeIsolatedRecoveryFailure/);
  assert.match(workerSchema, /restore_recovery_jobs_execution_disabled_check/);
});

async function recoveryDatabase(objectCount) {
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql").sort()) {
    db.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(T0);
  db.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)").run(T0);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, consumed_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'consumed', ?, ?, ?, ?)
  `).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T13:15:00.000Z", T0, T0, T0);
  db.prepare(`
    INSERT INTO restore_recovery_jobs (
      id, organization_id, field_id, confirmation_token_id, actor_email, backup_sha256,
      snapshot_sha256, plan_sha256, status, execution_enabled, expected_row_count,
      prepared_at, created_at, updated_at
    ) VALUES ('recovery-1', 'org-fundosmart', 'field-1', 'confirmation-1', 'owner@example.com',
      ?, ?, ?, 'copying', 0, 42, ?, ?, ?)
  `).run("b".repeat(64), "c".repeat(64), "d".repeat(64), T0, T0, T0);
  for (let index = 0; index < objectCount; index += 1) seedPending(db, index);
  return db;
}

function seedPending(db, index) {
  db.prepare(`
    INSERT INTO restore_recovery_objects (
      id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes,
      status, was_preexisting, attempt_count, created_at, updated_at
    ) VALUES (?, 'recovery-1', ?, ?, ?, 10, 'pending', 0, 0, ?, ?)
  `).run(`object-${index + 1}`, `import-${index + 1}`, index, String(index + 1).repeat(64), T0, T0);
}

function seedCreatedState(db, importJobId, key, status) {
  db.prepare(`
    UPDATE restore_recovery_objects
    SET status = ?, destination_object_key = ?, attempt_count = 1,
      copied_at = ?, verified_at = ?, updated_at = ?
    WHERE recovery_job_id = 'recovery-1' AND import_job_id = ?
  `).run(status, key, T1, status === "verified" ? T2 : null, T2, importJobId);
}

function claim(db, leaseToken, now, ttlMs) {
  return claimIsolatedRecoveryLease(db, { jobId: "recovery-1", leaseToken, now, ttlMs, guard });
}

function copyObject(db, importJobId, key, now) {
  const expected = readObject(db, importJobId);
  return commitIsolatedRecoveryObjectState(db, {
    jobId: "recovery-1", importJobId, leaseToken: "worker-a", expectedJobAttemptCount: 1, now,
    expected: objectState(expected),
    next: objectState({ ...expected, status: "copied", destinationObjectKey: key, attemptCount: expected.attemptCount + 1 }),
    guard,
  });
}

function failureInput(db, importJobId, now, failureCode = "original_hash_mismatch") {
  return {
    jobId: "recovery-1", importJobId, leaseToken: "worker-a", now, failureCode,
    expectedJob: readJob(db), expectedObject: objectState(readObject(db, importJobId)), guard,
  };
}

function finalizationInput(db, now) {
  const job = readJob(db);
  return { jobId: "recovery-1", leaseToken: "worker-a", expectedJobAttemptCount: job.attemptCount, now, guard };
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
