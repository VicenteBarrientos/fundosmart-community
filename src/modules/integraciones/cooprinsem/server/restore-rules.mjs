import { canonicalJson, FUNDOSMART_BACKUP_FORMAT, sha256Hex } from "./backup-format.mjs";
import { portableMilkSettlementIntegrityIssues } from "../../../leche/server/milk-settlement-integrity.mjs";

export const SECTION_KEY_FIELDS = Object.freeze({
  fields: "id",
  paddocks: "id",
  paddockNdvi: "id",
  activities: "id",
  subdivisionDrafts: "field_id",
  paddockCellOperations: "id",
  paddockCells: "id",
  paddockRotationSettingOperations: "id",
  paddockRotationSettings: "field_id",
  fieldLandmarkOperations: "id",
  fieldLandmarks: "id",
  livestockLots: "id",
  livestockAnimals: "id",
  livestockWeighings: "id",
  livestockFeedingPlans: "id",
  livestockPartners: "id",
  livestockExpenses: "id",
  milkSettlements: "id",
  importJobs: "id",
  importRows: "id",
  importErrors: "id",
  sourceRecords: "id",
  livestockLactations: "id",
  livestockMilkControls: "id",
  livestockReproductiveEvents: "id",
  livestockBirths: "id",
  livestockBirthOffspring: "id",
  livestockHealthEvents: "id",
  fieldExternalIdentifiers: "id",
  livestockLotExternalIdentifiers: "id",
  livestockAnimalIdentifiers: "id",
  livestockLotMemberships: "id",
  auditLog: "id",
});

const MAX_SECTION_COUNT = 40;
const MAX_TOTAL_ROWS = 200_000;

const REFERENCE_RULES = Object.freeze([
  ["paddocks", "field_id", "fields", false],
  ["paddockNdvi", "field_id", "fields", false],
  ["paddockNdvi", "paddock_id", "paddocks", false],
  ["activities", "paddock_id", "paddocks", false],
  ["subdivisionDrafts", "field_id", "fields", false],
  ["paddockCellOperations", "field_id", "fields", false],
  ["paddockCellOperations", "paddock_id", "paddocks", false],
  ["paddockCells", "field_id", "fields", false],
  ["paddockCells", "paddock_id", "paddocks", false],
  ["paddockCells", "created_by_operation_id", "paddockCellOperations", false],
  ["paddockCells", "closed_by_operation_id", "paddockCellOperations", true],
  ["paddockRotationSettingOperations", "field_id", "fields", false],
  ["paddockRotationSettings", "field_id", "fields", false],
  ["fieldLandmarkOperations", "field_id", "fields", false],
  ["fieldLandmarkOperations", "landmark_id", "fieldLandmarks", false],
  ["fieldLandmarks", "field_id", "fields", false],
  ["fieldLandmarks", "last_operation_id", "fieldLandmarkOperations", false],
  ["livestockLots", "field_id", "fields", false],
  ["livestockLots", "paddock_id", "paddocks", true],
  ["livestockAnimals", "lot_id", "livestockLots", false],
  ["livestockWeighings", "animal_id", "livestockAnimals", false],
  ["livestockWeighings", "lot_id", "livestockLots", true],
  ["livestockFeedingPlans", "lot_id", "livestockLots", false],
  ["livestockExpenses", "field_id", "fields", true],
  ["livestockExpenses", "paid_by_id", "livestockPartners", true],
  ["livestockExpenses", "lot_id", "livestockLots", true],
  ["milkSettlements", "field_id", "fields", false],
  ["importJobs", "field_id", "fields", false],
  ["importRows", "import_job_id", "importJobs", false],
  ["importErrors", "import_job_id", "importJobs", false],
  ["importErrors", "import_row_id", "importRows", false],
  ["sourceRecords", "import_job_id", "importJobs", false],
  ["sourceRecords", "import_row_id", "importRows", false],
  ["livestockLactations", "field_id", "fields", false],
  ["livestockLactations", "animal_id", "livestockAnimals", false],
  ["livestockLactations", "source_record_id", "sourceRecords", true],
  ["livestockMilkControls", "field_id", "fields", false],
  ["livestockMilkControls", "animal_id", "livestockAnimals", false],
  ["livestockMilkControls", "lactation_id", "livestockLactations", true],
  ["livestockMilkControls", "source_record_id", "sourceRecords", true],
  ["livestockReproductiveEvents", "field_id", "fields", false],
  ["livestockReproductiveEvents", "animal_id", "livestockAnimals", false],
  ["livestockReproductiveEvents", "source_record_id", "sourceRecords", true],
  ["livestockBirths", "field_id", "fields", false],
  ["livestockBirths", "dam_animal_id", "livestockAnimals", false],
  ["livestockBirths", "reproductive_event_id", "livestockReproductiveEvents", true],
  ["livestockBirths", "source_record_id", "sourceRecords", true],
  ["livestockBirthOffspring", "birth_id", "livestockBirths", false],
  ["livestockBirthOffspring", "animal_id", "livestockAnimals", true],
  ["livestockHealthEvents", "field_id", "fields", false],
  ["livestockHealthEvents", "animal_id", "livestockAnimals", false],
  ["livestockHealthEvents", "source_record_id", "sourceRecords", true],
  ["fieldExternalIdentifiers", "field_id", "fields", false],
  ["livestockLotExternalIdentifiers", "field_id", "fields", false],
  ["livestockLotExternalIdentifiers", "lot_id", "livestockLots", false],
  ["livestockAnimalIdentifiers", "field_id", "fields", false],
  ["livestockAnimalIdentifiers", "animal_id", "livestockAnimals", false],
  ["livestockLotMemberships", "animal_id", "livestockAnimals", false],
  ["livestockLotMemberships", "lot_id", "livestockLots", false],
  ["auditLog", "field_id", "fields", true],
  ["auditLog", "source_record_id", "sourceRecords", true],
]);

