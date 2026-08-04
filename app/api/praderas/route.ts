import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { PastureDomainError } from "@/src/modules/praderas/domain/pasture-planning.mjs";
import type { CreatePastureRotationPlanRequest, ManualPastureObservationRequest } from "@/src/modules/praderas/domain/types";
import {
  PastureScopeError,
  createPastureRotationPlan,
  getPastureDashboard,
  recordManualPastureObservation,
} from "@/src/modules/praderas/server/pasture-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const fieldId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const access = await authorizeApiAccess("pastoreo:read", fieldId);
    if (isAccessResponse(access)) return access;
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const pasture = await getPastureDashboard(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "pastoreo:read", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ pasture });
  } catch (cause) {
    return pastureError(cause, "pasture.dashboard", "No fue posible cargar las praderas.");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authenticated = await authorizeApiAccess("operate");
    if (isAccessResponse(authenticated)) return authenticated;
    const payload = await readJsonObject<Record<string, unknown>>(request);
    if (payload instanceof Response) return payload;
    const fieldId = text(payload.fieldId);
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const access = await authorizeApiAccess("pastoreo:write", fieldId);
    if (isAccessResponse(access)) return access;
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;

    if (payload.action === "record_manual_sample") {
      const observation = await recordManualPastureObservation(payload as unknown as ManualPastureObservationRequest, access);
      const currentAccess = await reauthorizeApiAccess(access, "pastoreo:write", fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return privateJson({ observation }, observation.idempotentReplay ? 200 : 201);
    }
    if (payload.action === "create_rotation_plan") {
      const result = await createPastureRotationPlan(payload as unknown as CreatePastureRotationPlanRequest, access);
      const currentAccess = await reauthorizeApiAccess(access, "pastoreo:write", fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return privateJson({ plan: result }, 201);
    }
    return privateJson({ error: "La acción de praderas no es válida." }, 400);
  } catch (cause) {
    return pastureError(cause, "pasture.mutation", "No fue posible guardar el manejo de praderas.");
  }
}

function pastureError(cause: unknown, operation: string, fallback: string): Response {
  if (cause instanceof PastureScopeError) return privateJson({ error: cause.message, code: cause.code }, 409);
  if (cause instanceof PastureDomainError) {
    const status = cause.code === "PASTURE_RAW_TOO_LARGE" ? 413
      : cause.code === "PASTURE_RAW_STORAGE_FAILED" ? 503
        : cause.code.includes("CONFLICT") || cause.code === "PASTURE_RAW_PENDING" ? 409
          : 422;
    return privateJson({ error: cause.message, code: cause.code }, status);
  }
  if (cause instanceof Error && cause.message.includes("no such table")) {
    return privateJson({ error: "La base de datos todavía no está preparada para praderas." }, 503);
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
