const MAX_ATTEMPTS = 3;
const FAILURE_CODES = new Set(["original_missing", "original_hash_mismatch", "lease_lost", "unknown_failure"]);

export function commitIsolatedRecoveryObjectState(database, input) {
  assertGuard(input?.guard);
  const jobId = requiredText(input.jobId, "jobId");
  const importJobId = requiredText(input.importJobId, "importJobId");
  const leaseToken = requiredText(input.leaseToken, "leaseToken");
  const now = validNow(input.now);
  const expectedJobAttemptCount = nonNegativeInteger(input.expectedJobAttemptCount, "expectedJobAttemptCount");
  const expected = normalizeObject(input.expected, "expected");
  const next = normalizeObject(input.next, "next");
  assertObjectTransition(database, jobId, importJobId, expected, next);

  const timestamps = transitionTimestamps(expected, next, now);
  const result = database.prepare(`
    UPDATE restore_recovery_objects
    SET status = ?, destination_object_key = ?, was_preexisting = ?, attempt_count = ?,
      last_error_code = ?, copied_at = ?, verified_at = ?, compensated_at = ?, updated_at = ?
    WHERE recovery_job_id = ? AND import_job_id = ?
      AND status = ? AND destination_object_key IS ? AND was_preexisting = ?
      AND attempt_count = ? AND last_error_code IS ?
      AND EXISTS (
        SELECT 1 FROM restore_recovery_jobs job
        WHERE job.id = ? AND job.execution_enabled = 0
          AND job.lease_token = ? AND job.lease_expires_at > ? AND job.attempt_count = ?
      )
  `).run(
    next.status,
    next.destinationObjectKey,
    next.wasPreexisting ? 1 : 0,
    next.attemptCount,
    next.lastErrorCode,
    timestamps.copiedAt,
    timestamps.verifiedAt,
    timestamps.compensatedAt,
    now,
    jobId,
    importJobId,
    expected.status,
    expected.destinationObjectKey,
    expected.wasPreexisting ? 1 : 0,
    expected.attemptCount,
    expected.lastErrorCode,
    jobId,
    leaseToken,
    now,
    expectedJobAttemptCount,
  );
  const object = readIsolatedRecoveryObject(database, { jobId, importJobId, guard: input.guard });
  const changed = Number(result.changes) === 1;
  return {
    changed,
    reason: changed ? "committed" : classifyRejectedObject(database, jobId, leaseToken, expectedJobAttemptCount, now, object),
    object: publicObjectState(object),
    productWritesEnabled: false,
  };
}

export function readIsolatedRecoveryObject(database, input) {
  assertGuard(input?.guard);
  const row = database.prepare(`
    SELECT recovery_job_id, import_job_id, sequence_number, sha256, size_bytes, status,
      destination_object_key, was_preexisting, attempt_count, last_error_code,
      copied_at, verified_at, compensated_at, updated_at
    FROM restore_recovery_objects
    WHERE recovery_job_id = ? AND import_job_id = ?
  `).get(requiredText(input.jobId, "jobId"), requiredText(input.importJobId, "importJobId"));
  if (!row) return null;
  return {
    recoveryJobId: String(row.recovery_job_id),
    importJobId: String(row.import_job_id),
    sequenceNumber: Number(row.sequence_number),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    status: String(row.status),
    destinationObjectKey: row.destination_object_key == null ? null : String(row.destination_object_key),
    wasPreexisting: Boolean(row.was_preexisting),
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
    copiedAt: row.copied_at == null ? null : String(row.copied_at),
    verifiedAt: row.verified_at == null ? null : String(row.verified_at),
    compensatedAt: row.compensated_at == null ? null : String(row.compensated_at),
    updatedAt: String(row.updated_at),
  };
}

function assertObjectTransition(database, jobId, importJobId, expected, next) {
  if (expected.status === "failed" && expected.destinationObjectKey) {
    assertStableObjectIdentity(expected, next);
    if (next.status !== "compensated" || next.lastErrorCode !== null || next.attemptCount !== expected.attemptCount) {
      throw new Error("Un objeto fallido ya creado debe compensarse sin otro intento.");
    }
    if (expected.wasPreexisting) throw new Error("Un objeto preexistente nunca puede compensarse.");
    assertReverseCompensationOrder(database, jobId, importJobId);
    const job = database.prepare("SELECT status FROM restore_recovery_jobs WHERE id = ?").get(jobId);
    if (job?.status !== "compensating") throw new Error("La compensacion exige un trabajo en estado compensating.");
    return;
  }
  if (expected.status === "pending" || expected.status === "failed") {
    assertCopyOrder(database, jobId, importJobId);
    if (expected.attemptCount >= MAX_ATTEMPTS) throw new Error("El original agoto sus intentos aislados.");
    if (next.attemptCount !== expected.attemptCount + 1) throw new Error("Cada intento de original debe incrementar el contador una vez.");
    if (next.status === "copied") {
      if (!next.destinationObjectKey || next.lastErrorCode !== null) throw new Error("Copied requiere clave interna y ningun error.");
      return;
    }
    if (next.status === "failed") {
      if (next.destinationObjectKey !== expected.destinationObjectKey
        || next.wasPreexisting !== expected.wasPreexisting
        || !FAILURE_CODES.has(next.lastErrorCode)) {
        throw new Error("Failed requiere un codigo generico y no puede inventar una clave.");
      }
      return;
    }
    throw new Error("Un original pendiente o fallido solo puede copiarse o fallar.");
  }
  if (expected.status === "copied") {
    assertStableObjectIdentity(expected, next);
    if (next.attemptCount !== expected.attemptCount) throw new Error("Verificar no crea un nuevo intento.");
    if (next.status === "verified" && next.lastErrorCode === null) return;
    if (next.status === "failed" && FAILURE_CODES.has(next.lastErrorCode)) return;
    throw new Error("Un original copiado solo puede verificarse o fallar con codigo generico.");
  }
  if (expected.status === "verified") {
    assertStableObjectIdentity(expected, next);
    if (next.status !== "compensated" || next.lastErrorCode !== null) throw new Error("Verified solo puede entrar en compensacion limpia.");
    if (expected.wasPreexisting) throw new Error("Un objeto preexistente nunca puede compensarse.");
    assertReverseCompensationOrder(database, jobId, importJobId);
    const job = database.prepare("SELECT status FROM restore_recovery_jobs WHERE id = ?").get(jobId);
    if (job?.status !== "compensating") throw new Error("La compensacion exige un trabajo en estado compensating.");
    return;
  }
  throw new Error("El estado del original es terminal para este simulador.");
}

