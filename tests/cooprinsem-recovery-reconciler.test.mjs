import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { coordinateIsolatedRecoveryCheckpointEvent } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-checkpoint-event-coordinator.mjs";
import {
  appendIsolatedRecoveryEvent,
  readIsolatedRecoveryEvents,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import {
  coordinateIsolatedRecoveryFailedEvent,
  coordinateIsolatedRecoveryFailureStartEvents,
  coordinateIsolatedRecoveryObjectCopyEvent,
  coordinateIsolatedRecoveryObjectProgressEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-failure-event-coordinator.mjs";
import { readIsolatedRecoveryObject } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-simulator.mjs";
import { coordinateIsolatedRecoveryPhaseFailureEvent } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-phase-failure-coordinator.mjs";
import { reconcileIsolatedRecoveryState } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-reconciler.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import {
  coordinateIsolatedRecoveryLeaseEvent,
  coordinateIsolatedRecoveryPreparationEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T18:00:00.000Z";
const times = Array.from({ length: 20 }, (_, index) => new Date(Date.parse(T0) + (index + 1) * 1_000).toISOString());
const TOKEN_HASH = "a".repeat(64);
const OBJECT_KEY = "private/recovery-1/import-1";
const PRE_RESTORE_SHA256 = "1".repeat(64);
const POST_RESTORE_SHA256 = "2".repeat(64);

test("reconcilia una recuperacion exitosa sin escribir ni exponer claves o lease", async () => {
  const db = await successfulDatabase();
  const before = totalChanges(db);
  const result = reconcile(db);
  assert.equal(result.consistent, true);
  assert.equal(result.reason, "reconciled");
  assert.equal(result.chain.terminal, true);
  assert.equal(result.actualJob.status, "succeeded");
  assert.equal(result.actualJob.leaseActive, false);
  assert.equal(result.inventory.statusCounts.verified, 1);
  assert.deepEqual(result.issues, []);
  assert.equal(totalChanges(db), before);
  assert.doesNotMatch(JSON.stringify(result), /worker-a|private\/recovery-1/);
  db.close();
});

test("reconcilia la ruta fallida compensada y su terminalidad", async () => {
  const db = await failedDatabase();
  const result = reconcile(db);
  assert.equal(result.consistent, true);
  assert.equal(result.actualJob.status, "failed");
  assert.equal(result.actualJob.compensatedObjectCount, 1);
  assert.equal(result.actualJob.failureCode, "original_hash_mismatch");
  assert.equal(result.inventory.statusCounts.compensated, 1);
  assert.equal(result.inventory.createdObjectCount, 1);
  assert.deepEqual(result.issues, []);
  db.close();
});

test("detecta estado mutable divergente aunque la cadena siga valida", async () => {
  const db = await successfulDatabase();
  db.prepare("UPDATE restore_recovery_jobs SET copied_object_count = 0 WHERE id = 'recovery-1'").run();
  db.prepare(`
    UPDATE restore_recovery_objects
    SET status = 'copied', verified_at = NULL, updated_at = copied_at
    WHERE recovery_job_id = 'recovery-1' AND import_job_id = 'import-1'
  `).run();
  const result = reconcile(db);
  assert.equal(result.chain.valid, true);
  assert.equal(result.reason, "state_divergence");
  assertIssueCodes(result, ["job_copied_count_mismatch", "object_status_mismatch", "success_inventory_incomplete"]);
  db.close();
});

test("detecta una huella posterior mutable que diverge del diario v2", async () => {
  const db = await successfulDatabase();
  db.prepare(`
    UPDATE restore_recovery_jobs SET post_restore_sha256 = ? WHERE id = 'recovery-1'
  `).run("3".repeat(64));
  const result = reconcile(db);
  assert.equal(result.chain.valid, true);
  assert.equal(result.reason, "state_divergence");
  assertIssueCodes(result, ["job_post_restore_hash_mismatch"]);
  db.close();
});

test("detecta un cierre exitoso v2 sin evidencia posterior", async () => {
  const db = await successfulDatabase({ postRestoreSha256: null });
  const result = reconcile(db);
  assert.equal(result.chain.valid, true);
  assert.equal(result.reason, "state_divergence");
  assertIssueCodes(result, ["success_snapshot_hashes_incomplete"]);
  db.close();
});

test("detecta un fallo de fase terminal cuyo snapshot no fue restaurado", async () => {
  const db = await copyingDatabase();
  const copied = copyFirst(db, times[2]);
  const verified = coordinateIsolatedRecoveryObjectProgressEvent(db, {
    ...progressInput(db, copied.event, "verify", times[3], "worker-a"),
    transitionToApplying: true,
  });
  const started = coordinateIsolatedRecoveryPhaseFailureEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[4],
    failureCode: "schema_drift",
    expectedJob: readCheckpoint(db),
    expectedJournalHead: verified.event,
    guard,
  });
  const compensated = coordinateIsolatedRecoveryObjectProgressEvent(db, progressInput(
    db,
    started.event,
    "compensate",
    times[5],
    "worker-a",
  ));
  const checkpoint = readCheckpoint(db);
  db.prepare(`
    UPDATE restore_recovery_jobs
    SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
      completed_at = ?, updated_at = ?
    WHERE id = 'recovery-1'
  `).run(times[6], times[6]);
  const terminal = appendIsolatedRecoveryEvent(db, {
    recoveryJobId: "recovery-1",
    sequenceNumber: compensated.event.sequenceNumber + 1,
    eventType: "failed",
    jobStatus: "failed",
    jobAttemptCount: checkpoint.attemptCount,
    importJobId: null,
    objectStatus: null,
    failureCode: "schema_drift",
    copiedObjectCount: checkpoint.copiedObjectCount,
    compensatedObjectCount: checkpoint.compensatedObjectCount,
    appliedRowCount: checkpoint.appliedRowCount,
    verifiedRowCount: checkpoint.verifiedRowCount,
    occurredAt: times[6],
    previousEventSha256: compensated.event.eventSha256,
    guard,
  });
  assert.equal(terminal.changed, true);
  const result = reconcile(db);
  assert.equal(result.chain.valid, true);
  assert.equal(result.reason, "state_divergence");
  assertIssueCodes(result, ["failure_snapshot_not_restored"]);
  db.close();
});

test("detiene la derivacion cuando la cadena hash fue alterada", async () => {
  const db = await successfulDatabase();
  db.exec("DROP TRIGGER restore_recovery_events_no_update");
  db.prepare(`
    UPDATE restore_recovery_events SET occurred_at = ?
    WHERE recovery_job_id = 'recovery-1' AND sequence_number = 1
  `).run("2026-07-18T18:00:01.500Z");
  const result = reconcile(db);
  assert.equal(result.consistent, false);
  assert.equal(result.reason, "invalid_chain");
  assert.equal(result.expectedJob, null);
  assertIssueCodes(result, ["journal_hash_mismatch"]);
  db.close();
});

test("detecta progreso e inventario sin eventos de objeto", async () => {
  const db = await copyingDatabase();
  const advanced = advance(db, {
    status: "applying", copiedObjectCount: 1, objectCursorImportJobId: "import-1",
  }, times[2]);
  assert.equal(advanced.changed, true);
  db.prepare(`
    UPDATE restore_recovery_objects
    SET status = 'verified', destination_object_key = ?, attempt_count = 1,
      copied_at = ?, verified_at = ?, updated_at = ?
    WHERE recovery_job_id = 'recovery-1' AND import_job_id = 'import-1'
  `).run(OBJECT_KEY, times[2], times[2], times[2]);
  const result = reconcile(db);
  assert.equal(result.chain.valid, true);
  assertIssueCodes(result, ["verified_event_count_mismatch", "object_event_missing"]);
  db.close();
});

test("detecta un evento que apunta a un objeto inexistente", async () => {
  const db = await copyingDatabase();
  const checkpoint = readCheckpoint(db);
  const head = readEvents(db).at(-1);
  const appended = appendIsolatedRecoveryEvent(db, {
    recoveryJobId: "recovery-1",
    sequenceNumber: head.sequenceNumber + 1,
    eventType: "object_copied",
    jobStatus: checkpoint.status,
    jobAttemptCount: checkpoint.attemptCount,
    importJobId: "import-ghost",
    objectStatus: "copied",
    failureCode: null,
    copiedObjectCount: checkpoint.copiedObjectCount,
    compensatedObjectCount: checkpoint.compensatedObjectCount,
    appliedRowCount: checkpoint.appliedRowCount,
    verifiedRowCount: checkpoint.verifiedRowCount,
    occurredAt: times[2],
    previousEventSha256: head.eventSha256,
    guard,
  });
  assert.equal(appended.changed, true);
  const result = reconcile(db);
  assert.equal(result.chain.valid, true);
  assertIssueCodes(result, ["event_object_missing"]);
  db.close();
});

test("un crash tras copia se reconcilia y una nueva epoca puede continuar", async () => {
  const db = await copyingDatabase(3_000);
  const copied = copyFirst(db, times[2]);
  const afterCrash = reconcile(db);
  assert.equal(afterCrash.consistent, true);
  assert.equal(afterCrash.objects[0].status, "copied");
  assert.equal(afterCrash.actualJob.leaseActive, true);

  const recovered = coordinateIsolatedRecoveryLeaseEvent(db, {
    operation: "claim",
    jobId: "recovery-1",
    leaseToken: "worker-b",
    now: times[4],
    ttlMs: 30_000,
    expectedCheckpoint: readCheckpoint(db),
    expectedJournalHead: copied.event,
    guard,
  });
  assert.equal(recovered.changed, true);
  assert.equal(recovered.event.eventType, "lease_recovered");
  const resumed = reconcile(db);
  assert.equal(resumed.consistent, true);
  assert.equal(resumed.actualJob.attemptCount, 2);
  assert.doesNotMatch(JSON.stringify(resumed), /worker-b|private\/recovery-1/);
  db.close();
});

test("rechaza otro entorno y permanece fuera de API, Worker y escrituras", async () => {
  const db = await migratedDatabase();
  assert.throws(() => reconcileIsolatedRecoveryState(db, {
    recoveryJobId: "recovery-1",
    guard: { target: "d1", productWritesEnabled: false },
  }), /solo admite SQLite aislado/);
  const source = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-reconciler.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(route, /isolated-recovery-reconciler|reconcileIsolatedRecoveryState/);
  assert.doesNotMatch(worker, /isolated-recovery-reconciler|reconcileIsolatedRecoveryState/);
  db.close();
});

async function successfulDatabase({ postRestoreSha256 = POST_RESTORE_SHA256 } = {}) {
  const db = await copyingDatabase();
  let head = copyFirst(db, times[2]).event;
  const verified = coordinateIsolatedRecoveryObjectProgressEvent(db, {
    ...progressInput(db, head, "verify", times[3], "worker-a"),
    transitionToApplying: true,
  });
  assert.equal(verified.changed, true);
  head = verified.event;
  let checkpoint = verified.job;
  const verifying = coordinateIsolatedRecoveryCheckpointEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[4],
    expectedCheckpoint: readCheckpoint(db),
    expectedJournalHead: head,
    next: {
      status: "verifying",
      objectCursorImportJobId: checkpoint.objectCursorImportJobId,
      copiedObjectCount: checkpoint.copiedObjectCount,
      appliedRowCount: 42,
      verifiedRowCount: 0,
    },
    guard,
  });
  assert.equal(verifying.changed, true);
  if (postRestoreSha256 !== null) {
    db.prepare(`
      UPDATE restore_recovery_jobs SET post_restore_sha256 = ? WHERE id = 'recovery-1'
    `).run(postRestoreSha256);
  }
  const succeeded = coordinateIsolatedRecoveryCheckpointEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[5],
    expectedCheckpoint: verifying.checkpoint,
    expectedJournalHead: verifying.event,
    next: {
      status: "succeeded",
      objectCursorImportJobId: "import-1",
      copiedObjectCount: 1,
      appliedRowCount: 42,
      verifiedRowCount: 42,
    },
    guard,
  });
  assert.equal(succeeded.changed, true);
  return db;
}

