import { getDb } from "@/db";
import { fields, importJobs, organizations } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { AccessContext } from "@/src/modules/access/domain/types";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import type { ImportFieldAccess } from "./import-repository";
import {
  canonicalJson,
  FUNDOSMART_BACKUP_FORMAT,
  safeDownloadFilename,
  sha256Hex,
} from "./backup-format.mjs";

type BackupRow = Record<string, unknown>;
type BackupSections = Record<string, BackupRow[]>;

type BackupScope = {
  type: "field" | "import";
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  fieldId: string;
  fieldName: string;
};

export type OriginalFileReference = {
  importJobId: string;
  organizationId: string;
  fieldId: string;
  fieldName: string;
  originalFilename: string;
  contentType: string | null;
  fileSizeBytes: number;
  objectKey: string;
  sha256: string;
  sourceTable: string;
  createdAt: string;
};

type PortableOriginalFile = Omit<OriginalFileReference, "objectKey">;
type CurrentManageImportsAccess = ImportFieldAccess & Pick<AccessContext, "membershipId" | "email">;
type BackupDownloadAccess = CurrentManageImportsAccess;

export type FundoSmartPortableBackup = {
  manifest: {
    format: typeof FUNDOSMART_BACKUP_FORMAT;
    generatedAt: string;
    generatedBy: string;
    encoding: "UTF-8 JSON";
    scope: BackupScope;
    recordCounts: Record<string, number>;
    sectionSha256: Record<string, string>;
    originalFiles: Array<PortableOriginalFile & { downloadPath: string }>;
    excluded: Array<{ section: string; reason: string }>;
  };
  data: BackupSections;
};

type SectionSpec = {
  name: string;
  sql: string;
  jsonColumns?: string[];
};

const PORTABLE_IMPORT_JOB_COLUMNS = [
  "id", "organization_id", "field_id", "source_system", "source_format", "source_table",
  "original_filename", "content_type", "file_size_bytes", "sha256", "mapping_version", "effective_at",
  "status", "is_dry_run", "requested_by", "row_count", "valid_row_count", "warning_row_count",
  "error_row_count", "skipped_row_count", "file_issue_count", "failure_message", "started_at",
  "previewed_at", "confirmed_at", "completed_at", "created_at", "updated_at",
].join(", ");

