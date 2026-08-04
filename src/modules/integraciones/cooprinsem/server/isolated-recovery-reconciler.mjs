import {
  readIsolatedRecoveryEvents,
  verifyIsolatedRecoveryEventChain,
} from "./isolated-recovery-event-journal.mjs";

const LEASE_REQUIRED_EVENTS = new Set([
  "checkpoint_advanced", "object_copied", "object_verified", "object_failed",
  "compensation_started", "object_compensated", "succeeded", "failed",
]);
const JOB_MUTATING_EVENTS = new Set([
  "prepared", "lease_claimed", "lease_renewed", "lease_recovered", "lease_released",
  "checkpoint_advanced", "object_verified", "object_failed", "object_compensated",
  "compensation_started", "succeeded", "failed",
]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);
const PHASE_FAILURE_CODES = new Set([
  "schema_drift", "snapshot_changed", "plan_changed", "foreign_key_violation", "unknown_failure",
]);

export function reconcileIsolatedRecoveryState(database, input) {
  assertGuard(input?.guard);
  const recoveryJobId = requiredText(input?.recoveryJobId, "recoveryJobId");
  const job = readJob(database, recoveryJobId);
  const objects = readObjects(database, recoveryJobId);
  if (!job) return missingResult(recoveryJobId, objects);

  const chain = verifyIsolatedRecoveryEventChain(database, { recoveryJobId, guard: input.guard });
  if (!chain.valid) {
    return reconciliationResult({
      recoveryJobId,
      consistent: false,
      reason: "invalid_chain",
      chain,
      expected: null,
      actual: publicJob(job),
      objects,
      issues: [issue(`journal_${chain.reason}`, "journal", null, "verified", chain.reason)],
    });
  }

  const events = readIsolatedRecoveryEvents(database, { recoveryJobId, guard: input.guard });
  const issues = [];
  const derived = deriveExpectedState(events, objects, issues);
  compareJob(job, derived.job, issues);
  compareObjects(objects, derived.objects, issues);
  compareInventory(job, objects, events, derived, issues);

  return reconciliationResult({
    recoveryJobId,
    consistent: issues.length === 0,
    reason: issues.length === 0 ? "reconciled" : "state_divergence",
    chain,
    expected: derived.job,
    actual: publicJob(job),
    objects,
    issues,
  });
}

