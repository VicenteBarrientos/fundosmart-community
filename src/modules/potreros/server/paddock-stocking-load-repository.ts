import { getDb } from "@/db";
import { fields, livestockLots, paddocks } from "@/db/schema";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope } from "@/src/modules/access/server/organization-field-scope";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FieldStockingLoad, PaddockStockingLoad } from "../types";
import { calculateGrossHectares, calculateNetHectares } from "../utils/geometry";
import { decodeStoredPolygon } from "../utils/polygon-rings";

export async function getFieldStockingLoad(
  fieldId: string,
  scope: OrganizationFieldScope,
): Promise<FieldStockingLoad> {
  await assertFieldInScope(fieldId, scope);
  const rows = await getDb()
    .select({
      paddock: paddocks,
      animalCount: sql<number>`coalesce(sum(case when ${livestockLots.status} = 'active' then ${livestockLots.animalCount} else 0 end), 0)`,
    })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .leftJoin(livestockLots, eq(livestockLots.paddockId, paddocks.id))
    .where(and(
      eq(paddocks.fieldId, fieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddocks.archivedAt),
      isNull(paddocks.deletedAt),
    ))
    .groupBy(paddocks.id)
    .orderBy(asc(paddocks.name), asc(paddocks.id));

  const paddockLoads: PaddockStockingLoad[] = rows.map(({ paddock, animalCount }) => {
    const geometry = decodeStoredPolygon(paddock.coordinates);
    const grossAreaHectares = calculateGrossHectares(geometry);
    const netAreaHectares = calculateNetHectares(geometry);
    const effectiveGrazeableAreaHectares = paddock.grazeableAreaHectares ?? netAreaHectares;
    const normalizedAnimalCount = Number(animalCount);
    return {
      paddockId: paddock.id,
      paddockName: paddock.name,
      grossAreaHectares,
      netAreaHectares,
      grazeableAreaHectares: paddock.grazeableAreaHectares,
      effectiveGrazeableAreaHectares,
      animalCount: normalizedAnimalCount,
      animalsPerHectare: effectiveGrazeableAreaHectares > 0
        ? normalizedAnimalCount / effectiveGrazeableAreaHectares
        : null,
    };
  });
  const totals = paddockLoads.reduce((sum, paddock) => ({
    gross: sum.gross + paddock.grossAreaHectares,
    net: sum.net + paddock.netAreaHectares,
    effective: sum.effective + paddock.effectiveGrazeableAreaHectares,
    animals: sum.animals + paddock.animalCount,
  }), { gross: 0, net: 0, effective: 0, animals: 0 });
  return {
    fieldId,
    grossAreaHectares: totals.gross,
    netAreaHectares: totals.net,
    effectiveGrazeableAreaHectares: totals.effective,
    animalCount: totals.animals,
    animalsPerHectare: totals.effective > 0 ? totals.animals / totals.effective : null,
    paddocks: paddockLoads,
  };
}
