import { getDb } from "@/db";
import { fields, importJobs } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type { CooprinsemOriginalDeepVerification, CooprinsemOriginalIntegrityDashboard } from "../domain/types";
import { sha256Hex } from "./backup-format.mjs";
import { headImportFile, readImportFile } from "./file-storage";
import type { ImportFieldAccess } from "./import-repository";
import { assessDeepOriginalIntegrity, assessOriginalIntegrity } from "./original-integrity.mjs";
import {
  currentCooprinsemActorFieldGuard,
  hasCurrentCooprinsemActorFieldAccess,
  normalizeCooprinsemActorFieldAccess,
  type NormalizedCooprinsemActorFieldAccess,
} from "./current-actor-access";

const MAX_SCAN_FILES = 100;
const SCAN_CONCURRENCY = 10;
const MAX_DEEP_VERIFY_BYTES = 20 * 1024 * 1024;

export class OriginalDeepVerificationLimitError extends Error {}

export class OriginalIntegrityScopeError extends Error {
  readonly code = "ORIGINAL_INTEGRITY_SCOPE_CHANGED";

  constructor() {
    super("El alcance cambió durante la verificación; vuelve a iniciarla.");
    this.name = "OriginalIntegrityScopeError";
  }
}

type OriginalCandidate = {
  importJobId: string;
  originalFilename: string;
  sourceTable: string;
  fileSizeBytes: number;
  sha256: string;
  objectKey: string;
  organizationId: string;
  fieldId: string;
  createdAt: string;
};

export async function verifyImportOriginals(input: {
  fieldId: string;
  actor: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
}): Promise<CooprinsemOriginalIntegrityDashboard | null> {
  const access = normalizeAccess(input);
  if (!access?.fieldIds.includes(input.fieldId)) return null;
  if (!await hasCurrentCooprinsemActorFieldAccess(input.fieldId, access)) return null;
  const [scope] = await getDb()
    .select({ fieldId: fields.id, fieldName: fields.name, organizationId: fields.organizationId })
    .from(fields)
    .where(and(
      eq(fields.id, input.fieldId),
      eq(fields.organizationId, access.organizationId),
      sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
    ))
    .limit(1);
  if (!scope) return null;

  const candidates: OriginalCandidate[] = await getDb()
    .select({
      importJobId: importJobs.id,
      originalFilename: importJobs.originalFilename,
      sourceTable: importJobs.sourceTable,
      fileSizeBytes: importJobs.fileSizeBytes,
      sha256: importJobs.sha256,
      objectKey: importJobs.objectKey,
      organizationId: importJobs.organizationId,
      fieldId: importJobs.fieldId,
      createdAt: importJobs.createdAt,
    })
    .from(importJobs)
    .where(and(
      eq(importJobs.fieldId, input.fieldId),
      eq(importJobs.organizationId, access.organizationId),
      sql`EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ${importJobs.fieldId}
          AND current_field.organization_id = ${importJobs.organizationId}
          AND current_field.organization_id = ${access.organizationId}
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))
      )`,
    ))
    .orderBy(asc(importJobs.createdAt), asc(importJobs.id))
    .limit(MAX_SCAN_FILES + 1);
  const truncated = candidates.length > MAX_SCAN_FILES;
  const selected = candidates.slice(0, MAX_SCAN_FILES);
  const items: CooprinsemOriginalIntegrityDashboard["items"] = [];
  for (let index = 0; index < selected.length; index += SCAN_CONCURRENCY) {
    const chunk = selected.slice(index, index + SCAN_CONCURRENCY);
    items.push(...await Promise.all(chunk.map(async (candidate) => {
      const stored = await headImportFile(candidate.objectKey);
      const assessment = assessOriginalIntegrity(candidate, stored ? {
        size: stored.size,
        customMetadata: stored.customMetadata,
      } : null);
      return {
        importJobId: candidate.importJobId,
        originalFilename: candidate.originalFilename,
        sourceTable: candidate.sourceTable,
        expectedSizeBytes: candidate.fileSizeBytes,
        storedSizeBytes: stored?.size ?? null,
        sha256: candidate.sha256,
        status: assessment.status,
        issues: assessment.issues,
        importedAt: candidate.createdAt,
        storedAt: stored?.uploaded?.toISOString() ?? null,
      };
    })));
  }
  const totals = {
    checkedCount: items.length,
    healthyCount: items.filter((item) => item.status === "healthy").length,
    missingCount: items.filter((item) => item.status === "missing").length,
    mismatchCount: items.filter((item) => !["healthy", "missing"].includes(item.status)).length,
  };
  const checkedAt = new Date().toISOString();
  const audited = await recordInventoryAudit({
    access,
    actor: input.actor,
    candidates,
    checkedAt,
    fieldId: scope.fieldId,
    fieldName: scope.fieldName,
    totals,
    truncated,
  });
  if (!audited) throw new OriginalIntegrityScopeError();
  return { ...scope, checkedAt, truncated, limit: MAX_SCAN_FILES, totals, items };
}

