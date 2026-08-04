import { getDb } from "@/db";
import { fields, livestockFeedingPlans, livestockLots } from "@/db/schema";
import type { LivestockFeedingPlan } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { and, asc, eq, inArray } from "drizzle-orm";

type FeedingPlanRow = typeof livestockFeedingPlans.$inferSelect;

function toPlan(row: FeedingPlanRow): LivestockFeedingPlan {
  return {
    id: row.id,
    lotId: row.lotId,
    productName: row.productName,
    kgPerAnimalDay: row.kgPerAnimalDay,
    sackWeightKg: row.sackWeightKg,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nextUpdatedAt(previous?: string): string {
  const now = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(previousTime) && previousTime >= now ? previousTime + 1 : now).toISOString();
}

export async function listLivestockFeedingPlans(scope: OrganizationFieldScope): Promise<LivestockFeedingPlan[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ plan: livestockFeedingPlans })
    .from(livestockFeedingPlans)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockFeedingPlans.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
    .orderBy(asc(livestockFeedingPlans.lotId));
  return rows.map(({ plan }) => toPlan(plan));
}

export async function upsertLivestockFeedingPlan(
  plan: LivestockFeedingPlan,
  scope: OrganizationFieldScope,
): Promise<LivestockFeedingPlan> {
  if (scope.fieldIds.length === 0) throwFieldScopeConflict("El lote seleccionado no está disponible.");
  const db = getDb();
  const [lot] = await db
    .select({ id: livestockLots.id, fieldId: livestockLots.fieldId })
    .from(livestockLots)
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockLots.id, plan.lotId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!lot) throw new DomainRuleError("El lote seleccionado no existe.");
  const [existingById] = await db
    .select({ fieldId: livestockLots.fieldId })
    .from(livestockFeedingPlans)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockFeedingPlans.lotId))
    .where(eq(livestockFeedingPlans.id, plan.id))
    .limit(1);
  if (existingById) await assertFieldInScope(existingById.fieldId, scope, "El identificador del plan no está disponible.");
  const [existingForLotRow] = await db
    .select({ plan: livestockFeedingPlans })
    .from(livestockFeedingPlans)
    .where(eq(livestockFeedingPlans.lotId, plan.lotId))
    .limit(1);
  const existingForLot = existingForLotRow?.plan;
  if (existingById && existingForLot?.id !== plan.id) {
    throwFieldScopeConflict("El identificador del plan no está disponible.");
  }
  if (existingForLot && plan.updatedAt !== existingForLot.updatedAt) {
    throwFieldScopeConflict("El plan de alimentación cambió desde la última carga.");
  }

  const updatedAt = nextUpdatedAt(existingForLot?.updatedAt);
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const client = db.$client;
  const mutation = existingForLot
    ? client.prepare(`
      UPDATE livestock_feeding_plans
      SET product_name = ?, kg_per_animal_day = ?, sack_weight_kg = ?, notes = ?, updated_at = ?
      WHERE id = ? AND lot_id = ?
        AND product_name = ? AND kg_per_animal_day = ? AND sack_weight_kg = ? AND notes = ?
        AND created_at = ? AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM livestock_lots AS current_lot
          INNER JOIN fields AS current_field ON current_field.id = current_lot.field_id
          WHERE current_lot.id = livestock_feeding_plans.lot_id
            AND current_field.organization_id = ?
            AND current_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      plan.productName,
      plan.kgPerAnimalDay,
      plan.sackWeightKg,
      plan.notes,
      updatedAt,
      existingForLot.id,
      existingForLot.lotId,
      existingForLot.productName,
      existingForLot.kgPerAnimalDay,
      existingForLot.sackWeightKg,
      existingForLot.notes,
      existingForLot.createdAt,
      existingForLot.updatedAt,
      scope.organizationId,
      fieldIdsJson,
    )
    : client.prepare(`
      INSERT INTO livestock_feeding_plans (
        id, lot_id, product_name, kg_per_animal_day, sack_weight_kg, notes, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM livestock_lots AS target_lot
        INNER JOIN fields AS target_field ON target_field.id = target_lot.field_id
        WHERE target_lot.id = ?
          AND target_field.organization_id = ?
          AND target_field.id IN (SELECT value FROM json_each(?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_feeding_plans AS existing_id WHERE existing_id.id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_feeding_plans AS existing_lot WHERE existing_lot.lot_id = ?
        )
    `).bind(
      plan.id,
      plan.lotId,
      plan.productName,
      plan.kgPerAnimalDay,
      plan.sackWeightKg,
      plan.notes,
      plan.createdAt,
      updatedAt,
      plan.lotId,
      scope.organizationId,
      fieldIdsJson,
      plan.id,
      plan.lotId,
    );
  const savedId = existingForLot?.id ?? plan.id;
  const savedStatement = client.prepare(`
    SELECT
      saved_plan.id,
      saved_plan.lot_id AS "lotId",
      saved_plan.product_name AS "productName",
      saved_plan.kg_per_animal_day AS "kgPerAnimalDay",
      saved_plan.sack_weight_kg AS "sackWeightKg",
      saved_plan.notes,
      saved_plan.created_at AS "createdAt",
      saved_plan.updated_at AS "updatedAt"
    FROM livestock_feeding_plans AS saved_plan
    INNER JOIN livestock_lots AS saved_lot ON saved_lot.id = saved_plan.lot_id
    INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
    WHERE saved_plan.id = ?
      AND saved_plan.lot_id = ?
      AND saved_plan.updated_at = ?
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT value FROM json_each(?))
    LIMIT 1
  `).bind(savedId, plan.lotId, updatedAt, scope.organizationId, fieldIdsJson);
  const [result, savedResult] = await client.batch([mutation, savedStatement]);
  if (result.meta.changes === 0) throwFieldScopeConflict("El identificador del plan no está disponible.");
  const saved = savedResult.results[0] as FeedingPlanRow | undefined;
  if (!saved) throwFieldScopeConflict("El identificador del plan no está disponible.");
  return toPlan(saved);
}

export async function deleteLivestockFeedingPlan(
  id: string,
  scope: OrganizationFieldScope,
  expectedUpdatedAt: string,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existingRow] = await db
    .select({ plan: livestockFeedingPlans })
    .from(livestockFeedingPlans)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockFeedingPlans.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockFeedingPlans.id, id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  const existing = existingRow?.plan;
  if (!existing) return false;
  if (!expectedUpdatedAt || expectedUpdatedAt !== existing.updatedAt) {
    throwFieldScopeConflict("El plan de alimentación cambió desde la última carga.");
  }
  const client = db.$client;
  const [deleted] = await client.batch([
    client.prepare(`
      DELETE FROM livestock_feeding_plans
      WHERE id = ? AND lot_id = ?
        AND product_name = ? AND kg_per_animal_day = ? AND sack_weight_kg = ? AND notes = ?
        AND created_at = ? AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM livestock_lots AS current_lot
          INNER JOIN fields AS current_field ON current_field.id = current_lot.field_id
          WHERE current_lot.id = livestock_feeding_plans.lot_id
            AND current_field.organization_id = ?
            AND current_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      id,
      existing.lotId,
      existing.productName,
      existing.kgPerAnimalDay,
      existing.sackWeightKg,
      existing.notes,
      existing.createdAt,
      existing.updatedAt,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
    ),
  ]);
  if (deleted.meta.changes === 0) {
    throwFieldScopeConflict("El plan de alimentación cambió desde la última carga.");
  }
  return true;
}
