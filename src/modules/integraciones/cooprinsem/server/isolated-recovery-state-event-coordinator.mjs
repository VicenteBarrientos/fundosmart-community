import {
  appendIsolatedRecoveryEvent,
} from "./isolated-recovery-event-journal.mjs";
import {
  claimIsolatedRecoveryLease,
  readIsolatedRecoveryCheckpoint,
  releaseIsolatedRecoveryLease,
  renewIsolatedRecoveryLease,
} from "./isolated-recovery-lease-simulator.mjs";
import {
  buildRecoveryPreparationStatements,
  recoveryPreparationMatches,
} from "./recovery-job-preparation.mjs";

const LEASE_OPERATIONS = new Set(["claim", "renew", "release"]);
const CHECKPOINT_FIELDS = [
  "jobId",
  "status",
  "executionEnabled",
  "attemptCount",
  "leaseToken",
  "leaseExpiresAt",
  "objectCursorImportJobId",
  "copiedObjectCount",
  "compensationCursorImportJobId",
  "compensatedObjectCount",
  "appliedRowCount",
  "verifiedRowCount",
  "expectedRowCount",
  "updatedAt",
];

export function coordinateIsolatedRecoveryPreparationEvent(database, input) {
  assertGuard(input?.guard);
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = readPreparedRecovery(database, input.spec?.job?.confirmationTokenId);
    if (existing) {
      if (!recoveryPreparationMatches(camelJob(existing.job), existing.objects.map(camelObject), input.spec)) {
        database.exec("ROLLBACK");
        return preparationResult(false, "preparation_conflict", existing.job.id, null);
      }
      const eventResult = appendIsolatedRecoveryEvent(database, preparedEventInput(existing.job, input.guard));
      database.exec("ROLLBACK");
      if (!eventResult.changed && eventResult.reason === "already_committed") {
        return preparationResult(false, "already_committed", existing.job.id, eventResult.event);
      }
      return preparationResult(false, "evidence_inconsistent", existing.job.id, null);
    }

    const statements = buildRecoveryPreparationStatements(input.spec, input.tokenSha256);
    for (const statement of statements) database.prepare(statement.sql).run(...statement.params);
    const created = readPreparedRecovery(database, input.spec.job.confirmationTokenId);
    if (!created) {
      database.exec("ROLLBACK");
      return preparationResult(false, "confirmation_invalid", null, null);
    }
    if (!recoveryPreparationMatches(camelJob(created.job), created.objects.map(camelObject), input.spec)) {
      database.exec("ROLLBACK");
      return preparationResult(false, "preparation_conflict", created.job.id, null);
    }
    const eventResult = appendIsolatedRecoveryEvent(database, preparedEventInput(created.job, input.guard));
    if (!eventResult.changed) {
      database.exec("ROLLBACK");
      return preparationResult(false, "evidence_inconsistent", created.job.id, null);
    }
    database.exec("COMMIT");
    return preparationResult(true, "committed", created.job.id, eventResult.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function coordinateIsolatedRecoveryLeaseEvent(database, input) {
  assertGuard(input?.guard);
  const operation = String(input.operation ?? "");
  if (!LEASE_OPERATIONS.has(operation)) throw new Error("Operacion coordinada de lease desconocida.");
  const expected = input.expectedCheckpoint;
  const expectedJournalHead = input.expectedJournalHead;
  assertExpectedLeaseState(expected, expectedJournalHead, input.jobId);
  const expectedAfter = projectLeaseResult(expected, input, operation);
  const eventInput = leaseEventInput(expected, expectedJournalHead, input, operation);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readCheckpoint(database, input.jobId, input.guard);
    if (checkpointEquals(current, expectedAfter)) {
      const replay = appendIsolatedRecoveryEvent(database, eventInput);
      database.exec("ROLLBACK");
      if (!replay.changed && replay.reason === "already_committed") {
        return leaseResult(false, "already_committed", operation, current, replay.event);
      }
      return leaseResult(false, "evidence_inconsistent", operation, current, null);
    }
    if (!checkpointEquals(current, expected)) {
      database.exec("ROLLBACK");
      return leaseResult(false, "state_conflict", operation, current, null);
    }

    const stateResult = applyLeaseOperation(database, input, operation);
    if (!stateResult.changed || !checkpointEquals(stateResult.checkpoint, expectedAfter)) {
      database.exec("ROLLBACK");
      return leaseResult(false, "state_rejected", operation, stateResult.checkpoint, null);
    }
    const eventResult = appendIsolatedRecoveryEvent(database, eventInput);
    if (!eventResult.changed) {
      database.exec("ROLLBACK");
      return leaseResult(false, "evidence_inconsistent", operation, current, null);
    }
    database.exec("COMMIT");
    return leaseResult(true, "committed", operation, stateResult.checkpoint, eventResult.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

function applyLeaseOperation(database, input, operation) {
  const common = {
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    now: input.now,
    guard: input.guard,
  };
  if (operation === "claim") return claimIsolatedRecoveryLease(database, { ...common, ttlMs: input.ttlMs });
  if (operation === "renew") return renewIsolatedRecoveryLease(database, { ...common, ttlMs: input.ttlMs });
  return releaseIsolatedRecoveryLease(database, common);
}

function projectLeaseResult(expected, input, operation) {
  const now = canonicalIso(input.now, "now");
  const leaseToken = requiredText(input.leaseToken, "leaseToken");
  if (operation === "release") {
    if (expected.leaseToken !== leaseToken) throw new Error("El lease esperado no pertenece al solicitante.");
    return { ...expected, leaseToken: null, leaseExpiresAt: null, updatedAt: now };
  }
  const ttlMs = Number(input.ttlMs);
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) {
    throw new Error("El lease coordinado requiere un TTL entre 1 segundo y 5 minutos.");
  }
  return {
    ...expected,
    attemptCount: operation === "claim" ? expected.attemptCount + 1 : expected.attemptCount,
    leaseToken,
    leaseExpiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    updatedAt: now,
  };
}

function leaseEventInput(expected, journalHead, input, operation) {
  const eventType = operation === "claim"
    ? (expected.attemptCount === 0 ? "lease_claimed" : "lease_recovered")
    : (operation === "renew" ? "lease_renewed" : "lease_released");
  return {
    recoveryJobId: expected.jobId,
    sequenceNumber: journalHead.sequenceNumber + 1,
    eventType,
    jobStatus: expected.status,
    jobAttemptCount: operation === "claim" ? expected.attemptCount + 1 : expected.attemptCount,
    importJobId: null,
    objectStatus: null,
    failureCode: null,
    copiedObjectCount: expected.copiedObjectCount,
    compensatedObjectCount: expected.compensatedObjectCount,
    appliedRowCount: expected.appliedRowCount,
    verifiedRowCount: expected.verifiedRowCount,
    occurredAt: canonicalIso(input.now, "now"),
    previousEventSha256: journalHead.eventSha256,
    guard: input.guard,
  };
}

function preparedEventInput(job, guard) {
  return {
    recoveryJobId: String(job.id),
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
    occurredAt: canonicalIso(job.prepared_at, "preparedAt"),
    previousEventSha256: null,
    guard,
  };
}

function readPreparedRecovery(database, confirmationTokenId) {
  if (!confirmationTokenId) return null;
  const job = database.prepare(`
    SELECT * FROM restore_recovery_jobs WHERE confirmation_token_id = ? LIMIT 1
  `).get(confirmationTokenId);
  if (!job) return null;
  const objects = database.prepare(`
    SELECT * FROM restore_recovery_objects WHERE recovery_job_id = ? ORDER BY sequence_number
  `).all(job.id);
  return { job, objects };
}

function readCheckpoint(database, jobId, guard) {
  return readIsolatedRecoveryCheckpoint(database, { jobId, guard });
}

function assertExpectedLeaseState(checkpoint, journalHead, jobId) {
  if (!checkpoint || checkpoint.jobId !== jobId) throw new Error("El checkpoint esperado no corresponde al trabajo.");
  if (!journalHead || journalHead.recoveryJobId !== jobId || journalHead.eventSha256?.length !== 64) {
    throw new Error("La cabeza esperada del diario no corresponde al trabajo.");
  }
  if (!Number.isInteger(journalHead.sequenceNumber) || journalHead.sequenceNumber < 0) {
    throw new Error("La secuencia esperada del diario es invalida.");
  }
}

function checkpointEquals(left, right) {
  return Boolean(left && right) && CHECKPOINT_FIELDS.every((field) => left[field] === right[field]);
}

function preparationResult(changed, reason, recoveryJobId, event) {
  return { changed, reason, recoveryJobId, event, productWritesEnabled: false };
}

function leaseResult(changed, reason, operation, checkpoint, event) {
  return { changed, reason, operation, checkpoint, event, productWritesEnabled: false };
}

function camelJob(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    fieldId: row.field_id,
    confirmationTokenId: row.confirmation_token_id,
    actorEmail: row.actor_email,
    backupSha256: row.backup_sha256,
    snapshotSha256: row.snapshot_sha256,
    planSha256: row.plan_sha256,
    status: row.status,
    executionEnabled: Boolean(row.execution_enabled),
    expectedRowCount: Number(row.expected_row_count),
    attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    objectCursorImportJobId: row.object_cursor_import_job_id,
    copiedObjectCount: Number(row.copied_object_count),
    compensationCursorImportJobId: row.compensation_cursor_import_job_id,
    compensatedObjectCount: Number(row.compensated_object_count),
    appliedRowCount: Number(row.applied_row_count),
    verifiedRowCount: Number(row.verified_row_count),
    preRestoreBackupObjectKey: row.pre_restore_backup_object_key,
    preRestoreBackupSha256: row.pre_restore_backup_sha256,
    postRestoreSha256: row.post_restore_sha256,
    failureCode: row.failure_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function camelObject(row) {
  return {
    importJobId: row.import_job_id,
    sequenceNumber: Number(row.sequence_number),
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    destinationObjectKey: row.destination_object_key,
    wasPreexisting: Boolean(row.was_preexisting),
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code,
  };
}

function canonicalIso(value, name) {
  const text = requiredText(value, name);
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw new Error(`${name} debe ser ISO-8601 UTC canonico.`);
  }
  return text;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El coordinador estado/evento solo admite SQLite aislado.");
  }
}
