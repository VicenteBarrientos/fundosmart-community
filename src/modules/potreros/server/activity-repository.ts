import { getDb } from "@/db";
import { activities, fields, paddocks } from "@/db/schema";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ACTIVITY_TYPE_LABELS, type Activity, type ActivityWithLineage } from "../types";

type ActivityRow = typeof activities.$inferSelect;

const activitySummaryTypeCases = Object.keys(ACTIVITY_TYPE_LABELS)
  .map(() => "WHEN ? THEN ?")
  .join("\n");
const activitySummaryTypeBindings = Object.entries(ACTIVITY_TYPE_LABELS)
  .flatMap(([type, label]) => [type, label]);
const latestActivitySummarySql = `
  COALESCE((
    SELECT
      CASE activity.type
        ${activitySummaryTypeCases}
        ELSE ?
      END || ' · ' ||
      CASE
        WHEN activity.occurred_at = ? THEN 'hoy'
        ELSE substr(activity.occurred_at, 9, 2) || ' ' ||
          CASE substr(activity.occurred_at, 6, 2)
            WHEN '01' THEN 'ene'
            WHEN '02' THEN 'feb'
            WHEN '03' THEN 'mar'
            WHEN '04' THEN 'abr'
            WHEN '05' THEN 'may'
            WHEN '06' THEN 'jun'
            WHEN '07' THEN 'jul'
            WHEN '08' THEN 'ago'
            WHEN '09' THEN 'sept'
            WHEN '10' THEN 'oct'
            WHEN '11' THEN 'nov'
            WHEN '12' THEN 'dic'
          END || ' ' || substr(activity.occurred_at, 1, 4)
      END
    FROM activities AS activity
    WHERE activity.paddock_id = potreros.id
      AND activity.deleted_at IS NULL
    ORDER BY activity.occurred_at DESC, activity.created_at DESC
    LIMIT 1
  ), 'Sin manejos registrados')
`;
const updatePaddockSummarySql = `
  UPDATE potreros
  SET last_activity = ${latestActivitySummarySql}, updated_at = ?
  WHERE id = ? AND field_id = ? AND changes() > 0
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = potreros.field_id
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT value FROM json_each(?))
    )
`;

function activitySummaryBindings(
  today: string,
  updatedAt: string,
  paddockId: string,
  fieldId: string,
  scope: OrganizationFieldScope,
) {
  return [
    ...activitySummaryTypeBindings,
    ACTIVITY_TYPE_LABELS.other,
    today,
    updatedAt,
    paddockId,
    fieldId,
    scope.organizationId,
    JSON.stringify(scope.fieldIds),
  ];
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    potreroId: row.paddockId,
    type: row.type,
    occurredAt: row.occurredAt,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    costClp: row.costClp,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRow(activity: Activity): typeof activities.$inferInsert {
  return {
    id: activity.id,
    paddockId: activity.potreroId,
    type: activity.type,
    occurredAt: activity.occurredAt,
    description: activity.description,
    quantity: activity.quantity,
    unit: activity.unit,
    costClp: activity.costClp,
    createdAt: activity.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function sameActivityPayload(row: ActivityRow, activity: Activity): boolean {
  return row.paddockId === activity.potreroId
    && row.type === activity.type
    && row.occurredAt === activity.occurredAt
    && row.description === activity.description
    && row.quantity === activity.quantity
    && row.unit === activity.unit
    && row.costClp === activity.costClp
    && row.createdAt === activity.createdAt;
}

export async function listActivities(scope: OrganizationFieldScope, potreroId?: string): Promise<Activity[]> {
  if (scope.fieldIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ activity: activities })
    .from(activities)
    .innerJoin(paddocks, eq(paddocks.id, activities.paddockId))
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      potreroId ? eq(activities.paddockId, potreroId) : undefined,
      isNull(activities.deletedAt),
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
    ))
    .orderBy(desc(activities.occurredAt), desc(activities.createdAt));

  return rows.map(({ activity }) => toActivity(activity));
}

