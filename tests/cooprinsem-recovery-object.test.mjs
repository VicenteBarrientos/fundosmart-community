import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import {
  commitIsolatedRecoveryObjectState,
  readIsolatedRecoveryObject,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-simulator.mjs";
import { claimIsolatedRecoveryLease } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T11:00:00.000Z";
const T1 = "2026-07-18T11:00:01.000Z";
const T2 = "2026-07-18T11:00:02.000Z";
const T3 = "2026-07-18T11:00:03.000Z";
const T4 = "2026-07-18T11:00:04.000Z";

test("los originales se copian y verifican uno por vez y en orden", async () => {
  const db = await recoveryDatabase();
  claim(db, "worker-a", T0, 300_000);
  const secondPending = readObject(db, "import-2");
  assert.throws(() => commit(db, "import-2", secondPending, {
    status: "copied", destinationObjectKey: "private/import-2", attemptCount: 1,
  }, T1), /en orden/);

  let first = readObject(db, "import-1");
  const copiedFirst = commit(db, "import-1", first, {
    status: "copied", destinationObjectKey: "private/import-1", attemptCount: 1,
  }, T1);
  assert.equal(copiedFirst.changed, true);
  assert.equal(copiedFirst.object.hasDestinationObjectKey, true);
  assert.doesNotMatch(JSON.stringify(copiedFirst.object), /private\/import-1/);
  first = readObject(db, "import-1");
  assert.equal(commit(db, "import-1", first, { status: "verified" }, T2).changed, true);

  let second = readObject(db, "import-2");
  assert.equal(commit(db, "import-2", second, {
    status: "copied", destinationObjectKey: "private/import-2", attemptCount: 1,
  }, T3).changed, true);
  second = readObject(db, "import-2");
  assert.equal(commit(db, "import-2", second, { status: "verified" }, T4).changed, true);
  assert.deepEqual([readObject(db, "import-1").status, readObject(db, "import-2").status], ["verified", "verified"]);
  db.close();
});

test("los fallos usan codigos genericos y respetan el maximo de tres intentos", async () => {
  const db = await recoveryDatabase();
  claim(db, "worker-a", T0, 300_000);
  let object = readObject(db, "import-1");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failed = commit(db, "import-1", object, {
      status: "failed", attemptCount: attempt, lastErrorCode: "original_missing",
    }, `2026-07-18T11:00:0${attempt}.000Z`);
    assert.equal(failed.changed, true);
    assert.equal(failed.object.lastErrorCode, "original_missing");
    object = readObject(db, "import-1");
  }
  assert.throws(() => commit(db, "import-1", object, {
    status: "failed", attemptCount: 4, lastErrorCode: "original_missing",
  }, T4), /agoto/);
  assert.throws(() => commit(db, "import-1", { ...object, attemptCount: 2 }, {
    status: "failed", attemptCount: 3, lastErrorCode: "raw-private-error",
  }, T4), /codigo generico/);
  db.close();
});

test("el propietario perdido no escribe y una carrera del vigente tiene un ganador", async () => {
  const db = await recoveryDatabase();
  claim(db, "worker-a", T0, 60_000);
  const stale = readObject(db, "import-1");
  claim(db, "worker-b", "2026-07-18T11:01:01.000Z", 60_000);
  const lost = commit(db, "import-1", stale, {
    status: "copied", destinationObjectKey: "private/stale", attemptCount: 1,
  }, "2026-07-18T11:01:02.000Z", "worker-a", 1);
  assert.equal(lost.changed, false);
  assert.equal(lost.reason, "lease_lost");
  assert.equal(lost.object.hasDestinationObjectKey, false);

  const current = readObject(db, "import-1");
  const first = commit(db, "import-1", current, {
    status: "copied", destinationObjectKey: "private/winner", attemptCount: 1,
  }, "2026-07-18T11:01:03.000Z", "worker-b", 2);
  const second = commit(db, "import-1", current, {
    status: "copied", destinationObjectKey: "private/loser", attemptCount: 1,
  }, "2026-07-18T11:01:04.000Z", "worker-b", 2);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.reason, "stale_object");
  assert.equal(readObject(db, "import-1").destinationObjectKey, "private/winner");
  db.close();
});

