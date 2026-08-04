import { canonicalJson, sha256Hex } from "./backup-format.mjs";
import {
  buildRestoreConfirmationBinding,
  isRestorePlanConfirmable,
  restorePlanSha256,
  restoreSnapshotSha256,
  validateRestoreConfirmation,
} from "./restore-confirmation-rules.mjs";
import { buildPortableRestorePlan, SECTION_KEY_FIELDS, validatePortableBackup } from "./restore-rules.mjs";
import {
  applyInsertOnlyRestoreRows,
  quoteRestoreIdentifier,
  RESTORE_SECTION_TABLES,
  restoreSqliteValue,
} from "./isolated-restore-writer.mjs";

export async function runIsolatedRecoveryRehearsal(database, input) {
  assertRehearsalGuard(input.guard);
  const backup = await validatePortableBackup(input.backup);
  const binding = buildRestoreConfirmationBinding(input.confirmation.binding);
  const tokenSha256 = await sha256Hex(input.confirmation.token);
  assertActiveConfirmation(database, tokenSha256, binding, input.confirmation.now);
  await assertCurrentSnapshot(database, input.currentData);
  const recalculatedPlan = buildPortableRestorePlan(backup, input.currentData);
  if (canonicalJson(recalculatedPlan) !== canonicalJson(input.plan)) throw new Error("El plan cambio al recalcular el destino aislado.");
  if (!isRestorePlanConfirmable(recalculatedPlan)) throw new Error("El ensayo requiere un plan ready sin bloqueos.");
  const backupSha256 = await sha256Hex(input.backupPayload);
  const snapshotSha256 = await restoreSnapshotSha256(input.currentData);
  const planSha256 = await restorePlanSha256(recalculatedPlan);
  assertEqualHash("respaldo", backupSha256, binding.backupSha256);
  assertEqualHash("snapshot", snapshotSha256, binding.snapshotSha256);
  assertEqualHash("plan", planSha256, binding.planSha256);

  const preRestoreBackup = await captureTargetBackup(database, backup.data);
  const preparedOriginals = await prepareOriginals(backup, input.originalFiles, input.objectStore);
  const restoredBackup = withRestoredObjectKeys(backup, preparedOriginals);
  const copiedKeys = [];

  try {
    for (const original of preparedOriginals) {
      const existing = await input.objectStore.get(original.objectKey);
      if (existing) {
        await assertOriginalBytes(original, existing);
        continue;
      }
      await input.objectStore.put(original.objectKey, original.bytes, original.metadata);
      copiedKeys.push(original.objectKey);
      await assertOriginalBytes(original, await input.objectStore.get(original.objectKey));
    }

    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      assertActiveConfirmation(database, tokenSha256, binding, input.confirmation.now);
      const writeResult = applyInsertOnlyRestoreRows(database, {
        backup: restoredBackup,
        currentData: input.currentData,
        plan: recalculatedPlan,
        guard: input.guard,
      });
      const verification = await verifyRestoredBackup(database, backup);
      const foreignKeyIssues = database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyIssues.length > 0) throw new Error(`La verificacion encontro ${foreignKeyIssues.length} referencia(s) foranea(s) invalidas.`);
      const consumed = database.prepare(`
        UPDATE restore_confirmation_tokens
        SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE token_sha256 = ? AND status = 'active' AND expires_at > ?
      `).run(input.confirmation.now, input.confirmation.now, tokenSha256, input.confirmation.now);
      if (Number(consumed.changes) !== 1) throw new Error("La confirmacion no pudo consumirse dentro de la transaccion aislada.");
      database.exec("COMMIT");
      return {
        format: "fundosmart.recovery-rehearsal.v1",
        productWritesEnabled: false,
        tokenConsumed: true,
        insertedRowCount: writeResult.insertedRowCount,
        verifiedRowCount: verification.verifiedRowCount,
        verifiedSectionCount: verification.sections.length,
        postRestoreSha256: verification.postRestoreSha256,
        originalFileCount: preparedOriginals.length,
        originalBytes: preparedOriginals.reduce((total, original) => total + original.bytes.byteLength, 0),
        foreignKeyIssueCount: 0,
        preRestoreBackup,
        sections: verification.sections,
      };
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  } catch (cause) {
    for (const objectKey of copiedKeys.reverse()) await input.objectStore.delete(objectKey);
    throw cause;
  }
}