const SOURCE_TARGET_SECTIONS = Object.freeze({
  field_external_identifier: "fieldExternalIdentifiers",
  livestock_animal: "livestockAnimals",
  livestock_animal_identifier: "livestockAnimalIdentifiers",
  livestock_milk_control: "livestockMilkControls",
  livestock_lot_membership: "livestockLotMemberships",
});

const SCOPE_RULES = Object.freeze([
  ["fields", "id", "fieldId"],
  ["fields", "organization_id", "organizationId"],
  ["paddocks", "field_id", "fieldId"],
  ["paddockNdvi", "field_id", "fieldId"],
  ["paddockNdvi", "organization_id", "organizationId"],
  ["paddockCellOperations", "field_id", "fieldId"],
  ["paddockCellOperations", "organization_id", "organizationId"],
  ["paddockCells", "field_id", "fieldId"],
  ["paddockRotationSettingOperations", "field_id", "fieldId"],
  ["paddockRotationSettingOperations", "organization_id", "organizationId"],
  ["paddockRotationSettings", "field_id", "fieldId"],
  ["fieldLandmarkOperations", "field_id", "fieldId"],
  ["fieldLandmarkOperations", "organization_id", "organizationId"],
  ["fieldLandmarks", "field_id", "fieldId"],
]);

export class PortableBackupValidationError extends Error {
  constructor(issues) {
    super(issues[0] ?? "El respaldo portable no es válido.");
    this.name = "PortableBackupValidationError";
    this.code = "PORTABLE_BACKUP_INVALID";
    this.issues = issues;
  }
}