test("la compensacion excluye preexistentes y avanza en orden inverso", async () => {
  const db = await recoveryDatabase();
  db.prepare("UPDATE restore_recovery_jobs SET status = 'compensating' WHERE id = 'recovery-1'").run();
  seedVerifiedObject(db, "object-3", "import-3", 2, "private/import-3", true);
  for (const importJobId of ["import-1", "import-2"]) {
    db.prepare(`
      UPDATE restore_recovery_objects
      SET status = 'verified', destination_object_key = ?, attempt_count = 1,
        copied_at = ?, verified_at = ?, updated_at = ?
      WHERE recovery_job_id = 'recovery-1' AND import_job_id = ?
    `).run(`private/${importJobId}`, T1, T2, T2, importJobId);
  }
  claim(db, "worker-a", T0, 300_000);
  const first = readObject(db, "import-1");
  assert.throws(() => commit(db, "import-1", first, { status: "compensated" }, T3), /orden inverso/);
  const preexisting = readObject(db, "import-3");
  assert.throws(() => commit(db, "import-3", preexisting, { status: "compensated" }, T3), /preexistente/);
  let second = readObject(db, "import-2");
  assert.equal(commit(db, "import-2", second, { status: "compensated" }, T3).changed, true);
  assert.equal(commit(db, "import-1", first, { status: "compensated" }, T4).changed, true);
  assert.equal(readObject(db, "import-3").status, "verified");
  db.close();
});

test("el simulador de objetos no toca R2 ni entra en API o Worker", async () => {
  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-object-simulator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|INSERT INTO import_jobs|copy_original|apply_next_batch/);
  assert.doesNotMatch(route, /isolated-recovery-object-simulator|commitIsolatedRecoveryObjectState/);
  assert.doesNotMatch(worker, /commitIsolatedRecoveryObjectState|isolated-recovery-object-simulator/);
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
  `).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T11:15:00.000Z", T0, T0, T0);
  db.prepare(`
    INSERT INTO restore_recovery_jobs (
      id, organization_id, field_id, confirmation_token_id, actor_email, backup_sha256,
      snapshot_sha256, plan_sha256, status, execution_enabled, expected_row_count,
      prepared_at, created_at, updated_at
    ) VALUES ('recovery-1', 'org-fundosmart', 'field-1', 'confirmation-1', 'owner@example.com',
      ?, ?, ?, 'copying', 0, 42, ?, ?, ?)
  `).run("b".repeat(64), "c".repeat(64), "d".repeat(64), T0, T0, T0);
  seedPendingObject(db, "object-1", "import-1", 0);
  seedPendingObject(db, "object-2", "import-2", 1);
  return db;
}

function seedPendingObject(db, id, importJobId, sequenceNumber) {
  db.prepare(`
    INSERT INTO restore_recovery_objects (
      id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes,
      status, was_preexisting, attempt_count, created_at, updated_at
    ) VALUES (?, 'recovery-1', ?, ?, ?, 10, 'pending', 0, 0, ?, ?)
  `).run(id, importJobId, sequenceNumber, String(sequenceNumber + 1).repeat(64), T0, T0);
}

function seedVerifiedObject(db, id, importJobId, sequenceNumber, key, wasPreexisting) {
  db.prepare(`
    INSERT INTO restore_recovery_objects (
      id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes,
      status, destination_object_key, was_preexisting, attempt_count,
      copied_at, verified_at, created_at, updated_at
    ) VALUES (?, 'recovery-1', ?, ?, ?, 10, 'verified', ?, ?, 1, ?, ?, ?, ?)
  `).run(id, importJobId, sequenceNumber, String(sequenceNumber + 1).repeat(64), key, wasPreexisting ? 1 : 0, T1, T2, T0, T2);
}

function claim(db, leaseToken, now, ttlMs) {
  return claimIsolatedRecoveryLease(db, { jobId: "recovery-1", leaseToken, now, ttlMs, guard });
}

function readObject(db, importJobId) {
  return readIsolatedRecoveryObject(db, { jobId: "recovery-1", importJobId, guard });
}

function commit(db, importJobId, expected, overrides, now, leaseToken = "worker-a", expectedJobAttemptCount = 1) {
  return commitIsolatedRecoveryObjectState(db, {
    jobId: "recovery-1",
    importJobId,
    leaseToken,
    expectedJobAttemptCount,
    now,
    expected: objectState(expected),
    next: objectState({ ...expected, ...overrides }),
    guard,
  });
}

function objectState(object) {
  return {
    status: object.status,
    destinationObjectKey: object.destinationObjectKey ?? null,
    wasPreexisting: object.wasPreexisting === true,
    attemptCount: object.attemptCount,
    lastErrorCode: object.lastErrorCode ?? null,
    copiedAt: object.copiedAt ?? null,
    verifiedAt: object.verifiedAt ?? null,
    compensatedAt: object.compensatedAt ?? null,
  };
}
