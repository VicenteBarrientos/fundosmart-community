import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiSnapshotAccess,
  requireResourceField,
} from "@/app/access";
import type { HerdOperations } from "@/src/modules/ganado/domain/operations";
import { AnimalRecordRuleError, normalizeHealthEventInput } from "@/src/modules/ganado/ficha/server/animal-record-rules.mjs";
import { saveHealthEventsBatch } from "@/src/modules/ganado/ficha/server/animal-record-repository";
import { listLivestockAnimals } from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockFinance } from "@/src/modules/ganado/server/livestock-finance-repository";
import { listHerdOperations } from "@/src/modules/ganado/server/herd-operations-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import { listLivestockWeighings } from "@/src/modules/ganado/server/livestock-weighing-repository";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await authorizeApiAccess();
  if (isAccessResponse(access)) return access;
  try {
    const canViewFinance = roleHasCapability(access.role, "manage_finance");
    const operations = await loadVisibleOperations(
      access.organizationId,
      access.fieldIds,
      canViewFinance,
    );
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: canViewFinance ? "manage_finance" : "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ operations }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    console.error("[ganado] herd operations failed", cause);
    return Response.json({ error: "No fue posible actualizar la agenda del rebaño." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("operate");
  if (isAccessResponse(access)) return access;
  let payload: { action?: string; animalIds?: unknown; event?: unknown; batchId?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return Response.json({ error: "La solicitud no contiene datos válidos." }, { status: 400 });
  }
  if (payload.action !== "batch_health") return Response.json({ error: "Selecciona una operación grupal soportada." }, { status: 400 });
  const animalIds = Array.isArray(payload.animalIds) ? [...new Set(payload.animalIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())))] : [];
  if (animalIds.length === 0) return Response.json({ error: "Selecciona al menos un animal." }, { status: 400 });
  if (animalIds.length > 40) return Response.json({ error: "Selecciona como máximo 40 animales por operación para conservar atomicidad." }, { status: 400 });
  const batchId = typeof payload.batchId === "string" && /^[A-Za-z0-9-]{8,80}$/.test(payload.batchId) ? payload.batchId : crypto.randomUUID();
  try {
    for (const animalId of animalIds) {
      const forbidden = await requireResourceField(access, "animal", animalId);
      if (forbidden) return forbidden;
    }
    const inputs = animalIds.map((animalId) => normalizeHealthEventInput({ ...(payload.event as object), animalId }));
    const created = await saveHealthEventsBatch(inputs, access.email, batchId);
    const canViewFinance = roleHasCapability(access.role, "manage_finance");
    const operations = await loadVisibleOperations(
      access.organizationId,
      access.fieldIds,
      canViewFinance,
    );
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: canViewFinance ? "manage_finance" : "operate",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ created, operations }, { status: 201 });
  } catch (cause) {
    if (cause instanceof AnimalRecordRuleError) return Response.json({ error: cause.message, code: cause.code }, { status: 400 });
    return Response.json({ error: cause instanceof Error ? cause.message : "No fue posible registrar el tratamiento grupal." }, { status: 422 });
  }
}

async function loadVisibleOperations(organizationId: string, fieldIds: string[], canViewFinance: boolean): Promise<HerdOperations> {
  const scope = { organizationId, fieldIds };
  const [lots, animals, weighings, finance] = await Promise.all([
    listLivestockLots(scope),
    listLivestockAnimals(scope),
    listLivestockWeighings(scope),
    canViewFinance
      ? listLivestockFinance({ ...scope, allowOrganizationWide: false })
      : Promise.resolve({ partners: [], contributions: [], expenses: [] }),
  ]);
  const allowedFields = new Set(fieldIds);
  const visibleLots = lots.filter((entry) => allowedFields.has(entry.fieldId));
  const lotIds = new Set(visibleLots.map((entry) => entry.id));
  const visibleAnimals = animals.filter((entry) => lotIds.has(entry.lotId));
  const animalIds = new Set(visibleAnimals.map((entry) => entry.id));
  const operations = await listHerdOperations({
    fieldIds,
    lots: visibleLots,
    animals: visibleAnimals,
    weighings: weighings.filter((entry) => animalIds.has(entry.animalId)),
    expenses: finance.expenses.filter((entry) => !entry.fieldId || allowedFields.has(entry.fieldId)),
  });
  return canViewFinance ? operations : { ...operations, animalMargins: [], lotMargins: [] };
}
