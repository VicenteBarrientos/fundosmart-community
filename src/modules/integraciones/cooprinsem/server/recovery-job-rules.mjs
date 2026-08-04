import { buildRestoreConfirmationBinding } from "./restore-confirmation-rules.mjs";

export const RECOVERY_JOB_STATUSES = Object.freeze(["prepared", "copying", "applying", "verifying", "succeeded", "compensating", "failed"]);
export const RECOVERY_OBJECT_STATUSES = Object.freeze(["pending", "copied", "verified", "compensated", "failed"]);
export const RECOVERY_MAX_OBJECT_ATTEMPTS = 3;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSITIONS = Object.freeze({
  prepared: Object.freeze(["copying", "failed"]),
  copying: Object.freeze(["applying", "compensating", "failed"]),
  applying: Object.freeze(["verifying", "compensating", "failed"]),
  verifying: Object.freeze(["succeeded", "compensating", "failed"]),
  succeeded: Object.freeze([]),
  compensating: Object.freeze(["failed"]),
  failed: Object.freeze([]),
});

const FAILURE_CODES = new Set([
  "original_missing",
  "original_hash_mismatch",
  "schema_drift",
  "snapshot_changed",
  "plan_changed",
  "foreign_key_violation",
  "lease_lost",
]);
const FAILURE_PHASES = new Set(["prepare", "copy", "apply", "verify", "compensate"]);

export function prepareRecoveryJobSpec(input) {
  const binding = buildRestoreConfirmationBinding(input.binding);
  const jobId = requiredText(input.jobId, "jobId");
  const confirmationTokenId = requiredText(input.confirmationTokenId, "confirmationTokenId");
  const now = requiredText(input.now, "now");
  const expectedRowCount = Number(input.expectedRowCount);
  if (!Number.isInteger(expectedRowCount) || expectedRowCount < 0) throw new Error("expectedRowCount debe ser un entero no negativo.");
  const originals = Array.isArray(input.originalFiles) ? input.originalFiles : [];
  const seen = new Set();
  const objects = originals.map((file, sequenceNumber) => {
    const importJobId = requiredText(file.importJobId, "importJobId");
    if (seen.has(importJobId)) throw new Error("Cada importacion puede declarar un solo original por trabajo.");
    seen.add(importJobId);
    const sha256 = String(file.sha256 ?? "");
    const sizeBytes = Number(file.fileSizeBytes);
    if (!SHA256_PATTERN.test(sha256)) throw new Error("El original requiere un SHA-256 valido.");
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw new Error("El original requiere un tamano no negativo.");
    return {
      id: `${jobId}:object:${sequenceNumber}`,
      recoveryJobId: jobId,
      importJobId,
      sequenceNumber,
      sha256,
      sizeBytes,
      status: "pending",
      destinationObjectKey: null,
      wasPreexisting: false,
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  return {
    job: {
      id: jobId,
      organizationId: binding.organizationId,
      fieldId: binding.fieldId,
      confirmationTokenId,
      actorEmail: binding.actorEmail,
      backupSha256: binding.backupSha256,
      snapshotSha256: binding.snapshotSha256,
      planSha256: binding.planSha256,
      status: "prepared",
      executionEnabled: false,
      expectedRowCount,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      objectCursorImportJobId: null,
      copiedObjectCount: 0,
      compensationCursorImportJobId: null,
      compensatedObjectCount: 0,
      appliedRowCount: 0,
      verifiedRowCount: 0,
      preRestoreBackupObjectKey: null,
      preRestoreBackupSha256: null,
      postRestoreSha256: null,
      failureCode: null,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    objects,
  };
}

export function planNextRecoveryAction(job, objects, now = new Date().toISOString()) {
  if (job?.executionEnabled !== true) return { action: "blocked", reason: "execution_disabled" };
  if (!RECOVERY_JOB_STATUSES.includes(job.status)) return { action: "blocked", reason: "invalid_status" };
  if (!recoveryLeaseIsClaimable(job, now)) return { action: "busy", reason: "lease_active" };
  const ordered = [...(objects ?? [])].sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  if (job.status === "succeeded" || job.status === "failed") return { action: "none", reason: "terminal" };
  if (job.status === "prepared") {
    return job.preRestoreBackupSha256 && job.preRestoreBackupObjectKey
      ? { action: "begin_copying" }
      : { action: "capture_pre_restore_backup" };
  }
  if (job.status === "copying") {
    const failedWithCreatedObject = ordered.find((object) => object.status === "failed" && object.destinationObjectKey && !object.wasPreexisting);
    if (failedWithCreatedObject) return { action: "begin_compensation", importJobId: failedWithCreatedObject.importJobId };
    const exhausted = ordered.find((object) => object.status === "failed" && object.attemptCount >= RECOVERY_MAX_OBJECT_ATTEMPTS);
    if (exhausted) return { action: "begin_compensation", importJobId: exhausted.importJobId };
    const verify = ordered.find((object) => object.status === "copied");
    if (verify) return { action: "verify_original", importJobId: verify.importJobId, sequenceNumber: verify.sequenceNumber };
    const copy = ordered.find((object) => object.status === "pending" || object.status === "failed");
    if (copy) return { action: "copy_original", importJobId: copy.importJobId, sequenceNumber: copy.sequenceNumber };
    return { action: "begin_applying" };
  }
  if (job.status === "applying") {
    return job.appliedRowCount < job.expectedRowCount
      ? { action: "apply_next_batch", remainingRowCount: job.expectedRowCount - job.appliedRowCount }
      : { action: "begin_verifying" };
  }
  if (job.status === "verifying") {
    return job.verifiedRowCount < job.expectedRowCount
      ? { action: "verify_next_batch", remainingRowCount: job.expectedRowCount - job.verifiedRowCount }
      : { action: "finalize_success" };
  }
  const compensate = ordered
    .filter((object) => !object.wasPreexisting && (
      object.status === "copied" || object.status === "verified" || (object.status === "failed" && object.destinationObjectKey)
    ))
    .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0];
  return compensate
    ? { action: "compensate_original", importJobId: compensate.importJobId, sequenceNumber: compensate.sequenceNumber }
    : { action: "finalize_failure" };
}

export function recoveryJobCanTransition(current, next) {
  return TRANSITIONS[current]?.includes(next) ?? false;
}

export function recoveryLeaseIsClaimable(job, now = new Date().toISOString()) {
  return !job?.leaseToken || !job?.leaseExpiresAt || job.leaseExpiresAt <= now;
}

export function sanitizeRecoveryFailure(cause, phase) {
  const code = cause && typeof cause === "object" && FAILURE_CODES.has(cause.code) ? cause.code : "unknown_failure";
  return {
    code,
    phase: FAILURE_PHASES.has(phase) ? phase : "apply",
    retryable: code === "original_missing" || code === "lease_lost" || code === "unknown_failure",
  };
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}
