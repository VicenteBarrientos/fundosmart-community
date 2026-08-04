import { getDb } from "@/db";
import { fields, importErrors, importJobs, importRows } from "@/db/schema";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import type { ImportFormat, ImportSourceSystem } from "@/src/modules/importaciones/domain/types";
import type {
  CooprinsemImportDashboard,
  CooprinsemImportErrorStatus,
  CooprinsemImportIssue,
  CooprinsemImportIssueItem,
  CooprinsemImportPreview,
  CooprinsemImportRowStatus,
  CooprinsemImportSummary,
  CooprinsemSourceTable,
  ImportRecord,
} from "../domain/types";
import { and, asc, count, desc, eq, inArray, sql, sum } from "drizzle-orm";

const PREVIEW_ROW_LIMIT = 200;
const D1_MAX_BOUND_PARAMETERS = 100;
const IMPORT_ROW_BOUND_PARAMETERS = 8;
const IMPORT_ERROR_BOUND_PARAMETERS = 9;
const IMPORT_LIFECYCLE_GUARD_PARAMETERS = 3;
const IMPORT_ROW_CHUNK_SIZE = Math.floor((D1_MAX_BOUND_PARAMETERS - IMPORT_LIFECYCLE_GUARD_PARAMETERS) / IMPORT_ROW_BOUND_PARAMETERS);
const IMPORT_ERROR_CHUNK_SIZE = Math.floor((D1_MAX_BOUND_PARAMETERS - IMPORT_LIFECYCLE_GUARD_PARAMETERS) / IMPORT_ERROR_BOUND_PARAMETERS);
const PREVIEW_BATCH_STATEMENT_LIMIT = 900;

export class ImportPreviewLimitError extends Error {
  readonly code = "IMPORT_PREVIEW_QUERY_LIMIT";

  constructor() {
    super("El archivo genera demasiadas observaciones para construir una vista previa segura.");
    this.name = "ImportPreviewLimitError";
  }
}

export type ImportFieldScope = {
  fieldId: string;
  fieldName: string;
  organizationId: string;
};

export type ImportFieldAccess = {
  organizationId: string;
  fieldIds: string[];
};

export type ImportActorAccess = ImportFieldAccess & {
  membershipId: string;
  email: string;
};

export class ImportAccessChangedError extends Error {
  readonly code = "IMPORT_ACCESS_CHANGED";

  constructor() {
    super("Tu membresia o alcance cambio durante la operacion. Recarga e intentalo nuevamente.");
    this.name = "ImportAccessChangedError";
  }
}

export type ImportJobLifecycleScope = ImportFieldAccess & {
  importJobId: string;
  fieldId: string;
};

export type ParsingImportJobScope = ImportJobLifecycleScope & {
  parsingStartedAt: string;
};

export type ImportJobInput = {
  id: string;
  membershipId: string;
  organizationId: string;
  fieldId: string;
  sourceSystem?: ImportSourceSystem;
  sourceFormat?: ImportFormat;
  sourceTable: string;
  originalFilename: string;
  contentType: string | null;
  fileSizeBytes: number;
  objectKey: string;
  sha256: string;
  mappingVersion: string;
  effectiveAt: string | null;
  requestedBy: string;
  fieldIds: string[];
};

export type StagedPreviewRow = {
  recordNumber: number;
  rawRecord: ImportRecord;
  normalizedRecord: ImportRecord | null;
  status: CooprinsemImportRowStatus;
  issues: CooprinsemImportIssue[];
};

export class ImportJobScopeError extends Error {
  readonly code = "IMPORT_SCOPE_CHANGED";

  constructor() {
    super("El fundo cambió mientras se preparaba la importación. Recarga e inténtalo nuevamente.");
    this.name = "ImportJobScopeError";
  }
}

export async function resolveImportField(fieldId: string, access: ImportFieldAccess): Promise<ImportFieldScope | null> {
  if (access.fieldIds.length === 0) return null;
  const [field] = await getDb()
    .select({ fieldId: fields.id, fieldName: fields.name, organizationId: fields.organizationId })
    .from(fields)
    .where(and(
      eq(fields.id, fieldId),
      eq(fields.organizationId, access.organizationId),
      inArray(fields.id, access.fieldIds),
    ))
    .limit(1);
  return field ?? null;
}

export async function findImportJobByFingerprint(input: {
  organizationId: string;
  fieldId: string;
  fieldIds: string[];
  sha256: string;
  mappingVersion: string;
  sourceSystem?: ImportSourceSystem;
}) {
  if (input.fieldIds.length === 0) return null;
  const [job] = await getDb()
    .select()
    .from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(
      eq(importJobs.organizationId, input.organizationId),
      eq(importJobs.fieldId, input.fieldId),
      eq(fields.organizationId, input.organizationId),
      inArray(fields.id, input.fieldIds),
      eq(importJobs.sha256, input.sha256),
      eq(importJobs.mappingVersion, input.mappingVersion),
      eq(importJobs.sourceSystem, input.sourceSystem ?? "cooprinsem"),
    ))
    .limit(1);
  return job?.import_jobs ?? null;
}

