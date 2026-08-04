import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
} from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import { deletePotrero, listPotreros, upsertPotrero } from "@/src/modules/potreros/server/potrero-repository";
import type { Potrero } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const fundoId = new URL(request.url).searchParams.get("fundoId")?.trim() || undefined;
    if (fundoId) {
      const forbidden = requireContextField(access, fundoId);
      if (forbidden) return forbidden;
    }
    const potreros = await listPotreros(access, fundoId);
    const currentAccess = fundoId
      ? await reauthorizeApiAccess(access, "view", fundoId)
      : await reauthorizeApiSnapshotAccess(access, {
        capability: "view",
        fieldIds: access.fieldIds,
      });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { potreros },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return databaseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<Potrero>>(request);
    if (payload instanceof Response) return payload;
    const validationError = validatePotrero(payload);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }

    const targetForbidden = requireContextField(access, payload.fieldId);
    if (targetForbidden) return targetForbidden;
    const existingFieldId = await resolveResourceFieldId("paddock", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
    }
    const saved = await upsertPotrero(payload as Potrero, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", saved.fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ potrero: saved }, { status: 201 });
  } catch (error) {
    return databaseError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del potrero." }, { status: 400 });
    const expectedUpdatedAt = new URL(request.url).searchParams.get("updatedAt")?.trim();
    if (!expectedUpdatedAt) {
      return Response.json({ error: "Actualiza los potreros antes de eliminar." }, { status: 409 });
    }

    const fieldId = await resolveResourceFieldId("paddock", id);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const deleted = await deletePotrero(id, access, expectedUpdatedAt);
    if (!deleted) return Response.json({ error: "El potrero no existe." }, { status: 404 });
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true, id });
  } catch (error) {
    return databaseError(error);
  }
}

function validatePotrero(payload: Partial<Potrero>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del potrero.";
  if (!payload.fieldId?.trim()) return "Selecciona el fundo al que pertenece el potrero.";
  if (!payload.name?.trim()) return "El nombre es obligatorio.";
  if (!payload.sector?.trim()) return "El sector es obligatorio.";
  if (!Array.isArray(payload.coordinates) || payload.coordinates.length < 3) {
    return "El potrero necesita al menos tres puntos.";
  }
  if (!Number.isFinite(payload.areaHectares) || Number(payload.areaHectares) <= 0) {
    return "La superficie calculada no es válida.";
  }
  return null;
}

function databaseError(error: unknown) {
  if (error instanceof DomainRuleError) {
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : "No fue posible acceder a los datos.";
  const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;

  if (combined.includes("no such table")) {
    return Response.json(
      { error: "La base de datos todavía no está preparada." },
      { status: 503 },
    );
  }

  return Response.json({ error: "No fue posible aplicar los cambios." }, { status: 500 });
}
