import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readBuiltWorkerSchema } from "./built-worker-test-helper.mjs";
import {
  appendIsolatedRecoveryEvent,
  readIsolatedRecoveryEvents,
  verifyIsolatedRecoveryEventChain,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-event-journal.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T14:00:00.000Z";

test("la migracion crea un diario inmutable y protege su trabajo padre", async () => {
  const db = await recoveryDatabase();
  const first = appendIsolatedRecoveryEvent(db, preparedInput());
  assert.equal(first.changed, true);
  assert.equal(first.event.eventSha256.length, 64);
  assert.equal(first.event.evidenceVersion, 2);
  assert.equal(first.event.preRestoreBackupSha256, null);
  assert.equal(first.event.postRestoreSha256, null);
  const triggers = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'restore_recovery_events' ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(triggers, ["restore_recovery_events_no_delete", "restore_recovery_events_no_update"]);
  assert.throws(() => db.prepare("UPDATE restore_recovery_events SET job_status = 'failed'").run(), /append_only/);
  assert.throws(() => db.prepare("DELETE FROM restore_recovery_events").run(), /append_only/);
  assert.throws(() => db.prepare("DELETE FROM restore_recovery_jobs WHERE id = 'recovery-1'").run(), /FOREIGN KEY/);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close();
});

test("la evidencia v2 encadena las huellas del snapshot y detecta su alteracion", async () => {
  const db = await recoveryDatabase();
  let head = appendIsolatedRecoveryEvent(db, preparedInput()).event;
  db.prepare(`
    UPDATE restore_recovery_jobs SET pre_restore_backup_sha256 = ? WHERE id = 'recovery-1'
  `).run("e".repeat(64));
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "lease_claimed",
    jobAttemptCount: 1,
  })).event;
  assert.equal(head.evidenceVersion, 2);
  assert.equal(head.preRestoreBackupSha256, "e".repeat(64));
  assert.equal(head.postRestoreSha256, null);

  db.prepare(`
    UPDATE restore_recovery_jobs SET post_restore_sha256 = ? WHERE id = 'recovery-1'
  `).run("e".repeat(64));
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { eventType: "lease_renewed" })).event;
  assert.equal(head.preRestoreBackupSha256, "e".repeat(64));
  assert.equal(head.postRestoreSha256, "e".repeat(64));
  assert.equal(verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard }).valid, true);

  db.exec("DROP TRIGGER restore_recovery_events_no_update");
  db.prepare(`
    UPDATE restore_recovery_events SET post_restore_sha256 = ?
    WHERE recovery_job_id = 'recovery-1' AND sequence_number = 2
  `).run("f".repeat(64));
  const altered = verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard });
  assert.equal(altered.valid, false);
  assert.equal(altered.reason, "hash_mismatch");
  assert.equal(altered.invalidSequenceNumber, 2);
  db.close();
});