export async function createImportJob(input: ImportJobInput) {
  if (input.fieldIds.length === 0 || !input.membershipId.trim()) throw new ImportJobScopeError();
  const db = getDb();
  const now = new Date().toISOString();
  const insertJob = db.$client.prepare(`
    WITH candidate (
      id, organization_id, field_id, source_system, source_format, source_table,
      original_filename, content_type, file_size_bytes, object_key, sha256,
      mapping_version, effective_at, requested_by, created_at, updated_at
    ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
    INSERT INTO import_jobs (
      id, organization_id, field_id, source_system, source_format, source_table,
      original_filename, content_type, file_size_bytes, object_key, sha256,
      mapping_version, effective_at, status, is_dry_run, requested_by, created_at, updated_at
    )
    SELECT
      candidate.id, candidate.organization_id, candidate.field_id,
      candidate.source_system, candidate.source_format, candidate.source_table,
      candidate.original_filename, candidate.content_type, candidate.file_size_bytes,
      candidate.object_key, candidate.sha256, candidate.mapping_version,
      candidate.effective_at, 'uploaded', 1, candidate.requested_by,
      candidate.created_at, candidate.updated_at
    FROM candidate
    WHERE EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = candidate.field_id
        AND current_field.organization_id = candidate.organization_id
        AND current_field.id IN (SELECT value FROM json_each(?))
        AND current_field.is_demo = 0
        AND EXISTS (
          SELECT 1 FROM organization_memberships AS current_actor
          WHERE current_actor.id = ?
            AND current_actor.organization_id = current_field.organization_id
            AND current_actor.normalized_email = lower(trim(candidate.requested_by))
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
        )
    )
      AND NOT EXISTS (
        SELECT 1 FROM import_jobs AS existing_id
        WHERE existing_id.id = candidate.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM import_jobs AS existing_fingerprint
        WHERE existing_fingerprint.organization_id = candidate.organization_id
          AND existing_fingerprint.field_id = candidate.field_id
          AND existing_fingerprint.sha256 = candidate.sha256
          AND existing_fingerprint.mapping_version = candidate.mapping_version
          AND existing_fingerprint.source_system = candidate.source_system
      )
  `).bind(
    input.id,
    input.organizationId,
    input.fieldId,
    input.sourceSystem ?? "cooprinsem",
    input.sourceFormat ?? "dbf",
    input.sourceTable,
    input.originalFilename,
    input.contentType,
    input.fileSizeBytes,
    input.objectKey,
    input.sha256,
    input.mappingVersion,
    input.effectiveAt,
    input.requestedBy,
    now,
    now,
    JSON.stringify(input.fieldIds),
    input.membershipId,
    DEMO_EMAIL,
  );
  let inserted = false;
  try {
    inserted = (await insertJob.run()).meta.changes === 1;
  } catch (cause) {
    if (!(cause instanceof Error) || !/UNIQUE constraint failed/i.test(cause.message)) throw cause;
  }
  if (inserted) {
    const [created] = await db.select().from(importJobs).where(and(
      eq(importJobs.id, input.id),
      eq(importJobs.organizationId, input.organizationId),
      eq(importJobs.fieldId, input.fieldId),
      eq(importJobs.sourceSystem, input.sourceSystem ?? "cooprinsem"),
    )).limit(1);
    if (!created) throw new ImportJobScopeError();
    return { job: created, created: true };
  }
  if (!(await hasCurrentImportActorAccess({
    membershipId: input.membershipId,
    organizationId: input.organizationId,
    fieldId: input.fieldId,
    fieldIds: input.fieldIds,
    actorEmail: input.requestedBy,
  }))) throw new ImportJobScopeError();
  const existing = await findImportJobByFingerprint(input);
  if (existing) return { job: existing, created: false };
  throw new ImportJobScopeError();
}

export async function hasCurrentImportActorAccess(input: {
  membershipId: string;
  organizationId: string;
  fieldId: string;
  fieldIds: string[];
  actorEmail: string;
}): Promise<boolean> {
  return hasCurrentImportActorAccessForFields({
    membershipId: input.membershipId,
    organizationId: input.organizationId,
    fieldIds: input.fieldIds,
    email: input.actorEmail,
  }, [input.fieldId]);
}

