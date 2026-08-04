import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  requireContextField,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { updateLinkedFieldBoundary } from "@/src/modules/potreros/server/potrero-repository";
import type { Fundo, Potrero } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_members");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<{ fundo?: Fundo; potreros?: Potrero[] }>(request);
    if (payload instanceof Response) return payload;
    if (
      !payload.fundo?.id?.trim()
      || !payload.fundo.name?.trim()
      || !payload.fundo.location?.trim()
      || !payload.fundo.snapshotToken?.trim()
    ) {
      return Response.json({ error: "Actualiza el fundo antes de editar su límite." }, { status: 409 });
    }
    if (!Array.isArray(payload.fundo.coordinates) || payload.fundo.coordinates.length < 3) {
      return Response.json({ error: "El fundo necesita al menos tres vértices." }, { status: 400 });
    }
    if (!Number.isFinite(payload.fundo.areaHectares) || payload.fundo.areaHectares <= 0) {
      return Response.json({ error: "La superficie calculada del fundo no es válida." }, { status: 400 });
    }
    if (!Array.isArray(payload.potreros) || payload.potreros.length === 0) {
      return Response.json({ error: "No hay potreros vinculados para actualizar." }, { status: 400 });
    }
    const forbiddenField = requireContextField(access, payload.fundo.id);
    if (forbiddenField) return forbiddenField;

    for (const potrero of payload.potreros) {
      if (!potrero.id?.trim() || potrero.fieldId !== payload.fundo.id) {
        return Response.json({ error: "Uno de los potreros no pertenece al fundo." }, { status: 400 });
      }
      if (!Array.isArray(potrero.coordinates) || potrero.coordinates.length < 3) {
        return Response.json({ error: "Cada potrero necesita al menos tres vértices." }, { status: 400 });
      }
      if (!Number.isFinite(potrero.areaHectares) || potrero.areaHectares <= 0) {
        return Response.json({ error: "Una superficie calculada no es válida." }, { status: 400 });
      }
      if (!potrero.updatedAt?.trim()) {
        return Response.json({ error: "Actualiza los potreros antes de modificar sus límites." }, { status: 409 });
      }
      const forbidden = await requireResourceField(access, "paddock", potrero.id);
      if (forbidden) return forbidden;
    }

    const saved = await updateLinkedFieldBoundary(payload.fundo, payload.potreros, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", saved.fundo.id);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(saved);
  } catch (cause) {
    if (cause instanceof DomainRuleError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    return unexpectedApiFailure(
      "paddock.linked_field_boundary.save",
      "No fue posible guardar el límite del fundo y sus potreros.",
      cause,
    );
  }
}
