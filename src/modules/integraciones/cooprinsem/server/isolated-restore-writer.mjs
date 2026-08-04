import { canonicalJson } from "./backup-format.mjs";
import { SECTION_KEY_FIELDS } from "./restore-rules.mjs";
import { portableMilkSettlementIntegrityIssues } from "../../../leche/server/milk-settlement-integrity.mjs";

export const RESTORE_SECTION_TABLES = Object.freeze({
  fields: "fields",
  paddocks: "potreros",
  paddockNdvi: "paddock_ndvi",
  activities: "activities",
  subdivisionDrafts: "subdivision_drafts",
  paddockCellOperations: "paddock_cell_operations",
  paddockCells: "paddock_cells",
  paddockRotationSettingOperations: "paddock_rotation_setting_operations",
  paddockRotationSettings: "paddock_rotation_settings",
  fieldLandmarkOperations: "field_landmark_operations",
  fieldLandmarks: "field_landmarks",
  livestockLots: "livestock_lots",
  livestockAnimals: "livestock_animals",
  livestockWeighings: "livestock_weighings",
  livestockFeedingPlans: "livestock_feeding_plans",
  livestockPartners: "livestock_partners",
  livestockExpenses: "livestock_expenses",
  milkSettlements: "milk_settlements",
  importJobs: "import_jobs",
  importRows: "import_rows",
  importErrors: "import_errors",
  sourceRecords: "source_records",
  livestockLactations: "livestock_lactations",
  livestockMilkControls: "livestock_milk_controls",
  livestockReproductiveEvents: "livestock_reproductive_events",
  livestockBirths: "livestock_births",
  livestockBirthOffspring: "livestock_birth_offspring",
  livestockHealthEvents: "livestock_health_events",
  fieldExternalIdentifiers: "field_external_identifiers",
  livestockLotExternalIdentifiers: "livestock_lot_external_identifiers",
  livestockAnimalIdentifiers: "livestock_animal_identifiers",
  livestockLotMemberships: "livestock_lot_memberships",
  auditLog: "audit_log",
});

const LEGACY_ORGANIZATION_SCOPED_SECTIONS = new Set(["livestockPartners", "livestockExpenses"]);
const FIELD_SCOPED_SECTIONS = new Set([
  "paddockNdvi",
  "paddockCellOperations",
  "paddockCells",
  "paddockRotationSettingOperations",
  "paddockRotationSettings",
  "fieldLandmarkOperations",
  "fieldLandmarks",
]);
const ORGANIZATION_SCOPED_SECTIONS = new Set([
  "paddockNdvi",
  "paddockCellOperations",
  "paddockRotationSettingOperations",
  "fieldLandmarkOperations",
]);

export function applyInsertOnlyRestoreSimulation(database, input) {
  assertIsolatedRestoreInput(input);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = applyInsertOnlyRestoreRows(database, input);
    database.exec("COMMIT");
    return result;
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

export function applyInsertOnlyRestoreRows(database, input) {
  assertIsolatedRestoreInput(input);
  const sections = [];
  let insertedRowCount = 0;
  for (const section of Object.keys(input.backup.data)) {
    if (!RESTORE_SECTION_TABLES[section] || !SECTION_KEY_FIELDS[section]) {
      throw new Error(`Seccion no soportada por el escritor aislado: ${section}.`);
    }
  }
  for (const [section, table] of Object.entries(RESTORE_SECTION_TABLES)) {
    const rows = input.backup.data[section];
    if (!rows) continue;
    const keyField = SECTION_KEY_FIELDS[section];
    const existingKeys = new Set((input.currentData[section] ?? []).map((row) => rowKey(row, keyField)).filter(Boolean));
    const insertable = rows.filter((row) => !existingKeys.has(rowKey(row, keyField)));
    const tableColumns = new Set(database.prepare(`PRAGMA table_info(\"${table}\")`).all().map((column) => String(column.name)));
    let inserted = 0;
    for (const row of insertable) {
      const legacyScopedRow = withLegacyOrganizationScope(section, row, input.backup.manifest.scope.organizationId);
      const scopedRow = withPortableScope(section, legacyScopedRow, input.backup.manifest.scope);
      const columns = Object.keys(scopedRow).filter((column) => tableColumns.has(column));
      if (!columns.includes(keyField)) throw new Error(`La fila de ${section} no contiene su clave ${keyField}.`);
      if (columns.length !== Object.keys(scopedRow).length) throw new Error(`La fila de ${section} contiene columnas ajenas al esquema aislado.`);
      const columnSql = columns.map(quoteRestoreIdentifier).join(", ");
      const valueSql = columns.map(() => "?").join(", ");
      const values = columns.map((column) => restoreSqliteValue(scopedRow[column]));
      database.prepare(`INSERT INTO ${quoteRestoreIdentifier(table)} (${columnSql}) VALUES (${valueSql})`).run(...values);
      inserted += 1;
    }
    insertedRowCount += inserted;
    sections.push({ section, insertedRowCount: inserted });
  }
  if (insertedRowCount !== input.plan.totals.insertableRowCount) {
    throw new Error(`El escritor aislado inserto ${insertedRowCount} filas, pero el plan autorizaba ${input.plan.totals.insertableRowCount}.`);
  }
  return { insertedRowCount, sections, productWritesEnabled: false };
}

function withPortableScope(section, row, scope) {
  if (FIELD_SCOPED_SECTIONS.has(section) && row.field_id !== scope.fieldId) {
    throw new Error(`La fila de ${section} no pertenece al fundo del respaldo.`);
  }
  if (ORGANIZATION_SCOPED_SECTIONS.has(section) && row.organization_id !== scope.organizationId) {
    throw new Error(`La fila de ${section} no pertenece a la organizacion del respaldo.`);
  }
  return row;
}

function withLegacyOrganizationScope(section, row, organizationId) {
  if (!LEGACY_ORGANIZATION_SCOPED_SECTIONS.has(section)) return row;
  if (typeof row.organization_id === "string" && row.organization_id !== organizationId) {
    throw new Error(`La fila de ${section} no pertenece a la organizacion del respaldo.`);
  }
  return row.organization_id ? row : { ...row, organization_id: organizationId };
}

function assertIsolatedRestoreInput(input) {
  if (input?.guard?.target !== "isolated_sqlite_memory" || input?.guard?.productWritesEnabled !== false) {
    throw new Error("El escritor de restauracion solo admite SQLite aislado en memoria con escrituras productivas deshabilitadas.");
  }
  if (input?.plan?.assessment !== "ready" || input?.plan?.writeEnabled !== false || input.plan.blockers.length > 0) {
    throw new Error("El escritor aislado requiere un plan ready, sin bloqueos y con writeEnabled=false.");
  }
  for (const [index, row] of (input?.backup?.data?.milkSettlements ?? []).entries()) {
    const [issue] = portableMilkSettlementIntegrityIssues(row);
    if (issue) throw new Error(`La liquidación milkSettlements[${index}] no es válida: ${issue}`);
  }
}

function rowKey(row, keyField) {
  const value = row?.[keyField];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function quoteRestoreIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Identificador SQLite no permitido.");
  return `\"${value}\"`;
}

export function restoreSqliteValue(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value && typeof value === "object") return canonicalJson(value);
  return value;
}
