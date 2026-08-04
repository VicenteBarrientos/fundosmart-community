import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import type { LivestockAnimal } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { validateAnimalPayload } from "@/src/modules/ganado/server/animal-payload";
import {
  deleteLivestockAnimal,
  listLivestockAnimals,
  upsertLivestockAnimal,
} from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const animals = await listLivestockAnimals(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { animals },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "No fue posible cargar los animales." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<LivestockAnimal>>(request);
    if (payload instanceof Response) return payload;
    const error = validateAnimalPayload(payload);
    if (error) return Response.json({ error }, { status: 400 });

    const targetForbidden = await requireResourceField(access, "lot", payload.lotId!);
    if (targetForbidden) return targetForbidden;
    const existingFieldId = await resolveResourceFieldId("animal", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
      if (!payload.snapshotToken?.trim()) {
        return Response.json({ error: "Actualiza los animales antes de editar." }, { status: 409 });
      }
    }
    const animal = await upsertLivestockAnimal(payload as LivestockAnimal, access);
    const lots = await listLivestockLots(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "operate",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ animal, lots }, { status: 201 });
  } catch (cause) {
    return livestockAnimalError(cause, "livestock.animal.save", "No fue posible guardar el animal.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del animal." }, { status: 400 });
    const expectedSnapshotToken = new URL(request.url).searchParams.get("snapshotToken")?.trim();
    if (!expectedSnapshotToken) {
      return Response.json({ error: "Actualiza los animales antes de eliminar." }, { status: 409 });
    }
    const forbidden = await requireResourceField(access, "animal", id);
    if (forbidden) return forbidden;
    const deleted = await deleteLivestockAnimal(id, access, expectedSnapshotToken);
    if (!deleted) return Response.json({ error: "El animal no existe." }, { status: 404 });
    const lots = await listLivestockLots(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "operate",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true, lots });
  } catch (cause) {
    return livestockAnimalError(cause, "livestock.animal.delete", "No fue posible eliminar el animal.");
  }
}

function livestockAnimalError(cause: unknown, operation: string, fallback: string) {
  if (cause instanceof Error && "code" in cause && cause.code === "FIELD_SCOPE_CONFLICT") {
    return Response.json({ error: cause.message }, { status: 409 });
  }
  if (cause instanceof DomainRuleError) {
    return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiSnapshotAccess,
  requireContextField,
  requireResourceField,
} from "@/app/access";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
