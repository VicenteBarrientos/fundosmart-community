import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  AnalyticsRequestError,
  AnalyticsScopeError,
  getAnalyticsDashboard,
} from "@/src/modules/analytics/server/analytics-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const fieldId = params.get("fieldId")?.trim();
  const period = params.get("period")?.trim();
  if (!fieldId || !period) return privateJson({ error: "Selecciona un fundo y un período." }, 400);

  try {
    const access = await authorizeApiAccess("analitica:read", fieldId);
    if (isAccessResponse(access)) return access;
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const analytics = await getAnalyticsDashboard({ actor: access, fieldId, period });
    const currentAccess = await reauthorizeApiAccess(access, "analitica:read", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ analytics });
  } catch (cause) {
    if (cause instanceof AnalyticsRequestError) return privateJson({ error: cause.message, code: cause.code }, 400);
    if (cause instanceof AnalyticsScopeError) return privateJson({ error: "La analítica solicitada no está disponible." }, 404);
    return unexpectedApiFailure("analytics.dashboard.read", "No fue posible cargar la analítica del fundo.", cause);
  }
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
