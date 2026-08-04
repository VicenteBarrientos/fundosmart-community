import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { coordinateIsolatedRecoveryCheckpointEvent } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-checkpoint-event-coordinator.mjs";
import { readIsolatedRecoveryEvents } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-lease-simulator.mjs";
import {
  coordinateIsolatedRecoveryFailedEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-object-failure-event-coordinator.mjs";
import {
  coordinateIsolatedRecoveryPhaseFailureEvent,
  recordIsolatedRecoverySnapshotRestored,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-phase-failure-coordinator.mjs";
import { reconcileIsolatedRecoveryState } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-reconciler.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import {
  coordinateIsolatedRecoveryLeaseEvent,
  coordinateIsolatedRecoveryPreparationEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-19T11:00:00.000Z";
const times = Array.from({ length: 10 }, (_, index) => new Date(Date.parse(T0) + (index + 1) * 1_000).toISOString());
const TOKEN_HASH = "a".repeat(64);
const PRE_RESTORE_SHA256 = "e".repeat(64);

test("registra una falla de aplicación atómicamente y el replay no duplica el diario", async () => {
  const db = await applyingDatabase();
  const input = phaseFailureInput(db, times[3], "schema_drift");
  const first = coordinateIsolatedRecoveryPhaseFailureEvent(db, input);
  assert.equal(first.changed, true);
  assert.equal(first.reason, "committed");
  assert.equal(first.job.status, "compensating");
  assert.equal(first.event.eventType, "compensation_started");
  assert.equal(first.event.failureCode, "schema_drift");
  assert.equal(first.productWritesEnabled, false);
  assert.doesNotMatch(JSON.stringify(first), /worker-a|pre-restore\/recovery-1/);
  assert.equal(reconcile(db).consistent, true, JSON.stringify(reconcile(db)));

  const replay = coordinateIsolatedRecoveryPhaseFailureEvent(db, input);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  assert.equal(readEvents(db).filter((event) => event.eventType === "compensation_started").length, 1);
  db.close();
});

test("si falla el evento se revierten también la fase, el código y la huella posterior", async () => {
  const db = await applyingDatabase();
  db.prepare(`
    UPDATE restore_recovery_jobs SET post_restore_sha256 = ? WHERE id = 'recovery-1'
  `).run("f".repeat(64));
  const before = readCheckpoint(db);
  db.exec(`
    CREATE TRIGGER force_phase_failure_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'compensation_started'
    BEGIN SELECT RAISE(ABORT, 'forced phase failure event'); END;
  `);
  assert.throws(() => coordinateIsolatedRecoveryPhaseFailureEvent(
    db,
    phaseFailureInput(db, times[3], "snapshot_changed"),
  ), /forced phase failure event/);
  const after = readCheckpoint(db);
  assert.deepEqual(after, before);
  const row = db.prepare(`
    SELECT failure_code, post_restore_sha256 FROM restore_recovery_jobs WHERE id = 'recovery-1'
  `).get();
  assert.equal(row.failure_code, null);
  assert.equal(row.post_restore_sha256, "f".repeat(64));
  db.close();
});

test("el cierre fatal exige evidencia CAS de que el snapshot previo fue restaurado", async () => {
  const db = await applyingDatabase();
  const started = coordinateIsolatedRecoveryPhaseFailureEvent(
    db,
    phaseFailureInput(db, times[3], "foreign_key_violation"),
  );
  const premature = coordinateIsolatedRecoveryFailedEvent(db, finalizationInput(
    db,
    started.event,
    times[4],
    "foreign_key_violation",
  ));
  assert.equal(premature.changed, false);
  assert.equal(premature.reason, "snapshot_restore_incomplete");
  assert.equal(readCheckpoint(db).status, "compensating");

  assert.throws(() => recordIsolatedRecoverySnapshotRestored(db, {
    ...snapshotInput(db, times[4], "foreign_key_violation"),
    restoredSha256: "f".repeat(64),
  }), /no coincide/);
  const snapshot = snapshotInput(db, times[4], "foreign_key_violation");
  const recorded = recordIsolatedRecoverySnapshotRestored(db, snapshot);
  assert.equal(recorded.changed, true);
  assert.equal(recorded.snapshotRestored, true);
  const replay = recordIsolatedRecoverySnapshotRestored(db, snapshot);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");

  const finalized = coordinateIsolatedRecoveryFailedEvent(db, finalizationInput(
    db,
    recorded.event,
    times[5],
    "foreign_key_violation",
  ));
  assert.equal(finalized.changed, true);
  assert.equal(finalized.job.status, "failed");
  assert.equal(reconcile(db).consistent, true, JSON.stringify(reconcile(db)));
  db.close();
});

test("si falla el evento de snapshot se revierten atomicamente la huella y la fecha", async () => {
  const db = await applyingDatabase();
  coordinateIsolatedRecoveryPhaseFailureEvent(
    db,
    phaseFailureInput(db, times[3], "schema_drift"),
  );
  const before = readCheckpoint(db);
  db.exec(`
    CREATE TRIGGER force_snapshot_evidence_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'checkpoint_advanced' AND NEW.job_status = 'compensating'
    BEGIN SELECT RAISE(ABORT, 'forced snapshot evidence failure'); END;
  `);
  assert.throws(() => recordIsolatedRecoverySnapshotRestored(
    db,
    snapshotInput(db, times[4], "schema_drift"),
  ), /forced snapshot evidence failure/);
  const after = readCheckpoint(db);
  assert.deepEqual(after, before);
  const row = db.prepare(`
    SELECT post_restore_sha256, updated_at FROM restore_recovery_jobs WHERE id = 'recovery-1'
  `).get();
  assert.equal(row.post_restore_sha256, null);
  assert.equal(row.updated_at, before.updatedAt);
  assert.equal(readEvents(db).filter((event) => (
    event.eventType === "checkpoint_advanced" && event.jobStatus === "compensating"
  )).length, 0);
  db.close();
});

test("el coordinador queda aislado de rutas, red y bindings productivos", async () => {
  const source = await readFile(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-phase-failure-coordinator.mjs",
  ), "utf8");
  const route = await readFile(path.join(
    root,
    "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts",
  ), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|--remote|wrangler|env\.(?:DB|FILES)|\.put\(|\.delete\(/i);
  assert.doesNotMatch(route, /isolated-recovery-phase-failure-coordinator|coordinateIsolatedRecoveryPhaseFailureEvent/);
});

async function applyingDatabase() {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const spec = prepareRecoveryJobSpec({
    jobId: "recovery-1",
    confirmationTokenId: "confirmation-1",
    binding: confirmationBinding(),
    originalFiles: [],
    expectedRowCount: 2,
    now: T0,
  });
  const prepared = coordinateIsolatedRecoveryPreparationEvent(db, { spec, tokenSha256: TOKEN_HASH, guard });
  assert.equal(prepared.changed, true);
  db.prepare(`
    UPDATE restore_recovery_jobs
    SET pre_restore_backup_object_key = 'pre-restore/recovery-1', pre_restore_backup_sha256 = ?
    WHERE id = 'recovery-1'
  `).run(PRE_RESTORE_SHA256);
  const claimed = coordinateIsolatedRecoveryLeaseEvent(db, {
    operation: "claim",
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now: times[0],
    ttlMs: 300_000,
    expectedCheckpoint: readCheckpoint(db),
    expectedJournalHead: prepared.event,
    guard,
  });
  assert.equal(claimed.changed, true);
  let checkpoint = claimed.checkpoint;
  let head = claimed.event;
  ({ checkpoint, event: head } = advance(db, checkpoint, head, "copying", times[1]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, "applying", times[2]));
  assert.equal(checkpoint.status, "applying");
  return db;
}

function advance(db, expectedCheckpoint, expectedJournalHead, status, now) {
  return coordinateIsolatedRecoveryCheckpointEvent(db, {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now,
    expectedCheckpoint,
    expectedJournalHead,
    next: {
      status,
      objectCursorImportJobId: expectedCheckpoint.objectCursorImportJobId,
      copiedObjectCount: expectedCheckpoint.copiedObjectCount,
      appliedRowCount: expectedCheckpoint.appliedRowCount,
      verifiedRowCount: expectedCheckpoint.verifiedRowCount,
    },
    guard,
  });
}

function phaseFailureInput(db, now, failureCode) {
  return {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now,
    failureCode,
    expectedJob: readCheckpoint(db),
    expectedJournalHead: readEvents(db).at(-1),
    guard,
  };
}

function snapshotInput(db, now, failureCode) {
  return {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now,
    failureCode,
    expectedJobAttemptCount: readCheckpoint(db).attemptCount,
    expectedJournalHead: readEvents(db).at(-1),
    expectedSha256: PRE_RESTORE_SHA256,
    restoredSha256: PRE_RESTORE_SHA256,
    guard,
  };
}

function finalizationInput(db, head, now, failureCode) {
  return {
    jobId: "recovery-1",
    leaseToken: "worker-a",
    now,
    failureCode,
    expectedJob: readCheckpoint(db),
    expectedJournalHead: head,
    guard,
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
  `).run(TOKEN_HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-19T12:00:00.000Z", T0, T0);
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

function readEvents(db) {
  return readIsolatedRecoveryEvents(db, { recoveryJobId: "recovery-1", guard });
}

function reconcile(db) {
  return reconcileIsolatedRecoveryState(db, { recoveryJobId: "recovery-1", guard });
}
