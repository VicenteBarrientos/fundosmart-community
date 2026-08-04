import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { PaddockNdviRefreshRequest } from "@/src/modules/potreros/domain/paddock-ndvi";
import { listPaddockNdvi, refreshPaddockNdvi } from "@/src/modules/potreros/ndvi/paddock-ndvi-service";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;
    const fieldId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const ndvi = await listPaddockNdvi(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ ndvi });
  } catch (cause) {
    return ndviError(cause);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockNdviRefreshRequest>>(request);
    if (payload instanceof Response) return payload;
    const fieldId = payload.fieldId?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const ndvi = await refreshPaddockNdvi(fieldId, access, {
      clientId: env.CDSE_CLIENT_ID,
      clientSecret: env.CDSE_CLIENT_SECRET,
    });
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ ndvi });
  } catch (cause) {
    return ndviError(cause);
  }
}

function ndviError(cause: unknown): Response {
  if (cause instanceof DomainRuleError) {
    const status = cause.code === "PADDOCK_NDVI_INVALID" ? 422 : 409;
    return privateJson({ error: cause.message, code: cause.code }, status);
  }
  if (cause instanceof Error && cause.message.includes("no such table")) {
    return privateJson({ error: "La base de datos todavía no está preparada." }, 503);
  }
  return privateJson({ error: "No fue posible procesar el NDVI de los potreros." }, 500);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