export async function hasCurrentImportActorAccessForFields(
  access: ImportActorAccess,
  requiredFieldIds: string[],
): Promise<boolean> {
  const fieldIds = normalizedIds(access.fieldIds);
  const requiredFields = normalizedIds(requiredFieldIds);
  if (!access.membershipId.trim() || !access.organizationId.trim() || !access.email.trim()) return false;
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM organization_memberships AS current_actor
      WHERE current_actor.id = ?
        AND current_actor.organization_id = ?
        AND current_actor.normalized_email = lower(trim(?))
        AND current_actor.normalized_email <> ?
        AND current_actor.status = 'active'
        AND current_actor.role IN ('owner', 'admin', 'manager')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS required_field
          WHERE NOT EXISTS (
            SELECT 1 FROM fields AS current_field
            WHERE current_field.id = CAST(required_field.value AS TEXT)
              AND current_field.organization_id = ?
              AND current_field.is_demo = 0
              AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
              AND (
                current_actor.role IN ('owner', 'admin')
                OR EXISTS (
                  SELECT 1 FROM membership_field_access AS current_scope
                  WHERE current_scope.membership_id = current_actor.id
                    AND current_scope.field_id = current_field.id
                )
              )
          )
        )
    ) THEN 1 ELSE 0 END AS authorized
  `).bind(
    access.membershipId,
    access.organizationId,
    access.email,
    DEMO_EMAIL,
    JSON.stringify(requiredFields),
    access.organizationId,
    JSON.stringify(fieldIds),
  ).first<{ authorized: number }>();
  return Number(row?.authorized) === 1;
}

export async function assertCurrentImportActorAccess(
  access: ImportActorAccess,
  requiredFieldIds: string[],
): Promise<void> {
  if (!(await hasCurrentImportActorAccessForFields(access, requiredFieldIds))) {
    throw new ImportAccessChangedError();
  }
}

export async function markImportParsing(input: ImportJobLifecycleScope): Promise<string> {
  if (input.fieldIds.length === 0) throw new ImportJobScopeError();
  const client = getDb().$client;
  const startedAt = new Date().toISOString();
  const fieldIds = JSON.stringify(input.fieldIds);
  const claim = client.prepare(`
    UPDATE import_jobs
    SET status = 'parsing', started_at = ?, failure_message = NULL, completed_at = NULL, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'uploaded'
      AND started_at IS NULL
      AND previewed_at IS NULL
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND row_count = 0
      AND valid_row_count = 0
      AND warning_row_count = 0
      AND error_row_count = 0
      AND skipped_row_count = 0
      AND file_issue_count = 0
      AND NOT EXISTS (SELECT 1 FROM import_rows WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (SELECT 1 FROM import_errors WHERE import_job_id = import_jobs.id)
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    startedAt,
    startedAt,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.organizationId,
    fieldIds,
  );
  const assertClaimed = client.prepare(`
    SELECT CASE WHEN changes() = 1
      AND EXISTS (
        SELECT 1 FROM import_jobs AS claimed_job
        INNER JOIN fields AS current_field ON current_field.id = claimed_job.field_id
        WHERE claimed_job.id = ?
          AND claimed_job.organization_id = ?
          AND claimed_job.field_id = ?
          AND claimed_job.status = 'parsing'
          AND claimed_job.started_at = ?
          AND claimed_job.updated_at = ?
          AND claimed_job.failure_message IS NULL
          AND claimed_job.previewed_at IS NULL
          AND claimed_job.confirmed_at IS NULL
          AND claimed_job.completed_at IS NULL
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.importJobId,
    input.organizationId,
    input.fieldId,
    startedAt,
    startedAt,
    input.organizationId,
    fieldIds,
  );
  try {
    const results = await client.batch([claim, assertClaimed]);
    if ((results[1].results[0] as { complete?: number } | undefined)?.complete !== 1) throw new ImportJobScopeError();
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) throw cause;
    if (isImportLifecycleConflict(cause)) throw new ImportJobScopeError();
    throw cause;
  }
  return startedAt;
}

export async function markImportFailed(input: ParsingImportJobScope & { message: string }): Promise<void> {
  if (input.fieldIds.length === 0) throw new ImportJobScopeError();
  const client = getDb().$client;
  const now = new Date().toISOString();
  const failureToken = crypto.randomUUID();
  const fieldIds = JSON.stringify(input.fieldIds);
  const claim = client.prepare(`
    UPDATE import_jobs
    SET updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'parsing'
      AND started_at = ?
      AND updated_at = ?
      AND failure_message IS NULL
      AND previewed_at IS NULL
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    failureToken,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.parsingStartedAt,
    input.parsingStartedAt,
    input.organizationId,
    fieldIds,
  );
  const deleteErrors = client.prepare(`
    DELETE FROM import_errors
    WHERE import_job_id = ?
      AND EXISTS (
        SELECT 1 FROM import_jobs AS claimed_job
        WHERE claimed_job.id = import_errors.import_job_id
          AND claimed_job.status = 'parsing'
          AND claimed_job.started_at = ?
          AND claimed_job.updated_at = ?
      )
  `).bind(input.importJobId, input.parsingStartedAt, failureToken);
  const deleteRows = client.prepare(`
    DELETE FROM import_rows
    WHERE import_job_id = ?
      AND EXISTS (
        SELECT 1 FROM import_jobs AS claimed_job
        WHERE claimed_job.id = import_rows.import_job_id
          AND claimed_job.status = 'parsing'
          AND claimed_job.started_at = ?
          AND claimed_job.updated_at = ?
      )
  `).bind(input.importJobId, input.parsingStartedAt, failureToken);
  const failJob = client.prepare(`
    UPDATE import_jobs
    SET status = 'failed', row_count = 0, valid_row_count = 0, warning_row_count = 0,
        error_row_count = 0, skipped_row_count = 0, file_issue_count = 0,
        failure_message = ?, previewed_at = NULL, completed_at = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'parsing'
      AND started_at = ?
      AND updated_at = ?
      AND NOT EXISTS (SELECT 1 FROM import_rows WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (SELECT 1 FROM import_errors WHERE import_job_id = import_jobs.id)
  `).bind(
    input.message.slice(0, 1_000),
    now,
    now,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.parsingStartedAt,
    failureToken,
  );
  const assertFailed = client.prepare(`
    SELECT CASE WHEN changes() = 1
      AND EXISTS (
        SELECT 1 FROM import_jobs AS failed_job
        INNER JOIN fields AS current_field ON current_field.id = failed_job.field_id
        WHERE failed_job.id = ?
          AND failed_job.organization_id = ?
          AND failed_job.field_id = ?
          AND failed_job.status = 'failed'
          AND failed_job.started_at = ?
          AND failed_job.failure_message = ?
          AND failed_job.previewed_at IS NULL
          AND failed_job.completed_at = ?
          AND failed_job.updated_at = ?
          AND failed_job.row_count = 0
          AND failed_job.valid_row_count = 0
          AND failed_job.warning_row_count = 0
          AND failed_job.error_row_count = 0
          AND failed_job.skipped_row_count = 0
          AND failed_job.file_issue_count = 0
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM import_rows WHERE import_job_id = failed_job.id)
          AND NOT EXISTS (SELECT 1 FROM import_errors WHERE import_job_id = failed_job.id)
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.parsingStartedAt,
    input.message.slice(0, 1_000),
    now,
    now,
    input.organizationId,
    fieldIds,
  );
  try {
    const results = await client.batch([claim, deleteErrors, deleteRows, failJob, assertFailed]);
    if ((results[4].results[0] as { complete?: number } | undefined)?.complete !== 1) throw new ImportJobScopeError();
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) throw cause;
    if (isImportLifecycleConflict(cause)) throw new ImportJobScopeError();
    throw cause;
  }
}

export async function saveImportPreview(input: {
  importJobId: string;
  organizationId: string;
  fieldId: string;
  fieldIds: string[];
  parsingStartedAt: string;
  rows: StagedPreviewRow[];
  summary: CooprinsemImportSummary;
}): Promise<void> {
  if (input.fieldIds.length === 0) throw new ImportJobScopeError();
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const previewToken = crypto.randomUUID();
  const fieldIds = JSON.stringify(input.fieldIds);
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'parsing'
      AND started_at = ?
      AND updated_at = ?
      AND failure_message IS NULL
      AND previewed_at IS NULL
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM import_rows WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (SELECT 1 FROM import_errors WHERE import_job_id = import_jobs.id)
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    previewToken,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.parsingStartedAt,
    input.parsingStartedAt,
    input.organizationId,
    fieldIds,
  )];
  const rowValues = input.rows.map((row) => ({
    id: importRowId(input.importJobId, row.recordNumber),
    importJobId: input.importJobId,
    recordNumber: row.recordNumber,
    rawRecord: row.rawRecord,
    normalizedRecord: row.normalizedRecord,
    status: row.status,
    warningCount: row.issues.filter((entry) => entry.severity === "warning").length,
    errorCount: row.issues.filter((entry) => entry.severity === "error").length,
  }));

  for (const chunk of chunks(rowValues, IMPORT_ROW_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(client.prepare(`
      WITH staged_rows (
        id, import_job_id, record_number, raw_record, normalized_record, status, warning_count, error_count
      ) AS (VALUES ${values})
      INSERT INTO import_rows (
        id, import_job_id, record_number, raw_record, normalized_record, status, warning_count, error_count
      )
      SELECT id, import_job_id, record_number, raw_record, normalized_record, status, warning_count, error_count
      FROM staged_rows
      WHERE EXISTS (
        SELECT 1 FROM import_jobs AS claimed_job
        WHERE claimed_job.id = ?
          AND claimed_job.status = 'parsing'
          AND claimed_job.started_at = ?
          AND claimed_job.updated_at = ?
      )
    `).bind(
      ...chunk.flatMap((row) => [
        row.id,
        row.importJobId,
        row.recordNumber,
        JSON.stringify(row.rawRecord),
        row.normalizedRecord === null ? null : JSON.stringify(row.normalizedRecord),
        row.status,
        row.warningCount,
        row.errorCount,
      ]),
      input.importJobId,
      input.parsingStartedAt,
      previewToken,
    ));
  }

  const errorValues = input.rows.flatMap((row) => row.issues.map((entry, index) => ({
    id: `${importRowId(input.importJobId, row.recordNumber)}:issue:${index}`,
    importJobId: input.importJobId,
    importRowId: importRowId(input.importJobId, row.recordNumber),
    fieldName: entry.fieldName,
    ruleCode: entry.ruleCode,
    severity: entry.severity,
    message: entry.message,
    sourceValue: entry.sourceValue,
    status: "open" as const,
  })));
  for (const chunk of chunks(errorValues, IMPORT_ERROR_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(client.prepare(`
      WITH staged_errors (
        id, import_job_id, import_row_id, field_name, rule_code, severity, message, source_value, status
      ) AS (VALUES ${values})
      INSERT INTO import_errors (
        id, import_job_id, import_row_id, field_name, rule_code, severity, message, source_value, status
      )
      SELECT id, import_job_id, import_row_id, field_name, rule_code, severity, message, source_value, status
      FROM staged_errors
      WHERE EXISTS (
        SELECT 1 FROM import_jobs AS claimed_job
        WHERE claimed_job.id = ?
          AND claimed_job.status = 'parsing'
          AND claimed_job.started_at = ?
          AND claimed_job.updated_at = ?
      )
    `).bind(
      ...chunk.flatMap((entry) => [
        entry.id,
        entry.importJobId,
        entry.importRowId,
        entry.fieldName,
        entry.ruleCode,
        entry.severity,
        entry.message,
        entry.sourceValue === null || entry.sourceValue === undefined ? null : JSON.stringify(entry.sourceValue),
        entry.status,
      ]),
      input.importJobId,
      input.parsingStartedAt,
      previewToken,
    ));
  }

  const now = new Date().toISOString();
  const issueCount = errorValues.length;
  const warningIssueCount = errorValues.filter((entry) => entry.severity === "warning").length;
  const errorIssueCount = issueCount - warningIssueCount;
  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = 'preview_ready', row_count = ?, valid_row_count = ?, warning_row_count = ?,
        error_row_count = ?, skipped_row_count = ?, file_issue_count = ?,
        previewed_at = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'parsing'
      AND started_at = ?
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id) = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id AND status = 'valid') = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id AND status = 'warning') = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id AND status = 'error') = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id AND status = 'skipped') = ?
      AND (SELECT COUNT(*) FROM import_errors WHERE import_job_id = import_jobs.id) = ?
      AND (SELECT COUNT(*) FROM import_errors WHERE import_job_id = import_jobs.id AND severity = 'warning') = ?
      AND (SELECT COUNT(*) FROM import_errors WHERE import_job_id = import_jobs.id AND severity = 'error') = ?
  `).bind(
    input.summary.rowCount,
    input.summary.validRowCount,
    input.summary.warningRowCount,
    input.summary.errorRowCount,
    input.summary.skippedRowCount,
    input.summary.fileIssueCount,
    now,
    now,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.parsingStartedAt,
    previewToken,
    input.summary.rowCount,
    input.summary.validRowCount,
    input.summary.warningRowCount,
    input.summary.errorRowCount,
    input.summary.skippedRowCount,
    issueCount,
    warningIssueCount,
    errorIssueCount,
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN changes() = 1
      AND EXISTS (
        SELECT 1 FROM import_jobs AS preview_job
        INNER JOIN fields AS current_field ON current_field.id = preview_job.field_id
        WHERE preview_job.id = ?
          AND preview_job.organization_id = ?
          AND preview_job.field_id = ?
          AND preview_job.status = 'preview_ready'
          AND preview_job.started_at = ?
          AND preview_job.failure_message IS NULL
          AND preview_job.previewed_at = ?
          AND preview_job.updated_at = ?
          AND preview_job.row_count = ?
          AND preview_job.valid_row_count = ?
          AND preview_job.warning_row_count = ?
          AND preview_job.error_row_count = ?
          AND preview_job.skipped_row_count = ?
          AND preview_job.file_issue_count = ?
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = preview_job.id) = ?
          AND (SELECT COUNT(*) FROM import_errors WHERE import_job_id = preview_job.id) = ?
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.parsingStartedAt,
    now,
    now,
    input.summary.rowCount,
    input.summary.validRowCount,
    input.summary.warningRowCount,
    input.summary.errorRowCount,
    input.summary.skippedRowCount,
    input.summary.fileIssueCount,
    input.organizationId,
    fieldIds,
    input.summary.rowCount,
    issueCount,
  ));
  if (statements.length > PREVIEW_BATCH_STATEMENT_LIMIT) throw new ImportPreviewLimitError();
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const assertion = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (assertion?.complete !== 1) throw new ImportJobScopeError();
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) throw cause;
    if (isImportLifecycleConflict(cause)) throw new ImportJobScopeError();
    throw cause;
  }
}

