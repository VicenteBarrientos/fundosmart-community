import { appendIsolatedRecoveryEvent } from "./isolated-recovery-event-journal.mjs";
import {
  failIsolatedRecoveryObjectAndBeginCompensationInOpenTransaction,
  finalizeIsolatedRecoveryFailureInOpenTransaction,
} from "./isolated-recovery-failure-coordinator.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import {
  commitIsolatedRecoveryObjectState,
  readIsolatedRecoveryObject,
} from "./isolated-recovery-object-simulator.mjs";
import { coordinateIsolatedRecoveryProgressInOpenTransaction } from "./isolated-recovery-coordinator.mjs";

const FAILURE_CODES = new Set([
  "original_missing", "original_hash_mismatch", "schema_drift", "snapshot_changed", "plan_changed",
  "foreign_key_violation", "lease_lost", "unknown_failure",
]);
const OBJECT_FAILURE_CODES = new Set(["original_missing", "original_hash_mismatch", "lease_lost", "unknown_failure"]);
const CHECKPOINT_FIELDS = [
  "jobId", "status", "executionEnabled", "attemptCount", "leaseToken", "leaseExpiresAt",
  "objectCursorImportJobId", "copiedObjectCount", "compensationCursorImportJobId",
  "compensatedObjectCount", "appliedRowCount", "verifiedRowCount", "expectedRowCount", "updatedAt",
];
const OBJECT_FIELDS = [
  "recoveryJobId", "importJobId", "sequenceNumber", "sha256", "sizeBytes", "status",
  "destinationObjectKey", "wasPreexisting", "attemptCount", "lastErrorCode", "copiedAt",
  "verifiedAt", "compensatedAt", "updatedAt",
];

