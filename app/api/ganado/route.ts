import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  LIVESTOCK_CATEGORY_LABELS,
  LIVESTOCK_STATUS_LABELS,
  type LivestockLot,
} from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  deleteLivestockLot,
  listLivestockLots,
  upsertLivestockLot,
} from "@/src/modules/ganado/server/livestock-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const lots = await listLivestockLots(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { lots },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "No fue posible cargar el inventario ganadero." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<LivestockLot>>(request);
    if (payload instanceof Response) return payload;
    const error = validateLivestockLot(payload);
    if (error) return Response.json({ error }, { status: 400 });

    const targetForbidden = requireContextField(access, payload.fieldId);
    if (targetForbidden) return targetForbidden;
    const existingFieldId = await resolveResourceFieldId("lot", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
      if (!payload.updatedAt?.trim()) {
        return Response.json({ error: "Actualiza el inventario antes de editar el lote ganadero." }, { status: 409 });
      }
    }
    const lot = await upsertLivestockLot(payload as LivestockLot, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", lot.fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ lot }, { status: 201 });
  } catch (cause) {
    return livestockLotError(cause, "livestock.lot.save", "No fue posible guardar el lote ganadero.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del lote." }, { status: 400 });
    const expectedUpdatedAt = new URL(request.url).searchParams.get("updatedAt")?.trim();
    if (!expectedUpdatedAt) {
      return Response.json({ error: "Actualiza el inventario antes de eliminar el lote ganadero." }, { status: 409 });
    }

    const fieldId = await resolveResourceFieldId("lot", id);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const deleted = await deleteLivestockLot(id, access, expectedUpdatedAt);
    if (!deleted) return Response.json({ error: "El lote ganadero no existe." }, { status: 404 });
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true });
  } catch (cause) {
    return livestockLotError(cause, "livestock.lot.delete", "No fue posible eliminar el lote ganadero.");
  }
}

function livestockLotError(cause: unknown, operation: string, fallback: string) {
  if (cause instanceof Error && "code" in cause && cause.code === "FIELD_SCOPE_CONFLICT") {
    return Response.json({ error: cause.message }, { status: 409 });
  }
  if (cause instanceof DomainRuleError) {
    return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

function validateLivestockLot(payload: Partial<LivestockLot>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del lote.";
  if (!payload.fieldId?.trim()) return "Selecciona un fundo.";
  if (!payload.name?.trim()) return "Ingresa un nombre para el lote.";
  if (!payload.category || !(payload.category in LIVESTOCK_CATEGORY_LABELS)) return "La categoría no es válida.";
  if (payload.trackingMode !== "summary" && payload.trackingMode !== "individual") return "El modo de trazabilidad no es válido.";
  if (typeof payload.animalCount !== "number" || !Number.isInteger(payload.animalCount) || payload.animalCount < 0) return "La cantidad de animales debe ser un número entero desde cero.";
  if (payload.trackingMode === "summary" && payload.animalCount === 0) return "La cantidad de animales debe ser mayor que cero en el modo de resumen.";
  if (payload.averageWeightKg !== null && payload.averageWeightKg !== undefined && (!Number.isFinite(payload.averageWeightKg) || payload.averageWeightKg <= 0)) return "El peso promedio debe ser mayor que cero.";
  if (!payload.entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(payload.entryDate)) return "Indica una fecha de ingreso válida.";
  if (!payload.status || !(payload.status in LIVESTOCK_STATUS_LABELS)) return "El estado no es válido.";
  return null;
}
import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
} from "@/app/access";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
