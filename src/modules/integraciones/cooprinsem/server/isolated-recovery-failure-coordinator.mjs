import { recoveryJobCanTransition } from "./recovery-job-rules.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import {
  commitIsolatedRecoveryObjectState,
  readIsolatedRecoveryObject,
} from "./isolated-recovery-object-simulator.mjs";
import { isolatedRecoveryPhaseFailureRequiresSnapshot } from "./isolated-recovery-phase-failure-coordinator.mjs";

const FAILURE_CODES = new Set(["original_missing", "original_hash_mismatch", "lease_lost", "unknown_failure"]);

export function failIsolatedRecoveryObjectAndBeginCompensation(database, input) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = failIsolatedRecoveryObjectAndBeginCompensationInOpenTransaction(database, input);
    database.exec(result.changed ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function failIsolatedRecoveryObjectAndBeginCompensationInOpenTransaction(database, input) {
  assertGuard(input?.guard);
  const failureCode = String(input.failureCode ?? "");
  if (!FAILURE_CODES.has(failureCode)) throw new Error("La falla aislada requiere un codigo generico.");
  if (!recoveryJobCanTransition(input.expectedJob.status, "compensating")) {
    throw new Error("El trabajo no puede entrar en compensacion desde su fase actual.");
  }
  const current = readFailureState(database, input);
  if (current.job?.status === "compensating"
    && current.job.failureCode === failureCode
    && current.object?.status === "failed"
    && current.object.lastErrorCode === failureCode) {
    return failureResult(false, "already_committed", current);
  }

  const nextAttemptCount = input.expectedObject.status === "copied"
      ? input.expectedObject.attemptCount
      : input.expectedObject.attemptCount + 1;
    const objectResult = commitIsolatedRecoveryObjectState(database, {
      jobId: input.jobId,
      importJobId: input.importJobId,
      leaseToken: input.leaseToken,
      expectedJobAttemptCount: input.expectedJob.attemptCount,
      now: input.now,
      expected: input.expectedObject,
      next: {
        ...input.expectedObject,
        status: "failed",
        attemptCount: nextAttemptCount,
        lastErrorCode: failureCode,
      },
      guard: input.guard,
    });
  if (!objectResult.changed) {
    return failureResult(false, objectResult.reason, readFailureState(database, input));
  }
  const jobUpdate = database.prepare(`
      UPDATE restore_recovery_jobs
      SET status = 'compensating', failure_code = ?, updated_at = ?
      WHERE id = ? AND execution_enabled = 0 AND status = ?
        AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
    `).run(
      failureCode,
      input.now,
      input.jobId,
      input.expectedJob.status,
      input.leaseToken,
      input.now,
      input.expectedJob.attemptCount,
    );
  if (Number(jobUpdate.changes) !== 1) {
    const reason = classifyJobRejection(database, input);
    return failureResult(false, reason, readFailureState(database, input));
  }
  return failureResult(true, "committed", readFailureState(database, input));
}

export function finalizeIsolatedRecoveryFailure(database, input) {
  return finalizeIsolatedRecoveryFailureInOpenTransaction(database, input);
}

export function finalizeIsolatedRecoveryFailureInOpenTransaction(database, input) {
  assertGuard(input?.guard);
  const current = readFailureState(database, { ...input, importJobId: input.importJobId ?? "" });
  if (current.job?.status === "failed" && current.job.completedAt) {
    return failureResult(false, "already_committed", current);
  }
  const snapshotRestoreRequired = isolatedRecoveryPhaseFailureRequiresSnapshot(database, {
    jobId: input.jobId,
    guard: input.guard,
  });
  const result = database.prepare(`
    UPDATE restore_recovery_jobs
    SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
      completed_at = ?, updated_at = ?
    WHERE id = ? AND execution_enabled = 0 AND status = 'compensating'
      AND failure_code IS NOT NULL
      AND (
        ? = 0
        OR (
          pre_restore_backup_sha256 IS NOT NULL
          AND post_restore_sha256 = pre_restore_backup_sha256
        )
      )
      AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
      AND compensated_object_count = (
        SELECT count(*) FROM restore_recovery_objects object
        WHERE object.recovery_job_id = restore_recovery_jobs.id AND object.status = 'compensated'
      )
      AND NOT EXISTS (
        SELECT 1 FROM restore_recovery_objects object
        WHERE object.recovery_job_id = restore_recovery_jobs.id
          AND object.was_preexisting = 0 AND object.destination_object_key IS NOT NULL
          AND object.status <> 'compensated'
      )
  `).run(
    input.now,
    input.now,
    input.jobId,
    snapshotRestoreRequired ? 1 : 0,
    input.leaseToken,
    input.now,
    input.expectedJobAttemptCount,
  );
  const changed = Number(result.changes) === 1;
  return failureResult(
    changed,
    changed ? "committed" : classifyFinalizationRejection(database, input),
    readFailureState(database, { ...input, importJobId: input.importJobId ?? "" }),
  );
}

function readFailureState(database, input) {
  const checkpoint = readIsolatedRecoveryCheckpoint(database, { jobId: input.jobId, guard: input.guard });
  const row = database.prepare(`
    SELECT status, failure_code, completed_at FROM restore_recovery_jobs WHERE id = ?
  `).get(input.jobId);
  const object = input.importJobId
    ? readIsolatedRecoveryObject(database, { jobId: input.jobId, importJobId: input.importJobId, guard: input.guard })
    : null;
  return {
    job: checkpoint && row ? { ...checkpoint, failureCode: row.failure_code, completedAt: row.completed_at } : null,
    object,
  };
}

function classifyJobRejection(database, input) {
  const job = database.prepare(`SELECT lease_token, lease_expires_at, attempt_count FROM restore_recovery_jobs WHERE id = ?`).get(input.jobId);
  if (!job) return "not_found";
  if (job.lease_token !== input.leaseToken || job.lease_expires_at <= input.now || Number(job.attempt_count) !== input.expectedJob.attemptCount) {
    return "lease_lost";
  }
  return "stale_checkpoint";
}

function classifyFinalizationRejection(database, input) {
  const job = database.prepare(`
    SELECT status, lease_token, lease_expires_at, attempt_count, failure_code,
      pre_restore_backup_sha256, post_restore_sha256
    FROM restore_recovery_jobs WHERE id = ?
  `).get(input.jobId);
  if (!job) return "not_found";
  if (job.lease_token !== input.leaseToken || job.lease_expires_at <= input.now || Number(job.attempt_count) !== input.expectedJobAttemptCount) {
    return "lease_lost";
  }
  if (isolatedRecoveryPhaseFailureRequiresSnapshot(database, { jobId: input.jobId, guard: input.guard })
    && (!job.pre_restore_backup_sha256 || job.post_restore_sha256 !== job.pre_restore_backup_sha256)) {
    return "snapshot_restore_incomplete";
  }
  return "compensation_incomplete";
}

function failureResult(changed, reason, state) {
  return {
    changed,
    reason,
    job: state.job ? {
      status: state.job.status,
      failureCode: state.job.failureCode,
      compensatedObjectCount: state.job.compensatedObjectCount,
      leaseActive: Boolean(state.job.leaseToken),
      completedAt: state.job.completedAt,
    } : null,
    object: state.object ? {
      importJobId: state.object.importJobId,
      status: state.object.status,
      attemptCount: state.object.attemptCount,
      hasDestinationObjectKey: Boolean(state.object.destinationObjectKey),
      lastErrorCode: state.object.lastErrorCode,
    } : null,
    productWritesEnabled: false,
  };
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El coordinador de fallas solo admite SQLite aislado.");
  }
}