function deriveExpectedState(events, objects, issues) {
  const first = events[0];
  const expectedObjects = new Map(objects.map((object) => [object.importJobId, initialObject(object, first.occurredAt)]));
  let leaseActive = false;
  let failureCode = null;
  let jobUpdatedAt = first.occurredAt;
  let objectCursorImportJobId = null;
  let compensationCursorImportJobId = null;
  let verifiedEventCount = 0;
  let compensatedEventCount = 0;
  let lastCompensatedSequence = Number.POSITIVE_INFINITY;

  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1];
    if (LEASE_REQUIRED_EVENTS.has(event.eventType) && !leaseActive) {
      issues.push(issue("event_without_active_lease", "journal", event.importJobId, true, false));
    }

    if (event.eventType === "lease_claimed") {
      if (leaseActive) issues.push(issue("lease_transition_invalid", "journal", null, false, true));
      leaseActive = true;
    } else if (event.eventType === "lease_recovered") {
      if (!leaseActive) issues.push(issue("lease_transition_invalid", "journal", null, true, false));
      leaseActive = true;
    } else if (event.eventType === "lease_renewed") {
      if (!leaseActive) issues.push(issue("lease_transition_invalid", "journal", null, true, false));
    } else if (event.eventType === "lease_released") {
      if (!leaseActive) issues.push(issue("lease_transition_invalid", "journal", null, true, false));
      leaseActive = false;
    }

    if (event.importJobId) {
      const state = expectedObjects.get(event.importJobId) ?? initialObject({
        importJobId: event.importJobId,
        sequenceNumber: -1,
      }, first.occurredAt);
      if (!expectedObjects.has(event.importJobId)) {
        issues.push(issue("event_object_missing", "inventory", event.importJobId, true, false));
        expectedObjects.set(event.importJobId, state);
      }
      applyObjectEvent(state, event, issues);
      if (event.eventType === "object_verified") {
        verifiedEventCount += 1;
        objectCursorImportJobId = event.importJobId;
        if (state.sequenceNumber !== verifiedEventCount - 1) {
          issues.push(issue("object_copy_order_mismatch", "object", event.importJobId, verifiedEventCount - 1, state.sequenceNumber));
        }
      }
      if (event.eventType === "object_compensated") {
        compensatedEventCount += 1;
        compensationCursorImportJobId = event.importJobId;
        if (state.sequenceNumber >= lastCompensatedSequence) {
          issues.push(issue("object_compensation_order_mismatch", "object", event.importJobId, "descending", state.sequenceNumber));
        }
        lastCompensatedSequence = state.sequenceNumber;
      }
      if (event.eventType === "object_failed") {
        failureCode = consistentFailureCode(failureCode, event.failureCode, event.importJobId, issues);
      }
    }

    if (event.eventType === "compensation_started") {
      failureCode = consistentFailureCode(failureCode, event.failureCode, null, issues);
      const followsAtomicObjectFailure = previous.eventType === "object_failed"
        && previous.failureCode === event.failureCode
        && previous.occurredAt === event.occurredAt;
      const startsFromPhaseFailure = new Set(["applying", "verifying"]).has(previous.jobStatus)
        && PHASE_FAILURE_CODES.has(event.failureCode);
      if (!followsAtomicObjectFailure && !startsFromPhaseFailure) {
        issues.push(issue(
          "compensation_start_without_atomic_failure",
          "journal",
          null,
          "object_failed_or_phase_failure",
          previous.eventType,
        ));
      }
    }
    if (event.eventType === "failed") {
      failureCode = consistentFailureCode(failureCode, event.failureCode, null, issues);
    }
    if (event.eventType === "succeeded" || event.eventType === "failed") leaseActive = false;
    if (JOB_MUTATING_EVENTS.has(event.eventType)) jobUpdatedAt = event.occurredAt;
  }

  const head = events.at(-1);
  return {
    job: {
      status: head.jobStatus,
      attemptCount: head.jobAttemptCount,
      leaseActive,
      objectCursorImportJobId,
      copiedObjectCount: head.copiedObjectCount,
      compensationCursorImportJobId,
      compensatedObjectCount: head.compensatedObjectCount,
      appliedRowCount: head.appliedRowCount,
      verifiedRowCount: head.verifiedRowCount,
      evidenceVersion: head.evidenceVersion,
      preRestoreBackupSha256: head.evidenceVersion === 2 ? head.preRestoreBackupSha256 : null,
      postRestoreSha256: head.evidenceVersion === 2 ? head.postRestoreSha256 : null,
      failureCode: head.jobStatus === "compensating" || head.jobStatus === "failed" ? failureCode : null,
      completedAt: TERMINAL_STATUSES.has(head.jobStatus) ? head.occurredAt : null,
      updatedAt: jobUpdatedAt,
    },
    objects: expectedObjects,
    verifiedEventCount,
    compensatedEventCount,
  };
}

function applyObjectEvent(state, event, issues) {
  const priorStatus = state.status;
  if (event.eventType === "object_copied") {
    if (priorStatus !== "pending" && priorStatus !== "failed") {
      issues.push(issue("object_lifecycle_invalid", "object", event.importJobId, "pending", priorStatus));
    }
    state.status = "copied";
    state.attemptCount += 1;
    state.hasDestinationObjectKey = true;
    state.lastErrorCode = null;
    state.copiedAt = event.occurredAt;
  } else if (event.eventType === "object_verified") {
    if (priorStatus !== "copied") {
      issues.push(issue("object_lifecycle_invalid", "object", event.importJobId, "copied", priorStatus));
    }
    state.status = "verified";
    state.lastErrorCode = null;
    state.verifiedAt = event.occurredAt;
  } else if (event.eventType === "object_failed") {
    if (priorStatus !== "pending" && priorStatus !== "copied") {
      issues.push(issue("object_lifecycle_invalid", "object", event.importJobId, "pending_or_copied", priorStatus));
    }
    if (priorStatus === "pending") state.attemptCount += 1;
    state.status = "failed";
    state.lastErrorCode = event.failureCode;
  } else if (event.eventType === "object_compensated") {
    if ((priorStatus !== "failed" && priorStatus !== "verified") || !state.hasDestinationObjectKey) {
      issues.push(issue("object_lifecycle_invalid", "object", event.importJobId, "created_failed_or_verified", priorStatus));
    }
    state.status = "compensated";
    state.lastErrorCode = null;
    state.compensatedAt = event.occurredAt;
  }
  state.updatedAt = event.occurredAt;
}

