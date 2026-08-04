import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "../src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import { readIsolatedRecoveryEvents } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import { readIsolatedRecoveryObject } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-simulator.mjs";
import {
  createIsolatedMemoryObjectStore,
  ISOLATED_RECOVERY_PROCESSOR_FORMAT,
  runIsolatedRecoveryProcessorStep,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-processor.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import { coordinateIsolatedRecoveryPreparationEvent } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-19T09:00:00.000Z";
const times = Array.from({ length: 30 }, (_, index) => new Date(Date.parse(T0) + (index + 1) * 1_000).toISOString());
const TOKEN_HASH = "a".repeat(64);

test("orquesta el ciclo durable completo por fronteras reanudables y reconcilia el cierre", async () => {
  const scenario = await recoveryScenario({ expectedRowCount: 5 });
  const actions = [];
  for (let index = 0; index < 11; index += 1) {
    const result = await runStep(scenario, index, { batchSize: 2 });
    actions.push(result.action);
    assert.equal(result.reconciliation.consistent, true, JSON.stringify(result.reconciliation));
    assert.equal(result.productWritesEnabled, false);
    assert.equal(result.remoteWrites, false);
    assert.doesNotMatch(JSON.stringify(result), /worker-a|isolated-recovery\//);
  }
  assert.deepEqual(actions, [
    "lease_claimed",
    "pre_restore_backup_captured",
    "original_copied",
    "original_verified",
    "rows_applied",
    "rows_applied",
    "rows_applied",
    "rows_verified",
    "rows_verified",
    "succeeded",
    "terminal",
  ]);
  const checkpoint = readCheckpoint(scenario.db);
  assert.equal(checkpoint.status, "succeeded");
  assert.equal(checkpoint.appliedRowCount, 5);
  assert.equal(checkpoint.verifiedRowCount, 5);
  assert.equal(checkpoint.leaseToken, null);
  assert.equal(targetRowCount(scenario.db), 5);
  const job = scenario.db.prepare(`
    SELECT pre_restore_backup_object_key, pre_restore_backup_sha256, post_restore_sha256
    FROM restore_recovery_jobs WHERE id = 'recovery-1'
  `).get();
  assert.match(job.pre_restore_backup_object_key, /^pre-restore\//);
  assert.match(job.pre_restore_backup_sha256, /^[a-f0-9]{64}$/);
  assert.match(job.post_restore_sha256, /^[a-f0-9]{64}$/);
  assert.equal(readEvents(scenario.db).at(-1).eventType, "succeeded");
  scenario.db.close();
});

test("reanuda respaldo, copia y aplicación tras una caída sin duplicar efectos", async () => {
  const scenario = await recoveryScenario({ expectedRowCount: 2 });
  await runStep(scenario, 0);

  const captureBackup = scenario.operations.capturePreRestoreBackup;
  let backupCrash = true;
  scenario.operations.capturePreRestoreBackup = async (input) => {
    const result = await captureBackup(input);
    if (backupCrash) {
      backupCrash = false;
      throw new Error("simulated backup crash");
    }
    return result;
  };
  await assert.rejects(() => runStep(scenario, 1), /simulated backup crash/);
  const unrecorded = scenario.db.prepare(`
    SELECT pre_restore_backup_object_key objectKey FROM restore_recovery_jobs WHERE id = 'recovery-1'
  `).get();
  assert.equal(unrecorded.objectKey, null);
  scenario.operations.capturePreRestoreBackup = captureBackup;
  await runStep(scenario, 2);

  let copyCrash = true;
  const durableStore = scenario.objectStore;
  const durablePut = durableStore.put.bind(durableStore);
  durableStore.put = async (key, bytes, metadata) => {
    await durablePut(key, bytes, metadata);
    if (copyCrash && key.startsWith("isolated-recovery/")) {
      copyCrash = false;
      throw new Error("simulated copy crash");
    }
  };
  await assert.rejects(() => runStep(scenario, 3), /simulated copy crash/);
  assert.equal(readObject(scenario.db).status, "pending");
  durableStore.put = durablePut;
  const resumedCopy = await runStep(scenario, 4);
  assert.equal(resumedCopy.action, "original_copied");
  assert.equal(readObject(scenario.db).wasPreexisting, false);
  await runStep(scenario, 5);

  const insert = scenario.db.prepare("INSERT OR IGNORE INTO isolated_processor_target (id) VALUES (?)");
  insert.run(0);
  insert.run(1);
  assert.equal(readCheckpoint(scenario.db).appliedRowCount, 0);
  assert.equal(targetRowCount(scenario.db), 2);
  const resumedApply = await runStep(scenario, 6, { batchSize: 2 });
  assert.equal(resumedApply.status, "verifying");
  assert.equal(targetRowCount(scenario.db), 2);
  const finished = await runStep(scenario, 7, { batchSize: 2 });
  assert.equal(finished.action, "succeeded");
  assert.equal(finished.reconciliation.consistent, true);
  scenario.db.close();
});

test("una huella alterada inicia compensación, elimina solo el objeto creado y cierra failed", async () => {
  const scenario = await recoveryScenario({ expectedRowCount: 1 });
  await runStep(scenario, 0);
  await runStep(scenario, 1);
  await runStep(scenario, 2);
  const objectKey = scenario.objectStore.keys().find((key) => key.startsWith("isolated-recovery/"));
  const stored = await scenario.objectStore.get(objectKey);
  await scenario.objectStore.put(objectKey, new TextEncoder().encode("alterado"), stored.metadata);

  const failed = await runStep(scenario, 3);
  assert.equal(failed.action, "compensation_started");
  assert.equal(failed.status, "compensating");
  const durableDelete = scenario.objectStore.delete.bind(scenario.objectStore);
  let compensationCrash = true;
  scenario.objectStore.delete = async (key) => {
    await durableDelete(key);
    if (compensationCrash) {
      compensationCrash = false;
      throw new Error("simulated compensation crash");
    }
  };
  await assert.rejects(() => runStep(scenario, 4), /simulated compensation crash/);
  assert.equal(readObject(scenario.db).status, "failed");
  assert.equal(await scenario.objectStore.get(objectKey), null);
  scenario.objectStore.delete = durableDelete;
  const compensated = await runStep(scenario, 5);
  assert.equal(compensated.action, "original_compensated");
  assert.equal(await scenario.objectStore.get(objectKey), null);
  const finalized = await runStep(scenario, 6);
  assert.equal(finalized.action, "failed");
  assert.equal(finalized.reconciliation.consistent, true);
  const terminal = await runStep(scenario, 7);
  assert.equal(terminal.action, "terminal");
  assert.equal(terminal.status, "failed");
  assert.deepEqual(readEvents(scenario.db).slice(-4).map((event) => event.eventType), [
    "object_failed", "compensation_started", "object_compensated", "failed",
  ]);
  scenario.db.close();
});

test("una falla de aplicación compensa objetos y restaura el snapshot incluso tras caer después del efecto", async () => {
  const scenario = await recoveryScenario({ expectedRowCount: 2 });
  await runStep(scenario, 0);
  await runStep(scenario, 1);
  await runStep(scenario, 2);
  await runStep(scenario, 3);

  const applyRows = scenario.operations.applyRows;
  scenario.operations.applyRows = async (input) => {
    await applyRows(input);
    throw Object.assign(new Error("detalle sensible del adaptador"), { code: "foreign_key_violation" });
  };
  const started = await runStep(scenario, 4, { batchSize: 2 });
  assert.equal(started.action, "phase_compensation_started");
  assert.equal(started.status, "compensating");
  assert.equal(started.reconciliation.consistent, true, JSON.stringify(started.reconciliation));
  assert.equal(targetRowCount(scenario.db), 2);
  assert.doesNotMatch(JSON.stringify(started), /detalle sensible|foreign_key_violation/);

  const compensated = await runStep(scenario, 5);
  assert.equal(compensated.action, "original_compensated");
  const restore = scenario.operations.restorePreRestoreBackup;
  let restoreCrash = true;
  scenario.operations.restorePreRestoreBackup = async (input) => {
    const result = await restore(input);
    if (restoreCrash) {
      restoreCrash = false;
      throw new Error("simulated restore crash");
    }
    return result;
  };
  await assert.rejects(() => runStep(scenario, 6), /simulated restore crash/);
  assert.equal(targetRowCount(scenario.db), 0);
  assert.equal(scenario.db.prepare(`
    SELECT post_restore_sha256 value FROM restore_recovery_jobs WHERE id = 'recovery-1'
  `).get().value, null);

  scenario.operations.restorePreRestoreBackup = restore;
  const restored = await runStep(scenario, 7);
  assert.equal(restored.action, "snapshot_restored");
  assert.equal(restored.reconciliation.consistent, true);
  const evidence = scenario.db.prepare(`
    SELECT pre_restore_backup_sha256 before_sha, post_restore_sha256 after_sha
    FROM restore_recovery_jobs WHERE id = 'recovery-1'
  `).get();
  assert.equal(evidence.after_sha, evidence.before_sha);

  const finalized = await runStep(scenario, 8);
  assert.equal(finalized.action, "failed");
  assert.equal(finalized.reconciliation.consistent, true);
  assert.deepEqual(readEvents(scenario.db).slice(-4).map((event) => event.eventType), [
    "compensation_started", "object_compensated", "checkpoint_advanced", "failed",
  ]);
  const terminal = await runStep(scenario, 9);
  assert.equal(terminal.status, "failed");
  scenario.db.close();
});

test("una falla de verificación también revierte los datos aplicados antes de cerrar", async () => {
  const scenario = await recoveryScenario({ expectedRowCount: 1 });
  await runStep(scenario, 0);
  await runStep(scenario, 1);
  await runStep(scenario, 2);
  await runStep(scenario, 3);
  const applied = await runStep(scenario, 4);
  assert.equal(applied.status, "verifying");
  assert.equal(targetRowCount(scenario.db), 1);

  scenario.operations.verifyRows = async () => {
    throw Object.assign(new Error("detalle privado de verificación"), { code: "snapshot_changed" });
  };
  const started = await runStep(scenario, 5);
  assert.equal(started.action, "phase_compensation_started");
  assert.equal(started.reconciliation.consistent, true);
  assert.doesNotMatch(JSON.stringify(started), /detalle privado|snapshot_changed/);
  assert.equal((await runStep(scenario, 6)).action, "original_compensated");
  assert.equal((await runStep(scenario, 7)).action, "snapshot_restored");
  assert.equal(targetRowCount(scenario.db), 0);
  const finalized = await runStep(scenario, 8);
  assert.equal(finalized.action, "failed");
  assert.equal(finalized.reconciliation.consistent, true);
  scenario.db.close();
});

test("el guard, el object store y la frontera de producto son obligatorios", async () => {
  const scenario = await recoveryScenario({ expectedRowCount: 0 });
  await assert.rejects(() => runIsolatedRecoveryProcessorStep(scenario.db, {
    ...stepInput(scenario, 0),
    guard: { target: "d1", productWritesEnabled: false },
  }), /solo admite SQLite/);
  await assert.rejects(() => runIsolatedRecoveryProcessorStep(scenario.db, {
    ...stepInput(scenario, 0),
    objectStore: { kind: "remote" },
  }), /object store aislado/);
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  assert.doesNotMatch(route, /isolated-recovery-processor|runIsolatedRecoveryProcessorStep/);
  const source = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-processor.mjs"), "utf8");
  assert.doesNotMatch(source, /--remote|wrangler|fetch\s*\(|env\.(?:DB|FILES)/i);
  assert.match(source, /executionEnabled !== false/);
  scenario.db.close();
});

async function recoveryScenario({ expectedRowCount }) {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const original = new TextEncoder().encode("original cooprinsem");
  const originalSha256 = await sha256Hex(original);
  const spec = prepareRecoveryJobSpec({
    jobId: "recovery-1",
    confirmationTokenId: "confirmation-1",
    binding: confirmationBinding(),
    originalFiles: [{ importJobId: "import-1", sha256: originalSha256, fileSizeBytes: original.byteLength }],
    expectedRowCount,
    now: T0,
  });
  const prepared = coordinateIsolatedRecoveryPreparationEvent(db, { spec, tokenSha256: TOKEN_HASH, guard });
  assert.equal(prepared.changed, true);
  db.exec("CREATE TABLE isolated_processor_target (id INTEGER PRIMARY KEY)");
  const objectStore = createIsolatedMemoryObjectStore();
  const operations = {
    async capturePreRestoreBackup({ jobId, objectStore: store }) {
      const rows = db.prepare("SELECT id FROM isolated_processor_target ORDER BY id").all();
      const bytes = new TextEncoder().encode(JSON.stringify(rows.map((row) => Number(row.id))));
      const objectKey = `pre-restore/${jobId}`;
      await store.put(objectKey, bytes, { kind: "pre_restore" });
      return { objectKey, sha256: await sha256Hex(bytes) };
    },
    async applyRows({ from, to }) {
      const insert = db.prepare("INSERT OR IGNORE INTO isolated_processor_target (id) VALUES (?)");
      for (let index = from; index < to; index += 1) insert.run(index);
      return { appliedThrough: to };
    },
    async verifyRows({ to }) {
      const rows = db.prepare("SELECT id FROM isolated_processor_target WHERE id < ? ORDER BY id").all(to);
      assert.deepEqual(rows.map((row) => Number(row.id)), Array.from({ length: to }, (_, index) => index));
      return {
        verifiedThrough: to,
        ...(to === expectedRowCount ? { postRestoreSha256: await sha256Hex(JSON.stringify(rows)) } : {}),
      };
    },
    async restorePreRestoreBackup({ objectKey, sha256, objectStore: store }) {
      const stored = await store.get(objectKey);
      assert.ok(stored);
      assert.equal(await sha256Hex(stored.bytes), sha256);
      const ids = JSON.parse(new TextDecoder().decode(stored.bytes));
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM isolated_processor_target");
        const insert = db.prepare("INSERT INTO isolated_processor_target (id) VALUES (?)");
        for (const id of ids) insert.run(id);
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      return { restoredSha256: sha256 };
    },
  };
  return {
    db,
    objectStore,
    originalFiles: new Map([["import-1", original]]),
    operations,
  };
}

function runStep(scenario, timeIndex, overrides = {}) {
  return runIsolatedRecoveryProcessorStep(scenario.db, { ...stepInput(scenario, timeIndex), ...overrides });
}

function stepInput(scenario, timeIndex) {
  return {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[timeIndex],
    ttlMs: 300_000,
    batchSize: 2,
    guard,
    objectStore: scenario.objectStore,
    originalFiles: scenario.originalFiles,
    operations: scenario.operations,
  };
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
  `).run(TOKEN_HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-19T10:00:00.000Z", T0, T0);
}

function confirmationBinding() {
  return {
    actorEmail: "owner@example.com",
    organizationId: "org-fundosmart",
    fieldId: "field-1",
    backupSha256: "b".repeat(64),
    snapshotSha256: "c".repeat(64),
    planSha256: "d".repeat(64),
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

function targetRowCount(db) {
  return Number(db.prepare("SELECT count(*) count FROM isolated_processor_target").get().count);
}

assert.equal(ISOLATED_RECOVERY_PROCESSOR_FORMAT, "fundosmart.isolated-recovery-processor.v1");
