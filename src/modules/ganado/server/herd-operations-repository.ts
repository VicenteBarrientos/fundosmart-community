import { getDb } from "@/db";
import { livestockBirthOffspring, livestockBirths, livestockHealthEvents, livestockReproductiveEvents } from "@/db/schema";
import type { LivestockAnimal, LivestockExpense, LivestockLot, LivestockWeighing } from "@/src/core/domain/types";
import type { HerdOperations } from "../domain/operations";
import type { LivestockBirth, LivestockBirthOffspring } from "../ficha/domain/types";
import { buildHerdOperations } from "../lib/operations-rules";
import { inArray } from "drizzle-orm";

type HerdOperationsRepositoryInput = {
  fieldIds: string[];
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  weighings: LivestockWeighing[];
  expenses: LivestockExpense[];
};

export async function listHerdOperations(input: HerdOperationsRepositoryInput): Promise<HerdOperations> {
  if (input.fieldIds.length === 0) return buildHerdOperations({ ...input, reproductiveEvents: [], births: [], healthEvents: [] });
  const db = getDb();
  const [reproductiveEvents, birthRows, offspringRows, healthEvents] = await Promise.all([
    db.select().from(livestockReproductiveEvents).where(inArray(livestockReproductiveEvents.fieldId, input.fieldIds)),
    db.select().from(livestockBirths).where(inArray(livestockBirths.fieldId, input.fieldIds)),
    db.select().from(livestockBirthOffspring),
    db.select().from(livestockHealthEvents).where(inArray(livestockHealthEvents.fieldId, input.fieldIds)),
  ]);
  const offspringByBirth = new Map<string, LivestockBirthOffspring[]>();
  for (const row of offspringRows) offspringByBirth.set(row.birthId, [...(offspringByBirth.get(row.birthId) ?? []), row]);
  const births: LivestockBirth[] = birthRows.map((row) => ({ ...row, offspring: offspringByBirth.get(row.id) ?? [] }));
  return buildHerdOperations({
    animals: input.animals,
    lots: input.lots,
    weighings: input.weighings,
    expenses: input.expenses,
    reproductiveEvents,
    births,
    healthEvents,
  });
}