export async function listActivitiesWithLineage(
  scope: OrganizationFieldScope,
  potreroId: string,
): Promise<ActivityWithLineage[]> {
  if (scope.fieldIds.length === 0) return [];
  const result = await getDb().$client.prepare(`
    WITH RECURSIVE ancestors(paddock_id, lineage_depth, path) AS (
      SELECT ?, 0, ',' || ? || ','
      UNION ALL
      SELECT edge.parent_paddock_id, ancestors.lineage_depth + 1,
        ancestors.path || edge.parent_paddock_id || ','
      FROM ancestors
      INNER JOIN paddock_lineage_edges AS edge ON edge.child_paddock_id = ancestors.paddock_id
      WHERE ancestors.lineage_depth < 32
        AND instr(ancestors.path, ',' || edge.parent_paddock_id || ',') = 0
    ),
    candidates AS (
      SELECT
        activity.id,
        activity.paddock_id AS "potreroId",
        activity.type,
        activity.occurred_at AS "occurredAt",
        activity.description,
        activity.quantity,
        activity.unit,
        activity.cost_clp AS "costClp",
        activity.created_at AS "createdAt",
        activity.updated_at AS "updatedAt",
        source_paddock.id AS "sourcePaddockId",
        source_paddock.name AS "sourcePaddockName",
        ancestors.lineage_depth AS "lineageDepth",
        row_number() OVER (PARTITION BY activity.id ORDER BY ancestors.lineage_depth, source_paddock.id) AS row_number
      FROM ancestors
      INNER JOIN potreros AS source_paddock ON source_paddock.id = ancestors.paddock_id
      INNER JOIN fields AS source_field ON source_field.id = source_paddock.field_id
      INNER JOIN activities AS activity ON activity.paddock_id = source_paddock.id
      WHERE activity.deleted_at IS NULL
        AND source_paddock.deleted_at IS NULL
        AND source_field.organization_id = ?
        AND source_field.id IN (SELECT value FROM json_each(?))
    )
    SELECT * FROM candidates
    WHERE row_number = 1
    ORDER BY "occurredAt" DESC, "createdAt" DESC, id
  `).bind(potreroId, potreroId, scope.organizationId, JSON.stringify(scope.fieldIds)).all();
  return (result.results as Array<{
    id: string;
    potreroId: string;
    type: Activity["type"];
    occurredAt: string;
    description: string;
    quantity: number | null;
    unit: string | null;
    costClp: number | null;
    createdAt: string;
    updatedAt: string;
    sourcePaddockId: string;
    sourcePaddockName: string;
    lineageDepth: number;
  }>).map((row) => ({
    id: row.id,
    potreroId: row.potreroId,
    type: row.type,
    occurredAt: row.occurredAt,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    costClp: row.costClp,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inherited: row.lineageDepth > 0,
    sourcePaddockId: row.sourcePaddockId,
    sourcePaddockName: row.sourcePaddockName,
    lineageDepth: row.lineageDepth,
  }));
}

