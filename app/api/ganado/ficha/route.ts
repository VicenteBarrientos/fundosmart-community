import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  getAnimalRecord,
  saveAnimalRenumber,
  saveBirth,
  saveHealthEvent,
  saveMilkControl,
  saveReproductiveEvent,
} from "@/src/modules/ganado/ficha/server/animal-record-repository";
import {
  AnimalRecordRuleError,
  normalizeBirthInput,
  normalizeHealthEventInput,
  normalizeMilkControlInput,
  normalizeRenumberInput,
  normalizeReproductiveEventInput,
} from "@/src/modules/ganado/ficha/server/animal-record-rules.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess();
  if (isAccessResponse(access)) return access;
  const animalId = new URL(request.url).searchParams.get("animalId")?.trim();
  if (!animalId) return Response.json({ error: "Falta el animal que deseas consultar." }, { status: 400 });
  const forbidden = await requireResourceField(access, "animal", animalId);
  if (forbidden) return forbidden;
  const record = await getAnimalRecord(animalId, access);
  if (!record) return Response.json({ error: "El animal seleccionado no existe." }, { status: 404 });
  const currentAccess = await reauthorizeApiAccess(access, "view", record.fieldId);
  if (isAccessResponse(currentAccess)) return currentAccess;
  return Response.json({ record }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("operate");
  if (isAccessResponse(access)) return access;
  const payload = await readJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;

  const action = typeof (payload as { action?: unknown })?.action === "string"
    ? (payload as { action: string }).action
    : "";
  try {
    if (action === "milk_control") {
      const input = normalizeMilkControlInput(payload);
      const forbidden = await requireResourceField(access, "animal", input.animalId);
      if (forbidden) return forbidden;
      return Response.json({ record: await saveMilkControl(input, access.email, access) });
    }
    if (action === "reproductive_event") {
      const input = normalizeReproductiveEventInput(payload);
      const forbidden = await requireResourceField(access, "animal", input.animalId);
      if (forbidden) return forbidden;
      return Response.json({ record: await saveReproductiveEvent(input, access.email, access) });
    }
    if (action === "birth") {
      const input = normalizeBirthInput(payload);
      const forbidden = await requireResourceField(access, "animal", input.animalId);
      if (forbidden) return forbidden;
      return Response.json({ record: await saveBirth(input, access.email, access) });
    }
    if (action === "health_event") {
      const input = normalizeHealthEventInput(payload);
      const forbidden = await requireResourceField(access, "animal", input.animalId);
      if (forbidden) return forbidden;
      return Response.json({ record: await saveHealthEvent(input, access.email, access) });
    }
    if (action === "renumber") {
      const input = normalizeRenumberInput(payload);
      const forbidden = await requireResourceField(access, "animal", input.animalId);
      if (forbidden) return forbidden;
      return Response.json({ record: await saveAnimalRenumber(input, access.email, access) });
    }
    return Response.json({ error: "Selecciona una operación de ficha soportada." }, { status: 400 });
  } catch (cause) {
    if (cause instanceof AnimalRecordRuleError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 400 });
    }
    if (cause instanceof DomainRuleError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
    }
    return unexpectedApiFailure("livestock.animal-record.update", "No fue posible actualizar la ficha animal.", cause);
  }
}