const FIELD_SECTIONS: SectionSpec[] = [
  { name: "fields", sql: "SELECT * FROM fields WHERE id = ? ORDER BY id", jsonColumns: ["coordinates"] },
  { name: "paddocks", sql: "SELECT * FROM potreros WHERE field_id = ? ORDER BY id", jsonColumns: ["coordinates"] },
  { name: "paddockNdvi", sql: "SELECT ndvi.* FROM paddock_ndvi ndvi INNER JOIN fields current_field ON current_field.id = ndvi.field_id AND current_field.organization_id = ndvi.organization_id INNER JOIN potreros paddock ON paddock.id = ndvi.paddock_id AND paddock.field_id = current_field.id WHERE current_field.id = ? ORDER BY ndvi.paddock_id, ndvi.month, ndvi.id", jsonColumns: ["geometry_snapshot", "paddock_snapshot"] },
  { name: "activities", sql: "SELECT * FROM activities WHERE paddock_id IN (SELECT id FROM potreros WHERE field_id = ?) ORDER BY id" },
  { name: "subdivisionDrafts", sql: "SELECT * FROM subdivision_drafts WHERE field_id = ? ORDER BY field_id", jsonColumns: ["history", "line"] },
  { name: "paddockCellOperations", sql: "SELECT operation.* FROM paddock_cell_operations operation INNER JOIN fields current_field ON current_field.id = operation.field_id AND current_field.organization_id = operation.organization_id INNER JOIN potreros paddock ON paddock.id = operation.paddock_id AND paddock.field_id = current_field.id WHERE current_field.id = ? ORDER BY operation.committed_at, operation.id", jsonColumns: ["request", "result"] },
  { name: "paddockCells", sql: "SELECT cell.* FROM paddock_cells cell INNER JOIN fields current_field ON current_field.id = cell.field_id INNER JOIN potreros paddock ON paddock.id = cell.paddock_id AND paddock.field_id = current_field.id INNER JOIN paddock_cell_operations created_operation ON created_operation.id = cell.created_by_operation_id AND created_operation.organization_id = current_field.organization_id AND created_operation.field_id = current_field.id AND created_operation.paddock_id = paddock.id LEFT JOIN paddock_cell_operations closed_operation ON closed_operation.id = cell.closed_by_operation_id AND closed_operation.organization_id = current_field.organization_id AND closed_operation.field_id = current_field.id AND closed_operation.paddock_id = paddock.id WHERE current_field.id = ? AND (cell.closed_by_operation_id IS NULL OR closed_operation.id IS NOT NULL) ORDER BY cell.paddock_id, cell.active_from, cell.cell_index, cell.id", jsonColumns: ["coordinates"] },
  { name: "paddockRotationSettingOperations", sql: "SELECT operation.* FROM paddock_rotation_setting_operations operation INNER JOIN fields current_field ON current_field.id = operation.field_id AND current_field.organization_id = operation.organization_id WHERE current_field.id = ? ORDER BY operation.committed_at, operation.id", jsonColumns: ["result"] },
  { name: "paddockRotationSettings", sql: "SELECT settings.* FROM paddock_rotation_settings settings INNER JOIN fields current_field ON current_field.id = settings.field_id WHERE current_field.id = ? ORDER BY settings.field_id" },
  { name: "fieldLandmarkOperations", sql: "SELECT operation.* FROM field_landmark_operations operation INNER JOIN fields current_field ON current_field.id = operation.field_id AND current_field.organization_id = operation.organization_id WHERE current_field.id = ? ORDER BY operation.committed_at, operation.id", jsonColumns: ["request", "result"] },
  { name: "fieldLandmarks", sql: "SELECT landmark.* FROM field_landmarks landmark INNER JOIN fields current_field ON current_field.id = landmark.field_id INNER JOIN field_landmark_operations last_operation ON last_operation.id = landmark.last_operation_id AND last_operation.organization_id = current_field.organization_id AND last_operation.field_id = current_field.id AND last_operation.landmark_id = landmark.id WHERE current_field.id = ? ORDER BY landmark.created_at, landmark.id", jsonColumns: ["geometry"] },
  { name: "livestockLots", sql: "SELECT * FROM livestock_lots WHERE field_id = ? ORDER BY id" },
  { name: "livestockAnimals", sql: "SELECT * FROM livestock_animals WHERE lot_id IN (SELECT id FROM livestock_lots WHERE field_id = ?) ORDER BY id" },
  { name: "livestockWeighings", sql: "SELECT * FROM livestock_weighings WHERE animal_id IN (SELECT a.id FROM livestock_animals a JOIN livestock_lots l ON l.id = a.lot_id WHERE l.field_id = ?) ORDER BY id" },
  { name: "livestockFeedingPlans", sql: "SELECT * FROM livestock_feeding_plans WHERE lot_id IN (SELECT id FROM livestock_lots WHERE field_id = ?) ORDER BY id" },
  { name: "livestockPartners", sql: "SELECT * FROM livestock_partners WHERE id IN (SELECT paid_by_id FROM livestock_expenses WHERE field_id = ? AND paid_by_id IS NOT NULL) ORDER BY id" },
  { name: "livestockExpenses", sql: "SELECT * FROM livestock_expenses WHERE field_id = ? ORDER BY id" },
  { name: "milkSettlements", sql: "SELECT * FROM milk_settlements WHERE field_id = ? ORDER BY id", jsonColumns: ["line_items"] },
  { name: "importJobs", sql: `SELECT ${PORTABLE_IMPORT_JOB_COLUMNS} FROM import_jobs WHERE field_id = ? AND organization_id = (SELECT organization_id FROM fields WHERE id = ?) AND source_system = 'cooprinsem' ORDER BY created_at, id` },
  { name: "importRows", sql: "SELECT r.* FROM import_rows r INNER JOIN import_jobs j ON j.id = r.import_job_id INNER JOIN fields f ON f.id = j.field_id AND f.organization_id = j.organization_id WHERE f.id = ? AND j.source_system = 'cooprinsem' ORDER BY r.import_job_id, r.record_number, r.id", jsonColumns: ["raw_record", "normalized_record"] },
  { name: "importErrors", sql: "SELECT e.* FROM import_errors e INNER JOIN import_jobs j ON j.id = e.import_job_id INNER JOIN fields f ON f.id = j.field_id AND f.organization_id = j.organization_id LEFT JOIN import_rows r ON r.id = e.import_row_id AND r.import_job_id = e.import_job_id WHERE f.id = ? AND j.source_system = 'cooprinsem' AND (e.import_row_id IS NULL OR r.id IS NOT NULL) ORDER BY e.import_job_id, e.import_row_id, e.id", jsonColumns: ["source_value"] },
  { name: "sourceRecords", sql: "SELECT s.* FROM source_records s INNER JOIN import_jobs j ON j.id = s.import_job_id INNER JOIN fields f ON f.id = j.field_id AND f.organization_id = j.organization_id LEFT JOIN import_rows r ON r.id = s.import_row_id AND r.import_job_id = s.import_job_id WHERE f.id = ? AND j.source_system = 'cooprinsem' AND (s.import_row_id IS NULL OR r.id IS NOT NULL) ORDER BY s.import_job_id, s.import_row_id, s.id" },
  { name: "livestockLactations", sql: "SELECT * FROM livestock_lactations WHERE field_id = ? ORDER BY animal_id, sequence_number, id" },
  { name: "livestockMilkControls", sql: "SELECT * FROM livestock_milk_controls WHERE field_id = ? ORDER BY control_date, animal_id, id" },
  { name: "livestockReproductiveEvents", sql: "SELECT * FROM livestock_reproductive_events WHERE field_id = ? ORDER BY occurred_at, animal_id, id", jsonColumns: ["metadata"] },
  { name: "livestockBirths", sql: "SELECT * FROM livestock_births WHERE field_id = ? ORDER BY occurred_at, dam_animal_id, id" },
  { name: "livestockBirthOffspring", sql: "SELECT * FROM livestock_birth_offspring WHERE birth_id IN (SELECT id FROM livestock_births WHERE field_id = ?) ORDER BY birth_id, id" },
  { name: "livestockHealthEvents", sql: "SELECT * FROM livestock_health_events WHERE field_id = ? ORDER BY occurred_at, animal_id, id", jsonColumns: ["metadata"] },
  { name: "fieldExternalIdentifiers", sql: "SELECT * FROM field_external_identifiers WHERE field_id = ? ORDER BY id" },
  { name: "livestockLotExternalIdentifiers", sql: "SELECT * FROM livestock_lot_external_identifiers WHERE field_id = ? ORDER BY id" },
  { name: "livestockAnimalIdentifiers", sql: "SELECT * FROM livestock_animal_identifiers WHERE field_id = ? ORDER BY animal_id, id" },
  { name: "livestockLotMemberships", sql: "SELECT * FROM livestock_lot_memberships WHERE lot_id IN (SELECT id FROM livestock_lots WHERE field_id = ?) ORDER BY animal_id, started_at, id" },
  { name: "auditLog", sql: "SELECT a.* FROM audit_log a INNER JOIN fields f ON f.id = a.field_id WHERE f.id = ? AND a.organization_id = f.organization_id ORDER BY a.occurred_at, a.id", jsonColumns: ["before", "after"] },
];