async function readImportPreview(
  id: string,
  access: ImportFieldAccess,
  reused = false,
): Promise<CooprinsemImportPreview | null> {
  if (access.fieldIds.length === 0) return null;
  const scope = importReadScope(access);
  const [job] = await getDb()
    .select({
      id: importJobs.id,
      fieldId: importJobs.fieldId,
      fieldName: fields.name,
      sourceTable: importJobs.sourceTable,
      originalFilename: importJobs.originalFilename,
      sha256: importJobs.sha256,
      mappingVersion: importJobs.mappingVersion,
      effectiveAt: importJobs.effectiveAt,
      status: importJobs.status,
      rowCount: importJobs.rowCount,
      validRowCount: importJobs.validRowCount,
      warningRowCount: importJobs.warningRowCount,
      errorRowCount: importJobs.errorRowCount,
      skippedRowCount: importJobs.skippedRowCount,
      fileIssueCount: importJobs.fileIssueCount,
      createdAt: importJobs.createdAt,
    })
    .from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(eq(importJobs.id, id), scope))
    .limit(1);
  if (!job) return null;

  const rows = await getDb()
    .select({
      id: importRows.id,
      recordNumber: importRows.recordNumber,
      rawRecord: importRows.rawRecord,
      normalizedRecord: importRows.normalizedRecord,
      status: importRows.status,
    })
    .from(importRows)
    .innerJoin(importJobs, eq(importJobs.id, importRows.importJobId))
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(eq(importRows.importJobId, id), scope))
    .orderBy(asc(importRows.recordNumber))
    .limit(PREVIEW_ROW_LIMIT);
  const rowIds = rows.map((row) => row.id);
  const issues = rowIds.length > 0
    ? await getDb()
      .select({
        id: importErrors.id,
        importRowId: importErrors.importRowId,
        fieldName: importErrors.fieldName,
        ruleCode: importErrors.ruleCode,
        severity: importErrors.severity,
        message: importErrors.message,
        sourceValue: importErrors.sourceValue,
        status: importErrors.status,
        resolutionNotes: importErrors.resolutionNotes,
        resolvedBy: importErrors.resolvedBy,
        resolvedAt: importErrors.resolvedAt,
        createdAt: importErrors.createdAt,
      })
      .from(importErrors)
      .innerJoin(importRows, and(
        eq(importRows.id, importErrors.importRowId),
        eq(importRows.importJobId, importErrors.importJobId),
      ))
      .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId))
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .where(and(
        eq(importErrors.importJobId, id),
        inArray(importErrors.importRowId, rowIds),
        scope,
      ))
      .orderBy(asc(importErrors.createdAt))
    : [];
  const issuesByRow = new Map<string, CooprinsemImportIssue[]>();
  for (const entry of issues) {
    const current = issuesByRow.get(entry.importRowId) ?? [];
    current.push({
      id: entry.id,
      fieldName: entry.fieldName,
      ruleCode: entry.ruleCode,
      severity: entry.severity,
      message: entry.message,
      sourceValue: entry.sourceValue,
      status: entry.status,
      resolutionNotes: entry.resolutionNotes,
      resolvedBy: entry.resolvedBy,
      resolvedAt: entry.resolvedAt,
    });
    issuesByRow.set(entry.importRowId, current);
  }

  return {
    id: job.id,
    fieldId: job.fieldId,
    fieldName: job.fieldName,
    sourceTable: job.sourceTable as CooprinsemSourceTable,
    originalFilename: job.originalFilename,
    sha256: job.sha256,
    mappingVersion: job.mappingVersion,
    effectiveAt: job.effectiveAt,
    status: job.status,
    createdAt: job.createdAt,
    reused,
    summary: {
      rowCount: job.rowCount,
      validRowCount: job.validRowCount,
      warningRowCount: job.warningRowCount,
      errorRowCount: job.errorRowCount,
      skippedRowCount: job.skippedRowCount,
      fileIssueCount: job.fileIssueCount,
    },
    rows: rows.map((row) => ({
      id: row.id,
      recordNumber: row.recordNumber,
      rawRecord: row.rawRecord,
      normalizedRecord: row.normalizedRecord,
      status: row.status,
      issues: issuesByRow.get(row.id) ?? [],
    })),
  };
}

