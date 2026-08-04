import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import {
  planNextRecoveryAction,
  prepareRecoveryJobSpec,
  recoveryJobCanTransition,
  recoveryLeaseIsClaimable,
  sanitizeRecoveryFailure,
} from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";

const root = process.cwd();
const NOW = "2026-07-18T07:00:00.000Z";
const HASH = "a".repeat(64);

test("prepara un trabajo durable siempre apagado y con originales deterministas", () => {
  const spec = prepareRecoveryJobSpec({
    jobId: "recovery-1",
    confirmationTokenId: "confirmation-1",
    binding: { actorEmail: " Owner@Example.com ", organizationId: "org-fundosmart", fieldId: "field-1", backupSha256: HASH, snapshotSha256: "b".repeat(64), planSha256: "c".repeat(64) },
    originalFiles: [
      { importJobId: "import-1", sha256: "d".repeat(64), fileSizeBytes: 10 },
      { importJobId: "import-2", sha256: "e".repeat(64), fileSizeBytes: 20 },
    ],
    expectedRowCount: 42,
    now: NOW,
  });
  assert.equal(spec.job.executionEnabled, false);
  assert.equal(spec.job.status, "prepared");
  assert.equal(spec.job.actorEmail, "owner@example.com");
  assert.equal(spec.objects.length, 2);
  assert.deepEqual(spec.objects.map((object) => object.sequenceNumber), [0, 1]);
  assert.deepEqual(spec.objects.map((object) => object.status), ["pending", "pending"]);
  assert.throws(() => prepareRecoveryJobSpec({
    jobId: "recovery-2",
    confirmationTokenId: "confirmation-2",
    binding: { actorEmail: "owner@example.com", organizationId: "org-fundosmart", fieldId: "field-1", backupSha256: HASH, snapshotSha256: HASH, planSha256: HASH },
    originalFiles: [{ importJobId: "same", sha256: HASH, fileSizeBytes: 1 }, { importJobId: "same", sha256: HASH, fileSizeBytes: 1 }],
    expectedRowCount: 1,
    now: NOW,
  }), /un solo original/);
});

test("la maquina durable prioriza lease, verificacion inmediata, lotes y compensacion inversa", () => {
  const base = { status: "prepared", executionEnabled: false, expectedRowCount: 10, appliedRowCount: 0, verifiedRowCount: 0, leaseToken: null, leaseExpiresAt: null, preRestoreBackupSha256: null, preRestoreBackupObjectKey: null };
  assert.deepEqual(planNextRecoveryAction(base, [], NOW), { action: "blocked", reason: "execution_disabled" });
  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true, leaseToken: "lease", leaseExpiresAt: "2026-07-18T07:05:00.000Z" }, [], NOW), { action: "busy", reason: "lease_active" });
  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true }, [], NOW), { action: "capture_pre_restore_backup" });
  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true, preRestoreBackupSha256: HASH, preRestoreBackupObjectKey: "private/key" }, [], NOW), { action: "begin_copying" });

  const copying = { ...base, executionEnabled: true, status: "copying" };
  const pending = { importJobId: "pending", sequenceNumber: 1, status: "pending", attemptCount: 0, wasPreexisting: false };
  const copied = { importJobId: "copied", sequenceNumber: 0, status: "copied", attemptCount: 1, wasPreexisting: false };
  assert.deepEqual(planNextRecoveryAction(copying, [pending, copied], NOW), { action: "verify_original", importJobId: "copied", sequenceNumber: 0 });
  assert.deepEqual(planNextRecoveryAction(copying, [pending], NOW), { action: "copy_original", importJobId: "pending", sequenceNumber: 1 });
  assert.deepEqual(planNextRecoveryAction(copying, [{ ...copied, status: "verified" }], NOW), { action: "begin_applying" });
  assert.deepEqual(planNextRecoveryAction(copying, [{ ...pending, status: "failed", attemptCount: 3 }], NOW), { action: "begin_compensation", importJobId: "pending" });

  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true, status: "applying", appliedRowCount: 4 }, [], NOW), { action: "apply_next_batch", remainingRowCount: 6 });
  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true, status: "applying", appliedRowCount: 10 }, [], NOW), { action: "begin_verifying" });
  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true, status: "verifying", verifiedRowCount: 9 }, [], NOW), { action: "verify_next_batch", remainingRowCount: 1 });
  assert.deepEqual(planNextRecoveryAction({ ...base, executionEnabled: true, status: "verifying", verifiedRowCount: 10 }, [], NOW), { action: "finalize_success" });

  const compensating = { ...base, executionEnabled: true, status: "compensating" };
  const created = { importJobId: "created", sequenceNumber: 2, status: "verified", wasPreexisting: false };
  const preexisting = { importJobId: "existing", sequenceNumber: 3, status: "verified", wasPreexisting: true };
  assert.deepEqual(planNextRecoveryAction(compensating, [created, preexisting], NOW), { action: "compensate_original", importJobId: "created", sequenceNumber: 2 });
  assert.deepEqual(planNextRecoveryAction(compensating, [{ ...created, status: "compensated" }, preexisting], NOW), { action: "finalize_failure" });
});