function compareJob(actual, expected, issues) {
  compareField(issues, "job_status_mismatch", "job", null, expected.status, actual.status);
  compareField(issues, "job_attempt_count_mismatch", "job", null, expected.attemptCount, actual.attemptCount);
  compareField(issues, "job_lease_state_mismatch", "job", null, expected.leaseActive, actual.leaseActive);
  compareField(issues, "job_object_cursor_mismatch", "job", null, expected.objectCursorImportJobId, actual.objectCursorImportJobId);
  compareField(issues, "job_copied_count_mismatch", "job", null, expected.copiedObjectCount, actual.copiedObjectCount);
  compareField(issues, "job_compensation_cursor_mismatch", "job", null, expected.compensationCursorImportJobId, actual.compensationCursorImportJobId);
  compareField(issues, "job_compensated_count_mismatch", "job", null, expected.compensatedObjectCount, actual.compensatedObjectCount);
  compareField(issues, "job_applied_rows_mismatch", "job", null, expected.appliedRowCount, actual.appliedRowCount);
  compareField(issues, "job_verified_rows_mismatch", "job", null, expected.verifiedRowCount, actual.verifiedRowCount);
  if (expected.evidenceVersion === 2) {
    compareField(
      issues,
      "job_pre_restore_hash_mismatch",
      "job",
      null,
      expected.preRestoreBackupSha256,
      actual.preRestoreBackupSha256,
    );
    compareField(
      issues,
      "job_post_restore_hash_mismatch",
      "job",
      null,
      expected.postRestoreSha256,
      actual.postRestoreSha256,
    );
  }
  compareField(issues, "job_failure_code_mismatch", "job", null, expected.failureCode, actual.failureCode);
  compareField(issues, "job_completed_at_mismatch", "job", null, expected.completedAt, actual.completedAt);
  compareField(issues, "job_updated_at_mismatch", "job", null, expected.updatedAt, actual.updatedAt);
  compareField(issues, "job_execution_enabled", "job", null, false, actual.executionEnabled);
}

function compareObjects(actualObjects, expectedObjects, issues) {
  for (const actual of actualObjects) {
    const expected = expectedObjects.get(actual.importJobId);
    if (!expected) continue;
    if (expected.status === "pending" && actual.status !== "pending") {
      issues.push(issue("object_event_missing", "object", actual.importJobId, "pending", actual.status));
    }
    compareField(issues, "object_status_mismatch", "object", actual.importJobId, expected.status, actual.status);
    compareField(issues, "object_attempt_count_mismatch", "object", actual.importJobId, expected.attemptCount, actual.attemptCount);
    compareField(issues, "object_key_presence_mismatch", "object", actual.importJobId, expected.hasDestinationObjectKey, actual.hasDestinationObjectKey);
    compareField(issues, "object_error_code_mismatch", "object", actual.importJobId, expected.lastErrorCode, actual.lastErrorCode);
    compareField(issues, "object_copied_at_mismatch", "object", actual.importJobId, expected.copiedAt, actual.copiedAt);
    compareField(issues, "object_verified_at_mismatch", "object", actual.importJobId, expected.verifiedAt, actual.verifiedAt);
    compareField(issues, "object_compensated_at_mismatch", "object", actual.importJobId, expected.compensatedAt, actual.compensatedAt);
    compareField(issues, "object_updated_at_mismatch", "object", actual.importJobId, expected.updatedAt, actual.updatedAt);
    if (actual.status === "compensated" && actual.wasPreexisting) {
      issues.push(issue("preexisting_object_compensated", "object", actual.importJobId, false, true));
    }
  }
}