export async function getImportPreview(
  id: string,
  access: ImportActorAccess,
  reused = false,
): Promise<CooprinsemImportPreview | null> {
  const preview = await readImportPreview(id, access, reused);
  if (preview) await assertCurrentImportActorAccess(access, [preview.fieldId]);
  return preview;
}

export async function getImportPreviewForUpload(
  id: string,
  access: ImportFieldAccess,
  reused = false,
): Promise<CooprinsemImportPreview | null> {
  return readImportPreview(id, access, reused);
}

async function readImportDashboard(access: ImportFieldAccess): Promise<CooprinsemImportDashboard> {
  if (access.fieldIds.length === 0) {
    return { imports: [], issues: [], totals: { importCount: 0, rowCount: 0, openIssueCount: 0, resolvedIssueCount: 0, ignoredIssueCount: 0 } };
  }
  const scope = and(importReadScope(access), eq(fields.isDemo, false));
  const jobs = await getDb()
    .select({
      id: importJobs.id,
      fieldId: importJobs.fieldId,
      fieldName: fields.name,
      sourceTable: importJobs.sourceTable,
      originalFilename: importJobs.originalFilename,
      status: importJobs.status,
      effectiveAt: importJobs.effectiveAt,
      createdAt: importJobs.createdAt,
      previewedAt: importJobs.previewedAt,
      confirmedAt: importJobs.confirmedAt,
      failureMessage: importJobs.failureMessage,
      openIssueCount: sql<number>`(
        SELECT COUNT(*)
        FROM import_errors
        INNER JOIN import_rows
          ON import_rows.id = import_errors.import_row_id
         AND import_rows.import_job_id = import_errors.import_job_id
        WHERE import_errors.import_job_id = ${importJobs.id}
          AND import_errors.status = 'open'
      )`,
      importedRowCount: sql<number>`(
        SELECT COUNT(*) FROM import_rows
        WHERE import_rows.import_job_id = ${importJobs.id}
          AND import_rows.status = 'imported'
      )`,
      rowCount: importJobs.rowCount,
      validRowCount: importJobs.validRowCount,
      warningRowCount: importJobs.warningRowCount,
      errorRowCount: importJobs.errorRowCount,
      skippedRowCount: importJobs.skippedRowCount,
      fileIssueCount: importJobs.fileIssueCount,
    })
    .from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(scope)
    .orderBy(desc(importJobs.createdAt))
    .limit(30);

  const issueRows = await getDb()
    .select({
      id: importErrors.id,
      importJobId: importErrors.importJobId,
      importRowId: importErrors.importRowId,
      recordNumber: importRows.recordNumber,
      fieldId: importJobs.fieldId,
      fieldName: fields.name,
      sourceTable: importJobs.sourceTable,
      originalFilename: importJobs.originalFilename,
      rawRecord: importRows.rawRecord,
      fieldNameSource: importErrors.fieldName,
      ruleCode: importErrors.ruleCode,
      severity: importErrors.severity,
      message: importErrors.message,
      sourceValue: importErrors.sourceValue,
      status: importErrors.status,
      resolutionNotes: importErrors.resolutionNotes,
      resolvedBy: importErrors.resolvedBy,
      resolvedAt: importErrors.resolvedAt,
      createdAt: importErrors.createdAt,
    })
    .from(importErrors)
    .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId))
    .innerJoin(importRows, and(
      eq(importRows.id, importErrors.importRowId),
      eq(importRows.importJobId, importErrors.importJobId),
    ))
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(scope)
    .orderBy(desc(importErrors.createdAt))
    .limit(300);

  const [jobTotals] = await getDb()
    .select({ importCount: count(importJobs.id), rowCount: sum(importJobs.rowCount) })
    .from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(scope);
  const issueTotals = await getDb()
    .select({ status: importErrors.status, value: count(importErrors.id) })
    .from(importErrors)
    .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId))
    .innerJoin(importRows, and(
      eq(importRows.id, importErrors.importRowId),
      eq(importRows.importJobId, importErrors.importJobId),
    ))
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(scope)
    .groupBy(importErrors.status);
  const issuesByStatus = new Map(issueTotals.map((entry) => [entry.status, entry.value]));

  return {
    imports: jobs.map((job) => ({
      id: job.id,
      fieldId: job.fieldId,
      fieldName: job.fieldName,
      sourceTable: job.sourceTable as CooprinsemSourceTable,
      originalFilename: job.originalFilename,
      status: job.status,
      effectiveAt: job.effectiveAt,
      createdAt: job.createdAt,
      previewedAt: job.previewedAt,
      confirmedAt: job.confirmedAt,
      failureMessage: job.failureMessage,
      openIssueCount: Number(job.openIssueCount),
      importedRowCount: Number(job.importedRowCount),
      summary: {
        rowCount: job.rowCount,
        validRowCount: job.validRowCount,
        warningRowCount: job.warningRowCount,
        errorRowCount: job.errorRowCount,
        skippedRowCount: job.skippedRowCount,
        fileIssueCount: job.fileIssueCount,
      },
    })),
    issues: issueRows.map(toIssueItem),
    totals: {
      importCount: jobTotals?.importCount ?? 0,
      rowCount: Number(jobTotals?.rowCount ?? 0),
      openIssueCount: issuesByStatus.get("open") ?? 0,
      resolvedIssueCount: issuesByStatus.get("resolved") ?? 0,
      ignoredIssueCount: issuesByStatus.get("ignored") ?? 0,
    },
  };
}

