import { recoveryJobCanTransition } from "./recovery-job-rules.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";

const SUPPORTED_STATUSES = new Set(["prepared", "copying", "applying", "verifying", "succeeded"]);

export function commitIsolatedRecoveryCheckpoint(database, input) {
  assertGuard(input?.guard);
  const jobId = requiredText(input.jobId, "jobId");
  const leaseToken = requiredText(input.leaseToken, "leaseToken");
  const now = validNow(input.now);
  const expected = normalizeExpected(input.expected);
  const next = normalizeNext(input.next, expected.expectedRowCount);
  assertCheckpointAdvance(database, jobId, expected, next);
  const terminal = next.status === "succeeded";
  const result = database.prepare(`
    UPDATE restore_recovery_jobs
    SET status = ?, object_cursor_import_job_id = ?, copied_object_count = ?,
      applied_row_count = ?, verified_row_count = ?,
      lease_token = ${terminal ? "NULL" : "lease_token"},
      lease_expires_at = ${terminal ? "NULL" : "lease_expires_at"},
      completed_at = ${terminal ? "?" : "completed_at"}, updated_at = ?
    WHERE id = ? AND execution_enabled = 0
      AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
      AND status = ? AND object_cursor_import_job_id IS ?
      AND copied_object_count = ? AND applied_row_count = ? AND verified_row_count = ?
      AND expected_row_count = ?
  `).run(
    next.status,
    next.objectCursorImportJobId,
    next.copiedObjectCount,
    next.appliedRowCount,
    next.verifiedRowCount,
    ...(terminal ? [now] : []),
    now,
    jobId,
    leaseToken,
    now,
    expected.attemptCount,
    expected.status,
    expected.objectCursorImportJobId,
    expected.copiedObjectCount,
    expected.appliedRowCount,
    expected.verifiedRowCount,
    expected.expectedRowCount,
  );
  const checkpoint = readIsolatedRecoveryCheckpoint(database, { jobId, guard: input.guard });
  const changed = Number(result.changes) === 1;
  return {
    changed,
    reason: changed ? "committed" : classifyRejectedCheckpoint(checkpoint, leaseToken, expected, now),
    checkpoint,
    productWritesEnabled: false,
  };
}

function assertCheckpointAdvance(database, jobId, expected, next) {
  if (!SUPPORTED_STATUSES.has(expected.status) || !SUPPORTED_STATUSES.has(next.status)) {
    throw new Error("El simulador de checkpoint solo cubre la ruta exitosa aislada.");
  }
  if (expected.status === "succeeded") throw new Error("Un checkpoint terminal no puede avanzar.");
  if (next.status !== expected.status && !recoveryJobCanTransition(expected.status, next.status)) {
    throw new Error("La transicion de checkpoint no esta permitida.");
  }
  if (next.copiedObjectCount < expected.copiedObjectCount
    || next.appliedRowCount < expected.appliedRowCount
    || next.verifiedRowCount < expected.verifiedRowCount) {
    throw new Error("Los contadores del checkpoint no pueden retroceder.");
  }
  if (next.appliedRowCount > expected.expectedRowCount
    || next.verifiedRowCount > next.appliedRowCount
    || next.verifiedRowCount > expected.expectedRowCount) {
    throw new Error("Los contadores del checkpoint exceden el plan confirmado.");
  }
  const objects = database.prepare(`
    SELECT import_job_id, sequence_number
    FROM restore_recovery_objects WHERE recovery_job_id = ? ORDER BY sequence_number
  `).all(jobId);
  if (next.copiedObjectCount > objects.length) throw new Error("El checkpoint excede el inventario de originales.");

  if (expected.status === "prepared") {
    assertUnchangedProgress(expected, next);
    if (next.status !== "copying") throw new Error("El primer checkpoint debe entrar en copying.");
    return;
  }
  if (expected.status === "copying") {
    if (next.appliedRowCount !== expected.appliedRowCount || next.verifiedRowCount !== expected.verifiedRowCount) {
      throw new Error("Copying no puede modificar filas aplicadas o verificadas.");
    }
    const copiedDelta = next.copiedObjectCount - expected.copiedObjectCount;
    if (copiedDelta < 0 || copiedDelta > 1) throw new Error("Copying solo puede confirmar un original por checkpoint.");
    if (copiedDelta === 1) {
      const expectedCursor = objects[next.copiedObjectCount - 1]?.import_job_id;
      if (next.objectCursorImportJobId !== expectedCursor) throw new Error("El cursor no coincide con el siguiente original confirmado.");
    } else if (next.objectCursorImportJobId !== expected.objectCursorImportJobId) {
      throw new Error("El cursor no puede avanzar sin confirmar un original.");
    }
    if (next.status === "copying" && copiedDelta !== 1) throw new Error("Un checkpoint copying debe avanzar un original.");
    if (next.status === "applying" && next.copiedObjectCount !== objects.length) {
      throw new Error("No se puede aplicar antes de confirmar todos los originales.");
    }
    return;
  }
  if (expected.status === "applying") {
    assertObjectProgressUnchanged(expected, next);
    if (next.verifiedRowCount !== expected.verifiedRowCount) throw new Error("Applying no puede verificar filas.");
    const appliedDelta = next.appliedRowCount - expected.appliedRowCount;
    if (next.status === "applying" && appliedDelta <= 0) throw new Error("Un checkpoint applying debe avanzar filas.");
    if (next.status === "verifying" && next.appliedRowCount !== expected.expectedRowCount) {
      throw new Error("No se puede verificar antes de aplicar todas las filas.");
    }
    return;
  }
  assertObjectProgressUnchanged(expected, next);
  if (next.appliedRowCount !== expected.appliedRowCount) throw new Error("Verifying no puede aplicar filas.");
  const verifiedDelta = next.verifiedRowCount - expected.verifiedRowCount;
  if (next.status === "verifying" && verifiedDelta <= 0) throw new Error("Un checkpoint verifying debe avanzar filas.");
  if (next.status === "succeeded" && next.verifiedRowCount !== expected.expectedRowCount) {
    throw new Error("No se puede finalizar antes de verificar todas las filas.");
  }
}