const IMPORT_SECTIONS: SectionSpec[] = [
  { name: "fields", sql: "SELECT f.* FROM fields f JOIN import_jobs j ON j.field_id = f.id AND j.organization_id = f.organization_id WHERE j.id = ? ORDER BY f.id", jsonColumns: ["coordinates"] },
  { name: "importJobs", sql: `SELECT ${PORTABLE_IMPORT_JOB_COLUMNS} FROM import_jobs WHERE id = ? ORDER BY id` },
  { name: "importRows", sql: "SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY record_number, id", jsonColumns: ["raw_record", "normalized_record"] },
  { name: "importErrors", sql: "SELECT e.* FROM import_errors e LEFT JOIN import_rows r ON r.id = e.import_row_id AND r.import_job_id = e.import_job_id WHERE e.import_job_id = ? AND (e.import_row_id IS NULL OR r.id IS NOT NULL) ORDER BY e.import_row_id, e.id", jsonColumns: ["source_value"] },
  { name: "sourceRecords", sql: "SELECT s.* FROM source_records s LEFT JOIN import_rows r ON r.id = s.import_row_id AND r.import_job_id = s.import_job_id WHERE s.import_job_id = ? AND (s.import_row_id IS NULL OR r.id IS NOT NULL) ORDER BY s.import_row_id, s.id" },
  {
    name: "auditLog",
    sql: "SELECT a.* FROM audit_log a INNER JOIN import_jobs j ON j.id = ? WHERE a.organization_id = j.organization_id AND (a.field_id IS NULL OR a.field_id = j.field_id) AND ((a.entity_type = 'import_job' AND a.entity_id = j.id) OR a.source_record_id IN (SELECT s.id FROM source_records s LEFT JOIN import_rows r ON r.id = s.import_row_id AND r.import_job_id = s.import_job_id WHERE s.import_job_id = j.id AND (s.import_row_id IS NULL OR r.id IS NOT NULL))) ORDER BY a.occurred_at, a.id",
    jsonColumns: ["before", "after"],
  },
];