function assertCopyOrder(database, jobId, importJobId) {
  const object = database.prepare(`
    SELECT sequence_number FROM restore_recovery_objects
    WHERE recovery_job_id = ? AND import_job_id = ?
  `).get(jobId, importJobId);
  if (!object) throw new Error("El original aislado no existe.");
  const previous = database.prepare(`
    SELECT count(*) AS count FROM restore_recovery_objects
    WHERE recovery_job_id = ? AND sequence_number < ? AND status <> 'verified'
  `).get(jobId, object.sequence_number);
  if (Number(previous.count) > 0) throw new Error("Los originales deben copiarse y verificarse en orden.");
}

function assertReverseCompensationOrder(database, jobId, importJobId) {
  const object = database.prepare(`
    SELECT sequence_number FROM restore_recovery_objects
    WHERE recovery_job_id = ? AND import_job_id = ?
  `).get(jobId, importJobId);
  const later = database.prepare(`
    SELECT count(*) AS count FROM restore_recovery_objects
    WHERE recovery_job_id = ? AND sequence_number > ? AND was_preexisting = 0
      AND status IN ('copied', 'verified')
  `).get(jobId, object.sequence_number);
  if (Number(later.count) > 0) throw new Error("La compensacion debe ejecutarse en orden inverso.");
}

function assertStableObjectIdentity(expected, next) {
  if (!expected.destinationObjectKey
    || next.destinationObjectKey !== expected.destinationObjectKey
    || next.wasPreexisting !== expected.wasPreexisting) {
    throw new Error("La clave interna y su procedencia no pueden cambiar despues de copiar.");
  }
}

function transitionTimestamps(expected, next, now) {
  return {
    copiedAt: next.status === "copied" ? now : expected.copiedAt,
    verifiedAt: next.status === "verified" ? now : expected.verifiedAt,
    compensatedAt: next.status === "compensated" ? now : expected.compensatedAt,
  };
}

function classifyRejectedObject(database, jobId, leaseToken, expectedJobAttemptCount, now, object) {
  if (!object) return "not_found";
  const job = database.prepare(`
    SELECT lease_token, lease_expires_at, attempt_count FROM restore_recovery_jobs WHERE id = ?
  `).get(jobId);
  if (!job || job.lease_token !== leaseToken || job.lease_expires_at <= now || Number(job.attempt_count) !== expectedJobAttemptCount) {
    return "lease_lost";
  }
  return "stale_object";
}

function publicObjectState(object) {
  if (!object) return null;
  return {
    importJobId: object.importJobId,
    sequenceNumber: object.sequenceNumber,
    status: object.status,
    attemptCount: object.attemptCount,
    wasPreexisting: object.wasPreexisting,
    hasDestinationObjectKey: Boolean(object.destinationObjectKey),
    lastErrorCode: object.lastErrorCode,
    copiedAt: object.copiedAt,
    verifiedAt: object.verifiedAt,
    compensatedAt: object.compensatedAt,
  };
}

function normalizeObject(value, prefix) {
  return {
    status: requiredText(value?.status, `${prefix}.status`),
    destinationObjectKey: value?.destinationObjectKey == null ? null : requiredText(value.destinationObjectKey, `${prefix}.destinationObjectKey`),
    wasPreexisting: value?.wasPreexisting === true,
    attemptCount: nonNegativeInteger(value?.attemptCount, `${prefix}.attemptCount`),
    lastErrorCode: value?.lastErrorCode == null ? null : requiredText(value.lastErrorCode, `${prefix}.lastErrorCode`),
    copiedAt: value?.copiedAt == null ? null : requiredText(value.copiedAt, `${prefix}.copiedAt`),
    verifiedAt: value?.verifiedAt == null ? null : requiredText(value.verifiedAt, `${prefix}.verifiedAt`),
    compensatedAt: value?.compensatedAt == null ? null : requiredText(value.compensatedAt, `${prefix}.compensatedAt`),
  };
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} debe ser un entero no negativo.`);
  return number;
}

function validNow(value) {
  const now = requiredText(value, "now");
  if (!Number.isFinite(Date.parse(now))) throw new Error("now debe ser una fecha ISO valida.");
  return now;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El simulador de objetos solo admite SQLite aislado.");
  }
}
