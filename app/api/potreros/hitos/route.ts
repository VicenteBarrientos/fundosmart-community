import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  archiveFieldLandmark,
  listFieldLandmarks,
  upsertFieldLandmark,
} from "@/src/modules/potreros/server/field-landmark-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;
    const fieldId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const landmarks = await listFieldLandmarks(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ landmarks });
  } catch (cause) {
    return landmarkError(cause);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload: unknown = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    const fieldId = recordText(payload, "fieldId");
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const result = await upsertFieldLandmark(payload, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result }, result.kind === "create" && !result.idempotentReplay ? 201 : 200);
  } catch (cause) {
    return landmarkError(cause);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload: unknown = await readJsonObject(request);
    if (payload instanceof Response) return payload;
    const fieldId = recordText(payload, "fieldId");
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const result = await archiveFieldLandmark(payload, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result });
  } catch (cause) {
    return landmarkError(cause);
  }
}

function recordText(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function landmarkError(cause: unknown): Response {
  if (cause instanceof DomainRuleError) {
    return privateJson(
      { error: cause.message, code: cause.code },
      cause.code === "FIELD_LANDMARK_INVALID" ? 422 : 409,
    );
  }
  if (cause instanceof Error && cause.message.includes("no such table")) {
    return privateJson({ error: "La base de datos todavía no está preparada." }, 503);
  }
  return privateJson({ error: "No fue posible procesar los hitos del fundo." }, 500);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