export async function buildFieldBackup(input: {
  fieldId: string;
  actor: string;
  generatedAt?: string;
} & ImportFieldAccess): Promise<FundoSmartPortableBackup | null> {
  const access = backupAccess(input);
  const scope = await loadFieldScope(input.fieldId, access);
  if (!scope) return null;
  const sections = await loadSections(FIELD_SECTIONS, input.fieldId);
  const currentScope = await loadFieldScope(input.fieldId, access);
  if (!currentScope || !sameFieldScope(scope, currentScope)) return null;
  const originals = originalFilesFromSections(sections, scope);
  return assembleBackup({
    actor: input.actor,
    generatedAt: input.generatedAt,
    originals,
    scope: { ...scope, type: "field", id: scope.fieldId, name: scope.fieldName },
    sections,
    excluded: [
      {
        section: "livestockContributions",
        reason: "Los aportes pertenecen a toda la organización y no se incluyen en un respaldo limitado a un fundo.",
      },
      {
        section: "accessConfiguration",
        reason: "Las membresias y permisos se administran como configuracion de seguridad y no forman parte del respaldo productivo del fundo.",
      },
      {
        section: "benchmarkPositions",
        reason: "Las posiciones privadas de benchmarking son derivados efimeros y nunca se exportan en respaldos portables.",
      },
      {
        section: "benchmarkSuppressedCounts",
        reason: "Los conteos internos de cohortes suprimidas no se exportan para evitar riesgos de reidentificacion.",
      },
      {
        section: "importCenterVisits",
        reason: "Las visitas Watt's y planillas genéricas usan el centro versionado y no forman parte del respaldo portable Cooprinsem v1.",
      },
    ],
  });
}

export async function buildImportBackup(input: {
  importJobId: string;
  actor: string;
  generatedAt?: string;
} & ImportFieldAccess): Promise<FundoSmartPortableBackup | null> {
  const access = backupAccess(input);
  const original = await getOriginalFileReference(input.importJobId, access);
  if (!original) return null;
  const sections = await loadSections(IMPORT_SECTIONS, input.importJobId);
  const currentOriginal = await getOriginalFileReference(input.importJobId, access);
  if (!currentOriginal || !sameOriginalFileReference(original, currentOriginal)) return null;
  const organization = await loadOrganization(original.organizationId);
  return assembleBackup({
    actor: input.actor,
    generatedAt: input.generatedAt,
    originals: [portableOriginalFile(original)],
    scope: {
      type: "import",
      id: original.importJobId,
      name: original.originalFilename,
      organizationId: original.organizationId,
      organizationName: organization?.name ?? original.organizationId,
      fieldId: original.fieldId,
      fieldName: original.fieldName,
    },
    sections,
    excluded: [],
  });
}

