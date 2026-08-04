import { createHash } from "node:crypto";
import { recoveryJobCanTransition } from "./recovery-job-rules.mjs";

export const RECOVERY_EVENT_TYPES = Object.freeze([
  "prepared",
  "lease_claimed",
  "lease_renewed",
  "lease_recovered",
  "lease_released",
  "checkpoint_advanced",
  "object_copied",
  "object_verified",
  "object_failed",
  "compensation_started",
  "object_compensated",
  "succeeded",
  "failed",
]);

const JOB_STATUSES = new Set(["prepared", "copying", "applying", "verifying", "succeeded", "compensating", "failed"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);
const NON_TERMINAL_STATUSES = ["prepared", "copying", "applying", "verifying", "compensating"];
const FAILURE_EVENTS = new Set(["object_failed", "compensation_started", "failed"]);
const FAILURE_CODES = new Set([
  "original_missing",
  "original_hash_mismatch",
  "schema_drift",
  "snapshot_changed",
  "plan_changed",
  "foreign_key_violation",
  "lease_lost",
  "unknown_failure",
]);
const OBJECT_EVENT_STATUS = Object.freeze({
  object_copied: "copied",
  object_verified: "verified",
  object_failed: "failed",
  object_compensated: "compensated",
});
const EVENT_JOB_STATUSES = Object.freeze({
  prepared: ["prepared"],
  lease_claimed: NON_TERMINAL_STATUSES,
  lease_renewed: NON_TERMINAL_STATUSES,
  lease_recovered: NON_TERMINAL_STATUSES,
  lease_released: NON_TERMINAL_STATUSES,
  checkpoint_advanced: ["copying", "applying", "verifying", "compensating"],
  object_copied: ["copying"],
  object_verified: ["copying", "applying"],
  object_failed: ["compensating"],
  compensation_started: ["compensating"],
  object_compensated: ["compensating"],
  succeeded: ["succeeded"],
  failed: ["failed"],
});
const INPUT_KEYS = new Set([
  "recoveryJobId",
  "sequenceNumber",
  "eventType",
  "jobStatus",
  "jobAttemptCount",
  "importJobId",
  "objectStatus",
  "failureCode",
  "copiedObjectCount",
  "compensatedObjectCount",
  "appliedRowCount",
  "verifiedRowCount",
  "occurredAt",
  "previousEventSha256",
  "guard",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function appendIsolatedRecoveryEvent(database, input) {
  assertGuard(input?.guard);
  assertKnownKeys(input);
  const recoveryJobId = requiredText(input.recoveryJobId, "recoveryJobId");
  const job = database.prepare(`
    SELECT id, execution_enabled, pre_restore_backup_sha256, post_restore_sha256
    FROM restore_recovery_jobs WHERE id = ?
  `).get(recoveryJobId);
  if (!job) return { changed: false, reason: "not_found", event: null, productWritesEnabled: false };
  if (Number(job.execution_enabled) !== 0) throw new Error("El diario aislado exige un trabajo con ejecucion bloqueada.");
  const event = normalizeEvent(input, job);

  const eventSha256 = hashRecoveryEvent(event);
  const existing = readEventAtSequence(database, event.recoveryJobId, event.sequenceNumber);
  if (existing) {
    return existing.eventSha256 === eventSha256
      ? journalResult(false, "already_committed", existing)
      : journalResult(false, "sequence_conflict", existing);
  }

  const previous = readLastEvent(database, event.recoveryJobId);
  assertEventSequence(event, previous);
  try {
    database.prepare(`
      INSERT INTO restore_recovery_events (
        id, recovery_job_id, sequence_number, event_type, job_status, job_attempt_count,
        import_job_id, object_status, failure_code, copied_object_count,
        compensated_object_count, applied_row_count, verified_row_count, evidence_version,
        pre_restore_backup_sha256, post_restore_sha256, occurred_at, previous_event_sha256,
        event_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventSha256,
      event.recoveryJobId,
      event.sequenceNumber,
      event.eventType,
      event.jobStatus,
      event.jobAttemptCount,
      event.importJobId,
      event.objectStatus,
      event.failureCode,
      event.copiedObjectCount,
      event.compensatedObjectCount,
      event.appliedRowCount,
      event.verifiedRowCount,
      event.evidenceVersion,
      event.preRestoreBackupSha256,
      event.postRestoreSha256,
      event.occurredAt,
      event.previousEventSha256,
      eventSha256,
      event.occurredAt,
    );
  } catch (cause) {
    const winner = readEventAtSequence(database, event.recoveryJobId, event.sequenceNumber);
    if (!winner) throw cause;
    return winner.eventSha256 === eventSha256
      ? journalResult(false, "already_committed", winner)
      : journalResult(false, "sequence_conflict", winner);
  }
  return journalResult(true, "committed", { ...event, eventSha256 });
}

export function readIsolatedRecoveryEvents(database, input) {
  assertGuard(input?.guard);
  const recoveryJobId = requiredText(input?.recoveryJobId, "recoveryJobId");
  return database.prepare(`
    SELECT recovery_job_id, sequence_number, event_type, job_status, job_attempt_count,
      import_job_id, object_status, failure_code, copied_object_count,
      compensated_object_count, applied_row_count, verified_row_count, evidence_version,
      pre_restore_backup_sha256, post_restore_sha256, occurred_at, previous_event_sha256,
      event_sha256
    FROM restore_recovery_events
    WHERE recovery_job_id = ?
    ORDER BY sequence_number
  `).all(recoveryJobId).map(eventFromRow).map(publicEvent);
}

export function verifyIsolatedRecoveryEventChain(database, input) {
  assertGuard(input?.guard);
  const recoveryJobId = requiredText(input?.recoveryJobId, "recoveryJobId");
  const rows = database.prepare(`
    SELECT recovery_job_id, sequence_number, event_type, job_status, job_attempt_count,
      import_job_id, object_status, failure_code, copied_object_count,
      compensated_object_count, applied_row_count, verified_row_count, evidence_version,
      pre_restore_backup_sha256, post_restore_sha256, occurred_at, previous_event_sha256,
      event_sha256
    FROM restore_recovery_events
    WHERE recovery_job_id = ?
    ORDER BY sequence_number
  `).all(recoveryJobId);
  if (rows.length === 0) return { valid: false, reason: "empty_chain", eventCount: 0, terminal: false };
  let previous = null;
  for (const row of rows) {
    const event = eventFromRow(row);
    try {
      assertEventSequence(event, previous);
    } catch {
      return {
        valid: false,
        reason: "invalid_sequence",
        eventCount: rows.length,
        invalidSequenceNumber: event.sequenceNumber,
        terminal: false,
      };
    }
    if (hashRecoveryEvent(event) !== event.eventSha256) {
      return {
        valid: false,
        reason: "hash_mismatch",
        eventCount: rows.length,
        invalidSequenceNumber: event.sequenceNumber,
        terminal: false,
      };
    }
    previous = event;
  }
  return {
    valid: true,
    reason: "verified",
    eventCount: rows.length,
    headSha256: previous.eventSha256,
    terminal: TERMINAL_STATUSES.has(previous.jobStatus),
  };
}

function assertEventSequence(event, previous) {
  assertEventShape(event);
  if (!previous) {
    if (event.sequenceNumber !== 0 || event.eventType !== "prepared" || event.jobStatus !== "prepared") {
      throw new Error("El diario debe comenzar con prepared en la secuencia cero.");
    }
    if (event.previousEventSha256 !== null || event.jobAttemptCount !== 0 || countValues(event).some((value) => value !== 0)) {
      throw new Error("El primer evento requiere hash previo nulo, intento cero y progreso cero.");
    }
    return;
  }
  if (TERMINAL_STATUSES.has(previous.jobStatus)) throw new Error("Un trabajo terminal no admite mas eventos.");
  if (event.sequenceNumber !== previous.sequenceNumber + 1) throw new Error("La secuencia del diario debe avanzar exactamente uno.");
  if (event.previousEventSha256 !== previous.eventSha256) throw new Error("El evento no enlaza la cabeza vigente del diario.");
  if (event.occurredAt < previous.occurredAt) throw new Error("El tiempo del diario no puede retroceder.");
  if (event.evidenceVersion < previous.evidenceVersion) throw new Error("La versión de evidencia no puede retroceder.");
  if (previous.evidenceVersion === 2) {
    if (previous.preRestoreBackupSha256 !== null
      && event.preRestoreBackupSha256 !== previous.preRestoreBackupSha256) {
      throw new Error("La huella previa encadenada no puede cambiar ni desaparecer.");
    }
    if (previous.postRestoreSha256 !== null
      && event.postRestoreSha256 !== previous.postRestoreSha256) {
      throw new Error("La huella posterior encadenada no puede cambiar ni desaparecer.");
    }
  }
  if (event.jobStatus !== previous.jobStatus && !recoveryJobCanTransition(previous.jobStatus, event.jobStatus)) {
    throw new Error("La fase del evento no es una transicion valida.");
  }
  const previousCounts = countValues(previous);
  if (countValues(event).some((value, index) => value < previousCounts[index])) {
    throw new Error("Los conteos del diario no pueden retroceder.");
  }
  assertAttemptAdvance(event, previous);
  if (event.eventType === "object_verified" && event.copiedObjectCount !== previous.copiedObjectCount + 1) {
    throw new Error("object_verified debe avanzar exactamente un original verificado.");
  }
  if (event.eventType === "object_compensated" && event.compensatedObjectCount !== previous.compensatedObjectCount + 1) {
    throw new Error("object_compensated debe avanzar exactamente una compensacion.");
  }
  if (!new Set(["checkpoint_advanced", "object_verified", "object_compensated", "succeeded"]).has(event.eventType)
    && countValues(event).some((value, index) => value !== previousCounts[index])) {
    throw new Error("Este tipo de evento no puede alterar contadores.");
  }
  if (event.eventType === "checkpoint_advanced" && event.jobStatus === "compensating") {
    if (countValues(event).some((value, index) => value !== previousCounts[index])) {
      throw new Error("La evidencia de snapshot restaurado no puede alterar contadores.");
    }
    if (event.preRestoreBackupSha256 === null
      || event.postRestoreSha256 !== event.preRestoreBackupSha256) {
      throw new Error("La evidencia de snapshot restaurado exige huellas previa y posterior identicas.");
    }
  }
}

function assertEventShape(event) {
  if (!RECOVERY_EVENT_TYPES.includes(event.eventType)) throw new Error("Tipo de evento de recuperacion desconocido.");
  if (!JOB_STATUSES.has(event.jobStatus) || !EVENT_JOB_STATUSES[event.eventType].includes(event.jobStatus)) {
    throw new Error("El evento no corresponde a la fase declarada.");
  }
  if (event.verifiedRowCount > event.appliedRowCount) throw new Error("Las filas verificadas no pueden superar las aplicadas.");
  if (event.evidenceVersion === 1) {
    if (event.preRestoreBackupSha256 !== null || event.postRestoreSha256 !== null) {
      throw new Error("La evidencia v1 no admite huellas de snapshot.");
    }
  } else if (event.evidenceVersion === 2) {
    if (event.preRestoreBackupSha256 !== null && !SHA256_PATTERN.test(event.preRestoreBackupSha256)) {
      throw new Error("La huella previa del evento no es SHA-256.");
    }
    if (event.postRestoreSha256 !== null && !SHA256_PATTERN.test(event.postRestoreSha256)) {
      throw new Error("La huella posterior del evento no es SHA-256.");
    }
    if (event.postRestoreSha256 !== null && event.preRestoreBackupSha256 === null) {
      throw new Error("La huella posterior exige evidencia previa.");
    }
  } else {
    throw new Error("Versión de evidencia de recuperación desconocida.");
  }
  const expectedObjectStatus = OBJECT_EVENT_STATUS[event.eventType];
  if (expectedObjectStatus) {
    if (!event.importJobId || event.objectStatus !== expectedObjectStatus) {
      throw new Error("El evento de original requiere importacion y estado coherentes.");
    }
  } else if (event.importJobId !== null || event.objectStatus !== null) {
    throw new Error("Solo los eventos de original pueden identificar una importacion.");
  }
  if (FAILURE_EVENTS.has(event.eventType)) {
    if (!FAILURE_CODES.has(event.failureCode)) throw new Error("El evento de falla requiere un codigo generico.");
  } else if (event.failureCode !== null) {
    throw new Error("El codigo de falla no corresponde a este evento.");
  }
}

function assertAttemptAdvance(event, previous) {
  if (event.eventType === "lease_claimed") {
    if (previous.jobAttemptCount !== 0 || event.jobAttemptCount !== 1) throw new Error("lease_claimed debe abrir el primer intento.");
    return;
  }
  if (event.eventType === "lease_recovered") {
    if (previous.jobAttemptCount < 1 || event.jobAttemptCount !== previous.jobAttemptCount + 1) {
      throw new Error("lease_recovered debe cercar una nueva epoca.");
    }
    return;
  }
  if (event.jobAttemptCount !== previous.jobAttemptCount) {
    throw new Error("Solo claim/recovery pueden cambiar el intento del trabajo.");
  }
}

function normalizeEvent(input, job) {
  const eventType = requiredText(input.eventType, "eventType");
  const importJobId = nullableText(input.importJobId, "importJobId");
  const objectStatus = nullableText(input.objectStatus, "objectStatus");
  const failureCode = nullableText(input.failureCode, "failureCode");
  const previousEventSha256 = nullableText(input.previousEventSha256, "previousEventSha256");
  if (previousEventSha256 !== null && !SHA256_PATTERN.test(previousEventSha256)) {
    throw new Error("previousEventSha256 debe ser una huella SHA-256 minuscula.");
  }
  return {
    recoveryJobId: requiredText(input.recoveryJobId, "recoveryJobId"),
    sequenceNumber: nonNegativeInteger(input.sequenceNumber, "sequenceNumber"),
    eventType,
    jobStatus: requiredText(input.jobStatus, "jobStatus"),
    jobAttemptCount: nonNegativeInteger(input.jobAttemptCount, "jobAttemptCount"),
    importJobId,
    objectStatus,
    failureCode,
    copiedObjectCount: nonNegativeInteger(input.copiedObjectCount, "copiedObjectCount"),
    compensatedObjectCount: nonNegativeInteger(input.compensatedObjectCount, "compensatedObjectCount"),
    appliedRowCount: nonNegativeInteger(input.appliedRowCount, "appliedRowCount"),
    verifiedRowCount: nonNegativeInteger(input.verifiedRowCount, "verifiedRowCount"),
    evidenceVersion: 2,
    preRestoreBackupSha256: nullableSha256(job.pre_restore_backup_sha256, "preRestoreBackupSha256"),
    postRestoreSha256: nullableSha256(job.post_restore_sha256, "postRestoreSha256"),
    occurredAt: validIso(input.occurredAt),
    previousEventSha256,
  };
}

function hashRecoveryEvent(event) {
  const payload = {
    version: event.evidenceVersion,
    recoveryJobId: event.recoveryJobId,
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    jobStatus: event.jobStatus,
    jobAttemptCount: event.jobAttemptCount,
    importJobId: event.importJobId,
    objectStatus: event.objectStatus,
    failureCode: event.failureCode,
    copiedObjectCount: event.copiedObjectCount,
    compensatedObjectCount: event.compensatedObjectCount,
    appliedRowCount: event.appliedRowCount,
    verifiedRowCount: event.verifiedRowCount,
    occurredAt: event.occurredAt,
    previousEventSha256: event.previousEventSha256,
  };
  if (event.evidenceVersion === 2) {
    payload.preRestoreBackupSha256 = event.preRestoreBackupSha256;
    payload.postRestoreSha256 = event.postRestoreSha256;
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function readLastEvent(database, recoveryJobId) {
  const row = database.prepare(`
    SELECT recovery_job_id, sequence_number, event_type, job_status, job_attempt_count,
      import_job_id, object_status, failure_code, copied_object_count,
      compensated_object_count, applied_row_count, verified_row_count, evidence_version,
      pre_restore_backup_sha256, post_restore_sha256, occurred_at, previous_event_sha256,
      event_sha256
    FROM restore_recovery_events WHERE recovery_job_id = ?
    ORDER BY sequence_number DESC LIMIT 1
  `).get(recoveryJobId);
  return row ? eventFromRow(row) : null;
}

function readEventAtSequence(database, recoveryJobId, sequenceNumber) {
  const row = database.prepare(`
    SELECT recovery_job_id, sequence_number, event_type, job_status, job_attempt_count,
      import_job_id, object_status, failure_code, copied_object_count,
      compensated_object_count, applied_row_count, verified_row_count, evidence_version,
      pre_restore_backup_sha256, post_restore_sha256, occurred_at, previous_event_sha256,
      event_sha256
    FROM restore_recovery_events WHERE recovery_job_id = ? AND sequence_number = ?
  `).get(recoveryJobId, sequenceNumber);
  return row ? eventFromRow(row) : null;
}

function eventFromRow(row) {
  return {
    recoveryJobId: row.recovery_job_id,
    sequenceNumber: Number(row.sequence_number),
    eventType: row.event_type,
    jobStatus: row.job_status,
    jobAttemptCount: Number(row.job_attempt_count),
    importJobId: row.import_job_id ?? null,
    objectStatus: row.object_status ?? null,
    failureCode: row.failure_code ?? null,
    copiedObjectCount: Number(row.copied_object_count),
    compensatedObjectCount: Number(row.compensated_object_count),
    appliedRowCount: Number(row.applied_row_count),
    verifiedRowCount: Number(row.verified_row_count),
    evidenceVersion: Number(row.evidence_version),
    preRestoreBackupSha256: row.pre_restore_backup_sha256 ?? null,
    postRestoreSha256: row.post_restore_sha256 ?? null,
    occurredAt: row.occurred_at,
    previousEventSha256: row.previous_event_sha256 ?? null,
    eventSha256: row.event_sha256,
  };
}

function publicEvent(event) {
  return {
    recoveryJobId: event.recoveryJobId,
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    jobStatus: event.jobStatus,
    jobAttemptCount: event.jobAttemptCount,
    importJobId: event.importJobId,
    objectStatus: event.objectStatus,
    failureCode: event.failureCode,
    copiedObjectCount: event.copiedObjectCount,
    compensatedObjectCount: event.compensatedObjectCount,
    appliedRowCount: event.appliedRowCount,
    verifiedRowCount: event.verifiedRowCount,
    evidenceVersion: event.evidenceVersion,
    preRestoreBackupSha256: event.preRestoreBackupSha256,
    postRestoreSha256: event.postRestoreSha256,
    occurredAt: event.occurredAt,
    previousEventSha256: event.previousEventSha256,
    eventSha256: event.eventSha256,
  };
}

function journalResult(changed, reason, event) {
  return { changed, reason, event: publicEvent(event), productWritesEnabled: false };
}

function countValues(event) {
  return [event.copiedObjectCount, event.compensatedObjectCount, event.appliedRowCount, event.verifiedRowCount];
}

function assertKnownKeys(input) {
  for (const key of Object.keys(input ?? {})) {
    if (!INPUT_KEYS.has(key)) throw new Error(`El diario no admite el campo ${key}.`);
  }
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El diario de recuperacion solo admite SQLite aislado.");
  }
}

function requiredText(value, name) {
  if (typeof value !== "string") throw new Error(`${name} debe ser texto.`);
  const text = value.trim();
  if (!text || text.length > 255) throw new Error(`${name} es obligatorio y acotado.`);
  return text;
}

function nullableSha256(value, name) {
  if (value == null) return null;
  const text = String(value);
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser SHA-256 hexadecimal.`);
  return text;
}

function nullableText(value, name) {
  if (value === null || value === undefined) return null;
  return requiredText(value, name);
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} debe ser un entero no negativo.`);
  return number;
}

function validIso(value) {
  const text = requiredText(value, "occurredAt");
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw new Error("occurredAt debe ser ISO-8601 UTC canonico.");
  }
  return text;
}