export async function upsertActivity(
  activity: Activity,
  scope: OrganizationFieldScope,
  actor = "system",
  auditSource: "activity" | "assistant.activity" = "activity",
): Promise<Activity> {
  const db = getDb();
  const values = toRow(activity);
  if (scope.fieldIds.length === 0) throwFieldScopeConflict("El potrero seleccionado no está disponible.");
  const [target] = await db
    .select({ fieldId: paddocks.fieldId })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(paddocks.id, activity.potreroId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
    ))
    .limit(1);
  if (!target) throwFieldScopeConflict("El potrero seleccionado no está disponible.");
  const [existing] = await db
    .select({ activity: activities, fieldId: paddocks.fieldId })
    .from(activities)
    .innerJoin(paddocks, eq(paddocks.id, activities.paddockId))
    .where(eq(activities.id, activity.id))
    .limit(1);
  if (existing) {
    await assertFieldInScope(existing.fieldId, scope, "El identificador del manejo no está disponible.");
    if (existing.activity.deletedAt) {
      throwFieldScopeConflict("El manejo fue eliminado y no puede volver a crearse con el mismo identificador.");
    }
    if (!activity.updatedAt && sameActivityPayload(existing.activity, activity)) return toActivity(existing.activity);
    if (!activity.updatedAt || activity.updatedAt !== existing.activity.updatedAt) {
      throwFieldScopeConflict("El manejo cambió desde la última carga.");
    }
  }

  const updatedAt = values.updatedAt ?? new Date().toISOString();
  const today = updatedAt.slice(0, 10);
  const client = db.$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const mutation = existing
    ? client.prepare(`
      UPDATE activities
      SET paddock_id = ?, type = ?, occurred_at = ?, description = ?,
        quantity = ?, unit = ?, cost_clp = ?, updated_at = ?
      WHERE id = ? AND paddock_id = ?
        AND type = ?
        AND occurred_at = ?
        AND description = ?
        AND quantity IS ?
        AND unit IS ?
        AND cost_clp IS ?
        AND created_at = ?
        AND updated_at = ?
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM potreros AS target_paddock
          INNER JOIN fields AS target_field ON target_field.id = target_paddock.field_id
          WHERE target_paddock.id = ?
            AND target_paddock.field_id = ?
            AND target_paddock.deleted_at IS NULL
            AND target_paddock.archived_at IS NULL
            AND target_field.organization_id = ?
            AND target_field.id IN (SELECT value FROM json_each(?))
        )
        AND EXISTS (
          SELECT 1
          FROM potreros AS source_paddock
          INNER JOIN fields AS source_field ON source_field.id = source_paddock.field_id
          WHERE source_paddock.id = ?
            AND source_paddock.field_id = ?
            AND source_paddock.deleted_at IS NULL
            AND source_paddock.archived_at IS NULL
            AND source_field.organization_id = ?
            AND source_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      values.paddockId,
      values.type,
      values.occurredAt,
      values.description,
      values.quantity,
      values.unit,
      values.costClp,
      updatedAt,
      activity.id,
      existing.activity.paddockId,
      existing.activity.type,
      existing.activity.occurredAt,
      existing.activity.description,
      existing.activity.quantity,
      existing.activity.unit,
      existing.activity.costClp,
      existing.activity.createdAt,
      existing.activity.updatedAt,
      values.paddockId,
      target.fieldId,
      scope.organizationId,
      fieldIdsJson,
      existing.activity.paddockId,
      existing.fieldId,
      scope.organizationId,
      fieldIdsJson,
    )
    : client.prepare(`
      INSERT INTO activities (
        id, paddock_id, type, occurred_at, description,
        quantity, unit, cost_clp, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM activities AS conflicting_activity WHERE conflicting_activity.id = ?)
        AND EXISTS (
          SELECT 1
          FROM potreros AS target_paddock
          INNER JOIN fields AS target_field ON target_field.id = target_paddock.field_id
          WHERE target_paddock.id = ?
            AND target_paddock.field_id = ?
            AND target_paddock.deleted_at IS NULL
            AND target_paddock.archived_at IS NULL
            AND target_field.organization_id = ?
            AND target_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      values.id,
      values.paddockId,
      values.type,
      values.occurredAt,
      values.description,
      values.quantity,
      values.unit,
      values.costClp,
      values.createdAt,
      updatedAt,
      values.id,
      values.paddockId,
      target.fieldId,
      scope.organizationId,
      fieldIdsJson,
    );
  const statements = [mutation];
  if (activity.type === "grazing") {
    statements.push(client.prepare(`
      UPDATE potreros
      SET status = 'En pastoreo', updated_at = ?
      WHERE id = ? AND field_id = ? AND changes() > 0
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM fields AS current_field
          WHERE current_field.id = potreros.field_id
            AND current_field.organization_id = ?
            AND current_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      updatedAt,
      activity.potreroId,
      target.fieldId,
      scope.organizationId,
      fieldIdsJson,
    ));
  }
  statements.push(client.prepare(updatePaddockSummarySql)
    .bind(...activitySummaryBindings(today, updatedAt, activity.potreroId, target.fieldId, scope)));
  if (existing && existing.activity.paddockId !== activity.potreroId) {
    statements.push(client.prepare(updatePaddockSummarySql)
      .bind(...activitySummaryBindings(today, updatedAt, existing.activity.paddockId, existing.fieldId, scope)));
  }
  const auditId = `activity-audit-${crypto.randomUUID()}`;
  const auditAction = `${auditSource}.${existing ? "updated" : "created"}`;
  const persistedActivity = { ...activity, updatedAt };
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, 'activity', ?, ?, ?, NULL, ?
    FROM activities AS current_activity
    INNER JOIN potreros AS current_paddock ON current_paddock.id = current_activity.paddock_id
    INNER JOIN fields AS current_field ON current_field.id = current_paddock.field_id
    WHERE current_activity.id = ?
      AND current_activity.paddock_id = ?
      AND current_activity.updated_at = ?
      AND current_activity.deleted_at IS NULL
      AND current_paddock.deleted_at IS NULL
      AND current_paddock.archived_at IS NULL
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
  `).bind(
    auditId,
    scope.organizationId,
    target.fieldId,
    actor,
    auditAction,
    activity.id,
    existing ? JSON.stringify(toActivity(existing.activity)) : null,
    JSON.stringify(persistedActivity),
    updatedAt,
    activity.id,
    activity.potreroId,
    updatedAt,
    scope.organizationId,
    fieldIdsJson,
  ));
  statements.push(client.prepare(`
    SELECT
      activity.id,
      activity.paddock_id AS "paddockId",
      activity.type,
      activity.occurred_at AS "occurredAt",
      activity.description,
      activity.quantity,
      activity.unit,
      activity.cost_clp AS "costClp",
      activity.created_at AS "createdAt",
      activity.updated_at AS "updatedAt"
    FROM activities AS activity
    INNER JOIN potreros AS current_paddock ON current_paddock.id = activity.paddock_id
    INNER JOIN fields AS current_field ON current_field.id = current_paddock.field_id
    WHERE activity.id = ?
      AND activity.paddock_id = ?
      AND activity.updated_at = ?
      AND activity.deleted_at IS NULL
      AND current_paddock.deleted_at IS NULL
      AND current_paddock.archived_at IS NULL
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
  `).bind(activity.id, activity.potreroId, updatedAt, scope.organizationId, fieldIdsJson));

  const results = await client.batch(statements);
  if (results[0].meta.changes === 0) throwFieldScopeConflict("El identificador del manejo no está disponible.");
  const savedResult = results[results.length - 1].results[0] as ActivityRow | undefined;
  if (!savedResult) throwFieldScopeConflict("El identificador del manejo no está disponible.");
  return toActivity(savedResult);
}

export async function deleteActivity(
  activityId: string,
  scope: OrganizationFieldScope,
  expectedUpdatedAt: string,
  actor = "system",
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existing] = await db
    .select({ activity: activities, fieldId: paddocks.fieldId })
    .from(activities)
    .innerJoin(paddocks, eq(paddocks.id, activities.paddockId))
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(activities.id, activityId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);

  if (!existing) return false;
  if (existing.activity.deletedAt) return true;
  if (existing.activity.updatedAt !== expectedUpdatedAt) {
    throwFieldScopeConflict("El manejo cambió desde la última carga.");
  }

  const updatedAt = new Date().toISOString();
  const today = updatedAt.slice(0, 10);
  const client = db.$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const auditId = `activity-audit-${crypto.randomUUID()}`;
  const results = await client.batch([
    client.prepare(`
      UPDATE activities
      SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND paddock_id = ?
        AND type = ?
        AND occurred_at = ?
        AND description = ?
        AND quantity IS ?
        AND unit IS ?
        AND cost_clp IS ?
        AND created_at = ?
        AND updated_at = ?
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM potreros AS current_paddock
          INNER JOIN fields AS current_field ON current_field.id = current_paddock.field_id
          WHERE current_paddock.id = ?
            AND current_paddock.field_id = ?
            AND current_field.organization_id = ?
            AND current_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      updatedAt,
      updatedAt,
      activityId,
      existing.activity.paddockId,
      existing.activity.type,
      existing.activity.occurredAt,
      existing.activity.description,
      existing.activity.quantity,
      existing.activity.unit,
      existing.activity.costClp,
      existing.activity.createdAt,
      existing.activity.updatedAt,
      existing.activity.paddockId,
      existing.fieldId,
      scope.organizationId,
      fieldIdsJson,
    ),
    client.prepare(updatePaddockSummarySql)
      .bind(...activitySummaryBindings(today, updatedAt, existing.activity.paddockId, existing.fieldId, scope)),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, source_record_id, occurred_at
      )
      SELECT ?, ?, ?, ?, 'activity.deleted', 'activity', ?, ?, NULL, NULL, ?
      FROM activities AS deleted_activity
      INNER JOIN potreros AS current_paddock ON current_paddock.id = deleted_activity.paddock_id
      INNER JOIN fields AS current_field ON current_field.id = current_paddock.field_id
      WHERE deleted_activity.id = ?
        AND deleted_activity.paddock_id = ?
        AND deleted_activity.updated_at = ?
        AND deleted_activity.deleted_at = ?
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT value FROM json_each(?))
    `).bind(
      auditId,
      scope.organizationId,
      existing.fieldId,
      actor,
      activityId,
      JSON.stringify(toActivity(existing.activity)),
      updatedAt,
      activityId,
      existing.activity.paddockId,
      updatedAt,
      updatedAt,
      scope.organizationId,
      fieldIdsJson,
    ),
  ]);

  return results[0].meta.changes > 0;
}