export async function getOriginalFileReference(
  importJobId: string,
  access: ImportFieldAccess,
): Promise<OriginalFileReference | null> {
  const fieldIds = normalizedFieldIds(access.fieldIds);
  if (fieldIds.length === 0) return null;
  const [row] = await getDb()
    .select({
      importJobId: importJobs.id,
      organizationId: importJobs.organizationId,
      fieldId: importJobs.fieldId,
      fieldName: fields.name,
      originalFilename: importJobs.originalFilename,
      contentType: importJobs.contentType,
      fileSizeBytes: importJobs.fileSizeBytes,
      objectKey: importJobs.objectKey,
      sha256: importJobs.sha256,
      sourceTable: importJobs.sourceTable,
      createdAt: importJobs.createdAt,
    })
    .from(importJobs)
    .innerJoin(fields, and(
      eq(fields.id, importJobs.fieldId),
      eq(fields.organizationId, importJobs.organizationId),
    ))
    .where(and(
      eq(importJobs.id, importJobId),
      eq(importJobs.sourceSystem, "cooprinsem"),
      eq(importJobs.organizationId, access.organizationId),
      sql`${importJobs.fieldId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(fieldIds)}))`,
    ))
    .limit(1);
  return row ?? null;
}

export async function recordBackupDownload(input: {
  actor: string;
  scope: BackupScope;
  kind: "portable_backup" | "original_file";
  sha256: string;
  filename: string;
  recordCounts?: Record<string, number>;
  access: BackupDownloadAccess;
}): Promise<boolean> {
  return recordScopedAudit({
    access: input.access,
    action: input.kind === "original_file" ? "import.original.downloaded" : `backup.${input.scope.type}.downloaded`,
    actor: input.actor,
    after: {
      filename: input.filename,
      format: input.kind === "portable_backup" ? FUNDOSMART_BACKUP_FORMAT : "original",
      recordCounts: input.recordCounts ?? null,
      sha256: input.sha256,
    },
    requireCurrentImport: input.scope.type === "import",
    requireCurrentManageImportsActor: true,
    scope: input.scope,
  });
}

export async function recordRestorePreview(input: {
  actor: string;
  scope: BackupScope;
  uploadedSha256: string;
  assessment: "ready" | "conflicts" | "no_changes";
  totals: Record<string, number>;
  access: CurrentManageImportsAccess;
}): Promise<boolean> {
  return recordScopedAudit({
    access: input.access,
    action: "backup.restore.previewed",
    actor: input.actor,
    after: {
      assessment: input.assessment,
      format: FUNDOSMART_BACKUP_FORMAT,
      totals: input.totals,
      uploadedSha256: input.uploadedSha256,
      writeEnabled: false,
    },
    entityType: input.scope.type === "import" ? "import_job" : "field",
    requireCurrentImport: false,
    requireCurrentManageImportsActor: true,
    scope: input.scope,
  });
}

export function backupFilename(backup: FundoSmartPortableBackup): string {
  const date = backup.manifest.generatedAt.slice(0, 10);
  const prefix = backup.manifest.scope.type === "field" ? "fundo" : "importacion";
  return safeDownloadFilename(`${prefix}-${backup.manifest.scope.name}-${date}.fundosmart.json`);
}

export function backupScope(backup: FundoSmartPortableBackup): BackupScope {
  return backup.manifest.scope;
}