test("transiciones, leases y errores publicables conservan invariantes", () => {
  assert.equal(recoveryJobCanTransition("prepared", "copying"), true);
  assert.equal(recoveryJobCanTransition("copying", "applying"), true);
  assert.equal(recoveryJobCanTransition("verifying", "succeeded"), true);
  assert.equal(recoveryJobCanTransition("succeeded", "prepared"), false);
  assert.equal(recoveryJobCanTransition("failed", "copying"), false);
  assert.equal(recoveryLeaseIsClaimable({ leaseToken: "lease", leaseExpiresAt: "2026-07-18T06:59:59.000Z" }, NOW), true);
  assert.equal(recoveryLeaseIsClaimable({ leaseToken: "lease", leaseExpiresAt: "2026-07-18T07:00:01.000Z" }, NOW), false);
  const safe = sanitizeRecoveryFailure({ code: "unexpected", message: "isolated-restores/secret-key" }, "copy");
  assert.deepEqual(safe, { code: "unknown_failure", phase: "copy", retryable: true });
  assert.doesNotMatch(JSON.stringify(safe), /secret-key|isolated-restores/);
  assert.deepEqual(sanitizeRecoveryFailure({ code: "schema_drift" }, "apply"), { code: "schema_drift", phase: "apply", retryable: false });
});

test("la migracion persiste reanudacion pero bloquea por CHECK toda ejecucion", async () => {
  const db = await migratedDatabase();
  seedScopeAndConfirmation(db);
  assert.throws(() => insertJob(db, { id: "job-enabled", executionEnabled: 1 }), /restore_recovery_jobs_execution_disabled_check/);
  insertJob(db, { id: "job-disabled", executionEnabled: 0 });
  assert.equal(db.prepare("SELECT execution_enabled FROM restore_recovery_jobs WHERE id = 'job-disabled'").get().execution_enabled, 0);
  assert.throws(() => insertJob(db, { id: "job-duplicate", executionEnabled: 0 }), /UNIQUE constraint failed/);
  db.prepare(`
    INSERT INTO restore_recovery_objects
      (id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes, status, was_preexisting, attempt_count, created_at, updated_at)
    VALUES ('object-1', 'job-disabled', 'import-not-created-yet', 0, ?, 10, 'pending', 0, 0, ?, ?)
  `).run(HASH, NOW, NOW);
  assert.equal(db.prepare("SELECT import_job_id FROM restore_recovery_objects WHERE id = 'object-1'").get().import_job_id, "import-not-created-yet");
  assert.throws(() => db.prepare(`
    INSERT INTO restore_recovery_objects
      (id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes, status, was_preexisting, attempt_count, created_at, updated_at)
    VALUES ('object-invalid', 'job-disabled', 'import-2', 1, ?, 10, 'copied', 0, 0, ?, ?)
  `).run(HASH, NOW, NOW), /restore_recovery_objects_key_check/);
  db.close();
});

test("el build incluye el bloqueo SQL pero no un ejecutor ni acciones durables", async () => {
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(route, /restoreRecoveryJobs|planNextRecoveryAction|copy_original/);
  assert.match(workerSchema, /restore_recovery_jobs_execution_disabled_check/);
  assert.doesNotMatch(worker, /capture_pre_restore_backup|begin_compensation|copy_original/);
});

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql").sort()) {
    db.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function seedScopeAndConfirmation(db) {
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(NOW);
  db.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)").run(NOW);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens
      (id, organization_id, field_id, actor_email, token_sha256, backup_sha256, snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at)
    VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'active', '2026-07-18T07:15:00.000Z', ?, ?)
  `).run(HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64), NOW, NOW);
}

function insertJob(db, input) {
  db.prepare(`
    INSERT INTO restore_recovery_jobs
      (id, organization_id, field_id, confirmation_token_id, actor_email, backup_sha256, snapshot_sha256, plan_sha256, status, execution_enabled, expected_row_count, prepared_at, created_at, updated_at)
    VALUES (?, 'org-fundosmart', 'field-1', 'confirmation-1', 'owner@example.com', ?, ?, ?, 'prepared', ?, 10, ?, ?, ?)
  `).run(input.id, "b".repeat(64), "c".repeat(64), "d".repeat(64), input.executionEnabled, NOW, NOW, NOW);
}