test("la migracion conserva cadenas v1 y permite continuar con evidencia v2", async () => {
  const db = new DatabaseSync(":memory:");
  await applyMigrations(db, (name) => name === "0000_public_schema.sql");
  db.exec("PRAGMA foreign_keys = ON");
  seedRecovery(db);
  const input = preparedInput();
  const eventSha256 = hashLegacyEvent(input);
  db.prepare(`
    INSERT INTO restore_recovery_events (
      id, recovery_job_id, sequence_number, event_type, job_status, job_attempt_count,
      import_job_id, object_status, failure_code, copied_object_count,
      compensated_object_count, applied_row_count, verified_row_count, occurred_at,
      previous_event_sha256, event_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventSha256,
    input.recoveryJobId,
    input.sequenceNumber,
    input.eventType,
    input.jobStatus,
    input.jobAttemptCount,
    input.importJobId,
    input.objectStatus,
    input.failureCode,
    input.copiedObjectCount,
    input.compensatedObjectCount,
    input.appliedRowCount,
    input.verifiedRowCount,
    input.occurredAt,
    input.previousEventSha256,
    eventSha256,
    input.occurredAt,
  );

  await applyMigrations(db, (name) => name === "0001_public_invariants.sql");
  const legacy = readIsolatedRecoveryEvents(db, { recoveryJobId: "recovery-1", guard });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].evidenceVersion, 1);
  assert.equal(legacy[0].preRestoreBackupSha256, null);
  assert.equal(legacy[0].postRestoreSha256, null);
  assert.equal(verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard }).valid, true);

  const next = appendIsolatedRecoveryEvent(db, nextInput(legacy[0], {
    eventType: "lease_claimed",
    jobAttemptCount: 1,
  }));
  assert.equal(next.changed, true);
  assert.equal(next.event.evidenceVersion, 2);
  assert.equal(verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard }).valid, true);
  const triggers = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'restore_recovery_events' ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(triggers, ["restore_recovery_events_no_delete", "restore_recovery_events_no_update"]);
  db.close();
});

test("el hash es determinista y replay o carrera no duplican una secuencia", async () => {
  const db = await recoveryDatabase();
  const first = appendIsolatedRecoveryEvent(db, preparedInput());
  const replay = appendIsolatedRecoveryEvent(db, preparedInput());
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  assert.equal(replay.event.eventSha256, first.event.eventSha256);

  const winnerInput = nextInput(first.event, { eventType: "lease_claimed", jobAttemptCount: 1 });
  const winner = appendIsolatedRecoveryEvent(db, winnerInput);
  const loser = appendIsolatedRecoveryEvent(db, {
    ...winnerInput,
    eventType: "checkpoint_advanced",
    jobStatus: "copying",
    jobAttemptCount: 0,
  });
  assert.equal(winner.changed, true);
  assert.equal(loser.changed, false);
  assert.equal(loser.reason, "sequence_conflict");
  assert.equal(readIsolatedRecoveryEvents(db, { recoveryJobId: "recovery-1", guard }).length, 2);

  const secondDb = await recoveryDatabase();
  const sameFirst = appendIsolatedRecoveryEvent(secondDb, preparedInput());
  assert.equal(sameFirst.event.eventSha256, first.event.eventSha256);
  db.close();
  secondDb.close();
});

test("la secuencia rechaza saltos, hashes stale, tiempo regresivo e intentos falsos", async () => {
  const db = await recoveryDatabase();
  assert.throws(() => appendIsolatedRecoveryEvent(db, {
    ...preparedInput(), eventType: "checkpoint_advanced", jobStatus: "copying",
  }), /comenzar con prepared/);
  const first = appendIsolatedRecoveryEvent(db, preparedInput()).event;
  assert.throws(() => appendIsolatedRecoveryEvent(db, {
    ...nextInput(first, { jobStatus: "copying" }), sequenceNumber: 2,
  }), /avanzar exactamente uno/);
  assert.throws(() => appendIsolatedRecoveryEvent(db, {
    ...nextInput(first, { jobStatus: "copying" }), previousEventSha256: "f".repeat(64),
  }), /cabeza vigente/);
  assert.throws(() => appendIsolatedRecoveryEvent(db, {
    ...nextInput(first, { jobStatus: "copying" }), occurredAt: "2026-07-18T13:59:59.000Z",
  }), /no puede retroceder/);
  const lease = appendIsolatedRecoveryEvent(db, nextInput(first, {
    eventType: "lease_claimed", jobAttemptCount: 1,
  })).event;
  assert.throws(() => appendIsolatedRecoveryEvent(db, nextInput(lease, {
    jobStatus: "copying", jobAttemptCount: 2,
  })), /Solo claim\/recovery/);
  assert.throws(() => appendIsolatedRecoveryEvent(db, nextInput(lease, {
    eventType: "object_verified", jobStatus: "copying", importJobId: "import-1", objectStatus: "verified",
  })), /avanzar exactamente un original/);
  db.close();
});

test("una ruta exitosa produce una cadena verificable y terminal", async () => {
  const db = await recoveryDatabase();
  let head = appendIsolatedRecoveryEvent(db, preparedInput()).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { eventType: "lease_claimed", jobAttemptCount: 1 })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { jobStatus: "copying" })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "object_copied", jobStatus: "copying", importJobId: "import-1", objectStatus: "copied",
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "object_verified", jobStatus: "copying", importJobId: "import-1", objectStatus: "verified",
    copiedObjectCount: 1,
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    jobStatus: "applying", appliedRowCount: 42,
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { jobStatus: "verifying" })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    jobStatus: "verifying", verifiedRowCount: 42,
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { eventType: "succeeded", jobStatus: "succeeded" })).event;
  const verification = verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard });
  assert.deepEqual(verification, {
    valid: true,
    reason: "verified",
    eventCount: 9,
    headSha256: head.eventSha256,
    terminal: true,
  });
  assert.throws(() => appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "lease_released", jobStatus: "succeeded",
  })), /fase declarada|terminal/);
  db.close();
});

test("el fallo posterior a copia compensa aunque supere el progreso verificado", async () => {
  const db = await recoveryDatabase();
  let head = appendIsolatedRecoveryEvent(db, preparedInput()).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { eventType: "lease_claimed", jobAttemptCount: 1 })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, { jobStatus: "copying" })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "object_copied", jobStatus: "copying", importJobId: "import-1", objectStatus: "copied",
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "object_failed", jobStatus: "compensating", importJobId: "import-1", objectStatus: "failed",
    failureCode: "original_hash_mismatch",
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "object_compensated", jobStatus: "compensating", importJobId: "import-1", objectStatus: "compensated",
    compensatedObjectCount: 1,
  })).event;
  head = appendIsolatedRecoveryEvent(db, nextInput(head, {
    eventType: "failed", jobStatus: "failed", failureCode: "original_hash_mismatch",
  })).event;
  assert.equal(head.compensatedObjectCount, 1);
  assert.equal(head.copiedObjectCount, 0);
  assert.equal(verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard }).valid, true);
  db.close();
});

test("la cadena detecta alteracion incluso si un administrador retira el trigger", async () => {
  const db = await recoveryDatabase();
  const first = appendIsolatedRecoveryEvent(db, preparedInput()).event;
  appendIsolatedRecoveryEvent(db, nextInput(first, { eventType: "lease_claimed", jobAttemptCount: 1 }));
  db.exec("DROP TRIGGER restore_recovery_events_no_update");
  db.prepare(`
    UPDATE restore_recovery_events SET occurred_at = '2026-07-18T14:00:09.000Z'
    WHERE recovery_job_id = 'recovery-1' AND sequence_number = 1
  `).run();
  const result = verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "hash_mismatch");
  assert.equal(result.invalidSequenceNumber, 1);
  db.close();
});

test("el diario rechaza secretos y permanece fuera de API, Worker y R2", async () => {
  const db = await recoveryDatabase();
  for (const forbidden of ["destinationObjectKey", "leaseToken", "message", "stack", "payload"]) {
    assert.throws(() => appendIsolatedRecoveryEvent(db, {
      ...preparedInput(), [forbidden]: "sensible",
    }), new RegExp(`no admite el campo ${forbidden}`));
  }
  assert.throws(() => appendIsolatedRecoveryEvent(db, {
    ...preparedInput(), failureCode: "mensaje_sql_interno",
  }), /codigo de falla no corresponde/);
  const missing = appendIsolatedRecoveryEvent(db, { ...preparedInput(), recoveryJobId: "missing" });
  assert.equal(missing.reason, "not_found");

  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-event-journal.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /destinationObjectKey|leaseToken|\.put\(|\.delete\(|copy_original|INSERT INTO import_jobs/);
  assert.doesNotMatch(route, /isolated-recovery-event-journal|appendIsolatedRecoveryEvent/);
  assert.doesNotMatch(worker, /appendIsolatedRecoveryEvent|verifyIsolatedRecoveryEventChain/);
  assert.match(workerSchema, /restore_recovery_events_hashes_check/);
  db.close();
});

async function recoveryDatabase() {
  const db = new DatabaseSync(":memory:");
  await applyMigrations(db);
  db.exec("PRAGMA foreign_keys = ON");
  seedRecovery(db);
  return db;
}

async function applyMigrations(db, predicate = () => true) {
  for (const name of (await readdir(path.join(root, "drizzle")))
    .filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql" && predicate(entry))
    .sort()) {
    db.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
}

function seedRecovery(db) {
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(T0);
  db.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)").run(T0);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, consumed_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'consumed', ?, ?, ?, ?)
  `).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T14:15:00.000Z", T0, T0, T0);
  db.prepare(`
    INSERT INTO restore_recovery_jobs (
      id, organization_id, field_id, confirmation_token_id, actor_email, backup_sha256,
      snapshot_sha256, plan_sha256, status, execution_enabled, expected_row_count,
      prepared_at, created_at, updated_at
    ) VALUES ('recovery-1', 'org-fundosmart', 'field-1', 'confirmation-1', 'owner@example.com',
      ?, ?, ?, 'prepared', 0, 42, ?, ?, ?)
  `).run("b".repeat(64), "c".repeat(64), "d".repeat(64), T0, T0, T0);
}

function hashLegacyEvent(event) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    recoveryJobId: event.recoveryJobId,
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    jobStatus: event.jobStatus,
    jobAttemptCount: event.jobAttemptCount,
    importJobId: event.importJobId,
    objectStatus: event.objectStatus,
    failureCode: event.failureCode,
    copiedObjectCount: event.copiedObjectCount,
    compensatedObjectCount: event.compensatedObjectCount,
    appliedRowCount: event.appliedRowCount,
    verifiedRowCount: event.verifiedRowCount,
    occurredAt: event.occurredAt,
    previousEventSha256: event.previousEventSha256,
  })).digest("hex");
}

