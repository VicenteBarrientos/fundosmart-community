import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import type { AgronomicAgendaSignal } from "./today-agenda.mjs";

type SignalRow = {
  id: string;
  fieldId: string;
  importJobId: string;
  paddockId: string;
  paddockName: string;
  externalPaddockKey: string;
  visitDate: string;
  actionHeading: string;
  recommendationText: string;
};

export async function listAgronomicAgendaSignals(
  actor: AccessContext,
): Promise<AgronomicAgendaSignal[]> {
  const fieldIds = [...new Set(actor.fieldIds)].sort();
  if (fieldIds.length === 0) return [];
  const placeholders = fieldIds.map(() => "?").join(", ");
  const result = await getDb().$client.prepare(`
    SELECT
      recommendation.id,
      recommendation.field_id AS fieldId,
      recommendation.import_job_id AS importJobId,
      recommendation.paddock_id AS paddockId,
      paddock.name AS paddockName,
      recommendation.external_paddock_key AS externalPaddockKey,
      recommendation.visit_date AS visitDate,
      recommendation.action_heading AS actionHeading,
      recommendation.recommendation_text AS recommendationText
    FROM field_visit_recommendations AS recommendation
    INNER JOIN field_visits AS visit
      ON visit.organization_id = recommendation.organization_id
     AND visit.field_id = recommendation.field_id
     AND visit.id = recommendation.visit_id
     AND visit.profile_key = 'agronomic.visit_report.pdf.v1'
    INNER JOIN import_jobs AS import_job
      ON import_job.organization_id = recommendation.organization_id
     AND import_job.field_id = recommendation.field_id
     AND import_job.id = recommendation.import_job_id
     AND import_job.status IN ('completed', 'completed_with_errors')
     AND import_job.confirmed_at IS NOT NULL
    INNER JOIN fields AS scoped_field
      ON scoped_field.organization_id = recommendation.organization_id
     AND scoped_field.id = recommendation.field_id
     AND scoped_field.is_demo = 0
    INNER JOIN potreros AS paddock
      ON paddock.field_id = recommendation.field_id
     AND paddock.id = recommendation.paddock_id
     AND paddock.deleted_at IS NULL
     AND paddock.archived_at IS NULL
    WHERE recommendation.organization_id = ?
      AND recommendation.field_id IN (${placeholders})
    ORDER BY recommendation.visit_date DESC, recommendation.sequence_number
    LIMIT 200
  `).bind(actor.organizationId, ...fieldIds).all<SignalRow>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    fieldId: row.fieldId,
    importJobId: row.importJobId,
    paddockId: row.paddockId,
    paddockName: row.paddockName,
    externalPaddockKey: row.externalPaddockKey,
    visitDate: row.visitDate,
    actionHeading: row.actionHeading,
    recommendationText: row.recommendationText,
  }));
}