async function assertCurrentSnapshot(database, currentData) {
  for (const [section, expectedRows] of Object.entries(currentData)) {
    const table = RESTORE_SECTION_TABLES[section];
    const keyField = SECTION_KEY_FIELDS[section];
    if (!table || !keyField) throw new Error(`El snapshot contiene una seccion no soportada: ${section}.`);
    const actualCount = database.prepare(`SELECT count(*) AS count FROM ${quoteRestoreIdentifier(table)}`).get();
    if (Number(actualCount.count) !== expectedRows.length) throw new Error(`El snapshot de ${section} cambio antes del ensayo.`);
    for (const expected of expectedRows) {
      const actual = database.prepare(
        `SELECT * FROM ${quoteRestoreIdentifier(table)} WHERE ${quoteRestoreIdentifier(keyField)} = ?`,
      ).get(restoreSqliteValue(expected[keyField]));
      if (!actual) throw new Error(`El snapshot ya no contiene ${section}:${String(expected[keyField])}.`);
      const projected = Object.fromEntries(
        Object.entries(expected).map(([column, expectedValue]) => [column, restoredValue(actual[column], expectedValue)]),
      );
      if (canonicalJson(projected) !== canonicalJson(expected)) throw new Error(`El snapshot de ${section} cambio antes del ensayo.`);
    }
  }
}

async function captureTargetBackup(database, backupData) {
  const data = {};
  for (const section of Object.keys(backupData)) {
    const table = RESTORE_SECTION_TABLES[section];
    const keyField = SECTION_KEY_FIELDS[section];
    if (!table || !keyField) throw new Error(`No se puede respaldar la seccion aislada ${section}.`);
    data[section] = database.prepare(
      `SELECT * FROM ${quoteRestoreIdentifier(table)} ORDER BY ${quoteRestoreIdentifier(keyField)}`,
    ).all();
  }
  const payload = canonicalJson({
    format: "fundosmart.recovery-target-snapshot.v1",
    capturedSections: Object.keys(data),
    data,
  });
  return {
    format: "fundosmart.recovery-target-snapshot.v1",
    payload,
    sha256: await sha256Hex(payload),
    rowCounts: Object.fromEntries(Object.entries(data).map(([section, rows]) => [section, rows.length])),
  };
}

async function prepareOriginals(backup, suppliedFiles, objectStore) {
  const jobs = new Map((backup.data.importJobs ?? []).map((row) => [String(row.id), row]));
  const manifestFiles = Array.isArray(backup.manifest.originalFiles) ? backup.manifest.originalFiles : [];
  if (jobs.size !== manifestFiles.length) throw new Error("Cada importacion del respaldo debe declarar exactamente un original.");
  if (jobs.size > 0 && !objectStore) throw new Error("El ensayo requiere un object store aislado para los originales.");
  const originals = [];
  for (const file of manifestFiles) {
    const importJobId = String(file.importJobId ?? "");
    const job = jobs.get(importJobId);
    if (!job) throw new Error("El manifiesto referencia un original sin importacion asociada.");
    const bytes = asBytes(suppliedFiles instanceof Map ? suppliedFiles.get(importJobId) : suppliedFiles?.[importJobId]);
    if (!bytes) throw new Error(`Faltan los bytes originales de la importacion ${importJobId}.`);
    const calculatedSha256 = await sha256Hex(bytes);
    const expectedSha256 = String(file.sha256 ?? "");
    if (calculatedSha256 !== expectedSha256 || calculatedSha256 !== String(job.sha256 ?? "")) {
      throw new Error(`El SHA-256 del original ${importJobId} no coincide.`);
    }
    if (bytes.byteLength !== Number(file.fileSizeBytes) || bytes.byteLength !== Number(job.file_size_bytes)) {
      throw new Error(`El tamano del original ${importJobId} no coincide.`);
    }
    const objectKey = [
      "isolated-restores",
      safeKeyPart(backup.manifest.scope.fieldId),
      safeKeyPart(importJobId),
      calculatedSha256,
    ].join("/");
    originals.push({
      importJobId,
      objectKey,
      bytes,
      sha256: calculatedSha256,
      metadata: {
        fieldId: backup.manifest.scope.fieldId,
        importJobId,
        sha256: calculatedSha256,
      },
    });
  }
  return originals;
}