async function assembleBackup(input: {
  actor: string;
  generatedAt?: string;
  originals: PortableOriginalFile[];
  scope: BackupScope;
  sections: BackupSections;
  excluded: Array<{ section: string; reason: string }>;
}): Promise<FundoSmartPortableBackup> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const entries = Object.entries(input.sections);
  const sectionSha256Entries = await Promise.all(
    entries.map(async ([name, rows]) => [name, await sha256Hex(canonicalJson(rows))] as const),
  );
  return {
    manifest: {
      format: FUNDOSMART_BACKUP_FORMAT,
      generatedAt,
      generatedBy: input.actor,
      encoding: "UTF-8 JSON",
      scope: input.scope,
      recordCounts: Object.fromEntries(entries.map(([name, rows]) => [name, rows.length])),
      sectionSha256: Object.fromEntries(sectionSha256Entries),
      originalFiles: input.originals.map((file) => ({
        importJobId: file.importJobId,
        organizationId: file.organizationId,
        fieldId: file.fieldId,
        fieldName: file.fieldName,
        originalFilename: file.originalFilename,
        contentType: file.contentType,
        fileSizeBytes: file.fileSizeBytes,
        sha256: file.sha256,
        sourceTable: file.sourceTable,
        createdAt: file.createdAt,
        downloadPath: `/api/integraciones/cooprinsem/respaldos?scope=import&id=${encodeURIComponent(file.importJobId)}&asset=original`,
      })),
      excluded: input.excluded,
    },
    data: input.sections,
  };
}

async function loadSections(specs: SectionSpec[], scopeId: string): Promise<BackupSections> {
  const client = getDb().$client;
  const statements = specs.map((spec) => {
    const bindCount = (spec.sql.match(/\?/g) ?? []).length;
    return client.prepare(spec.sql).bind(...Array.from({ length: bindCount }, () => scopeId));
  });
  const results = await client.batch<BackupRow>(statements);
  const entries = specs.map((spec, index) => [
    spec.name,
    results[index].results.map((row) => parseJsonColumns(row, spec.jsonColumns ?? [])),
  ] as const);
  return Object.fromEntries(entries);
}