function compareInventory(job, objects, events, derived, issues) {
  const sequences = objects.map((object) => object.sequenceNumber);
  sequences.forEach((sequence, index) => {
    if (sequence !== index) issues.push(issue("object_sequence_gap", "inventory", null, index, sequence));
  });
  compareField(
    issues, "verified_event_count_mismatch", "inventory", null,
    derived.verifiedEventCount, events.at(-1).copiedObjectCount,
  );
  compareField(
    issues, "compensated_event_count_mismatch", "inventory", null,
    derived.compensatedEventCount, events.at(-1).compensatedObjectCount,
  );
  if (job.appliedRowCount > job.expectedRowCount || job.verifiedRowCount > job.expectedRowCount) {
    issues.push(issue("expected_rows_exceeded", "inventory", null, job.expectedRowCount, Math.max(job.appliedRowCount, job.verifiedRowCount)));
  }
  if (job.status === "succeeded") {
    const incomplete = objects.filter((object) => object.status !== "verified").length;
    if (incomplete > 0) issues.push(issue("success_inventory_incomplete", "inventory", null, 0, incomplete));
    if (job.appliedRowCount !== job.expectedRowCount || job.verifiedRowCount !== job.expectedRowCount) {
      issues.push(issue("success_rows_incomplete", "inventory", null, job.expectedRowCount, job.verifiedRowCount));
    }
    if (derived.job.evidenceVersion === 2
      && (!derived.job.preRestoreBackupSha256 || !derived.job.postRestoreSha256)) {
      issues.push(issue("success_snapshot_hashes_incomplete", "journal", null, true, false));
    }
  }
  if (job.status === "failed") {
    const dirty = objects.filter((object) => !object.wasPreexisting
      && object.hasDestinationObjectKey && object.status !== "compensated").length;
    if (dirty > 0) issues.push(issue("failure_inventory_dirty", "inventory", null, 0, dirty));
    if (derived.job.evidenceVersion === 2 && hasPhaseFailure(events)
      && (!derived.job.preRestoreBackupSha256
        || derived.job.postRestoreSha256 !== derived.job.preRestoreBackupSha256)) {
      issues.push(issue("failure_snapshot_not_restored", "journal", null, true, false));
    }
  }
}

function hasPhaseFailure(events) {
  return events.some((event, index) => {
    if (event.eventType !== "compensation_started") return false;
    const previous = events[index - 1];
    return !previous
      || previous.eventType !== "object_failed"
      || previous.failureCode !== event.failureCode
      || previous.occurredAt !== event.occurredAt;
  });
}

function readJob(database, recoveryJobId) {
  const row = database.prepare(`
    SELECT id, status, execution_enabled, attempt_count, lease_token, lease_expires_at,
      object_cursor_import_job_id, copied_object_count,
      compensation_cursor_import_job_id, compensated_object_count,
      applied_row_count, verified_row_count, expected_row_count,
      pre_restore_backup_sha256, post_restore_sha256,
      failure_code, completed_at, updated_at
    FROM restore_recovery_jobs WHERE id = ?
  `).get(recoveryJobId);
  return row ? {
    jobId: String(row.id),
    status: String(row.status),
    executionEnabled: Boolean(row.execution_enabled),
    attemptCount: Number(row.attempt_count),
    leaseActive: row.lease_token != null && row.lease_expires_at != null,
    objectCursorImportJobId: nullableString(row.object_cursor_import_job_id),
    copiedObjectCount: Number(row.copied_object_count),
    compensationCursorImportJobId: nullableString(row.compensation_cursor_import_job_id),
    compensatedObjectCount: Number(row.compensated_object_count),
    appliedRowCount: Number(row.applied_row_count),
    verifiedRowCount: Number(row.verified_row_count),
    expectedRowCount: Number(row.expected_row_count),
    preRestoreBackupSha256: nullableString(row.pre_restore_backup_sha256),
    postRestoreSha256: nullableString(row.post_restore_sha256),
    failureCode: nullableString(row.failure_code),
    completedAt: nullableString(row.completed_at),
    updatedAt: String(row.updated_at),
  } : null;
}

