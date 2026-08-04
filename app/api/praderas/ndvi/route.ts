import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { PastureDomainError } from "@/src/modules/praderas/domain/pasture-planning.mjs";
import { enqueuePastureNdviCollection, getPastureProviderDecision } from "@/src/modules/praderas/server/pasture-repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const fieldId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const access = await authorizeApiAccess("pastoreo:read", fieldId);
    if (isAccessResponse(access)) return access;
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const provider = await getPastureProviderDecision(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "pastoreo:read", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ provider });
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("no such table")) {
      return privateJson({ error: "La base de datos todavía no está preparada para NDVI." }, 503);
    }
    return unexpectedApiFailure("pasture.ndvi.provider", "No fue posible consultar la decisión NDVI.", cause);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authenticated = await authorizeApiAccess("operate");
    if (isAccessResponse(authenticated)) return authenticated;
    const payload = await readJsonObject<Record<string, unknown>>(request);
    if (payload instanceof Response) return payload;
    const fieldId = typeof payload.fieldId === "string" ? payload.fieldId.trim() : "";
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const access = await authorizeApiAccess("pastoreo:write", fieldId);
    if (isAccessResponse(access)) return access;
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    if (!env.CDSE_CLIENT_ID?.trim() || !env.CDSE_CLIENT_SECRET?.trim()) {
      return privateJson({ error: "La ingesta NDVI no tiene credenciales CDSE configuradas.", code: "CDSE_NOT_CONFIGURED" }, 503);
    }
    const queue = await enqueuePastureNdviCollection(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "pastoreo:write", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ queue }, 202);
  } catch (cause) {
    if (cause instanceof PastureDomainError) {
      const status = cause.code === "PASTURE_NDVI_COLLECTION_IN_PROGRESS" ? 409 : 422;
      return privateJson({ error: cause.message, code: cause.code }, status);
    }
    return unexpectedApiFailure("pasture.ndvi.enqueue", "No fue posible programar la ingesta NDVI.", cause);
  }
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
