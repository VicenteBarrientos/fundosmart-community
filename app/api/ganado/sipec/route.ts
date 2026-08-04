import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField, requireResourceField } from "@/app/access";
import { getDb } from "@/db";
import { livestockHealthEvents } from "@/db/schema";
import { listLivestockAnimals } from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import {
  buildDeaDraft,
  buildFmaDrafts,
  deaDraftToCsv,
  fmaDraftsToCsv,
  type SagInventoryEntry,
  type SagProfile,
} from "@/src/modules/ganado/sag/sag-export-rules.mjs";
import type { LivestockAnimal, LivestockCategory, LivestockLot } from "@/src/core/domain/types";
import { inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

type ExportRequest = {
  action?: "dea" | "fma";
  profile?: SagProfile;
  asOfDate?: string;
  animalIds?: string[];
  movement?: Parameters<typeof buildFmaDrafts>[0]["movement"];
};

export async function POST(request: Request) {
  const access = await authorizeApiAccess("operate");
  if (isAccessResponse(access)) return access;
  let payload: ExportRequest;
  try { payload = await request.json() as ExportRequest; }
  catch { return Response.json({ error: "La solicitud SAG no contiene datos válidos." }, { status: 400 }); }
  if (!payload.profile?.fieldId) return Response.json({ error: "Selecciona el fundo de origen." }, { status: 400 });
  const forbidden = requireContextField(access, payload.profile.fieldId);
  if (forbidden) return forbidden;

  try {
    const scope = { organizationId: access.organizationId, fieldIds: access.fieldIds };
    const [lots, animals] = await Promise.all([listLivestockLots(scope), listLivestockAnimals(scope)]);
    const fieldLots = lots.filter((lot) => lot.fieldId === payload.profile!.fieldId && lot.status === "active");
    const lotIds = new Set(fieldLots.map((lot) => lot.id));
    const fieldAnimals = animals.filter((animal) => lotIds.has(animal.lotId));
    if (payload.action === "dea") {
      const unresolved = unresolvedSagInventory(fieldLots, fieldAnimals);
      if (unresolved.length) return Response.json({ error: "Hay existencias sin categoría SAG inequívoca.", issues: unresolved.map((message) => ({ message })) }, { status: 422 });
      const result = buildDeaDraft({
        profile: payload.profile,
        asOfDate: payload.asOfDate ?? new Date().toISOString().slice(0, 10),
        inventoryEntries: buildInventory(fieldLots, fieldAnimals),
        generatedAt: new Date().toISOString(),
      });
      if (!result.draft) return Response.json({ error: "El borrador DEA tiene datos pendientes.", issues: result.validation.errors }, { status: 422 });
      const csv = deaDraftToCsv(result.draft);
      const currentAccess = await reauthorizeApiAccess(access, "operate", payload.profile.fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return csvResponse(csv, `sag-dea-borrador-${payload.profile.fieldId}-${payload.asOfDate}.csv`);
    }
    if (payload.action === "fma") {
      const ids = [...new Set(Array.isArray(payload.animalIds) ? payload.animalIds.filter(Boolean) : [])];
      if (!ids.length) return Response.json({ error: "Selecciona al menos un animal para el FMA." }, { status: 400 });
      for (const id of ids) { const denied = await requireResourceField(access, "animal", id); if (denied) return denied; }
      const selected = fieldAnimals.filter((animal) => ids.includes(animal.id));
      if (selected.length !== ids.length) return Response.json({ error: "Uno o más animales no pertenecen al fundo de origen." }, { status: 404 });
      const mappedAnimals = selected.map((animal) => ({ animal, lot: fieldLots.find((lot) => lot.id === animal.lotId)! })).map(({ animal, lot }) => ({ animal, mapped: sagCategory(lot.category, animal.sex) }));
      const unsupported = mappedAnimals.filter((entry) => !entry.mapped);
      if (unsupported.length) return Response.json({ error: `Corrige especie/sexo SAG de ${unsupported.map((entry) => entry.animal.tag).join(", ")}.` }, { status: 422 });
      const healthRows = await getDb().select({
        animalId: livestockHealthEvents.animalId,
        status: livestockHealthEvents.status,
        withdrawalMilkUntil: livestockHealthEvents.withdrawalMilkUntil,
        withdrawalMeatUntil: livestockHealthEvents.withdrawalMeatUntil,
      }).from(livestockHealthEvents).where(inArray(livestockHealthEvents.animalId, ids));
      const result = buildFmaDrafts({
        profile: payload.profile,
        movement: payload.movement!,
        animals: mappedAnimals.map(({ animal, mapped }) => ({ id: animal.id, fieldId: payload.profile!.fieldId, diio: animal.tag, status: animal.status, ...mapped! })),
        withdrawals: healthRows,
        generatedAt: new Date().toISOString(),
      });
      if (!result.validation.valid) return Response.json({ error: "El borrador FMA tiene datos pendientes o resguardos activos.", issues: result.validation.errors }, { status: 422 });
      const csv = fmaDraftsToCsv(result.drafts);
      const currentAccess = await reauthorizeApiAccess(access, "operate", payload.profile.fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return csvResponse(csv, `sag-fma-borrador-${payload.profile.fieldId}-${payload.movement?.departureDate}.csv`);
    }
    return Response.json({ error: "Selecciona exportación DEA o FMA." }, { status: 400 });
  } catch (cause) {
    console.error("[ganado] SAG draft export failed", cause);
    return Response.json({ error: cause instanceof Error ? cause.message : "No fue posible generar el borrador SAG." }, { status: 500 });
  }
}

function buildInventory(lots: LivestockLot[], animals: LivestockAnimal[]): SagInventoryEntry[] {
  const entries: SagInventoryEntry[] = [];
  for (const lot of lots) {
    if (lot.trackingMode === "summary") {
      const category = sagCategory(lot.category, "unknown");
      if (category) entries.push({ id: lot.id, fieldId: lot.fieldId, ...category, quantity: lot.animalCount, trackingMode: "summary", status: lot.status });
      continue;
    }
    for (const animal of animals.filter((entry) => entry.lotId === lot.id && entry.status === "active")) {
      const category = sagCategory(lot.category, animal.sex);
      if (category) entries.push({ id: animal.id, fieldId: lot.fieldId, ...category, quantity: 1, trackingMode: "individual", status: animal.status });
    }
  }
  return entries;
}

function sagCategory(category: LivestockCategory, sex: LivestockAnimal["sex"]): { speciesCode: string; categoryCode: string } | null {
  if (category === "dairy_cow" || category === "dry_cow") return { speciesCode: "bovine", categoryCode: "cow" };
  if (category === "heifer") return { speciesCode: "bovine", categoryCode: "heifer" };
  if (category === "calf") return sex === "unknown" ? null : { speciesCode: "bovine", categoryCode: sex === "female" ? "female_calf" : "male_calf" };
  if (category === "steer") return { speciesCode: "bovine", categoryCode: "steer" };
  if (category === "bull") return { speciesCode: "bovine", categoryCode: "bull" };
  if (category === "sheep") return sex === "unknown" ? null : { speciesCode: "ovine", categoryCode: sex === "male" ? "ram" : "ewe" };
  return null;
}

function unresolvedSagInventory(lots: LivestockLot[], animals: LivestockAnimal[]): string[] {
  const messages: string[] = [];
  for (const lot of lots) {
    if (lot.trackingMode === "summary" && ["calf", "sheep", "other"].includes(lot.category)) messages.push(`${lot.name}: separa sexo/especie o activa trazabilidad individual.`);
    if (lot.trackingMode === "individual") for (const animal of animals.filter((entry) => entry.lotId === lot.id && entry.status === "active")) if (!sagCategory(lot.category, animal.sex)) messages.push(`${animal.tag}: registra sexo y una categoría compatible con SAG.`);
  }
  return messages;
}

function csvResponse(csv: string, filename: string) {
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "-")}"`, "Cache-Control": "no-store" } });
}