export async function validatePortableBackup(value) {
  const issues = [];
  const root = record(value);
  const manifest = record(root?.manifest);
  const data = record(root?.data);
  if (!root || !manifest || !data) {
    throw new PortableBackupValidationError(["El archivo debe contener objetos manifest y data."]);
  }
  if (manifest.format !== FUNDOSMART_BACKUP_FORMAT) {
    issues.push(`Formato no soportado: ${String(manifest.format ?? "sin formato")}.`);
  }
  const scope = record(manifest.scope);
  if (!scope || (scope.type !== "field" && scope.type !== "import")) issues.push("El manifiesto no declara un scope field o import válido.");
  for (const key of ["id", "organizationId", "fieldId"]) {
    if (typeof scope?.[key] !== "string" || scope[key].trim().length === 0) issues.push(`Falta manifest.scope.${key}.`);
  }
  if (scope?.type === "field" && scope.id !== scope.fieldId) issues.push("Un respaldo de fundo debe usar el mismo id y fieldId.");
  if (!isIsoDate(manifest.generatedAt)) issues.push("manifest.generatedAt debe ser una fecha ISO válida.");

  const counts = record(manifest.recordCounts);
  const hashes = record(manifest.sectionSha256);
  if (!counts || !hashes) issues.push("El manifiesto debe incluir recordCounts y sectionSha256.");
  const entries = Object.entries(data);
  if (entries.length === 0 || entries.length > MAX_SECTION_COUNT) issues.push(`El respaldo debe contener entre 1 y ${MAX_SECTION_COUNT} secciones.`);
  let totalRows = 0;
  for (const [section, rowsValue] of entries) {
    if (!Array.isArray(rowsValue)) {
      issues.push(`La sección ${section} no es un arreglo.`);
      continue;
    }
    totalRows += rowsValue.length;
    if (rowsValue.some((row) => !record(row))) issues.push(`La sección ${section} contiene filas que no son objetos.`);
    if (section === "milkSettlements") validatePortableMilkSettlements(rowsValue, issues);
    if (counts?.[section] !== rowsValue.length) issues.push(`El conteo de ${section} no coincide con sus filas.`);
    const expectedHash = hashes?.[section];
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      issues.push(`La sección ${section} no tiene un SHA-256 hexadecimal válido.`);
    } else if (await sha256Hex(canonicalJson(rowsValue)) !== expectedHash) {
      issues.push(`La huella de la sección ${section} no coincide.`);
    }
  }
  if (totalRows > MAX_TOTAL_ROWS) issues.push(`El respaldo supera el límite de ${MAX_TOTAL_ROWS} filas para una simulación síncrona.`);
  for (const section of Object.keys(counts ?? {})) {
    if (!(section in data)) issues.push(`recordCounts declara una sección ausente: ${section}.`);
  }
  for (const section of Object.keys(hashes ?? {})) {
    if (!(section in data)) issues.push(`sectionSha256 declara una sección ausente: ${section}.`);
  }
  validateOriginalInventory(manifest, data, issues);
  if (issues.length > 0) throw new PortableBackupValidationError(issues.slice(0, 100));
  return value;
}

function validatePortableMilkSettlements(rows, issues) {
  for (const [index, row] of rows.entries()) {
    if (!record(row)) continue;
    const key = typeof row.id === "string" && row.id.trim() ? row.id : "sin-id";
    for (const issue of portableMilkSettlementIntegrityIssues(row)) {
      if (issues.length >= 100) return;
      issues.push(`milkSettlements[${index}] (${key}): ${issue}`);
    }
  }
}

export function portableRestoreOriginalInventory(backup) {
  return backup.manifest.originalFiles.map((file) => ({
    importJobId: file.importJobId,
    sha256: file.sha256,
    fileSizeBytes: file.fileSizeBytes,
  }));
}

