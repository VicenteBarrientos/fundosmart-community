import { commitIsolatedRecoveryCheckpoint } from "./isolated-recovery-checkpoint-simulator.mjs";
import { appendIsolatedRecoveryEvent } from "./isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";

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

export function coordinateIsolatedRecoveryCheckpointEvent(database, input) {
  assertGuard(input?.guard);
  const now = canonicalIso(input.now);
  assertExpectedInput(input);
  const expected = input.expectedCheckpoint;
  const projected = projectCheckpoint(expected, input.next, now);
  const eventInput = checkpointEventInput(projected, input.expectedJournalHead, now, input.guard);

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readCheckpoint(database, input.jobId, input.guard);
    if (checkpointEquals(current, projected)) {
      const replay = appendIsolatedRecoveryEvent(database, eventInput);
      database.exec("ROLLBACK");
      if (!replay.changed && replay.reason === "already_committed") {
        return result(false, "already_committed", current, replay.event);
      }
      return result(false, "evidence_inconsistent", current, null);
    }
    if (!checkpointEquals(current, expected)) {
      const reason = leaseWasLost(current, expected, input.leaseToken, now) ? "lease_lost" : "state_conflict";
      database.exec("ROLLBACK");
      return result(false, reason, current, null);
    }

    const checkpointResult = commitIsolatedRecoveryCheckpoint(database, {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      now,
      expected: checkpointState(expected),
      next: {
        status: projected.status,
        objectCursorImportJobId: projected.objectCursorImportJobId,
        copiedObjectCount: projected.copiedObjectCount,
        appliedRowCount: projected.appliedRowCount,
        verifiedRowCount: projected.verifiedRowCount,
      },
      guard: input.guard,
    });
    if (!checkpointResult.changed || !checkpointEquals(checkpointResult.checkpoint, projected)) {
      database.exec("ROLLBACK");
      return result(false, checkpointResult.reason, checkpointResult.checkpoint, null);
    }
    const eventResult = appendIsolatedRecoveryEvent(database, eventInput);
    if (!eventResult.changed) {
      database.exec("ROLLBACK");
      return result(false, "evidence_inconsistent", current, null);
    }
    database.exec("COMMIT");
    return result(true, "committed", checkpointResult.checkpoint, eventResult.event);
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

function projectCheckpoint(expected, next, now) {
  const status = requiredText(next?.status, "next.status");
  const terminal = status === "succeeded";
  return {
    ...expected,
    status,
    objectCursorImportJobId: nullableText(next?.objectCursorImportJobId),
    copiedObjectCount: nonNegativeInteger(next?.copiedObjectCount, "next.copiedObjectCount"),
    appliedRowCount: nonNegativeInteger(next?.appliedRowCount, "next.appliedRowCount"),
    verifiedRowCount: nonNegativeInteger(next?.verifiedRowCount, "next.verifiedRowCount"),
    leaseToken: terminal ? null : expected.leaseToken,
    leaseExpiresAt: terminal ? null : expected.leaseExpiresAt,
    updatedAt: now,
  };
}

function checkpointEventInput(projected, journalHead, now, guard) {
  return {
    recoveryJobId: projected.jobId,
    sequenceNumber: journalHead.sequenceNumber + 1,
    eventType: projected.status === "succeeded" ? "succeeded" : "checkpoint_advanced",
    jobStatus: projected.status,
    jobAttemptCount: projected.attemptCount,
    importJobId: null,
    objectStatus: null,
    failureCode: null,
    copiedObjectCount: projected.copiedObjectCount,
    compensatedObjectCount: projected.compensatedObjectCount,
    appliedRowCount: projected.appliedRowCount,
    verifiedRowCount: projected.verifiedRowCount,
    occurredAt: now,
    previousEventSha256: journalHead.eventSha256,
    guard,
  };
}

function assertExpectedInput(input) {
  const expected = input.expectedCheckpoint;
  const head = input.expectedJournalHead;
  if (!expected || expected.jobId !== input.jobId) throw new Error("El checkpoint esperado no corresponde al trabajo.");
  if (!head || head.recoveryJobId !== input.jobId || head.eventSha256?.length !== 64) {
    throw new Error("La cabeza esperada del diario no corresponde al trabajo.");
  }
  if (!Number.isInteger(head.sequenceNumber) || head.sequenceNumber < 0) {
    throw new Error("La secuencia esperada del diario es invalida.");
  }
  if (!input.leaseToken || expected.leaseToken !== input.leaseToken) {
    throw new Error("El checkpoint esperado no pertenece al lease indicado.");
  }
}

function checkpointState(checkpoint) {
  return {
    status: checkpoint.status,
    attemptCount: checkpoint.attemptCount,
    objectCursorImportJobId: checkpoint.objectCursorImportJobId,
    copiedObjectCount: checkpoint.copiedObjectCount,
    appliedRowCount: checkpoint.appliedRowCount,
    verifiedRowCount: checkpoint.verifiedRowCount,
    expectedRowCount: checkpoint.expectedRowCount,
  };
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

function readCheckpoint(database, jobId, guard) {
  return readIsolatedRecoveryCheckpoint(database, { jobId, guard });
}

function result(changed, reason, checkpoint, event) {
  return { changed, reason, checkpoint, event, productWritesEnabled: false };
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function nullableText(value) {
  return value == null ? null : requiredText(value, "cursor");
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} debe ser un entero no negativo.`);
  return number;
}

function canonicalIso(value) {
  const text = requiredText(value, "now");
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw new Error("now debe ser ISO-8601 UTC canonico.");
  }
  return text;
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El coordinador checkpoint/evento solo admite SQLite aislado.");
  }
}
