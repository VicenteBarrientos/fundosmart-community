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
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import {
  coordinateIsolatedRecoveryLeaseEvent,
  coordinateIsolatedRecoveryPreparationEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const T0 = "2026-07-18T16:00:00.000Z";
const times = Array.from({ length: 12 }, (_, index) => new Date(Date.parse(T0) + (index + 1) * 1_000).toISOString());
const TOKEN_HASH = "a".repeat(64);

test("la ruta exitosa confirma cada checkpoint y el cierre con su evento", async () => {
  const db = await preparedAndClaimedDatabase();
  let checkpoint = readCheckpoint(db);
  let head = readEvents(db).at(-1);

  ({ checkpoint, event: head } = advance(db, checkpoint, head, { status: "copying" }, times[1]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    copiedObjectCount: 1, objectCursorImportJobId: "import-1",
  }, times[2]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    status: "applying", copiedObjectCount: 2, objectCursorImportJobId: "import-2",
  }, times[3]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, { appliedRowCount: 20 }, times[4]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    status: "verifying", appliedRowCount: 42,
  }, times[5]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    status: "succeeded", verifiedRowCount: 42,
  }, times[6]));

  assert.equal(checkpoint.status, "succeeded");
  assert.equal(checkpoint.leaseToken, null);
  assert.equal(checkpoint.leaseExpiresAt, null);
  assert.equal(db.prepare("SELECT completed_at FROM restore_recovery_jobs WHERE id = 'recovery-1'").get().completed_at, times[6]);
  const events = readEvents(db);
  assert.deepEqual(events.map((event) => event.eventType), [
    "prepared",
    "lease_claimed",
    "checkpoint_advanced",
    "checkpoint_advanced",
    "checkpoint_advanced",
    "checkpoint_advanced",
    "checkpoint_advanced",
    "succeeded",
  ]);
  assert.equal(events.at(-1).verifiedRowCount, 42);
  assert.equal(events.at(-1).eventSha256, head.eventSha256);
  assert.deepEqual(verifyChain(db), {
    valid: true,
    reason: "verified",
    eventCount: 8,
    headSha256: head.eventSha256,
    terminal: true,
  });
  db.close();
});

test("replay exacto no duplica y otro tiempo desde el mismo estado pierde", async () => {
  const db = await preparedAndClaimedDatabase();
  const expected = readCheckpoint(db);
  const head = readEvents(db).at(-1);
  const input = checkpointInput(expected, head, { status: "copying" }, times[1]);
  const first = coordinateIsolatedRecoveryCheckpointEvent(db, input);
  const replay = coordinateIsolatedRecoveryCheckpointEvent(db, input);
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.reason, "already_committed");
  assert.equal(replay.event.eventSha256, first.event.eventSha256);
  const loser = coordinateIsolatedRecoveryCheckpointEvent(db, checkpointInput(
    expected, head, { status: "copying" }, times[2],
  ));
  assert.equal(loser.changed, false);
  assert.equal(loser.reason, "state_conflict");
  assert.equal(readEvents(db).length, 3);
  db.close();
});

test("si falla el evento se revierte tambien el checkpoint", async () => {
  const db = await preparedAndClaimedDatabase();
  const before = readCheckpoint(db);
  const head = readEvents(db).at(-1);
  db.exec(`
    CREATE TRIGGER force_checkpoint_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'checkpoint_advanced'
    BEGIN SELECT RAISE(ABORT, 'forced checkpoint event failure'); END;
  `);
  assert.throws(() => advance(db, before, head, { status: "copying" }, times[1]), /forced checkpoint/);
  assert.deepEqual(readCheckpoint(db), before);
  assert.equal(readEvents(db).length, 2);
  db.close();
});

test("si falla succeeded se conservan fase, lease y completed_at previos", async () => {
  const db = await preparedAndClaimedDatabase();
  let checkpoint = readCheckpoint(db);
  let head = readEvents(db).at(-1);
  ({ checkpoint, event: head } = advance(db, checkpoint, head, { status: "copying" }, times[1]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    copiedObjectCount: 1, objectCursorImportJobId: "import-1",
  }, times[2]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    status: "applying", copiedObjectCount: 2, objectCursorImportJobId: "import-2",
  }, times[3]));
  ({ checkpoint, event: head } = advance(db, checkpoint, head, {
    status: "verifying", appliedRowCount: 42,
  }, times[4]));
  const before = checkpoint;
  const eventCount = readEvents(db).length;
  db.exec(`
    CREATE TRIGGER force_success_event_failure
    BEFORE INSERT ON restore_recovery_events
    WHEN NEW.event_type = 'succeeded'
    BEGIN SELECT RAISE(ABORT, 'forced success event failure'); END;
  `);
  assert.throws(() => advance(db, checkpoint, head, {
    status: "succeeded", verifiedRowCount: 42,
  }, times[5]), /forced success/);
  const after = readCheckpoint(db);
  assert.deepEqual(after, before);
  assert.equal(after.status, "verifying");
  assert.equal(after.leaseToken, "worker-a");
  assert.equal(db.prepare("SELECT completed_at FROM restore_recovery_jobs WHERE id = 'recovery-1'").get().completed_at, null);
  assert.equal(readEvents(db).length, eventCount);
  db.close();
});

