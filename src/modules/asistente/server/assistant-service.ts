import type { AccessContext } from "@/src/modules/access/domain/types";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { listLivestockAnimals } from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import { getMilkModuleSnapshot } from "@/src/modules/leche/server/milk-snapshot-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";
import type { AssistantEngineData } from "../domain/assistant-engine.mjs";

export async function loadAssistantData(
  access: AccessContext,
  asOf = todayInChile(),
): Promise<AssistantEngineData> {
  const [fields, paddocks, milk, lots, animals] = await Promise.all([
    listFundos(access),
    listPotreros(access),
    getMilkModuleSnapshot(access, asOf),
    listLivestockLots(access),
    listLivestockAnimals(access),
  ]);
  const fieldByLot = new Map(lots.map((lot) => [lot.id, lot.fieldId]));
  const livestockByField = Object.fromEntries(
    fields.map((field) => {
      const scoped = animals.filter((animal) => fieldByLot.get(animal.lotId) === field.id);
      return [field.id, {
        total: scoped.length,
        active: scoped.filter((animal) => animal.status === "active").length,
      }];
    }),
  );

  return {
    canOperate: roleHasCapability(access.role, "operate"),
    fields: fields.map((field) => ({ id: field.id, name: field.name })),
    paddocks: paddocks.map((paddock) => ({ id: paddock.id, fieldId: paddock.fieldId, name: paddock.name })),
    livestock: {
      total: animals.length,
      active: animals.filter((animal) => animal.status === "active").length,
    },
    livestockByField,
    milk,
  };
}

export function todayInChile(): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}