async function loadFieldScope(
  fieldId: string,
  access: ImportFieldAccess,
): Promise<Omit<BackupScope, "type" | "id" | "name"> | null> {
  const fieldIds = normalizedFieldIds(access.fieldIds);
  if (fieldIds.length === 0) return null;
  const [row] = await getDb()
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      fieldId: fields.id,
      fieldName: fields.name,
    })
    .from(fields)
    .innerJoin(organizations, eq(organizations.id, fields.organizationId))
    .where(and(
      eq(fields.id, fieldId),
      eq(fields.organizationId, access.organizationId),
      sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(fieldIds)}))`,
    ))
    .limit(1);
  return row ?? null;
}

async function loadOrganization(organizationId: string): Promise<{ name: string } | null> {
  const [row] = await getDb()
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

function originalFilesFromSections(
  sections: BackupSections,
  scope: Omit<BackupScope, "type" | "id" | "name">,
): PortableOriginalFile[] {
  return (sections.importJobs ?? []).map((row) => ({
    importJobId: String(row.id),
    organizationId: String(row.organization_id),
    fieldId: String(row.field_id),
    fieldName: scope.fieldName,
    originalFilename: String(row.original_filename),
    contentType: typeof row.content_type === "string" ? row.content_type : null,
    fileSizeBytes: Number(row.file_size_bytes),
    sha256: String(row.sha256),
    sourceTable: String(row.source_table),
    createdAt: String(row.created_at),
  }));
}

function portableOriginalFile(file: OriginalFileReference): PortableOriginalFile {
  return {
    importJobId: file.importJobId,
    organizationId: file.organizationId,
    fieldId: file.fieldId,
    fieldName: file.fieldName,
    originalFilename: file.originalFilename,
    contentType: file.contentType,
    fileSizeBytes: file.fileSizeBytes,
    sha256: file.sha256,
    sourceTable: file.sourceTable,
    createdAt: file.createdAt,
  };
}

async function recordScopedAudit(input: {
  access: ImportFieldAccess & Partial<Pick<AccessContext, "membershipId" | "email">>;
  action: string;
  actor: string;
  after: Record<string, unknown>;
  entityType?: "import_job" | "field";
  requireCurrentImport: boolean;
  requireCurrentManageImportsActor?: boolean;
  scope: BackupScope;
}): Promise<boolean> {
  const fieldIds = normalizedFieldIds(input.access.fieldIds);
  const normalizedActor = input.actor.trim().toLowerCase();
  if (
    fieldIds.length === 0
    || input.scope.organizationId !== input.access.organizationId
    || !fieldIds.includes(input.scope.fieldId)
    || (input.requireCurrentImport && input.scope.type !== "import")
    || (input.requireCurrentManageImportsActor && (
      !input.access.membershipId
      || !input.access.email
      || normalizedActor !== input.access.email.trim().toLowerCase()
      || normalizedActor === DEMO_EMAIL
    ))
  ) return false;
  const currentManageImportsActorGuard = input.requireCurrentManageImportsActor ? `
      AND current_field.is_demo = 0
      AND EXISTS (
        SELECT 1 FROM organization_memberships AS current_actor
        WHERE current_actor.id = ?
          AND current_actor.organization_id = current_field.organization_id
          AND current_actor.normalized_email = ?
          AND current_actor.normalized_email <> ?
          AND current_actor.status = 'active'
          AND current_actor.role IN ('owner', 'admin', 'manager')
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )` : "";
  const result = await getDb().$client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, current_field.organization_id, current_field.id, ?, ?, ?, ?,
      NULL, ?, NULL, ?
    FROM fields AS current_field
    WHERE current_field.id = ?
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ${currentManageImportsActorGuard}
      AND (
        ? = 0
        OR EXISTS (
          SELECT 1 FROM import_jobs AS current_job
          WHERE current_job.id = ?
            AND current_job.organization_id = current_field.organization_id
            AND current_job.field_id = current_field.id
        )
      )
  `).bind(
    crypto.randomUUID(),
    input.actor,
    input.action,
    input.entityType ?? (input.scope.type === "import" ? "import_job" : "field"),
    input.scope.id,
    JSON.stringify(input.after),
    new Date().toISOString(),
    input.scope.fieldId,
    input.access.organizationId,
    JSON.stringify(fieldIds),
    ...(input.requireCurrentManageImportsActor ? [
      input.access.membershipId!,
      normalizedActor,
      DEMO_EMAIL,
    ] : []),
    input.requireCurrentImport ? 1 : 0,
    input.scope.id,
  ).run();
  return Number(result.meta.changes) === 1;
}

function backupAccess(input: ImportFieldAccess): ImportFieldAccess {
  return { organizationId: input.organizationId, fieldIds: normalizedFieldIds(input.fieldIds) };
}

function normalizedFieldIds(fieldIds: string[]): string[] {
  return [...new Set(fieldIds.map((fieldId) => fieldId.trim()).filter(Boolean))].sort();
}

function sameFieldScope(
  left: Omit<BackupScope, "type" | "id" | "name">,
  right: Omit<BackupScope, "type" | "id" | "name">,
): boolean {
  return left.organizationId === right.organizationId
    && left.organizationName === right.organizationName
    && left.fieldId === right.fieldId
    && left.fieldName === right.fieldName;
}

export function sameOriginalFileReference(
  left: OriginalFileReference,
  right: OriginalFileReference,
): boolean {
  return left.importJobId === right.importJobId
    && left.organizationId === right.organizationId
    && left.fieldId === right.fieldId
    && left.fieldName === right.fieldName
    && left.originalFilename === right.originalFilename
    && left.contentType === right.contentType
    && left.fileSizeBytes === right.fileSizeBytes
    && left.objectKey === right.objectKey
    && left.sha256 === right.sha256
    && left.sourceTable === right.sourceTable
    && left.createdAt === right.createdAt;
}

function parseJsonColumns(row: BackupRow, columns: string[]): BackupRow {
  if (columns.length === 0) return row;
  const parsed = { ...row };
  for (const column of columns) {
    const value = parsed[column];
    if (typeof value !== "string") continue;
    try {
      parsed[column] = JSON.parse(value) as unknown;
    } catch {
      parsed[column] = value;
    }
  }
  return parsed;
}