function preparedInput() {
  return {
    recoveryJobId: "recovery-1",
    sequenceNumber: 0,
    eventType: "prepared",
    jobStatus: "prepared",
    jobAttemptCount: 0,
    importJobId: null,
    objectStatus: null,
    failureCode: null,
    copiedObjectCount: 0,
    compensatedObjectCount: 0,
    appliedRowCount: 0,
    verifiedRowCount: 0,
    occurredAt: T0,
    previousEventSha256: null,
    guard,
  };
}

function nextInput(previous, overrides = {}) {
  const sequenceNumber = previous.sequenceNumber + 1;
  return {
    recoveryJobId: previous.recoveryJobId,
    sequenceNumber,
    eventType: "checkpoint_advanced",
    jobStatus: previous.jobStatus,
    jobAttemptCount: previous.jobAttemptCount,
    importJobId: null,
    objectStatus: null,
    failureCode: null,
    copiedObjectCount: previous.copiedObjectCount,
    compensatedObjectCount: previous.compensatedObjectCount,
    appliedRowCount: previous.appliedRowCount,
    verifiedRowCount: previous.verifiedRowCount,
    occurredAt: new Date(Date.parse(T0) + sequenceNumber * 1_000).toISOString(),
    previousEventSha256: previous.eventSha256,
    guard,
    ...overrides,
  };
}
