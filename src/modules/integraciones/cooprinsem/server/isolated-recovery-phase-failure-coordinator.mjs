import { appendIsolatedRecoveryEvent } from "./isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import { recoveryJobCanTransition } from "./recovery-job-rules.mjs";

const PHASE_FAILURE_CODES = new Set([
  "schema_drift",
  "snapshot_changed",
  "plan_changed",
  "foreign_key_violation",
  "unknown_failure",
]);
const CHECKPOINT_FIELDS = [
  "jobId", "status", "executionEnabled", "attemptCount", "leaseToken", "leaseExpiresAt",
  "objectCursorImportJobId", "copiedObjectCount", "compensationCursorImportJobId",
  "compensatedObjectCount", "appliedRowCount", "verifiedRowCount", "expectedRowCount", "updatedAt",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function coordinateIsolatedRecoveryPhaseFailureEvent(database, input) {
  assertCommonInput(input);
  const now = canonicalIso(input.now);
  const failureCode = phaseFailureCode(input.failureCode);
  if (!new Set(["applying", "verifying"]).has(input.expectedJob.status)
    || !recoveryJobCanTransition(input.expectedJob.status, "compensating")) {
    throw new Error("La falla de fase aislada exige applying o verifying.");
  }
  const projectedJob = { ...input.expectedJob, status: "compensating", updatedAt: now };
  const eventInput = compensationStartedInput(projectedJob, input.expectedJournalHead, failureCode, now, input.guard);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readState(database, input.jobId, input.guard);
    if (checkpointEquals(current.job, projectedJob)
      && current.failureCode === failureCode
      && current.completedAt === null
      && current.postRestoreSha256 === null) {
      const replay = appendIsolatedRecoveryEvent(database, eventInput);
      database.exec("ROLLBACK");
      if (!replay.changed && replay.reason === "already_committed") {
        return phaseResult(false, "already_committed", current, replay.event);
      }
      return phaseResult(false, "evidence_inconsistent", current, null);
    }
    if (!checkpointEquals(current.job, input.expectedJob)
      || current.failureCode !== null
      || current.completedAt !== null) {
      const reason = leaseWasLost(current.job, input.expectedJob, input.leaseToken, now)
        ? "lease_lost"
        : "state_conflict";
      database.exec("ROLLBACK");
      return phaseResult(false, reason, current, null);
    }
    const updated = database.prepare(`
      UPDATE restore_recovery_jobs
      SET status = 'compensating', failure_code = ?, post_restore_sha256 = NULL, updated_at = ?
      WHERE id = ? AND execution_enabled = 0 AND status = ?
        AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
        AND failure_code IS NULL AND completed_at IS NULL
    `).run(
      failureCode,
      now,
      input.jobId,
      input.expectedJob.status,
      input.leaseToken,
      now,
      input.expectedJob.attemptCount,
    );
    const after = readState(database, input.jobId, input.guard);
    if (Number(updated.changes) !== 1
      || !checkpointEquals(after.job, projectedJob)
      || after.failureCode !== failureCode
      || after.postRestoreSha256 !== null) {
      const reason = leaseWasLost(after.job, input.expectedJob, input.leaseToken, now)
        ? "lease_lost"
        : "state_conflict";
      database.exec("ROLLBACK");
      return phaseResult(false, reason, after, null);
    }
    const event = appendIsolatedRecoveryEvent(database, eventInput);
    if (!event.changed) {
      database.exec("ROLLBACK");
      return phaseResult(false, "evidence_inconsistent", current, null);
    }
    database.exec("COMMIT");
    return phaseResult(true, "committed", after, event.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function recordIsolatedRecoverySnapshotRestored(database, input) {
  assertGuard(input?.guard);
  const jobId = requiredText(input?.jobId, "jobId");
  const leaseToken = requiredText(input?.leaseToken, "leaseToken");
  const now = canonicalIso(input?.now);
  const failureCode = phaseFailureCode(input?.failureCode);
  const expectedSha256 = validSha256(input?.expectedSha256, "expectedSha256");
  const restoredSha256 = validSha256(input?.restoredSha256, "restoredSha256");
  if (restoredSha256 !== expectedSha256) {
    throw new Error("La huella restaurada no coincide con el respaldo previo.");
  }
  assertJournalHead(input.expectedJournalHead, jobId);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readState(database, jobId, input.guard);
    if (current.job?.status === "compensating"
      && current.failureCode === failureCode
      && current.preRestoreBackupSha256 === expectedSha256
      && current.postRestoreSha256 === restoredSha256
      && current.job.updatedAt === now) {
      const replay = appendIsolatedRecoveryEvent(database, snapshotCheckpointInput(
        current.job,
        input.expectedJournalHead,
        now,
        input.guard,
      ));
      database.exec("ROLLBACK");
      return !replay.changed && replay.reason === "already_committed"
        ? snapshotResult(false, "already_committed", current, replay.event)
        : snapshotResult(false, "evidence_inconsistent", current, null);
    }
    if (!current.job
      || current.job.status !== "compensating"
      || current.failureCode !== failureCode
      || current.preRestoreBackupSha256 !== expectedSha256
      || current.postRestoreSha256 !== null) {
      database.exec("ROLLBACK");
      return snapshotResult(false, "state_conflict", current, null);
    }
    const updated = database.prepare(`
      UPDATE restore_recovery_jobs SET post_restore_sha256 = ?, updated_at = ?
      WHERE id = ? AND execution_enabled = 0 AND status = 'compensating'
        AND failure_code = ? AND pre_restore_backup_sha256 = ? AND post_restore_sha256 IS NULL
        AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
    `).run(
      restoredSha256,
      now,
      jobId,
      failureCode,
      expectedSha256,
      leaseToken,
      now,
      input.expectedJobAttemptCount,
    );
    const after = readState(database, jobId, input.guard);
    if (Number(updated.changes) !== 1 || after.postRestoreSha256 !== restoredSha256) {
      const reason = leaseWasLost(after.job, { attemptCount: input.expectedJobAttemptCount }, leaseToken, now)
        ? "lease_lost"
        : "state_conflict";
      database.exec("ROLLBACK");
      return snapshotResult(false, reason, after, null);
    }
    const event = appendIsolatedRecoveryEvent(database, snapshotCheckpointInput(
      after.job,
      input.expectedJournalHead,
      now,
      input.guard,
    ));
    if (!event.changed) {
      database.exec("ROLLBACK");
      return snapshotResult(false, "evidence_inconsistent", current, null);
    }
    database.exec("COMMIT");
    return snapshotResult(true, "committed", after, event.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function isolatedRecoveryPhaseFailureRequiresSnapshot(database, input) {
  assertGuard(input?.guard);
  const jobId = requiredText(input?.jobId, "jobId");
  const row = database.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM restore_recovery_events phase
      LEFT JOIN restore_recovery_events previous
        ON previous.recovery_job_id = phase.recovery_job_id
        AND previous.sequence_number = phase.sequence_number - 1
      WHERE phase.recovery_job_id = ?
        AND phase.event_type = 'compensation_started'
        AND (
          previous.event_type IS NULL
          OR previous.event_type <> 'object_failed'
          OR previous.failure_code <> phase.failure_code
          OR previous.occurred_at <> phase.occurred_at
        )
    ) AS required
  `).get(jobId);
  return Number(row?.required ?? 0) === 1;
}

function compensationStartedInput(job, head, failureCode, now, guard) {
  return {
    recoveryJobId: job.jobId,
    sequenceNumber: head.sequenceNumber + 1,
    eventType: "compensation_started",
    jobStatus: "compensating",
    jobAttemptCount: job.attemptCount,
    importJobId: null,
    objectStatus: null,
    failureCode,
    copiedObjectCount: job.copiedObjectCount,
    compensatedObjectCount: job.compensatedObjectCount,
    appliedRowCount: job.appliedRowCount,
    verifiedRowCount: job.verifiedRowCount,
    occurredAt: now,
    previousEventSha256: head.eventSha256,
    guard,
  };
}

function snapshotCheckpointInput(job, head, now, guard) {
  return {
    recoveryJobId: job.jobId,
    sequenceNumber: head.sequenceNumber + 1,
    eventType: "checkpoint_advanced",
    jobStatus: "compensating",
    jobAttemptCount: job.attemptCount,
    importJobId: null,
    objectStatus: null,
    failureCode: null,
    copiedObjectCount: job.copiedObjectCount,
    compensatedObjectCount: job.compensatedObjectCount,
    appliedRowCount: job.appliedRowCount,
    verifiedRowCount: job.verifiedRowCount,
    occurredAt: now,
    previousEventSha256: head.eventSha256,
    guard,
  };
}

function readState(database, jobId, guard) {
  const job = readIsolatedRecoveryCheckpoint(database, { jobId, guard });
  const row = database.prepare(`
    SELECT failure_code, completed_at, pre_restore_backup_sha256, post_restore_sha256
    FROM restore_recovery_jobs WHERE id = ?
  `).get(jobId);
  return {
    job,
    failureCode: row?.failure_code ?? null,
    completedAt: row?.completed_at ?? null,
    preRestoreBackupSha256: row?.pre_restore_backup_sha256 ?? null,
    postRestoreSha256: row?.post_restore_sha256 ?? null,
  };
}

function phaseResult(changed, reason, state, event) {
  return {
    changed,
    reason,
    job: publicJob(state.job),
    failureCode: state.failureCode,
    event,
    productWritesEnabled: false,
  };
}

function snapshotResult(changed, reason, state, event) {
  return {
    changed,
    reason,
    job: publicJob(state.job),
    snapshotRestored: Boolean(
      state.preRestoreBackupSha256
      && state.preRestoreBackupSha256 === state.postRestoreSha256
    ),
    event,
    productWritesEnabled: false,
  };
}

function publicJob(job) {
  return job ? {
    jobId: job.jobId,
    status: job.status,
    attemptCount: job.attemptCount,
    leaseActive: Boolean(job.leaseToken),
    objectCursorImportJobId: job.objectCursorImportJobId,
    copiedObjectCount: job.copiedObjectCount,
    compensationCursorImportJobId: job.compensationCursorImportJobId,
    compensatedObjectCount: job.compensatedObjectCount,
    appliedRowCount: job.appliedRowCount,
    verifiedRowCount: job.verifiedRowCount,
    expectedRowCount: job.expectedRowCount,
    updatedAt: job.updatedAt,
  } : null;
}

function assertCommonInput(input) {
  assertGuard(input?.guard);
  if (!input.expectedJob || input.expectedJob.jobId !== input.jobId || input.expectedJob.leaseToken !== input.leaseToken) {
    throw new Error("El checkpoint de falla de fase no corresponde al trabajo o lease.");
  }
  assertJournalHead(input.expectedJournalHead, input.jobId);
}

function assertJournalHead(head, jobId) {
  if (!head || head.recoveryJobId !== jobId || !Number.isInteger(head.sequenceNumber)
    || head.sequenceNumber < 0 || !SHA256_PATTERN.test(String(head.eventSha256 ?? ""))) {
    throw new Error("La cabeza del diario no corresponde a la falla de fase.");
  }
}

function checkpointEquals(left, right) {
  return Boolean(left && right) && CHECKPOINT_FIELDS.every((field) => left[field] === right[field]);
}

function leaseWasLost(current, expected, leaseToken, now) {
  return !current
    || current.leaseToken !== leaseToken
    || current.attemptCount !== expected.attemptCount
    || !current.leaseExpiresAt
    || current.leaseExpiresAt <= now;
}

function phaseFailureCode(value) {
  const code = requiredText(value, "failureCode");
  if (!PHASE_FAILURE_CODES.has(code)) throw new Error("La falla de fase requiere un código genérico permitido.");
  return code;
}

function validSha256(value, name) {
  const text = String(value ?? "");
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser SHA-256 hexadecimal.`);
  return text;
}

function canonicalIso(value) {
  const text = requiredText(value, "now");
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw new Error("now debe ser ISO-8601 UTC canónico.");
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
    throw new Error("El coordinador de falla de fase solo admite SQLite aislado.");
  }
}