export function coordinateIsolatedRecoveryObjectCopyEvent(database, input) {
  assertCommonInput(input);
  const now = canonicalIso(input.now);
  const projectedObject = {
    ...input.expectedObject,
    status: "copied",
    destinationObjectKey: requiredText(input.destinationObjectKey, "destinationObjectKey"),
    wasPreexisting: input.wasPreexisting === true,
    attemptCount: input.expectedObject.attemptCount + 1,
    lastErrorCode: null,
    copiedAt: now,
    updatedAt: now,
  };
  const eventInput = objectEventInput(input.expectedJob, input.expectedJournalHead, {
    eventType: "object_copied",
    objectStatus: "copied",
    importJobId: input.importJobId,
    occurredAt: now,
  }, input.guard);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readState(database, input);
    if (checkpointEquals(current.job, input.expectedJob) && objectEquals(current.object, projectedObject)) {
      return finishReplay(database, eventInput, current, "copy");
    }
    if (!checkpointEquals(current.job, input.expectedJob) || !objectEquals(current.object, input.expectedObject)) {
      const reason = leaseWasLost(current.job, input.expectedJob, input.leaseToken, now) ? "lease_lost" : "state_conflict";
      database.exec("ROLLBACK");
      return result(false, reason, current, null);
    }
    const objectResult = commitIsolatedRecoveryObjectState(database, {
      jobId: input.jobId,
      importJobId: input.importJobId,
      leaseToken: input.leaseToken,
      expectedJobAttemptCount: input.expectedJob.attemptCount,
      now,
      expected: input.expectedObject,
      next: projectedObject,
      guard: input.guard,
    });
    const after = readState(database, input);
    if (!objectResult.changed || !objectEquals(after.object, projectedObject) || !checkpointEquals(after.job, input.expectedJob)) {
      database.exec("ROLLBACK");
      return result(false, objectResult.reason, after, null);
    }
    const eventResult = appendIsolatedRecoveryEvent(database, eventInput);
    if (!eventResult.changed) {
      database.exec("ROLLBACK");
      return result(false, "evidence_inconsistent", current, null);
    }
    database.exec("COMMIT");
    return result(true, "committed", after, eventResult.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function coordinateIsolatedRecoveryObjectProgressEvent(database, input) {
  assertCommonInput(input);
  const now = canonicalIso(input.now);
  const operation = input.operation;
  if (operation !== "verify" && operation !== "compensate") throw new Error("La coordinacion de objeto requiere verify o compensate.");
  const projected = projectProgress(input, now);
  const eventInput = objectEventInput(projected.job, input.expectedJournalHead, {
    eventType: operation === "verify" ? "object_verified" : "object_compensated",
    objectStatus: operation === "verify" ? "verified" : "compensated",
    importJobId: input.importJobId,
    occurredAt: now,
  }, input.guard);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readState(database, input);
    if (checkpointEquals(current.job, projected.job) && objectEquals(current.object, projected.object)) {
      return finishReplay(database, eventInput, current, operation);
    }
    if (!checkpointEquals(current.job, input.expectedJob) || !objectEquals(current.object, input.expectedObject)) {
      const reason = leaseWasLost(current.job, input.expectedJob, input.leaseToken, now) ? "lease_lost" : "state_conflict";
      database.exec("ROLLBACK");
      return result(false, reason, current, null);
    }
    const progress = coordinateIsolatedRecoveryProgressInOpenTransaction(database, {
      operation,
      jobId: input.jobId,
      importJobId: input.importJobId,
      leaseToken: input.leaseToken,
      now,
      expectedJob: input.expectedJob,
      expectedObject: input.expectedObject,
      transitionToApplying: input.transitionToApplying,
      guard: input.guard,
    });
    const after = readState(database, input);
    if (!progress.changed || !checkpointEquals(after.job, projected.job) || !objectEquals(after.object, projected.object)) {
      database.exec("ROLLBACK");
      return result(false, progress.reason, after, null);
    }
    const eventResult = appendIsolatedRecoveryEvent(database, eventInput);
    if (!eventResult.changed) {
      database.exec("ROLLBACK");
      return result(false, "evidence_inconsistent", current, null);
    }
    database.exec("COMMIT");
    return result(true, "committed", after, eventResult.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function coordinateIsolatedRecoveryFailureStartEvents(database, input) {
  assertCommonInput(input);
  const now = canonicalIso(input.now);
  const failureCode = requiredText(input.failureCode, "failureCode");
  if (!OBJECT_FAILURE_CODES.has(failureCode)) throw new Error("La falla coordinada requiere un codigo generico.");
  const projected = projectFailureStart(input, now, failureCode);
  const objectFailedInput = objectEventInput(projected.job, input.expectedJournalHead, {
    eventType: "object_failed",
    objectStatus: "failed",
    importJobId: input.importJobId,
    failureCode,
    occurredAt: now,
  }, input.guard);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readFailureState(database, input);
    if (failureStateEquals(current, projected)) {
      return finishFailureStartReplay(database, objectFailedInput, current, failureCode, input.guard);
    }
    if (!checkpointEquals(current.job, input.expectedJob)
      || !objectEquals(current.object, input.expectedObject)
      || current.failureCode !== null
      || current.completedAt !== null) {
      const reason = leaseWasLost(current.job, input.expectedJob, input.leaseToken, now) ? "lease_lost" : "state_conflict";
      database.exec("ROLLBACK");
      return failureResult(false, reason, current, []);
    }
    const failed = failIsolatedRecoveryObjectAndBeginCompensationInOpenTransaction(database, {
      jobId: input.jobId,
      importJobId: input.importJobId,
      leaseToken: input.leaseToken,
      now,
      failureCode,
      expectedJob: input.expectedJob,
      expectedObject: input.expectedObject,
      guard: input.guard,
    });
    const after = readFailureState(database, input);
    if (!failed.changed || !failureStateEquals(after, projected)) {
      database.exec("ROLLBACK");
      return failureResult(false, failed.reason, after, []);
    }
    const first = appendIsolatedRecoveryEvent(database, objectFailedInput);
    if (!first.changed) {
      database.exec("ROLLBACK");
      return failureResult(false, "evidence_inconsistent", current, []);
    }
    const secondInput = compensationStartedInput(projected.job, first.event, failureCode, now, input.guard);
    const second = appendIsolatedRecoveryEvent(database, secondInput);
    if (!second.changed) {
      database.exec("ROLLBACK");
      return failureResult(false, "evidence_inconsistent", current, []);
    }
    database.exec("COMMIT");
    return failureResult(true, "committed", after, [first.event, second.event]);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function coordinateIsolatedRecoveryFailedEvent(database, input) {
  assertFinalizationInput(input);
  const now = canonicalIso(input.now);
  const failureCode = requiredText(input.failureCode, "failureCode");
  if (!FAILURE_CODES.has(failureCode)) throw new Error("El cierre fallido requiere un codigo generico.");
  const projectedJob = {
    ...input.expectedJob,
    status: "failed",
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: now,
  };
  const eventInput = terminalFailureEventInput(projectedJob, input.expectedJournalHead, failureCode, now, input.guard);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readFailureState(database, input);
    if (checkpointEquals(current.job, projectedJob)
      && current.failureCode === failureCode
      && current.completedAt === now) {
      const replay = appendIsolatedRecoveryEvent(database, eventInput);
      database.exec("ROLLBACK");
      if (!replay.changed && replay.reason === "already_committed") {
        return failureResult(false, "already_committed", current, [replay.event]);
      }
      return failureResult(false, "evidence_inconsistent", current, []);
    }
    if (!checkpointEquals(current.job, input.expectedJob)
      || current.failureCode !== failureCode
      || current.completedAt !== null) {
      const reason = leaseWasLost(current.job, input.expectedJob, input.leaseToken, now) ? "lease_lost" : "state_conflict";
      database.exec("ROLLBACK");
      return failureResult(false, reason, current, []);
    }
    const finalized = finalizeIsolatedRecoveryFailureInOpenTransaction(database, {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      expectedJobAttemptCount: input.expectedJob.attemptCount,
      now,
      guard: input.guard,
    });
    const after = readFailureState(database, input);
    if (!finalized.changed
      || !checkpointEquals(after.job, projectedJob)
      || after.failureCode !== failureCode
      || after.completedAt !== now) {
      database.exec("ROLLBACK");
      return failureResult(false, finalized.reason, after, []);
    }
    const eventResult = appendIsolatedRecoveryEvent(database, eventInput);
    if (!eventResult.changed) {
      database.exec("ROLLBACK");
      return failureResult(false, "evidence_inconsistent", current, []);
    }
    database.exec("COMMIT");
    return failureResult(true, "committed", after, [eventResult.event]);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

function finishReplay(database, eventInput, current, operation) {
  const replay = appendIsolatedRecoveryEvent(database, eventInput);
  database.exec("ROLLBACK");
  if (!replay.changed && replay.reason === "already_committed") {
    return result(false, "already_committed", current, replay.event, operation);
  }
  return result(false, "evidence_inconsistent", current, null, operation);
}

function finishFailureStartReplay(database, firstInput, current, failureCode, guard) {
  const first = appendIsolatedRecoveryEvent(database, firstInput);
  if (first.changed || first.reason !== "already_committed") {
    database.exec("ROLLBACK");
    return failureResult(false, "evidence_inconsistent", current, []);
  }
  const second = appendIsolatedRecoveryEvent(database, compensationStartedInput(
    current.job, first.event, failureCode, first.event.occurredAt, guard,
  ));
  database.exec("ROLLBACK");
  if (!second.changed && second.reason === "already_committed") {
    return failureResult(false, "already_committed", current, [first.event, second.event]);
  }
  return failureResult(false, "evidence_inconsistent", current, []);
}

function projectProgress(input, now) {
  const verify = input.operation === "verify";
  return {
    job: {
      ...input.expectedJob,
      status: verify && input.transitionToApplying === true ? "applying" : input.expectedJob.status,
      objectCursorImportJobId: verify ? input.importJobId : input.expectedJob.objectCursorImportJobId,
      copiedObjectCount: verify ? input.expectedJob.copiedObjectCount + 1 : input.expectedJob.copiedObjectCount,
      compensationCursorImportJobId: verify ? input.expectedJob.compensationCursorImportJobId : input.importJobId,
      compensatedObjectCount: verify ? input.expectedJob.compensatedObjectCount : input.expectedJob.compensatedObjectCount + 1,
      updatedAt: now,
    },
    object: {
      ...input.expectedObject,
      status: verify ? "verified" : "compensated",
      lastErrorCode: null,
      verifiedAt: verify ? now : input.expectedObject.verifiedAt,
      compensatedAt: verify ? input.expectedObject.compensatedAt : now,
      updatedAt: now,
    },
  };
}

function projectFailureStart(input, now, failureCode) {
  return {
    job: { ...input.expectedJob, status: "compensating", updatedAt: now },
    object: {
      ...input.expectedObject,
      status: "failed",
      attemptCount: input.expectedObject.status === "copied"
        ? input.expectedObject.attemptCount
        : input.expectedObject.attemptCount + 1,
      lastErrorCode: failureCode,
      updatedAt: now,
    },
    failureCode,
    completedAt: null,
  };
}

function objectEventInput(job, head, details, guard) {
  return {
    recoveryJobId: job.jobId,
    sequenceNumber: head.sequenceNumber + 1,
    eventType: details.eventType,
    jobStatus: job.status,
    jobAttemptCount: job.attemptCount,
    importJobId: details.importJobId,
    objectStatus: details.objectStatus,
    failureCode: details.failureCode ?? null,
    copiedObjectCount: job.copiedObjectCount,
    compensatedObjectCount: job.compensatedObjectCount,
    appliedRowCount: job.appliedRowCount,
    verifiedRowCount: job.verifiedRowCount,
    occurredAt: details.occurredAt,
    previousEventSha256: head.eventSha256,
    guard,
  };
}

function compensationStartedInput(job, previous, failureCode, now, guard) {
  return {
    recoveryJobId: job.jobId,
    sequenceNumber: previous.sequenceNumber + 1,
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
    previousEventSha256: previous.eventSha256,
    guard,
  };
}

function terminalFailureEventInput(job, head, failureCode, now, guard) {
  return {
    recoveryJobId: job.jobId,
    sequenceNumber: head.sequenceNumber + 1,
    eventType: "failed",
    jobStatus: "failed",
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

function readState(database, input) {
  return {
    job: readIsolatedRecoveryCheckpoint(database, { jobId: input.jobId, guard: input.guard }),
    object: readIsolatedRecoveryObject(database, {
      jobId: input.jobId, importJobId: input.importJobId, guard: input.guard,
    }),
  };
}

function readFailureState(database, input) {
  const state = {
    job: readIsolatedRecoveryCheckpoint(database, { jobId: input.jobId, guard: input.guard }),
    object: input.importJobId
      ? readIsolatedRecoveryObject(database, {
        jobId: input.jobId, importJobId: input.importJobId, guard: input.guard,
      })
      : null,
  };
  const row = database.prepare(`
    SELECT failure_code, completed_at FROM restore_recovery_jobs WHERE id = ?
  `).get(input.jobId);
  return {
    ...state,
    failureCode: row?.failure_code ?? null,
    completedAt: row?.completed_at ?? null,
  };
}

function failureStateEquals(current, projected) {
  return checkpointEquals(current.job, projected.job)
    && objectEquals(current.object, projected.object)
    && current.failureCode === projected.failureCode
    && current.completedAt === projected.completedAt;
}

function assertCommonInput(input) {
  assertGuard(input?.guard);
  if (!input.expectedJob || input.expectedJob.jobId !== input.jobId || input.expectedJob.leaseToken !== input.leaseToken) {
    throw new Error("El checkpoint esperado no corresponde al trabajo o lease.");
  }
  if (!input.expectedObject
    || input.expectedObject.recoveryJobId !== input.jobId
    || input.expectedObject.importJobId !== input.importJobId) {
    throw new Error("El objeto esperado no corresponde al trabajo.");
  }
  assertJournalHead(input.expectedJournalHead, input.jobId);
}

function assertFinalizationInput(input) {
  assertGuard(input?.guard);
  if (!input.expectedJob || input.expectedJob.jobId !== input.jobId || input.expectedJob.leaseToken !== input.leaseToken) {
    throw new Error("El checkpoint final esperado no corresponde al trabajo o lease.");
  }
  assertJournalHead(input.expectedJournalHead, input.jobId);
}

function assertJournalHead(head, jobId) {
  if (!head || head.recoveryJobId !== jobId || head.eventSha256?.length !== 64
    || !Number.isInteger(head.sequenceNumber) || head.sequenceNumber < 0) {
    throw new Error("La cabeza esperada del diario no corresponde al trabajo.");
  }
}

function checkpointEquals(left, right) {
  return Boolean(left && right) && CHECKPOINT_FIELDS.every((field) => left[field] === right[field]);
}

function objectEquals(left, right) {
  return Boolean(left && right) && OBJECT_FIELDS.every((field) => left[field] === right[field]);
}

function leaseWasLost(current, expected, leaseToken, now) {
  return !current
    || current.leaseToken !== leaseToken
    || current.attemptCount !== expected.attemptCount
    || !current.leaseExpiresAt
    || current.leaseExpiresAt <= now;
}

function publicObject(object) {
  return object ? {
    importJobId: object.importJobId,
    sequenceNumber: object.sequenceNumber,
    status: object.status,
    attemptCount: object.attemptCount,
    wasPreexisting: object.wasPreexisting,
    hasDestinationObjectKey: Boolean(object.destinationObjectKey),
    lastErrorCode: object.lastErrorCode,
  } : null;
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

function result(changed, reason, state, event) {
  return {
    changed,
    reason,
    job: publicJob(state.job),
    object: publicObject(state.object),
    event,
    productWritesEnabled: false,
  };
}

function failureResult(changed, reason, state, events) {
  return {
    changed,
    reason,
    job: publicJob(state.job),
    object: publicObject(state.object),
    failureCode: state.failureCode,
    completedAt: state.completedAt,
    events,
    productWritesEnabled: false,
  };
}

function canonicalIso(value) {
  const text = requiredText(value, "now");
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) throw new Error("now debe ser ISO-8601 UTC canonico.");
  return text;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El coordinador objeto/falla/evento solo admite SQLite aislado.");
  }
}
