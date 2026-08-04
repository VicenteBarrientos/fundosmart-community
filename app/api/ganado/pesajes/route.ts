import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiSnapshotAccess,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { listLivestockAnimals } from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import {
  deleteWeighing,
  listLivestockWeighings,
  recordWeighingSession,
  type LivestockWeighingEntry,
} from "@/src/modules/ganado/server/livestock-weighing-repository";

export const dynamic = "force-dynamic";

type SessionPayload = {
  lotId?: string;
  recordedAt?: string;
  notes?: string;
  entries?: { animalId?: string; weightKg?: number; snapshotToken?: string | null }[];
};

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const weighings = await listLivestockWeighings(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { weighings },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "No fue posible cargar los pesajes." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<SessionPayload>(request);
    if (payload instanceof Response) return payload;
    const error = validateSession(payload);
    if (error) return Response.json({ error }, { status: 400 });
    if (payload.entries!.some((entry) => entry.snapshotToken === undefined)) {
      return Response.json({ error: "Actualiza los pesajes antes de guardar." }, { status: 409 });
    }

    const entries = payload.entries!.map((entry) => ({
      animalId: entry.animalId!.trim(),
      weightKg: entry.weightKg!,
      snapshotToken: typeof entry.snapshotToken === "string" ? entry.snapshotToken.trim() : null,
    })) satisfies LivestockWeighingEntry[];
    const forbidden = await requireResourceField(access, "lot", payload.lotId!.trim());
    if (forbidden) return forbidden;
    const weighings = await recordWeighingSession(
      payload.lotId!.trim(),
      payload.recordedAt!,
      entries,
      payload.notes?.trim() ?? "",
      access,
    );
    const [lots, animals] = await Promise.all([listLivestockLots(access), listLivestockAnimals(access)]);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "operate",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ weighings, lots, animals }, { status: 201 });
  } catch (cause) {
    return weighingMutationError(cause, "livestock.weighing.record", "No fue posible registrar la sesión de pesaje.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const url = new URL(request.url);
    const id = url.searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del pesaje." }, { status: 400 });
    const expectedSnapshotToken = url.searchParams.get("snapshotToken")?.trim();
    if (!expectedSnapshotToken) {
      return Response.json({ error: "Actualiza los pesajes antes de eliminar." }, { status: 409 });
    }
    const forbidden = await requireResourceField(access, "weighing", id);
    if (forbidden) return forbidden;
    const deleted = await deleteWeighing(id, access, expectedSnapshotToken);
    if (!deleted) return Response.json({ error: "El pesaje no existe." }, { status: 404 });
    const [allWeighings, allLots, allAnimals] = await Promise.all([
      listLivestockWeighings(access),
      listLivestockLots(access),
      listLivestockAnimals(access),
    ]);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "operate",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ weighings: allWeighings, lots: allLots, animals: allAnimals });
  } catch (cause) {
    return weighingMutationError(cause, "livestock.weighing.delete", "No fue posible eliminar el pesaje.");
  }
}

function weighingMutationError(cause: unknown, operation: string, fallback: string): Response {
  if (cause instanceof DomainRuleError) {
    if (cause.code === "FIELD_SCOPE_CONFLICT") return Response.json({ error: cause.message }, { status: 409 });
    return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

function validateSession(payload: SessionPayload): string | null {
  if (!payload.lotId?.trim()) return "Selecciona un lote.";
  if (!payload.recordedAt || !/^\d{4}-\d{2}-\d{2}$/.test(payload.recordedAt)) return "Indica una fecha de pesaje válida.";
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) return "Registra al menos un peso.";
  for (const entry of payload.entries) {
    if (!entry.animalId?.trim()) return "Falta el identificador de un animal.";
    if (!Number.isFinite(entry.weightKg) || (entry.weightKg as number) <= 0) return "Todos los pesos deben ser mayores que cero.";
  }
  const unique = new Set(payload.entries.map((entry) => entry.animalId));
  if (unique.size !== payload.entries.length) return "Hay animales repetidos en la sesión.";
  return null;
}
