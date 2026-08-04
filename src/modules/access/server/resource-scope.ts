import { getDb } from "@/db";
import {
  activities,
  importErrors,
  importJobs,
  livestockAnimals,
  livestockExpenses,
  livestockFeedingPlans,
  livestockLots,
  livestockWeighings,
  milkSettlements,
  paddocks,
} from "@/db/schema";
import { eq } from "drizzle-orm";

export type FieldScopedResource =
  | "activity"
  | "paddock"
  | "lot"
  | "animal"
  | "weighing"
  | "feeding_plan"
  | "expense"
  | "milk_settlement"
  | "import_job"
  | "import_error";

export async function resolveResourceFieldId(resource: FieldScopedResource, id: string): Promise<string | null> {
  const db = getDb();
  if (resource === "paddock") {
    const [row] = await db.select({ fieldId: paddocks.fieldId }).from(paddocks).where(eq(paddocks.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "activity") {
    const [row] = await db.select({ fieldId: paddocks.fieldId }).from(activities)
      .innerJoin(paddocks, eq(paddocks.id, activities.paddockId)).where(eq(activities.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "lot") {
    const [row] = await db.select({ fieldId: livestockLots.fieldId }).from(livestockLots).where(eq(livestockLots.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "animal") {
    const [row] = await db.select({ fieldId: livestockLots.fieldId }).from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId)).where(eq(livestockAnimals.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "weighing") {
    const [row] = await db.select({ fieldId: livestockLots.fieldId }).from(livestockWeighings)
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockWeighings.animalId))
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .where(eq(livestockWeighings.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "feeding_plan") {
    const [row] = await db.select({ fieldId: livestockLots.fieldId }).from(livestockFeedingPlans)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockFeedingPlans.lotId))
      .where(eq(livestockFeedingPlans.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "expense") {
    const [row] = await db.select({ fieldId: livestockExpenses.fieldId, lotFieldId: livestockLots.fieldId })
      .from(livestockExpenses).leftJoin(livestockLots, eq(livestockLots.id, livestockExpenses.lotId))
      .where(eq(livestockExpenses.id, id)).limit(1);
    return row?.fieldId ?? row?.lotFieldId ?? null;
  }
  if (resource === "milk_settlement") {
    const [row] = await db.select({ fieldId: milkSettlements.fieldId }).from(milkSettlements)
      .where(eq(milkSettlements.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  if (resource === "import_job") {
    const [row] = await db.select({ fieldId: importJobs.fieldId }).from(importJobs).where(eq(importJobs.id, id)).limit(1);
    return row?.fieldId ?? null;
  }
  const [row] = await db.select({ fieldId: importJobs.fieldId }).from(importErrors)
    .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId)).where(eq(importErrors.id, id)).limit(1);
  return row?.fieldId ?? null;
}
