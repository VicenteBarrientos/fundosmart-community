import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import { commitIsolatedRecoveryCheckpoint } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-checkpoint-simulator.mjs";
import {
  claimIsolatedRecoveryLease,
  readIsolatedRecoveryCheckpoint,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T10:00:00.000Z";
const times = Array.from({ length: 8 }, (_, index) => `2026-07-18T10:00:0${index + 1}.000Z`);

test("la ruta exitosa avanza fase, cursor y conteos de forma monotona", async () => {
  const db = await recoveryDatabase();
  claimIsolatedRecoveryLease(db, leaseInput("worker-a", T0, 300_000));
  let checkpoint = readCheckpoint(db);

  checkpoint = commit(db, checkpoint, { status: "copying" }, times[0]).checkpoint;
  checkpoint = commit(db, checkpoint, { copiedObjectCount: 1, objectCursorImportJobId: "import-1" }, times[1]).checkpoint;
  checkpoint = commit(db, checkpoint, { status: "applying", copiedObjectCount: 2, objectCursorImportJobId: "import-2" }, times[2]).checkpoint;
  checkpoint = commit(db, checkpoint, { appliedRowCount: 20 }, times[3]).checkpoint;
  checkpoint = commit(db, checkpoint, { status: "verifying", appliedRowCount: 42 }, times[4]).checkpoint;
  checkpoint = commit(db, checkpoint, { status: "succeeded", verifiedRowCount: 42 }, times[5]).checkpoint;

  assert.deepEqual(progress(checkpoint), {
    status: "succeeded",
    objectCursorImportJobId: "import-2",
    copiedObjectCount: 2,
    appliedRowCount: 42,
    verifiedRowCount: 42,
    expectedRowCount: 42,
  });
  assert.equal(checkpoint.leaseToken, null);
  assert.equal(checkpoint.leaseExpiresAt, null);
  assert.equal(db.prepare("SELECT completed_at FROM restore_recovery_jobs WHERE id = 'recovery-1'").get().completed_at, times[5]);
  db.close();
});

test("dos commits con el mismo checkpoint solo permiten un ganador", async () => {
  const db = await recoveryDatabase();
  setApplying(db, 0);
  claimIsolatedRecoveryLease(db, leaseInput("worker-a", T0, 300_000));
  const expected = readCheckpoint(db);
  const first = commit(db, expected, { appliedRowCount: 10 }, times[0]);
  const second = commit(db, expected, { appliedRowCount: 20 }, times[1]);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.reason, "stale_checkpoint");
  assert.equal(second.checkpoint.appliedRowCount, 10);
  db.close();
});

test("un propietario perdido no puede confirmar progreso despues del recovery", async () => {
  const db = await recoveryDatabase();
  setApplying(db, 0);
  claimIsolatedRecoveryLease(db, leaseInput("worker-a", T0, 60_000));
  const stale = readCheckpoint(db);
  claimIsolatedRecoveryLease(db, leaseInput("worker-b", "2026-07-18T10:01:01.000Z", 60_000));
  const rejected = commit(db, stale, { appliedRowCount: 10 }, "2026-07-18T10:01:02.000Z", "worker-a");
  assert.equal(rejected.changed, false);
  assert.equal(rejected.reason, "lease_lost");
  assert.equal(rejected.checkpoint.appliedRowCount, 0);
  assert.equal(rejected.checkpoint.leaseToken, "worker-b");
  db.close();
});

test("regresiones, saltos de original y transiciones prematuras se rechazan", async () => {
  const applyingDb = await recoveryDatabase();
  setApplying(applyingDb, 10);
  claimIsolatedRecoveryLease(applyingDb, leaseInput("worker-a", T0, 300_000));
  const applying = readCheckpoint(applyingDb);
  assert.throws(() => commit(applyingDb, applying, { appliedRowCount: 9 }, times[0]), /retroceder/);
  assert.throws(() => commit(applyingDb, applying, { status: "verifying", appliedRowCount: 11 }, times[0]), /todas las filas/);
  applyingDb.close();

  const copyingDb = await recoveryDatabase();
  copyingDb.prepare("UPDATE restore_recovery_jobs SET status = 'copying' WHERE id = 'recovery-1'").run();
  claimIsolatedRecoveryLease(copyingDb, leaseInput("worker-a", T0, 300_000));
  const copying = readCheckpoint(copyingDb);
  assert.throws(() => commit(copyingDb, copying, { copiedObjectCount: 2, objectCursorImportJobId: "import-2" }, times[0]), /un original/);
  assert.throws(() => commit(copyingDb, copying, { status: "applying" }, times[0]), /todos los originales/);
  copyingDb.close();
});