function readObjects(database, recoveryJobId) {
  return database.prepare(`
    SELECT import_job_id, sequence_number, status, destination_object_key,
      was_preexisting, attempt_count, last_error_code, copied_at, verified_at,
      compensated_at, updated_at
    FROM restore_recovery_objects
    WHERE recovery_job_id = ? ORDER BY sequence_number, import_job_id
  `).all(recoveryJobId).map((row) => ({
    importJobId: String(row.import_job_id),
    sequenceNumber: Number(row.sequence_number),
    status: String(row.status),
    attemptCount: Number(row.attempt_count),
    wasPreexisting: Boolean(row.was_preexisting),
    hasDestinationObjectKey: row.destination_object_key != null,
    lastErrorCode: nullableString(row.last_error_code),
    copiedAt: nullableString(row.copied_at),
    verifiedAt: nullableString(row.verified_at),
    compensatedAt: nullableString(row.compensated_at),
    updatedAt: String(row.updated_at),
  }));
}

function initialObject(object, preparedAt) {
  return {
    importJobId: object.importJobId,
    sequenceNumber: object.sequenceNumber,
    status: "pending",
    attemptCount: 0,
    hasDestinationObjectKey: false,
    lastErrorCode: null,
    copiedAt: null,
    verifiedAt: null,
    compensatedAt: null,
    updatedAt: preparedAt,
  };
}

function consistentFailureCode(current, next, importJobId, issues) {
  if (current !== null && current !== next) {
    issues.push(issue("failure_code_event_mismatch", "journal", importJobId, current, next));
  }
  return current ?? next;
}

function compareField(issues, code, scope, importJobId, expected, actual) {
  if (expected !== actual) issues.push(issue(code, scope, importJobId, expected, actual));
}

function issue(code, scope, importJobId, expected, actual) {
  return { code, scope, importJobId: importJobId ?? null, expected, actual };
}

function publicJob(job) {
  return job ? { ...job } : null;
}

function publicObjects(objects) {
  return objects.map((object) => ({ ...object }));
}

function inventorySummary(objects) {
  const statusCounts = { pending: 0, copied: 0, verified: 0, failed: 0, compensated: 0 };
  let createdObjectCount = 0;
  let preexistingObjectCount = 0;
  for (const object of objects) {
    statusCounts[object.status] = (statusCounts[object.status] ?? 0) + 1;
    if (object.hasDestinationObjectKey && object.wasPreexisting) preexistingObjectCount += 1;
    if (object.hasDestinationObjectKey && !object.wasPreexisting) createdObjectCount += 1;
  }
  return { objectCount: objects.length, createdObjectCount, preexistingObjectCount, statusCounts };
}

function reconciliationResult(value) {
  return {
    recoveryJobId: value.recoveryJobId,
    consistent: value.consistent,
    reason: value.reason,
    chain: value.chain,
    expectedJob: value.expected,
    actualJob: value.actual,
    objects: publicObjects(value.objects),
    inventory: inventorySummary(value.objects),
    issues: value.issues,
    readOnly: true,
    productWritesEnabled: false,
  };
}

function missingResult(recoveryJobId, objects) {
  return reconciliationResult({
    recoveryJobId,
    consistent: false,
    reason: "not_found",
    chain: { valid: false, reason: "empty_chain", eventCount: 0, terminal: false },
    expected: null,
    actual: null,
    objects,
    issues: [issue("job_not_found", "job", null, true, false)],
  });
}

function nullableString(value) {
  return value == null ? null : String(value);
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El reconciliador solo admite SQLite aislado y no realiza escrituras.");
  }
}