export async function getImportDashboard(access: ImportActorAccess): Promise<CooprinsemImportDashboard> {
  const dashboard = await readImportDashboard(access);
  await assertCurrentImportActorAccess(access, [
    ...dashboard.imports.map((entry) => entry.fieldId),
    ...dashboard.issues.map((entry) => entry.fieldId),
  ]);
  return dashboard;
}

export async function setImportIssueResolution(input: {
  id: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  email: string;
  status: CooprinsemImportErrorStatus;
  resolutionNotes: string | null;
}): Promise<boolean> {
  if (input.fieldIds.length === 0) return false;
  const [current] = await getDb()
    .select({
      id: importErrors.id,
      importJobId: importErrors.importJobId,
      importRowId: importErrors.importRowId,
      organizationId: importJobs.organizationId,
      fieldId: importJobs.fieldId,
      fieldName: importErrors.fieldName,
      ruleCode: importErrors.ruleCode,
      severity: importErrors.severity,
      message: importErrors.message,
      sourceValue: importErrors.sourceValue,
      status: importErrors.status,
      resolutionNotes: importErrors.resolutionNotes,
      resolvedBy: importErrors.resolvedBy,
      resolvedAt: importErrors.resolvedAt,
      createdAt: importErrors.createdAt,
      updatedAt: importErrors.updatedAt,
    })
    .from(importErrors)
    .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId))
    .innerJoin(importRows, and(eq(importRows.id, importErrors.importRowId), eq(importRows.importJobId, importJobs.id)))
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(
      eq(importErrors.id, input.id),
      eq(importJobs.organizationId, input.organizationId),
      eq(fields.organizationId, input.organizationId),
      inArray(fields.id, input.fieldIds),
    ))
    .limit(1);
  if (!current) return false;

  const now = new Date().toISOString();
  const resolution = input.status === "open"
    ? { resolutionNotes: null, resolvedAt: null, resolvedBy: null }
    : { resolutionNotes: input.resolutionNotes, resolvedAt: now, resolvedBy: input.email };
  const before = {
    status: current.status,
    resolutionNotes: current.resolutionNotes,
    resolvedBy: current.resolvedBy,
    resolvedAt: current.resolvedAt,
  };
  const after = { status: input.status, ...resolution };
  const db = getDb();
  const client = db.$client;
  const auditId = crypto.randomUUID();
  const action = `import_issue.${input.status}`;
  const sourceValue = current.sourceValue === null ? null : JSON.stringify(current.sourceValue);
  const fieldIds = JSON.stringify(input.fieldIds);
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  const guardedResolution = client.prepare(`
    UPDATE import_errors
    SET status = ?, resolution_notes = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
      AND import_job_id = ?
      AND import_row_id = ?
      AND field_name IS ?
      AND rule_code = ?
      AND severity = ?
      AND message = ?
      AND source_value IS ?
      AND status = ?
      AND resolution_notes IS ?
      AND resolved_by IS ?
      AND resolved_at IS ?
      AND created_at = ?
      AND updated_at = ?
      AND EXISTS (
        SELECT 1
        FROM import_jobs AS current_job
        INNER JOIN fields AS current_field ON current_field.id = current_job.field_id
        INNER JOIN import_rows AS current_row
          ON current_row.id = import_errors.import_row_id
         AND current_row.import_job_id = current_job.id
        WHERE current_job.id = import_errors.import_job_id
          AND current_job.id = ?
          AND current_job.organization_id = ?
          AND current_job.field_id = ?
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND current_field.is_demo = 0
          AND EXISTS (
            SELECT 1 FROM organization_memberships AS current_actor
            WHERE current_actor.id = ?
              AND current_actor.organization_id = current_field.organization_id
              AND current_actor.normalized_email = lower(trim(?))
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
          )
      )
  `).bind(
    input.status,
    resolution.resolutionNotes,
    resolution.resolvedBy,
    resolution.resolvedAt,
    now,
    current.id,
    current.importJobId,
    current.importRowId,
    current.fieldName,
    current.ruleCode,
    current.severity,
    current.message,
    sourceValue,
    current.status,
    current.resolutionNotes,
    current.resolvedBy,
    current.resolvedAt,
    current.createdAt,
    current.updatedAt,
    current.importJobId,
    input.organizationId,
    current.fieldId,
    input.organizationId,
    fieldIds,
    input.membershipId,
    input.email,
    DEMO_EMAIL,
  );
  const insertAudit = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, 'import_error', ?, ?, ?, NULL, ?
    WHERE changes() = 1
      AND NOT EXISTS (SELECT 1 FROM audit_log AS existing_audit WHERE existing_audit.id = ?)
      AND EXISTS (
        SELECT 1
        FROM import_errors AS saved_issue
        INNER JOIN import_jobs AS saved_job ON saved_job.id = saved_issue.import_job_id
        INNER JOIN import_rows AS saved_row
          ON saved_row.id = saved_issue.import_row_id
         AND saved_row.import_job_id = saved_job.id
        INNER JOIN fields AS saved_field ON saved_field.id = saved_job.field_id
        WHERE saved_issue.id = ?
          AND saved_issue.import_job_id = ?
          AND saved_issue.import_row_id = ?
          AND saved_issue.field_name IS ?
          AND saved_issue.rule_code = ?
          AND saved_issue.severity = ?
          AND saved_issue.message = ?
          AND saved_issue.source_value IS ?
          AND saved_issue.status = ?
          AND saved_issue.resolution_notes IS ?
          AND saved_issue.resolved_by IS ?
          AND saved_issue.resolved_at IS ?
          AND saved_issue.created_at = ?
          AND saved_issue.updated_at = ?
          AND saved_job.organization_id = ?
          AND saved_job.field_id = ?
          AND saved_field.organization_id = ?
          AND saved_field.id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    auditId,
    input.organizationId,
    current.fieldId,
    input.email,
    action,
    current.id,
    beforeJson,
    afterJson,
    now,
    auditId,
    current.id,
    current.importJobId,
    current.importRowId,
    current.fieldName,
    current.ruleCode,
    current.severity,
    current.message,
    sourceValue,
    input.status,
    resolution.resolutionNotes,
    resolution.resolvedBy,
    resolution.resolvedAt,
    current.createdAt,
    now,
    input.organizationId,
    current.fieldId,
    input.organizationId,
    fieldIds,
  );
  const assertComplete = client.prepare(`
    SELECT CASE WHEN changes() = 1
      AND EXISTS (
        SELECT 1
        FROM import_errors AS saved_issue
        INNER JOIN import_jobs AS saved_job ON saved_job.id = saved_issue.import_job_id
        INNER JOIN import_rows AS saved_row
          ON saved_row.id = saved_issue.import_row_id
         AND saved_row.import_job_id = saved_job.id
        INNER JOIN fields AS saved_field ON saved_field.id = saved_job.field_id
        WHERE saved_issue.id = ?
          AND saved_issue.import_job_id = ?
          AND saved_issue.import_row_id = ?
          AND saved_issue.field_name IS ?
          AND saved_issue.rule_code = ?
          AND saved_issue.severity = ?
          AND saved_issue.message = ?
          AND saved_issue.source_value IS ?
          AND saved_issue.status = ?
          AND saved_issue.resolution_notes IS ?
          AND saved_issue.resolved_by IS ?
          AND saved_issue.resolved_at IS ?
          AND saved_issue.created_at = ?
          AND saved_issue.updated_at = ?
          AND saved_job.organization_id = ?
          AND saved_job.field_id = ?
          AND saved_field.organization_id = ?
          AND saved_field.id IN (SELECT value FROM json_each(?))
      )
      AND EXISTS (
        SELECT 1 FROM audit_log AS saved_audit
        WHERE saved_audit.id = ?
          AND saved_audit.organization_id = ?
          AND saved_audit.field_id = ?
          AND saved_audit.actor = ?
          AND saved_audit.action = ?
          AND saved_audit.entity_type = 'import_error'
          AND saved_audit.entity_id = ?
          AND saved_audit.before = ?
          AND saved_audit.after = ?
          AND saved_audit.source_record_id IS NULL
          AND saved_audit.occurred_at = ?
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    current.id,
    current.importJobId,
    current.importRowId,
    current.fieldName,
    current.ruleCode,
    current.severity,
    current.message,
    sourceValue,
    input.status,
    resolution.resolutionNotes,
    resolution.resolvedBy,
    resolution.resolvedAt,
    current.createdAt,
    now,
    input.organizationId,
    current.fieldId,
    input.organizationId,
    fieldIds,
    auditId,
    input.organizationId,
    current.fieldId,
    input.email,
    action,
    current.id,
    beforeJson,
    afterJson,
    now,
  );
  try {
    const results = await client.batch([guardedResolution, insertAudit, assertComplete]);
    if ((results[2].results[0] as { complete?: number } | undefined)?.complete !== 1) {
      throw new ImportAccessChangedError();
    }
    return true;
  } catch (cause) {
    if (cause instanceof Error && /integer overflow/i.test(cause.message)) throw new ImportAccessChangedError();
    throw cause;
  }
}

function toIssueItem(row: {
  id: string;
  importJobId: string;
  importRowId: string;
  recordNumber: number;
  fieldId: string;
  fieldName: string;
  sourceTable: string;
  originalFilename: string;
  rawRecord: ImportRecord;
  fieldNameSource: string | null;
  ruleCode: string;
  severity: "warning" | "error";
  message: string;
  sourceValue: unknown;
  status: CooprinsemImportErrorStatus;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}): CooprinsemImportIssueItem {
  return {
    ...row,
    sourceTable: row.sourceTable as CooprinsemSourceTable,
  };
}

function isImportLifecycleConflict(cause: unknown): boolean {
  return cause instanceof Error
    && /(?:UNIQUE constraint failed|FOREIGN KEY constraint failed|integer overflow)/i.test(cause.message);
}

function importReadScope(access: ImportFieldAccess) {
  return and(
    eq(importJobs.sourceSystem, "cooprinsem"),
    eq(importJobs.organizationId, access.organizationId),
    eq(fields.organizationId, access.organizationId),
    inArray(importJobs.fieldId, access.fieldIds),
    inArray(fields.id, access.fieldIds),
  );
}

function normalizedIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function importRowId(importJobId: string, recordNumber: number): string {
  return `${importJobId}:row:${recordNumber}`;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