export function buildPortableRestorePlan(backup, currentData) {
  const data = record(backup?.data);
  const dataIssues = [];
  if (!data) {
    dataIssues.push("El respaldo debe contener un objeto data antes de construir el plan.");
  } else {
    const entries = Object.entries(data);
    if (entries.length === 0) dataIssues.push("El respaldo debe contener al menos una sección antes de construir el plan.");
    for (const [section, rows] of entries) {
      if (!Array.isArray(rows)) dataIssues.push(`La sección ${section} no es un arreglo.`);
    }
  }
  if (dataIssues.length > 0) throw new PortableBackupValidationError(dataIssues);

  const settlementIssues = [];
  validatePortableMilkSettlements(data.milkSettlements ?? [], settlementIssues);
  if (settlementIssues.length > 0) {
    throw new PortableBackupValidationError(settlementIssues);
  }

  const blockers = [];
  const warnings = ["La ejecución de escritura permanece deshabilitada; la confirmación solo puede preparar un ensayo durable."];
  const conflicts = [];
  const sections = [];
  let insertableRowCount = 0;
  let unchangedRowCount = 0;
  let conflictRowCount = 0;
  let totalRowCount = 0;

  for (const [section, rows] of Object.entries(backup.data)) {
    totalRowCount += rows.length;
    const keyField = SECTION_KEY_FIELDS[section];
    if (!keyField) {
      blockers.push(`La sección ${section} no está soportada por el restaurador v1.`);
      sections.push({ section, rowCount: rows.length, insertableRowCount: 0, unchangedRowCount: 0, conflictRowCount: 0, status: "unsupported" });
      continue;
    }
    const currentRows = Array.isArray(currentData[section]) ? currentData[section] : [];
    const currentByKey = new Map();
    for (const row of currentRows) {
      const key = rowKey(row, keyField);
      if (key) currentByKey.set(key, row);
    }
    const seen = new Set();
    let insertable = 0;
    let unchanged = 0;
    let conflicting = 0;
    for (const row of rows) {
      const key = rowKey(row, keyField);
      if (!key) {
        conflicting += 1;
        conflicts.push({ section, key: "sin-clave", reason: `Falta ${keyField}.` });
        continue;
      }
      if (seen.has(key)) {
        conflicting += 1;
        conflicts.push({ section, key, reason: "La clave está duplicada dentro del respaldo." });
        continue;
      }
      seen.add(key);
      const current = currentByKey.get(key);
      if (!current) insertable += 1;
      else if (canonicalJson(current) === canonicalJson(row)) unchanged += 1;
      else {
        conflicting += 1;
        conflicts.push({ section, key, reason: "La misma clave existe con contenido diferente." });
      }
    }
    insertableRowCount += insertable;
    unchangedRowCount += unchanged;
    conflictRowCount += conflicting;
    sections.push({
      section,
      rowCount: rows.length,
      insertableRowCount: insertable,
      unchangedRowCount: unchanged,
      conflictRowCount: conflicting,
      status: conflicting > 0 ? "conflict" : insertable > 0 ? "insertable" : "unchanged",
    });
  }

  const availableKeys = new Map();
  for (const [section, keyField] of Object.entries(SECTION_KEY_FIELDS)) {
    const values = [...(currentData[section] ?? []), ...(backup.data[section] ?? [])]
      .map((row) => rowKey(row, keyField))
      .filter(Boolean);
    availableKeys.set(section, new Set(values));
  }
  let referenceIssueCount = 0;
  for (const [section, field, scopeField] of SCOPE_RULES) {
    const expected = backup.manifest.scope[scopeField];
    for (const row of backup.data[section] ?? []) {
      const value = record(row)?.[field];
      const actual = typeof value === "string" || typeof value === "number" ? String(value) : "";
      if (actual !== expected) {
        referenceIssueCount += 1;
        conflicts.push({
          section,
          key: rowKey(row, SECTION_KEY_FIELDS[section]) || "sin-clave",
          reason: `El alcance ${field}=${actual || "vacío"} no coincide con manifest.scope.${scopeField}.`,
        });
      }
    }
  }
  for (const [section, field, targetSection, optional] of REFERENCE_RULES) {
    const targets = availableKeys.get(targetSection) ?? new Set();
    for (const row of backup.data[section] ?? []) {
      const value = record(row)?.[field];
      if ((value === null || value === undefined || value === "") && optional) continue;
      const reference = typeof value === "string" || typeof value === "number" ? String(value) : "";
      if (!reference || !targets.has(reference)) {
        referenceIssueCount += 1;
        conflicts.push({
          section,
          key: rowKey(row, SECTION_KEY_FIELDS[section]) || "sin-clave",
          reason: `La referencia ${field}=${reference || "vacía"} no existe en ${targetSection}.`,
        });
      }
    }
  }
  for (const row of backup.data.sourceRecords ?? []) {
    const entity = typeof row.target_entity === "string" ? row.target_entity : "";
    const targetSection = SOURCE_TARGET_SECTIONS[entity];
    const targetId = typeof row.target_id === "string" || typeof row.target_id === "number" ? String(row.target_id) : "";
    if (!targetSection || !targetId || !(availableKeys.get(targetSection) ?? new Set()).has(targetId)) {
      referenceIssueCount += 1;
      conflicts.push({
        section: "sourceRecords",
        key: rowKey(row, "id") || "sin-clave",
        reason: targetSection
          ? `El destino ${entity}:${targetId || "vacío"} no existe en ${targetSection}.`
          : `El tipo de destino ${entity || "vacío"} no está soportado por el restaurador v1.`,
      });
    }
  }

  if (conflictRowCount > 0) blockers.push(`${conflictRowCount} filas usan claves existentes con contenido diferente o inválido.`);
  if (referenceIssueCount > 0) blockers.push(`${referenceIssueCount} referencia(s) no tienen destino en el respaldo ni en el fundo actual.`);
  const originalFileCount = Array.isArray(backup.manifest.originalFiles) ? backup.manifest.originalFiles.length : 0;
  if (originalFileCount > 0) warnings.push(`${originalFileCount} archivo(s) original(es) se referencian por metadatos; sus bytes no están embebidos en el JSON.`);
  if (Array.isArray(backup.manifest.excluded) && backup.manifest.excluded.length > 0) {
    warnings.push(`${backup.manifest.excluded.length} exclusión(es) declarada(s) seguirán fuera de una restauración.`);
  }
  const assessment = blockers.length > 0 ? "conflicts" : insertableRowCount > 0 ? "ready" : "no_changes";
  return {
    format: backup.manifest.format,
    scope: backup.manifest.scope,
    generatedAt: backup.manifest.generatedAt,
    assessment,
    writeEnabled: false,
    totals: {
      sectionCount: sections.length,
      rowCount: totalRowCount,
      insertableRowCount,
      unchangedRowCount,
      conflictRowCount,
      referenceIssueCount,
      originalFileCount,
    },
    sections,
    conflicts: conflicts.slice(0, 100),
    blockers,
    warnings,
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function validateOriginalInventory(manifest, data, issues) {
  if (!Array.isArray(manifest.originalFiles)) {
    issues.push("El manifiesto debe declarar originalFiles como un arreglo.");
    return;
  }
  const importJobs = new Map(
    (Array.isArray(data.importJobs) ? data.importJobs : [])
      .map((row) => record(row))
      .filter(Boolean)
      .map((row) => [String(row.id ?? ""), row]),
  );
  const seen = new Set();
  for (const [index, value] of manifest.originalFiles.entries()) {
    const file = record(value);
    if (!file) {
      issues.push(`originalFiles[${index}] no es un objeto.`);
      continue;
    }
    const importJobId = typeof file.importJobId === "string" ? file.importJobId.trim() : "";
    const sha256 = typeof file.sha256 === "string" ? file.sha256 : "";
    const fileSizeBytes = Number(file.fileSizeBytes);
    if (!importJobId) issues.push(`originalFiles[${index}] no declara importJobId.`);
    if (seen.has(importJobId)) issues.push(`originalFiles repite la importación ${importJobId}.`);
    seen.add(importJobId);
    if (!/^[a-f0-9]{64}$/.test(sha256)) issues.push(`El original ${importJobId || index} no tiene un SHA-256 válido.`);
    if (!Number.isInteger(fileSizeBytes) || fileSizeBytes < 0) issues.push(`El original ${importJobId || index} no tiene un tamaño válido.`);
    const job = importJobs.get(importJobId);
    if (!job) {
      issues.push(`El original ${importJobId || index} no tiene una importación asociada.`);
      continue;
    }
    if (String(job.sha256 ?? "") !== sha256) issues.push(`El SHA-256 del original ${importJobId} no coincide con importJobs.`);
    if (Number(job.file_size_bytes) !== fileSizeBytes) issues.push(`El tamaño del original ${importJobId} no coincide con importJobs.`);
  }
  for (const importJobId of importJobs.keys()) {
    if (importJobId && !seen.has(importJobId)) issues.push(`La importación ${importJobId} no declara su original en el manifiesto.`);
  }
}

function rowKey(row, keyField) {
  const value = record(row)?.[keyField];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function isIsoDate(value) {
  return typeof value === "string" && value.includes("T") && !Number.isNaN(Date.parse(value));
}
