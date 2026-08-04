import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import type { LivestockFeedingPlan } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  deleteLivestockFeedingPlan,
  listLivestockFeedingPlans,
  upsertLivestockFeedingPlan,
} from "@/src/modules/ganado/server/livestock-ration-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const plans = await listLivestockFeedingPlans(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { plans },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "No fue posible cargar el plan de alimentación." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<LivestockFeedingPlan>>(request);
    if (payload instanceof Response) return payload;
    const error = validatePlan(payload);
    if (error) return Response.json({ error }, { status: 400 });
    const targetFieldId = await resolveResourceFieldId("lot", payload.lotId!);
    const targetForbidden = requireContextField(access, targetFieldId);
    if (targetForbidden) return targetForbidden;
    const existingFieldId = await resolveResourceFieldId("feeding_plan", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
      if (!payload.updatedAt?.trim()) {
        return Response.json({ error: "Actualiza el plan de alimentación antes de editar." }, { status: 409 });
      }
    }

    const now = new Date().toISOString();
    const plan = await upsertLivestockFeedingPlan({
      id: payload.id!.trim(),
      lotId: payload.lotId!.trim(),
      productName: payload.productName!.trim(),
      kgPerAnimalDay: payload.kgPerAnimalDay!,
      sackWeightKg: payload.sackWeightKg!,
      notes: payload.notes?.trim() ?? "",
      createdAt: payload.createdAt ?? now,
      updatedAt: payload.updatedAt?.trim() ?? now,
    }, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", targetFieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ plan }, { status: 201 });
  } catch (cause) {
    return feedingPlanMutationError(cause, "livestock.ration.save", "No fue posible guardar el plan de alimentación.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const url = new URL(request.url);
    const id = url.searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del plan." }, { status: 400 });
    const expectedUpdatedAt = url.searchParams.get("updatedAt")?.trim();
    if (!expectedUpdatedAt) {
      return Response.json({ error: "Actualiza el plan de alimentación antes de eliminar." }, { status: 409 });
    }
    const fieldId = await resolveResourceFieldId("feeding_plan", id);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const deleted = await deleteLivestockFeedingPlan(id, access, expectedUpdatedAt);
    if (!deleted) return Response.json({ error: "El plan no existe." }, { status: 404 });
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true });
  } catch (cause) {
    return feedingPlanMutationError(cause, "livestock.ration.delete", "No fue posible eliminar el plan de alimentación.");
  }
}

function feedingPlanMutationError(cause: unknown, operation: string, fallback: string): Response {
  if (cause instanceof DomainRuleError) {
    if (cause.code === "FIELD_SCOPE_CONFLICT") return Response.json({ error: cause.message }, { status: 409 });
    return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

function validatePlan(payload: Partial<LivestockFeedingPlan>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del plan.";
  if (!payload.lotId?.trim()) return "Selecciona un lote.";
  if (!payload.productName?.trim()) return "Indica el alimento o escribe Sin concentrado.";
  if (!Number.isFinite(payload.kgPerAnimalDay) || (payload.kgPerAnimalDay as number) < 0) return "Los kilos por animal no pueden ser negativos.";
  if (!Number.isFinite(payload.sackWeightKg) || (payload.sackWeightKg as number) <= 0) return "El peso del saco debe ser mayor que cero.";
  return null;
}