function withRestoredObjectKeys(backup, originals) {
  const objectKeys = new Map(originals.map((original) => [original.importJobId, original.objectKey]));
  return {
    ...backup,
    data: {
      ...backup.data,
      importJobs: (backup.data.importJobs ?? []).map((row) => ({
        ...row,
        object_key: objectKeys.get(String(row.id)),
      })),
    },
  };
}

async function verifyRestoredBackup(database, backup) {
  const sections = [];
  const restoredData = {};
  let verifiedRowCount = 0;
  for (const [section, expectedRows] of Object.entries(backup.data)) {
    const table = RESTORE_SECTION_TABLES[section];
    const keyField = SECTION_KEY_FIELDS[section];
    const restoredRows = [];
    for (const expected of expectedRows) {
      const actual = database.prepare(
        `SELECT * FROM ${quoteRestoreIdentifier(table)} WHERE ${quoteRestoreIdentifier(keyField)} = ?`,
      ).get(restoreSqliteValue(expected[keyField]));
      if (!actual) throw new Error(`La verificacion no encontro ${section}:${String(expected[keyField])}.`);
      const projected = {};
      for (const [column, expectedValue] of Object.entries(expected)) {
        projected[column] = restoredValue(actual[column], expectedValue);
      }
      if (canonicalJson(projected) !== canonicalJson(expected)) {
        throw new Error(`La fila restaurada ${section}:${String(expected[keyField])} no coincide con el respaldo.`);
      }
      restoredRows.push(projected);
    }
    const sectionSha256 = await sha256Hex(canonicalJson(restoredRows));
    if (sectionSha256 !== backup.manifest.sectionSha256[section]) {
      throw new Error(`La huella post-restore de ${section} no coincide.`);
    }
    restoredData[section] = restoredRows;
    verifiedRowCount += restoredRows.length;
    sections.push({ section, rowCount: restoredRows.length, sha256: sectionSha256 });
  }
  return {
    sections,
    verifiedRowCount,
    postRestoreSha256: await sha256Hex(canonicalJson(restoredData)),
  };
}

function assertActiveConfirmation(database, tokenSha256, binding, now) {
  const row = database.prepare(`
    SELECT actor_email, organization_id, field_id, backup_sha256, snapshot_sha256, plan_sha256, status, expires_at
    FROM restore_confirmation_tokens WHERE token_sha256 = ?
  `).get(tokenSha256);
  const record = row ? {
    actorEmail: row.actor_email,
    organizationId: row.organization_id,
    fieldId: row.field_id,
    backupSha256: row.backup_sha256,
    snapshotSha256: row.snapshot_sha256,
    planSha256: row.plan_sha256,
    status: row.status,
    expiresAt: row.expires_at,
  } : null;
  const validation = validateRestoreConfirmation(record, binding, now);
  if (!validation.valid) throw new Error(`La confirmacion aislada no es valida: ${validation.code}.`);
}

async function assertOriginalBytes(original, stored) {
  const bytes = asBytes(stored?.bytes ?? stored);
  if (!bytes || bytes.byteLength !== original.bytes.byteLength || await sha256Hex(bytes) !== original.sha256) {
    throw new Error(`El original aislado ${original.importJobId} no supero la verificacion posterior.`);
  }
}

function restoredValue(actual, expected) {
  if (expected && typeof expected === "object") {
    if (typeof actual !== "string") return actual;
    try {
      return JSON.parse(actual);
    } catch {
      return actual;
    }
  }
  if (typeof expected === "boolean") return Boolean(actual);
  return actual;
}

function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function assertRehearsalGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El ensayo de recuperacion solo admite SQLite y objetos aislados.");
  }
}

function assertEqualHash(name, actual, expected) {
  if (actual !== expected) throw new Error(`La huella de ${name} cambio desde la confirmacion.`);
}

function safeKeyPart(value) {
  const safe = String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("No se pudo construir una clave aislada segura.");
  return safe;
}