test("lease perdido y cabeza stale no dejan checkpoint ni evento parcial", async () => {
  const db = await preparedAndClaimedDatabase(60_000);
  const staleCheckpoint = readCheckpoint(db);
  const staleHead = readEvents(db).at(-1);
  const recovered = coordinateIsolatedRecoveryLeaseEvent(db, {
    operation: "claim",
    jobId: "recovery-1",
    leaseToken: "worker-b",
    now: "2026-07-18T16:01:02.000Z",
    ttlMs: 60_000,
    expectedCheckpoint: staleCheckpoint,
    expectedJournalHead: staleHead,
    guard,
  });
  assert.equal(recovered.changed, true);

  const lost = coordinateIsolatedRecoveryCheckpointEvent(db, checkpointInput(
    staleCheckpoint, staleHead, { status: "copying" }, "2026-07-18T16:01:03.000Z", "worker-a",
  ));
  assert.equal(lost.changed, false);
  assert.equal(lost.reason, "lease_lost");
  const current = readCheckpoint(db);
  const staleJournal = coordinateIsolatedRecoveryCheckpointEvent(db, checkpointInput(
    current, staleHead, { status: "copying" }, "2026-07-18T16:01:04.000Z", "worker-b",
  ));
  assert.equal(staleJournal.changed, false);
  assert.equal(staleJournal.reason, "evidence_inconsistent");
  assert.deepEqual(readCheckpoint(db), current);
  assert.equal(readEvents(db).length, 3);
  db.close();
});

test("invariantes invalidas se revierten y el coordinador queda fuera del producto", async () => {
  const db = await preparedAndClaimedDatabase();
  const before = readCheckpoint(db);
  const head = readEvents(db).at(-1);
  assert.throws(() => advance(db, before, head, {
    status: "copying", appliedRowCount: 1,
  }, times[1]), /Prepared no puede/);
  assert.deepEqual(readCheckpoint(db), before);
  assert.equal(readEvents(db).length, 2);

  const moduleSource = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "isolated-recovery-checkpoint-event-coordinator.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  const workerSchema = await readBuiltWorkerSchema(root);
  assert.doesNotMatch(moduleSource, /\.put\(|\.delete\(|copy_original|apply_next_batch|INSERT INTO import_jobs/);
  assert.doesNotMatch(route, /isolated-recovery-checkpoint-event-coordinator|coordinateIsolatedRecoveryCheckpointEvent/);
  assert.doesNotMatch(worker, /coordinateIsolatedRecoveryCheckpointEvent|isolated-recovery-checkpoint-event-coordinator/);
  assert.match(workerSchema, /restore_recovery_events_hashes_check/);
  db.close();
});

async function preparedAndClaimedDatabase(ttlMs = 300_000) {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const prepared = coordinateIsolatedRecoveryPreparationEvent(db, {
    spec: recoverySpec(), tokenSha256: TOKEN_HASH, guard,
  });
  assert.equal(prepared.changed, true);
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
  assert.equal(claimed.changed, true);
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
  `).run(TOKEN_HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64), "2026-07-18T16:15:00.000Z", T0, T0);
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
    originalFiles: [
      { importJobId: "import-1", sha256: "e".repeat(64), fileSizeBytes: 10 },
      { importJobId: "import-2", sha256: "f".repeat(64), fileSizeBytes: 20 },
    ],
    expectedRowCount: 42,
    now: T0,
  });
}

function advance(db, expectedCheckpoint, expectedJournalHead, overrides, now) {
  return coordinateIsolatedRecoveryCheckpointEvent(db, checkpointInput(
    expectedCheckpoint, expectedJournalHead, overrides, now,
  ));
}

function checkpointInput(expected, head, overrides, now, leaseToken = "worker-a") {
  return {
    jobId: "recovery-1",
    leaseToken,
    now,
    expectedCheckpoint: expected,
    expectedJournalHead: head,
    next: {
      status: overrides.status ?? expected.status,
      objectCursorImportJobId: overrides.objectCursorImportJobId ?? expected.objectCursorImportJobId,
      copiedObjectCount: overrides.copiedObjectCount ?? expected.copiedObjectCount,
      appliedRowCount: overrides.appliedRowCount ?? expected.appliedRowCount,
      verifiedRowCount: overrides.verifiedRowCount ?? expected.verifiedRowCount,
    },
    guard,
  };
}

function readCheckpoint(db) {
  return readIsolatedRecoveryCheckpoint(db, { jobId: "recovery-1", guard });
}

function readEvents(db) {
  return readIsolatedRecoveryEvents(db, { recoveryJobId: "recovery-1", guard });
}

function verifyChain(db) {
  return verifyIsolatedRecoveryEventChain(db, { recoveryJobId: "recovery-1", guard });
}
