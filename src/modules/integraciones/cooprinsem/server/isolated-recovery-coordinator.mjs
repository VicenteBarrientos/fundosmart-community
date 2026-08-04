import { commitIsolatedRecoveryCheckpoint } from "./isolated-recovery-checkpoint-simulator.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import {
  commitIsolatedRecoveryObjectState,
  readIsolatedRecoveryObject,
} from "./isolated-recovery-object-simulator.mjs";

export function coordinateIsolatedRecoveryProgress(database, input) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = coordinateIsolatedRecoveryProgressInOpenTransaction(database, input);
    database.exec(result.changed ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function coordinateIsolatedRecoveryProgressInOpenTransaction(database, input) {
  assertGuard(input?.guard);
  const operation = input.operation;
  if (operation !== "verify" && operation !== "compensate") throw new Error("La coordinacion aislada requiere verify o compensate.");
  const current = coordinatedState(database, input);
  if (alreadyCommitted(current, input)) return coordinatedResult(false, "already_committed", current);
  const objectResult = commitIsolatedRecoveryObjectState(database, {
      jobId: input.jobId,
      importJobId: input.importJobId,
      leaseToken: input.leaseToken,
      expectedJobAttemptCount: input.expectedJob.attemptCount,
      now: input.now,
      expected: input.expectedObject,
      next: operation === "verify"
        ? { ...input.expectedObject, status: "verified", lastErrorCode: null }
        : { ...input.expectedObject, status: "compensated", lastErrorCode: null },
      guard: input.guard,
    });
  if (!objectResult.changed) {
    return coordinatedResult(false, objectResult.reason, coordinatedState(database, input));
  }

  let jobChanged;
  let rejectionReason = "stale_checkpoint";
  if (operation === "verify") {
    const checkpointResult = commitIsolatedRecoveryCheckpoint(database, {
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        now: input.now,
        expected: checkpointState(input.expectedJob),
        next: {
          status: input.transitionToApplying === true ? "applying" : "copying",
          objectCursorImportJobId: input.importJobId,
          copiedObjectCount: input.expectedJob.copiedObjectCount + 1,
          appliedRowCount: input.expectedJob.appliedRowCount,
          verifiedRowCount: input.expectedJob.verifiedRowCount,
        },
        guard: input.guard,
      });
    jobChanged = checkpointResult.changed;
    rejectionReason = checkpointResult.reason;
  } else {
    const update = database.prepare(`
        UPDATE restore_recovery_jobs
        SET compensation_cursor_import_job_id = ?, compensated_object_count = ?, updated_at = ?
        WHERE id = ? AND execution_enabled = 0 AND status = 'compensating'
          AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
          AND compensation_cursor_import_job_id IS ? AND compensated_object_count = ?
          AND EXISTS (
            SELECT 1 FROM restore_recovery_objects object
            WHERE object.recovery_job_id = restore_recovery_jobs.id
              AND object.import_job_id = ? AND object.status = 'compensated'
          )
      `).run(
        input.importJobId,
        input.expectedJob.compensatedObjectCount + 1,
        input.now,
        input.jobId,
        input.leaseToken,
        input.now,
        input.expectedJob.attemptCount,
        input.expectedJob.compensationCursorImportJobId,
        input.expectedJob.compensatedObjectCount,
        input.importJobId,
      );
    jobChanged = Number(update.changes) === 1;
    rejectionReason = classifyJobRejection(database, input);
  }
  if (!jobChanged) return coordinatedResult(false, rejectionReason, coordinatedState(database, input));
  return coordinatedResult(true, "committed", coordinatedState(database, input));
}

function coordinatedState(database, input) {
  return {
    job: readIsolatedRecoveryCheckpoint(database, { jobId: input.jobId, guard: input.guard }),
    object: readIsolatedRecoveryObject(database, { jobId: input.jobId, importJobId: input.importJobId, guard: input.guard }),
  };
}

function alreadyCommitted(current, input) {
  if (!current.job || !current.object) return false;
  if (input.operation === "verify") {
    const targetStatus = input.transitionToApplying === true ? "applying" : "copying";
    return current.object.status === "verified"
      && current.job.status === targetStatus
      && current.job.objectCursorImportJobId === input.importJobId
      && current.job.copiedObjectCount === input.expectedJob.copiedObjectCount + 1;
  }
  return current.object.status === "compensated"
    && current.job.status === "compensating"
    && current.job.compensationCursorImportJobId === input.importJobId
    && current.job.compensatedObjectCount === input.expectedJob.compensatedObjectCount + 1;
}

function classifyJobRejection(database, input) {
  const job = database.prepare(`
    SELECT lease_token, lease_expires_at, attempt_count FROM restore_recovery_jobs WHERE id = ?
  `).get(input.jobId);
  if (!job) return "not_found";
  if (job.lease_token !== input.leaseToken
    || job.lease_expires_at <= input.now
    || Number(job.attempt_count) !== input.expectedJob.attemptCount) return "lease_lost";
  return "stale_checkpoint";
}

function checkpointState(job) {
  return {
    status: job.status,
    attemptCount: job.attemptCount,
    objectCursorImportJobId: job.objectCursorImportJobId,
    copiedObjectCount: job.copiedObjectCount,
    appliedRowCount: job.appliedRowCount,
    verifiedRowCount: job.verifiedRowCount,
    expectedRowCount: job.expectedRowCount,
  };
}

function coordinatedResult(changed, reason, state) {
  return {
    changed,
    reason,
    job: state.job ? {
      status: state.job.status,
      attemptCount: state.job.attemptCount,
      objectCursorImportJobId: state.job.objectCursorImportJobId,
      copiedObjectCount: state.job.copiedObjectCount,
      compensationCursorImportJobId: state.job.compensationCursorImportJobId,
      compensatedObjectCount: state.job.compensatedObjectCount,
    } : null,
    object: state.object ? {
      importJobId: state.object.importJobId,
      sequenceNumber: state.object.sequenceNumber,
      status: state.object.status,
      attemptCount: state.object.attemptCount,
      wasPreexisting: state.object.wasPreexisting,
      hasDestinationObjectKey: Boolean(state.object.destinationObjectKey),
    } : null,
    productWritesEnabled: false,
  };
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El coordinador solo admite SQLite aislado.");
  }
}