function assertUnchangedProgress(expected, next) {
  assertObjectProgressUnchanged(expected, next);
  if (next.appliedRowCount !== expected.appliedRowCount || next.verifiedRowCount !== expected.verifiedRowCount) {
    throw new Error("Prepared no puede adelantar contadores.");
  }
}

function assertObjectProgressUnchanged(expected, next) {
  if (next.copiedObjectCount !== expected.copiedObjectCount
    || next.objectCursorImportJobId !== expected.objectCursorImportJobId) {
    throw new Error("La fase no puede modificar el progreso de originales.");
  }
}

function classifyRejectedCheckpoint(checkpoint, leaseToken, expected, now) {
  if (!checkpoint) return "not_found";
  if (checkpoint.leaseToken !== leaseToken
    || !checkpoint.leaseExpiresAt
    || checkpoint.leaseExpiresAt <= now
    || checkpoint.attemptCount !== expected.attemptCount) return "lease_lost";
  return "stale_checkpoint";
}

function normalizeExpected(value) {
  return {
    status: requiredText(value?.status, "expected.status"),
    attemptCount: nonNegativeInteger(value?.attemptCount, "expected.attemptCount"),
    objectCursorImportJobId: nullableText(value?.objectCursorImportJobId),
    copiedObjectCount: nonNegativeInteger(value?.copiedObjectCount, "expected.copiedObjectCount"),
    appliedRowCount: nonNegativeInteger(value?.appliedRowCount, "expected.appliedRowCount"),
    verifiedRowCount: nonNegativeInteger(value?.verifiedRowCount, "expected.verifiedRowCount"),
    expectedRowCount: nonNegativeInteger(value?.expectedRowCount, "expected.expectedRowCount"),
  };
}

function normalizeNext(value, expectedRowCount) {
  return {
    status: requiredText(value?.status, "next.status"),
    objectCursorImportJobId: nullableText(value?.objectCursorImportJobId),
    copiedObjectCount: nonNegativeInteger(value?.copiedObjectCount, "next.copiedObjectCount"),
    appliedRowCount: nonNegativeInteger(value?.appliedRowCount, "next.appliedRowCount"),
    verifiedRowCount: nonNegativeInteger(value?.verifiedRowCount, "next.verifiedRowCount"),
    expectedRowCount,
  };
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} debe ser un entero no negativo.`);
  return number;
}

function nullableText(value) {
  if (value == null) return null;
  return requiredText(value, "cursor");
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
    throw new Error("El simulador de checkpoint solo admite SQLite aislado.");
  }
}