async function failedDatabase() {
  const db = await copyingDatabase();
  let head = copyFirst(db, times[2]).event;
  const failed = coordinateIsolatedRecoveryFailureStartEvents(db, {
    jobId: "recovery-1",
    importJobId: "import-1",
    leaseToken: "worker-a",
    now: times[3],
    failureCode: "original_hash_mismatch",
    expectedJob: readCheckpoint(db),
    expectedObject: readObject(db),
    expectedJournalHead: head,
    guard,
  });
  assert.equal(failed.changed, true);
  head = failed.events.at(-1);
  const compensated = coordinateIsolatedRecoveryObjectProgressEvent(db, progressInput(
    db, head, "compensate", times[4], "worker-a",
  ));
  assert.equal(compensated.changed, true);
  const finalized = coordinateIsolatedRecoveryFailedEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[5],
    failureCode: "original_hash_mismatch",
    expectedJob: readCheckpoint(db),
    expectedJournalHead: compensated.event,
    guard,
  });
  assert.equal(finalized.changed, true);
  return db;
}

async function copyingDatabase(ttlMs = 300_000) {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const prepared = coordinateIsolatedRecoveryPreparationEvent(db, {
    spec: recoverySpec(), tokenSha256: TOKEN_HASH, guard,
  });
  const claimed = coordinateIsolatedRecoveryLeaseEvent(db, {
    operation: "claim",
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[0],
    ttlMs,
    expectedCheckpoint: readCheckpoint(db),
    expectedJournalHead: prepared.event,
    guard,
  });
  db.prepare(`
    UPDATE restore_recovery_jobs SET
      pre_restore_backup_object_key = 'pre-restore/recovery-1',
      pre_restore_backup_sha256 = ?
    WHERE id = 'recovery-1'
  `).run(PRE_RESTORE_SHA256);
  const copying = coordinateIsolatedRecoveryCheckpointEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[1],
    expectedCheckpoint: claimed.checkpoint,
    expectedJournalHead: claimed.event,
    next: {
      status: "copying",
      objectCursorImportJobId: null,
      copiedObjectCount: 0,
      appliedRowCount: 0,
      verifiedRowCount: 0,
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
  `).run(TOKEN_HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T18:15:00.000Z", T0, T0);
}

function recoverySpec() {
  return prepareRecoveryJobSpec({
    jobId: "recovery-1",
    confirmationTokenId: "confirmation-1",
    binding: {
      actorEmail: "owner@example.com",
      organizationId: "org-fundosmart",
      fieldId: "field-1",
      backupSha256: "b".repeat(64),
      snapshotSha256: "c".repeat(64),
      planSha256: "d".repeat(64),
    },
    originalFiles: [{ importJobId: "import-1", sha256: "e".repeat(64), fileSizeBytes: 10 }],
    expectedRowCount: 42,
    now: T0,
  });
}

function copyFirst(db, now) {
  return coordinateIsolatedRecoveryObjectCopyEvent(db, {
    jobId: "recovery-1",
    importJobId: "import-1",
    leaseToken: "worker-a",
    now,
    expectedJob: readCheckpoint(db),
    expectedObject: readObject(db),
    expectedJournalHead: readEvents(db).at(-1),
    destinationObjectKey: OBJECT_KEY,
    wasPreexisting: false,
    guard,
  });
}

function progressInput(db, head, operation, now, leaseToken) {
  return {
    operation,
    jobId: "recovery-1",
    importJobId: "import-1",
    leaseToken,
    now,
    expectedJob: readCheckpoint(db),
    expectedObject: readObject(db),
    expectedJournalHead: head,
    guard,
  };
}

function advance(db, next, now) {
  return coordinateIsolatedRecoveryCheckpointEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now,
    expectedCheckpoint: readCheckpoint(db),
    expectedJournalHead: readEvents(db).at(-1),
    next: {
      status: next.status ?? readCheckpoint(db).status,
      objectCursorImportJobId: next.objectCursorImportJobId ?? readCheckpoint(db).objectCursorImportJobId,
      copiedObjectCount: next.copiedObjectCount ?? readCheckpoint(db).copiedObjectCount,
      appliedRowCount: next.appliedRowCount ?? readCheckpoint(db).appliedRowCount,
      verifiedRowCount: next.verifiedRowCount ?? readCheckpoint(db).verifiedRowCount,
    },
    guard,
  });
}

function reconcile(db) {
  return reconcileIsolatedRecoveryState(db, { recoveryJobId: "recovery-1", guard });
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

function totalChanges(db) {
  return Number(db.prepare("SELECT total_changes() AS count").get().count);
}

function assertIssueCodes(result, expected) {
  const codes = new Set(result.issues.map((entry) => entry.code));
  for (const code of expected) assert.equal(codes.has(code), true, `falta issue ${code}: ${[...codes].join(", ")}`);
}
