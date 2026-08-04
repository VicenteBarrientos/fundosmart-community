import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { PaddockRotationSettingsUpdateRequest } from "@/src/modules/potreros/domain/cells-rotation";
import {
  getPaddockRotationSnapshot,
  updatePaddockRotationSettings,
} from "@/src/modules/potreros/server/paddock-rotation-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;
    const url = new URL(request.url);
    const fieldId = url.searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const referenceDate = url.searchParams.get("fecha")?.trim() || undefined;
    const rotation = await getPaddockRotationSnapshot(fieldId, access, referenceDate);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ rotation });
  } catch (cause) {
    return rotationError(cause);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockRotationSettingsUpdateRequest>>(request);
    if (payload instanceof Response) return payload;
    const error = !payload.fieldId?.trim()
      ? "Selecciona un fundo."
      : !payload.operationId?.trim()
        ? "Falta el identificador estable del cambio."
        : !Number.isInteger(payload.recentDays) || !Number.isInteger(payload.longRestDays)
          ? "Los umbrales deben ser días enteros."
          : payload.expectedVersion !== null && !Number.isInteger(payload.expectedVersion)
            ? "La versión esperada no es válida."
            : null;
    if (error) return privateJson({ error }, 400);
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;
    const result = await updatePaddockRotationSettings(payload as PaddockRotationSettingsUpdateRequest, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result });
  } catch (cause) {
    return rotationError(cause);
  }
}

function rotationError(cause: unknown): Response {
  if (cause instanceof DomainRuleError) {
    const status = cause.code === "PADDOCK_ROTATION_INVALID" ? 422 : 409;
    return privateJson({ error: cause.message, code: cause.code }, status);
  }
  if (cause instanceof Error && cause.message.includes("no such table")) {
    return privateJson({ error: "La base de datos todavía no está preparada." }, 503);
  }
  return privateJson({ error: "No fue posible calcular la rotación de potreros." }, 500);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