test("el checkpoint aislado no contiene acciones y queda fuera de API y Worker", async () => {
  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-checkpoint-simulator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|INSERT INTO import_jobs|copy_original|apply_next_batch/);
  assert.doesNotMatch(route, /isolated-recovery-checkpoint-simulator|commitIsolatedRecoveryCheckpoint/);
  assert.doesNotMatch(worker, /commitIsolatedRecoveryCheckpoint|isolated-recovery-checkpoint-simulator/);
  assert.match(workerSchema, /restore_recovery_jobs_execution_disabled_check/);
});

async function recoveryDatabase() {
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
  `).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T10:15:00.000Z", T0, T0, T0);
  db.prepare(`
    INSERT INTO restore_recovery_jobs (
      id, organization_id, field_id, confirmation_token_id, actor_email, backup_sha256,
      snapshot_sha256, plan_sha256, status, execution_enabled, expected_row_count,
      prepared_at, created_at, updated_at
    ) VALUES ('recovery-1', 'org-fundosmart', 'field-1', 'confirmation-1', 'owner@example.com',
      ?, ?, ?, 'prepared', 0, 42, ?, ?, ?)
  `).run("b".repeat(64), "c".repeat(64), "d".repeat(64), T0, T0, T0);
  for (const [index, importJobId] of ["import-1", "import-2"].entries()) {
    db.prepare(`
      INSERT INTO restore_recovery_objects (
        id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes,
        status, was_preexisting, attempt_count, created_at, updated_at
      ) VALUES (?, 'recovery-1', ?, ?, ?, 10, 'pending', 0, 0, ?, ?)
    `).run(`object-${index}`, importJobId, index, String(index + 1).repeat(64), T0, T0);
  }
  return db;
}

function setApplying(db, appliedRowCount) {
  db.prepare(`
    UPDATE restore_recovery_jobs
    SET status = 'applying', object_cursor_import_job_id = 'import-2',
      copied_object_count = 2, applied_row_count = ?, verified_row_count = 0
    WHERE id = 'recovery-1'
  `).run(appliedRowCount);
}

function readCheckpoint(db) {
  return readIsolatedRecoveryCheckpoint(db, { jobId: "recovery-1", guard });
}

function commit(db, expected, overrides, now, leaseToken = "worker-a") {
  return commitIsolatedRecoveryCheckpoint(db, {
    jobId: "recovery-1",
    leaseToken,
    now,
    expected: checkpointState(expected),
    next: {
      status: overrides.status ?? expected.status,
      objectCursorImportJobId: overrides.objectCursorImportJobId ?? expected.objectCursorImportJobId,
      copiedObjectCount: overrides.copiedObjectCount ?? expected.copiedObjectCount,
      appliedRowCount: overrides.appliedRowCount ?? expected.appliedRowCount,
      verifiedRowCount: overrides.verifiedRowCount ?? expected.verifiedRowCount,
    },
    guard,
  });
}

function checkpointState(checkpoint) {
  return {
    status: checkpoint.status,
    attemptCount: checkpoint.attemptCount,
    objectCursorImportJobId: checkpoint.objectCursorImportJobId,
    copiedObjectCount: checkpoint.copiedObjectCount,
    appliedRowCount: checkpoint.appliedRowCount,
    verifiedRowCount: checkpoint.verifiedRowCount,
    expectedRowCount: checkpoint.expectedRowCount,
  };
}

function progress(checkpoint) {
  const { status, objectCursorImportJobId, copiedObjectCount, appliedRowCount, verifiedRowCount, expectedRowCount } = checkpoint;
  return { status, objectCursorImportJobId, copiedObjectCount, appliedRowCount, verifiedRowCount, expectedRowCount };
}

function leaseInput(leaseToken, now, ttlMs) {
  return { jobId: "recovery-1", leaseToken, now, ttlMs, guard };
}
