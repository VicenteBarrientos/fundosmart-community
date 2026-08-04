import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import {
  AnalyticsConflictError,
  AnalyticsRequestError,
  AnalyticsScopeError,
  enqueueAnalyticsRecompute,
} from "@/src/modules/analytics/server/analytics-repository";

export const dynamic = "force-dynamic";

type RecomputeRequest = {
  fieldId?: unknown;
  period?: unknown;
  expectedSourceRevision?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) {
    return privateJson({ error: "La solicitud no proviene de FundoSmart.", code: "CSRF_REJECTED" }, 403);
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    return privateJson({ error: "La solicitud es demasiado grande." }, 413);
  }

  try {
    const payload = await readJsonObject<RecomputeRequest>(request);
    if (payload instanceof Response) return payload;
    const fieldId = text(payload.fieldId, 120);
    const period = text(payload.period, 7);
    const expectedSourceRevision = payload.expectedSourceRevision === null
      ? null
      : text(payload.expectedSourceRevision, 64);
    if (!fieldId || !period || (payload.expectedSourceRevision !== null && !expectedSourceRevision)) {
      return privateJson({ error: "Indica fundo, período y revisión esperada." }, 400);
    }

    const writeAccess = await authorizeApiAccess("manage_imports", fieldId);
    if (isAccessResponse(writeAccess)) return writeAccess;
    const access = await authorizeApiAccess("analitica:read", fieldId);
    if (isAccessResponse(access)) return access;
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    if (!roleHasCapability(access.role, "manage_imports")) {
      return privateJson({ error: "Tu rol no permite recalcular proyecciones.", code: "CAPABILITY_REQUIRED" }, 403);
    }
    const job = await enqueueAnalyticsRecompute({
      actor: access,
      fieldId,
      period,
      expectedSourceRevision,
    });
    const currentAccess = await reauthorizeApiAccess(access, "analitica:read", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    if (!roleHasCapability(currentAccess.role, "manage_imports")) {
      return privateJson({ error: "Tu rol no permite recalcular proyecciones.", code: "CAPABILITY_REQUIRED" }, 403);
    }
    return privateJson({ job }, 202);
  } catch (cause) {
    if (cause instanceof AnalyticsRequestError) return privateJson({ error: cause.message, code: cause.code }, 400);
    if (cause instanceof AnalyticsConflictError) return privateJson({ error: cause.message, code: cause.code }, 409);
    if (cause instanceof AnalyticsScopeError) return privateJson({ error: "La analítica solicitada no está disponible." }, 404);
    return unexpectedApiFailure("analytics.recompute.enqueue", "No fue posible solicitar el recálculo.", cause);
  }
}

function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

function text(value: unknown, maximum: number): string {
  return typeof value === "string" && value.trim().length <= maximum ? value.trim() : "";
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
