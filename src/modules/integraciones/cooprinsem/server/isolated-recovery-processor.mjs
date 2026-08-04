import { sha256Hex } from "./backup-format.mjs";
import { coordinateIsolatedRecoveryCheckpointEvent } from "./isolated-recovery-checkpoint-event-coordinator.mjs";
import { readIsolatedRecoveryEvents } from "./isolated-recovery-event-journal.mjs";
import { readIsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import {
  coordinateIsolatedRecoveryPhaseFailureEvent,
  isolatedRecoveryPhaseFailureRequiresSnapshot,
  recordIsolatedRecoverySnapshotRestored,
} from "./isolated-recovery-phase-failure-coordinator.mjs";
import {
  coordinateIsolatedRecoveryFailedEvent,
  coordinateIsolatedRecoveryFailureStartEvents,
  coordinateIsolatedRecoveryObjectCopyEvent,
  coordinateIsolatedRecoveryObjectProgressEvent,
} from "./isolated-recovery-object-failure-event-coordinator.mjs";
import { readIsolatedRecoveryObject } from "./isolated-recovery-object-simulator.mjs";
import { reconcileIsolatedRecoveryState } from "./isolated-recovery-reconciler.mjs";
import { coordinateIsolatedRecoveryLeaseEvent } from "./isolated-recovery-state-event-coordinator.mjs";
import { sanitizeRecoveryFailure } from "./recovery-job-rules.mjs";

export const ISOLATED_RECOVERY_PROCESSOR_FORMAT = "fundosmart.isolated-recovery-processor.v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 100;
const isolatedMemoryStores = new WeakSet();
const PHASE_FAILURE_CODES = new Set([
  "schema_drift", "snapshot_changed", "plan_changed", "foreign_key_violation", "unknown_failure",
]);

export async function runIsolatedRecoveryProcessorStep(database, input) {
  assertGuard(input?.guard);
  assertObjectStore(input?.objectStore);
  const jobId = requiredText(input?.jobId, "jobId");
  const leaseToken = requiredText(input?.leaseToken, "leaseToken");
  const now = canonicalIso(input?.now);
  const ttlMs = boundedInteger(input?.ttlMs ?? DEFAULT_LEASE_TTL_MS, 1_000, DEFAULT_LEASE_TTL_MS, "ttlMs");
  const batchSize = boundedInteger(input?.batchSize ?? DEFAULT_BATCH_SIZE, 1, 10_000, "batchSize");
  const checkpoint = readCheckpoint(database, jobId, input.guard);
  if (!checkpoint) return stepResult(database, jobId, "not_found", false, "not_found", null, input.guard);
  if (checkpoint.executionEnabled !== false) throw new Error("El procesador aislado exige execution_enabled = 0.");
  if (checkpoint.status === "succeeded" || checkpoint.status === "failed") {
    return stepResult(database, jobId, "terminal", false, "already_terminal", checkpoint, input.guard);
  }

  const head = readHead(database, jobId, input.guard);
  if (!head) throw new Error("El trabajo aislado no tiene evidencia preparada.");
  if (!leaseIsOwned(checkpoint, leaseToken, now)) {
    if (checkpoint.leaseToken && checkpoint.leaseExpiresAt > now) {
      return stepResult(database, jobId, "lease_busy", false, "lease_active", checkpoint, input.guard);
    }
    const claimed = coordinateIsolatedRecoveryLeaseEvent(database, {
      operation: "claim",
      jobId,
      leaseToken,
      now,
      ttlMs,
      expectedCheckpoint: checkpoint,
      expectedJournalHead: head,
      guard: input.guard,
    });
    return stepResult(database, jobId, "lease_claimed", claimed.changed, claimed.reason, claimed.checkpoint, input.guard);
  }

  if (checkpoint.status === "prepared") {
    await ensurePreRestoreBackup(database, {
      ...input,
      jobId,
      leaseToken,
      now,
      checkpoint,
    });
    const current = readCheckpoint(database, jobId, input.guard);
    const advanced = coordinateCheckpoint(database, {
      jobId,
      leaseToken,
      now,
      checkpoint: current,
      head: readHead(database, jobId, input.guard),
      next: { status: "copying" },
      guard: input.guard,
    });
    return stepResult(database, jobId, "pre_restore_backup_captured", advanced.changed, advanced.reason, advanced.checkpoint, input.guard);
  }

  if (checkpoint.status === "copying") {
    return processOriginalStep(database, {
      ...input,
      jobId,
      leaseToken,
      now,
      checkpoint,
    });
  }

  if (checkpoint.status === "applying") {
    const from = checkpoint.appliedRowCount;
    const to = Math.min(checkpoint.expectedRowCount, from + batchSize);
    try {
      if (to > from) {
        const applied = await requiredOperation(input.operations, "applyRows")({ jobId, from, to, guard: input.guard });
        if (Number(applied?.appliedThrough) !== to) throw new Error("La aplicación aislada no confirmó el límite solicitado.");
      }
    } catch (cause) {
      return beginPhaseFailure(database, {
        jobId, leaseToken, now, checkpoint, cause, phase: "apply", guard: input.guard,
      });
    }
    const advanced = coordinateCheckpoint(database, {
      jobId,
      leaseToken,
      now,
      checkpoint: readCheckpoint(database, jobId, input.guard),
      head: readHead(database, jobId, input.guard),
      next: { status: to === checkpoint.expectedRowCount ? "verifying" : "applying", appliedRowCount: to },
      guard: input.guard,
    });
    return stepResult(database, jobId, "rows_applied", advanced.changed, advanced.reason, advanced.checkpoint, input.guard);
  }

  if (checkpoint.status === "verifying") {
    const from = checkpoint.verifiedRowCount;
    const to = Math.min(checkpoint.expectedRowCount, from + batchSize);
    let verification;
    let postRestoreSha256 = null;
    try {
      verification = await requiredOperation(input.operations, "verifyRows")({ jobId, from, to, guard: input.guard });
      if (Number(verification?.verifiedThrough) !== to) throw new Error("La verificación aislada no confirmó el límite solicitado.");
      if (to === checkpoint.expectedRowCount) {
        postRestoreSha256 = validSha256(verification?.postRestoreSha256, "postRestoreSha256");
      }
    } catch (cause) {
      return beginPhaseFailure(database, {
        jobId, leaseToken, now, checkpoint, cause, phase: "verify", guard: input.guard,
      });
    }
    if (to === checkpoint.expectedRowCount) {
      await persistPostRestoreHash(database, {
        jobId,
        leaseToken,
        now,
        checkpoint,
        sha256: postRestoreSha256,
      });
    }
    const advanced = coordinateCheckpoint(database, {
      jobId,
      leaseToken,
      now,
      checkpoint: readCheckpoint(database, jobId, input.guard),
      head: readHead(database, jobId, input.guard),
      next: { status: to === checkpoint.expectedRowCount ? "succeeded" : "verifying", verifiedRowCount: to },
      guard: input.guard,
    });
    return stepResult(database, jobId, to === checkpoint.expectedRowCount ? "succeeded" : "rows_verified", advanced.changed, advanced.reason, advanced.checkpoint, input.guard);
  }

  if (checkpoint.status === "compensating") {
    return processCompensationStep(database, {
      ...input,
      jobId,
      leaseToken,
      now,
      checkpoint,
    });
  }

  throw new Error(`Estado de recuperación aislada no soportado: ${checkpoint.status}.`);
}

export function createIsolatedMemoryObjectStore(entries = []) {
  const objects = new Map();
  for (const entry of entries) {
    const key = requiredText(entry?.key, "key");
    objects.set(key, storedObject(entry.bytes, entry.metadata));
  }
  const store = {
    kind: "isolated_memory",
    async get(key) {
      const value = objects.get(String(key));
      return value ? storedObject(value.bytes, value.metadata) : null;
    },
    async put(key, bytes, metadata = {}) {
      objects.set(requiredText(key, "key"), storedObject(bytes, metadata));
    },
    async delete(key) {
      objects.delete(String(key));
    },
    keys() {
      return [...objects.keys()].sort();
    },
  };
  isolatedMemoryStores.add(store);
  return store;
}

async function ensurePreRestoreBackup(database, input) {
  const existing = readBackupEvidence(database, input.jobId);
  let evidence = existing;
  if (!existing.objectKey && !existing.sha256) {
    const captured = await requiredOperation(input.operations, "capturePreRestoreBackup")({
      jobId: input.jobId,
      guard: input.guard,
      objectStore: input.objectStore,
    });
    evidence = {
      objectKey: requiredText(captured?.objectKey, "preRestoreBackup.objectKey"),
      sha256: validSha256(captured?.sha256, "preRestoreBackup.sha256"),
    };
    await assertStoredBytes(input.objectStore, evidence.objectKey, evidence.sha256, null);
    const result = database.prepare(`
      UPDATE restore_recovery_jobs
      SET pre_restore_backup_object_key = ?, pre_restore_backup_sha256 = ?
      WHERE id = ? AND execution_enabled = 0 AND status = 'prepared'
        AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
        AND pre_restore_backup_object_key IS NULL AND pre_restore_backup_sha256 IS NULL
    `).run(
      evidence.objectKey,
      evidence.sha256,
      input.jobId,
      input.leaseToken,
      input.now,
      input.checkpoint.attemptCount,
    );
    if (Number(result.changes) !== 1) {
      const current = readBackupEvidence(database, input.jobId);
      if (current.objectKey !== evidence.objectKey || current.sha256 !== evidence.sha256) {
        throw new Error("La evidencia del respaldo previo cambió durante la captura.");
      }
    }
  } else if (!existing.objectKey || !existing.sha256) {
    throw new Error("La evidencia del respaldo previo está incompleta.");
  }
  await assertStoredBytes(input.objectStore, evidence.objectKey, evidence.sha256, null);
}

async function processOriginalStep(database, input) {
  const objects = readObjects(database, input.jobId, input.guard);
  const copied = objects.find((object) => object.status === "copied");
  if (copied) return verifyCopiedObject(database, input, copied, objects);
  const pending = objects.find((object) => object.status === "pending" || object.status === "failed");
  if (pending) return copyPendingObject(database, input, pending);
  const advanced = coordinateCheckpoint(database, {
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    now: input.now,
    checkpoint: readCheckpoint(database, input.jobId, input.guard),
    head: readHead(database, input.jobId, input.guard),
    next: { status: "applying" },
    guard: input.guard,
  });
  return stepResult(database, input.jobId, "originals_verified", advanced.changed, advanced.reason, advanced.checkpoint, input.guard);
}

async function copyPendingObject(database, input, object) {
  const bytes = originalBytes(input.originalFiles, object.importJobId);
  if (!bytes) return beginObjectFailure(database, input, object, "original_missing");
  if (bytes.byteLength !== object.sizeBytes || await sha256Hex(bytes) !== object.sha256) {
    return beginObjectFailure(database, input, object, "original_hash_mismatch");
  }
  const objectKey = destinationKey(input.jobId, object);
  const stored = await input.objectStore.get(objectKey);
  let wasPreexisting = false;
  if (stored) {
    await assertStoredBytes(input.objectStore, objectKey, object.sha256, object.sizeBytes);
    wasPreexisting = stored?.metadata?.recoveryJobId !== input.jobId
      || stored?.metadata?.processorFormat !== ISOLATED_RECOVERY_PROCESSOR_FORMAT;
  } else {
    await input.objectStore.put(objectKey, bytes, {
      processorFormat: ISOLATED_RECOVERY_PROCESSOR_FORMAT,
      recoveryJobId: input.jobId,
      importJobId: object.importJobId,
      sha256: object.sha256,
    });
    await assertStoredBytes(input.objectStore, objectKey, object.sha256, object.sizeBytes);
  }
  const currentJob = readCheckpoint(database, input.jobId, input.guard);
  const currentObject = readObject(database, input.jobId, object.importJobId, input.guard);
  const coordinated = coordinateIsolatedRecoveryObjectCopyEvent(database, {
    jobId: input.jobId,
    importJobId: object.importJobId,
    leaseToken: input.leaseToken,
    now: input.now,
    expectedJob: currentJob,
    expectedObject: currentObject,
    expectedJournalHead: readHead(database, input.jobId, input.guard),
    destinationObjectKey: objectKey,
    wasPreexisting,
    guard: input.guard,
  });
  return stepResult(database, input.jobId, "original_copied", coordinated.changed, coordinated.reason, coordinated.job, input.guard);
}

async function verifyCopiedObject(database, input, object, objects) {
  try {
    await assertStoredBytes(input.objectStore, object.destinationObjectKey, object.sha256, object.sizeBytes);
  } catch {
    return beginObjectFailure(database, input, object, "original_hash_mismatch");
  }
  const transitionToApplying = objects.every((candidate) => candidate.importJobId === object.importJobId || candidate.status === "verified");
  const coordinated = coordinateIsolatedRecoveryObjectProgressEvent(database, {
    operation: "verify",
    jobId: input.jobId,
    importJobId: object.importJobId,
    leaseToken: input.leaseToken,
    now: input.now,
    expectedJob: readCheckpoint(database, input.jobId, input.guard),
    expectedObject: readObject(database, input.jobId, object.importJobId, input.guard),
    expectedJournalHead: readHead(database, input.jobId, input.guard),
    transitionToApplying,
    guard: input.guard,
  });
  return stepResult(database, input.jobId, "original_verified", coordinated.changed, coordinated.reason, coordinated.job, input.guard);
}

function beginObjectFailure(database, input, object, failureCode) {
  const coordinated = coordinateIsolatedRecoveryFailureStartEvents(database, {
    jobId: input.jobId,
    importJobId: object.importJobId,
    leaseToken: input.leaseToken,
    now: input.now,
    failureCode,
    expectedJob: readCheckpoint(database, input.jobId, input.guard),
    expectedObject: readObject(database, input.jobId, object.importJobId, input.guard),
    expectedJournalHead: readHead(database, input.jobId, input.guard),
    guard: input.guard,
  });
  return stepResult(database, input.jobId, "compensation_started", coordinated.changed, coordinated.reason, coordinated.job, input.guard);
}

function beginPhaseFailure(database, input) {
  const failure = sanitizeRecoveryFailure(input.cause, input.phase);
  const failureCode = PHASE_FAILURE_CODES.has(failure.code) ? failure.code : "unknown_failure";
  const coordinated = coordinateIsolatedRecoveryPhaseFailureEvent(database, {
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    now: input.now,
    failureCode,
    expectedJob: readCheckpoint(database, input.jobId, input.guard),
    expectedJournalHead: readHead(database, input.jobId, input.guard),
    guard: input.guard,
  });
  return stepResult(
    database,
    input.jobId,
    "phase_compensation_started",
    coordinated.changed,
    coordinated.reason,
    coordinated.job,
    input.guard,
  );
}

async function processCompensationStep(database, input) {
  const objects = readObjects(database, input.jobId, input.guard).reverse();
  const dirty = objects.find((object) => !object.wasPreexisting
    && object.destinationObjectKey
    && ["copied", "verified", "failed"].includes(object.status));
  if (dirty) {
    await input.objectStore.delete(dirty.destinationObjectKey);
    const coordinated = coordinateIsolatedRecoveryObjectProgressEvent(database, {
      operation: "compensate",
      jobId: input.jobId,
      importJobId: dirty.importJobId,
      leaseToken: input.leaseToken,
      now: input.now,
      expectedJob: readCheckpoint(database, input.jobId, input.guard),
      expectedObject: readObject(database, input.jobId, dirty.importJobId, input.guard),
      expectedJournalHead: readHead(database, input.jobId, input.guard),
      guard: input.guard,
    });
    return stepResult(database, input.jobId, "original_compensated", coordinated.changed, coordinated.reason, coordinated.job, input.guard);
  }
  const failure = readFailureEvidence(database, input.jobId);
  if (isolatedRecoveryPhaseFailureRequiresSnapshot(database, {
    jobId: input.jobId,
    guard: input.guard,
  })
    && failure.postRestoreSha256 !== failure.preRestoreBackupSha256) {
    if (!failure.preRestoreBackupObjectKey || !failure.preRestoreBackupSha256) {
      throw new Error("La compensación de fase no tiene respaldo previo completo.");
    }
    await assertStoredBytes(
      input.objectStore,
      failure.preRestoreBackupObjectKey,
      failure.preRestoreBackupSha256,
      null,
    );
    const restored = await requiredOperation(input.operations, "restorePreRestoreBackup")({
      jobId: input.jobId,
      objectKey: failure.preRestoreBackupObjectKey,
      sha256: failure.preRestoreBackupSha256,
      guard: input.guard,
      objectStore: input.objectStore,
    });
    const restoredSha256 = validSha256(restored?.restoredSha256, "restoredSha256");
    const recorded = recordIsolatedRecoverySnapshotRestored(database, {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      now: input.now,
      failureCode: failure.failureCode,
      expectedJobAttemptCount: input.checkpoint.attemptCount,
      expectedJournalHead: readHead(database, input.jobId, input.guard),
      expectedSha256: failure.preRestoreBackupSha256,
      restoredSha256,
      guard: input.guard,
    });
    return stepResult(
      database,
      input.jobId,
      "snapshot_restored",
      recorded.changed,
      recorded.reason,
      recorded.job,
      input.guard,
    );
  }
  const finalized = coordinateIsolatedRecoveryFailedEvent(database, {
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    now: input.now,
    failureCode: requiredText(failure.failureCode, "failureCode"),
    expectedJob: readCheckpoint(database, input.jobId, input.guard),
    expectedJournalHead: readHead(database, input.jobId, input.guard),
    guard: input.guard,
  });
  return stepResult(database, input.jobId, "failed", finalized.changed, finalized.reason, finalized.job, input.guard);
}

async function persistPostRestoreHash(database, input) {
  const sha256 = validSha256(input.sha256, "postRestoreSha256");
  const result = database.prepare(`
    UPDATE restore_recovery_jobs SET post_restore_sha256 = ?
    WHERE id = ? AND execution_enabled = 0 AND status = 'verifying'
      AND lease_token = ? AND lease_expires_at > ? AND attempt_count = ?
      AND (post_restore_sha256 IS NULL OR post_restore_sha256 = ?)
  `).run(sha256, input.jobId, input.leaseToken, input.now, input.checkpoint.attemptCount, sha256);
  if (Number(result.changes) !== 1) throw new Error("La huella post-restore no pudo persistirse de forma idempotente.");
}

function coordinateCheckpoint(database, input) {
  const current = input.checkpoint;
  return coordinateIsolatedRecoveryCheckpointEvent(database, {
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    now: input.now,
    expectedCheckpoint: current,
    expectedJournalHead: input.head,
    next: {
      status: input.next.status ?? current.status,
      objectCursorImportJobId: input.next.objectCursorImportJobId ?? current.objectCursorImportJobId,
      copiedObjectCount: input.next.copiedObjectCount ?? current.copiedObjectCount,
      appliedRowCount: input.next.appliedRowCount ?? current.appliedRowCount,
      verifiedRowCount: input.next.verifiedRowCount ?? current.verifiedRowCount,
    },
    guard: input.guard,
  });
}

function stepResult(database, jobId, action, changed, reason, checkpoint, guard) {
  const reconciliation = reconcileIsolatedRecoveryState(database, { recoveryJobId: jobId, guard });
  return {
    format: ISOLATED_RECOVERY_PROCESSOR_FORMAT,
    action,
    changed: Boolean(changed),
    reason,
    status: checkpoint?.status ?? reconciliation.actualJob?.status ?? null,
    reconciliation: {
      consistent: reconciliation.consistent,
      reason: reconciliation.reason,
      eventCount: reconciliation.chain.eventCount,
      issueCodes: reconciliation.issues.map((issue) => issue.code),
    },
    productWritesEnabled: false,
    remoteWrites: false,
  };
}

function readCheckpoint(database, jobId, guard) {
  return readIsolatedRecoveryCheckpoint(database, { jobId, guard });
}

function readObject(database, jobId, importJobId, guard) {
  return readIsolatedRecoveryObject(database, { jobId, importJobId, guard });
}

function readObjects(database, jobId, guard) {
  return database.prepare(`
    SELECT import_job_id FROM restore_recovery_objects
    WHERE recovery_job_id = ? ORDER BY sequence_number
  `).all(jobId).map((row) => readObject(database, jobId, String(row.import_job_id), guard));
}

function readHead(database, jobId, guard) {
  return readIsolatedRecoveryEvents(database, { recoveryJobId: jobId, guard }).at(-1) ?? null;
}

function readBackupEvidence(database, jobId) {
  const row = database.prepare(`
    SELECT pre_restore_backup_object_key, pre_restore_backup_sha256
    FROM restore_recovery_jobs WHERE id = ?
  `).get(jobId);
  return {
    objectKey: row?.pre_restore_backup_object_key == null ? null : String(row.pre_restore_backup_object_key),
    sha256: row?.pre_restore_backup_sha256 == null ? null : String(row.pre_restore_backup_sha256),
  };
}

function readFailureEvidence(database, jobId) {
  const row = database.prepare(`
    SELECT failure_code, pre_restore_backup_object_key, pre_restore_backup_sha256, post_restore_sha256
    FROM restore_recovery_jobs WHERE id = ?
  `).get(jobId);
  return {
    failureCode: row?.failure_code ?? null,
    preRestoreBackupObjectKey: row?.pre_restore_backup_object_key ?? null,
    preRestoreBackupSha256: row?.pre_restore_backup_sha256 ?? null,
    postRestoreSha256: row?.post_restore_sha256 ?? null,
  };
}

async function assertStoredBytes(store, key, expectedSha256, expectedSize) {
  const stored = await store.get(requiredText(key, "objectKey"));
  const bytes = asBytes(stored?.bytes ?? stored);
  if (!bytes || (expectedSize !== null && bytes.byteLength !== expectedSize) || await sha256Hex(bytes) !== expectedSha256) {
    throw new Error("El objeto aislado no coincide con la evidencia esperada.");
  }
}

function originalBytes(originalFiles, importJobId) {
  const value = originalFiles instanceof Map ? originalFiles.get(importJobId) : originalFiles?.[importJobId];
  return asBytes(value);
}

function destinationKey(jobId, object) {
  return ["isolated-recovery", safePart(jobId), String(object.sequenceNumber), safePart(object.importJobId), object.sha256].join("/");
}

function safePart(value) {
  const safe = String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("No se pudo construir una clave aislada segura.");
  return safe;
}

function leaseIsOwned(checkpoint, leaseToken, now) {
  return checkpoint.leaseToken === leaseToken && checkpoint.leaseExpiresAt && checkpoint.leaseExpiresAt > now;
}

function requiredOperation(operations, name) {
  const operation = operations?.[name];
  if (typeof operation !== "function") throw new Error(`Falta la operación aislada ${name}.`);
  return operation;
}

function storedObject(bytes, metadata = {}) {
  const normalized = asBytes(bytes);
  if (!normalized) throw new Error("El object store aislado solo admite bytes.");
  return { bytes: Uint8Array.from(normalized), metadata: { ...(metadata ?? {}) } };
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function validSha256(value, name) {
  const text = String(value ?? "");
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser una huella SHA-256 hexadecimal.`);
  return text;
}

function canonicalIso(value) {
  const text = requiredText(value, "now");
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) throw new Error("now debe ser ISO-8601 UTC canónico.");
  return text;
}

function boundedInteger(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} debe estar entre ${minimum} y ${maximum}.`);
  }
  return number;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertObjectStore(store) {
  if (!isolatedMemoryStores.has(store)
    || store?.kind !== "isolated_memory"
    || typeof store.get !== "function"
    || typeof store.put !== "function"
    || typeof store.delete !== "function") {
    throw new Error("El procesador solo admite un object store aislado en memoria.");
  }
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El procesador solo admite SQLite y objetos aislados con escritura productiva deshabilitada.");
  }
}