export async function deepVerifyImportOriginal(input: {
  importJobId: string;
  actor: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
}): Promise<CooprinsemOriginalDeepVerification | null> {
  const access = normalizeAccess(input);
  if (!access) return null;
  const [reference] = await getDb()
    .select({
      importJobId: importJobs.id,
      originalFilename: importJobs.originalFilename,
      sourceTable: importJobs.sourceTable,
      fileSizeBytes: importJobs.fileSizeBytes,
      sha256: importJobs.sha256,
      objectKey: importJobs.objectKey,
      organizationId: importJobs.organizationId,
      fieldId: importJobs.fieldId,
      createdAt: importJobs.createdAt,
      updatedAt: importJobs.updatedAt,
    })
    .from(importJobs)
    .innerJoin(fields, and(
      eq(fields.id, importJobs.fieldId),
      eq(fields.organizationId, importJobs.organizationId),
    ))
    .where(and(
      eq(importJobs.id, input.importJobId),
      eq(importJobs.organizationId, access.organizationId),
      sql`${importJobs.fieldId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
    ))
    .limit(1);
  if (!reference) return null;
  if (!await hasCurrentCooprinsemActorFieldAccess(reference.fieldId, access)) return null;
  if (reference.fileSizeBytes > MAX_DEEP_VERIFY_BYTES) {
    throw new OriginalDeepVerificationLimitError("El original supera el límite de 20 MB para verificación síncrona.");
  }

  const object = await readImportFile(reference.objectKey);
  let calculatedSha256: string | null = null;
  if (object && object.size === reference.fileSizeBytes) {
    calculatedSha256 = await sha256Hex(await object.arrayBuffer());
  }
  const assessment = assessDeepOriginalIntegrity(reference, object ? {
    size: object.size,
    customMetadata: object.customMetadata,
  } : null, calculatedSha256);
  const checkedAt = new Date().toISOString();
  const result: CooprinsemOriginalDeepVerification = {
    importJobId: reference.importJobId,
    fieldId: reference.fieldId,
    originalFilename: reference.originalFilename,
    checkedAt,
    status: assessment.status,
    expectedSizeBytes: reference.fileSizeBytes,
    storedSizeBytes: object?.size ?? null,
    expectedSha256: reference.sha256,
    calculatedSha256,
    issues: assessment.issues,
  };
  const audited = await recordDeepVerificationAudit({
    access,
    actor: input.actor,
    checkedAt,
    reference,
    after: {
      status: result.status,
      expectedSizeBytes: result.expectedSizeBytes,
      storedSizeBytes: result.storedSizeBytes,
      expectedSha256: result.expectedSha256,
      calculatedSha256: result.calculatedSha256,
    },
  });
  if (!audited) throw new OriginalIntegrityScopeError();
  return result;
}

async function recordInventoryAudit(input: {
  access: NormalizedCooprinsemActorFieldAccess;
  actor: string;
  candidates: OriginalCandidate[];
  checkedAt: string;
  fieldId: string;
  fieldName: string;
  totals: CooprinsemOriginalIntegrityDashboard["totals"];
  truncated: boolean;
}): Promise<boolean> {
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", input.access);
  const result = await getDb().$client.prepare(`
    WITH current_scope AS (
      SELECT current_field.id AS field_id,
             current_field.name AS field_name,
             current_field.organization_id AS organization_id
      FROM fields AS current_field
      WHERE current_field.id = ?
        AND current_field.name = ?
        AND ${actorGuard.sql}
    ), current_candidates AS (
      SELECT current_job.id AS import_job_id,
             current_job.original_filename AS original_filename,
             current_job.source_table AS source_table,
             current_job.file_size_bytes AS file_size_bytes,
             current_job.sha256 AS sha256,
             current_job.object_key AS object_key,
             current_job.organization_id AS organization_id,
             current_job.field_id AS field_id,
             current_job.created_at AS created_at
      FROM import_jobs AS current_job
      INNER JOIN current_scope
        ON current_scope.field_id = current_job.field_id
       AND current_scope.organization_id = current_job.organization_id
      ORDER BY current_job.created_at, current_job.id
      LIMIT ${MAX_SCAN_FILES + 1}
    ), current_snapshot AS (
      SELECT json_group_array(json_object(
        'importJobId', import_job_id,
        'originalFilename', original_filename,
        'sourceTable', source_table,
        'fileSizeBytes', file_size_bytes,
        'sha256', sha256,
        'objectKey', object_key,
        'organizationId', organization_id,
        'fieldId', field_id,
        'createdAt', created_at
      )) AS value
      FROM current_candidates
    )
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, current_scope.organization_id, current_scope.field_id, ?,
      'import.originals.verified', 'field', current_scope.field_id,
      NULL, ?, NULL, ?
    FROM current_scope, current_snapshot
    WHERE json(current_snapshot.value) = json(?)
  `).bind(
    input.fieldId,
    input.fieldName,
    ...actorGuard.bindings,
    crypto.randomUUID(),
    input.actor,
    JSON.stringify({ totals: input.totals, truncated: input.truncated, limit: MAX_SCAN_FILES }),
    input.checkedAt,
    JSON.stringify(input.candidates),
  ).run();
  return Number(result.meta.changes) === 1;
}

async function recordDeepVerificationAudit(input: {
  access: NormalizedCooprinsemActorFieldAccess;
  actor: string;
  after: Record<string, unknown>;
  checkedAt: string;
  reference: OriginalCandidate & { updatedAt: string };
}): Promise<boolean> {
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", input.access);
  const result = await getDb().$client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, current_job.organization_id, current_job.field_id, ?,
      'import.original.deep_verified', 'import_job', current_job.id,
      NULL, ?, NULL, ?
    FROM import_jobs AS current_job
    INNER JOIN fields AS current_field
      ON current_field.id = current_job.field_id
     AND current_field.organization_id = current_job.organization_id
    WHERE current_job.id = ?
      AND current_job.organization_id = ?
      AND current_job.field_id = ?
      AND current_job.original_filename = ?
      AND current_job.source_table = ?
      AND current_job.file_size_bytes = ?
      AND current_job.sha256 = ?
      AND current_job.object_key = ?
      AND current_job.created_at = ?
      AND current_job.updated_at = ?
      AND ${actorGuard.sql}
  `).bind(
    crypto.randomUUID(),
    input.actor,
    JSON.stringify(input.after),
    input.checkedAt,
    input.reference.importJobId,
    input.access.organizationId,
    input.reference.fieldId,
    input.reference.originalFilename,
    input.reference.sourceTable,
    input.reference.fileSizeBytes,
    input.reference.sha256,
    input.reference.objectKey,
    input.reference.createdAt,
    input.reference.updatedAt,
    ...actorGuard.bindings,
  ).run();
  return Number(result.meta.changes) === 1;
}

function normalizeAccess(
  input: ImportFieldAccess & { actor: string; membershipId: string },
): NormalizedCooprinsemActorFieldAccess | null {
  return normalizeCooprinsemActorFieldAccess({
    actorEmail: input.actor,
    fieldIds: input.fieldIds,
    membershipId: input.membershipId,
    organizationId: input.organizationId,
  });
}
