import { getDb } from "@/db";
import type { CooprinsemRetentionDashboard } from "../domain/types";
import type { ImportFieldAccess } from "./import-repository";
import { simulateOriginalRetention } from "./retention-policy.mjs";
import {
  currentCooprinsemActorFieldGuard,
  hasCurrentCooprinsemActorFieldAccess,
  normalizeCooprinsemActorFieldAccess,
  type CooprinsemActorFieldAccess,
} from "./current-actor-access";

type RetentionRow = {
  fieldId: string;
  fieldName: string;
  organizationId: string;
  originalCount: number;
  totalSizeBytes: number | null;
  openIntegrityIncidentCount: number;
  oldestImportedAt: string | null;
  newestImportedAt: string | null;
};

export async function getOriginalRetentionDashboard(
  input: ImportFieldAccess & CooprinsemActorFieldAccess & { fieldId: string },
): Promise<CooprinsemRetentionDashboard | null> {
  const access = normalizeCooprinsemActorFieldAccess(input);
  if (!access?.fieldIds.includes(input.fieldId)) return null;
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", access);
  const row = await getDb().$client.prepare(`
    SELECT current_field.id AS fieldId,
           current_field.name AS fieldName,
           current_field.organization_id AS organizationId,
           (
             SELECT COUNT(*)
             FROM import_jobs AS current_job
             WHERE current_job.field_id = current_field.id
               AND current_job.organization_id = current_field.organization_id
           ) AS originalCount,
           (
             SELECT SUM(current_job.file_size_bytes)
             FROM import_jobs AS current_job
             WHERE current_job.field_id = current_field.id
               AND current_job.organization_id = current_field.organization_id
           ) AS totalSizeBytes,
           (
             SELECT MIN(current_job.created_at)
             FROM import_jobs AS current_job
             WHERE current_job.field_id = current_field.id
               AND current_job.organization_id = current_field.organization_id
           ) AS oldestImportedAt,
           (
             SELECT MAX(current_job.created_at)
             FROM import_jobs AS current_job
             WHERE current_job.field_id = current_field.id
               AND current_job.organization_id = current_field.organization_id
           ) AS newestImportedAt,
           (
             SELECT COUNT(*)
             FROM original_integrity_incidents AS current_incident
             INNER JOIN import_jobs AS incident_job
               ON incident_job.id = current_incident.import_job_id
              AND incident_job.organization_id = current_incident.organization_id
              AND incident_job.field_id = current_incident.field_id
             WHERE current_incident.organization_id = current_field.organization_id
               AND current_incident.field_id = current_field.id
               AND current_incident.status = 'open'
           ) AS openIntegrityIncidentCount
    FROM fields AS current_field
    WHERE current_field.id = ?
      AND ${actorGuard.sql}
  `).bind(input.fieldId, ...actorGuard.bindings).first<RetentionRow>();
  if (!row) return null;
  if (!await hasCurrentCooprinsemActorFieldAccess(input.fieldId, access)) return null;

  return simulateOriginalRetention({
    fieldId: row.fieldId,
    fieldName: row.fieldName,
    organizationId: row.organizationId,
    evaluatedAt: new Date().toISOString(),
    originalCount: row.originalCount,
    totalSizeBytes: Number(row.totalSizeBytes ?? 0),
    openIntegrityIncidentCount: row.openIntegrityIncidentCount,
    oldestImportedAt: row.oldestImportedAt,
    newestImportedAt: row.newestImportedAt,
  });
}
