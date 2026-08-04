const KNOWN_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "SCHEDULED"]);
const KNOWN_ENVIRONMENTS = new Set(["production", "staging", "local"]);

function boundedLabel(value, fallback, maxLength = 64) {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9._/-]/g, "_").slice(0, maxLength);
  return normalized || fallback;
}

function environmentLabel(env) {
  const value = String(env?.FUNDOSMART_DEPLOY_ENVIRONMENT ?? "local").toLowerCase();
  return KNOWN_ENVIRONMENTS.has(value) ? value : "unknown";
}

function releaseLabel(env) {
  const value = String(env?.FUNDOSMART_RELEASE_SHA ?? "").toLowerCase();
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : "unknown";
}

function methodLabel(method) {
  const value = String(method ?? "").toUpperCase();
  return KNOWN_METHODS.has(value) ? value : "OTHER";
}

function statusFamily(status) {
  const numeric = Number(status);
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599
    ? `${Math.floor(numeric / 100)}xx`
    : "unknown";
}

export function safeErrorType(cause) {
  return boundedLabel(cause instanceof Error ? cause.name : typeof cause, "unknown", 40);
}

/* Etiquetas acotadas: la lista es fija para que la métrica no crezca con datos
   del usuario. Un módulo desconocido cae en `product.other` en vez de abrir una
   dimensión nueva. */
const PRODUCT_MODULES = new Set([
  "analitica",
  "benchmarking",
  "configuracion",
  "costos",
  "cuenta",
  "espacios",
  "ganado",
  "importaciones",
  "integraciones",
  "leche",
  "potreros",
  "praderas",
  "reportes",
  "sin-acceso",
  "staff",
  "trazabilidad",
]);

const RSC_SUFFIX = ".rsc";

/* Distinguir el documento de su carga RSC separa el primer ingreso del cambio
   de módulo, que son los dos costos que se miden por separado. */
function productRouteLabel(pathname) {
  const isRscPayload = pathname.endsWith(RSC_SUFFIX);
  const base = isRscPayload ? pathname.slice(0, -RSC_SUFFIX.length) : pathname;
  const segment = base === "/app" ? "" : base.slice("/app/".length).split("/")[0];
  const moduleLabel = segment === ""
    ? "resumen"
    : PRODUCT_MODULES.has(segment) ? segment : "other";
  return isRscPayload ? `product.${moduleLabel}.rsc` : `product.${moduleLabel}`;
}

function isProductPath(pathname) {
  return pathname === "/app"
    || pathname === `/app${RSC_SUFFIX}`
    || pathname.startsWith("/app/");
}

export function classifyOperationalRoute(pathname) {
  if (pathname === "/") return "landing";
  if (pathname === "/healthz") return "health";
  if (pathname === "/demo") return "demo";
  if (pathname === "/cuenta") return "account";
  if (pathname === "/_vinext/image") return "image";
  /* Antes esta rama se quedaba con `/app/ganado.rsc`, así que cada navegación de
     cliente se contabilizaba como recurso estático y el producto sólo mostraba
     los ingresos en frío. */
  if (isProductPath(pathname)) return productRouteLabel(pathname);
  if (pathname.startsWith("/_next/") || pathname.includes(".")) return "asset";
  if (pathname === "/api/configuracion/accesos") return "api.access";
  if (pathname === "/api/configuracion/funcionalidades") return "api.features";
  if (pathname === "/api/sync") return "api.sync";
  if (pathname === "/api/offline/session") return "api.offline.session";
  if (pathname === "/api/offline/attachments") return "api.offline.attachments";
  if (pathname.startsWith("/api/analitica")) return "api.analytics";
  if (pathname.startsWith("/api/benchmarking")) return "api.benchmarking";
  if (pathname.startsWith("/api/trazabilidad")) return "api.traceability";
  if (pathname.startsWith("/api/importaciones")) return "api.imports";
  if (pathname.startsWith("/api/integraciones/cooprinsem")) return "api.cooprinsem";
  if (pathname.startsWith("/api/ganado/plata")) return "api.livestock-finance";
  if (pathname.startsWith("/api/ganado")) return "api.livestock";
  if (pathname.startsWith("/api/leche")) return "api.milk";
  if (pathname.startsWith("/api/praderas")) return "api.pastures";
  if (pathname.startsWith("/api/potreros") || pathname.startsWith("/api/subdivisiones")) return "api.paddocks";
  if (pathname.startsWith("/api/fundos")) return "api.fields";
  if (pathname.startsWith("/api/actividades")) return "api.activities";
  if (pathname.startsWith("/api/")) return "api.other";
  if (/^\/(analitica|benchmarking|configuracion|costos|dashboard|ganado|importaciones|integraciones|leche|potreros|praderas|sin-acceso|trazabilidad)(\/|$)/.test(pathname)) {
    return "legacy-product";
  }
  return "other";
}

function writeMetric(env, observation, logger) {
  if (!env?.METRICS) return;
  try {
    env.METRICS.writeDataPoint({
      indexes: [observation.environment],
      blobs: [
        observation.route,
        observation.method,
        observation.statusFamily,
        observation.outcome,
        observation.release,
      ],
      doubles: [observation.durationMs, observation.status],
    });
  } catch {
    logger.warn(JSON.stringify({
      event: "observability.metric_write_failed",
      environment: observation.environment,
      route: observation.route,
    }));
  }
}

export function recordOperationObservation({
  env,
  route,
  method,
  status,
  outcome,
  durationMs,
  logger = console,
  cfRay = undefined,
}) {
  const numericDuration = Number(durationMs);
  const observation = {
    event: "operation.completed",
    environment: environmentLabel(env),
    release: releaseLabel(env),
    route: boundedLabel(route, "other"),
    method: methodLabel(method),
    status: Number.isInteger(status) ? status : 500,
    statusFamily: statusFamily(status),
    outcome: outcome === "success" ? "success" : "failure",
    durationMs: Number.isFinite(numericDuration)
      ? Math.max(0, Math.round(numericDuration * 100) / 100)
      : 0,
    ...(cfRay ? { cfRay: boundedLabel(cfRay, "unknown", 64) } : {}),
  };

  logger.log(JSON.stringify(observation));
  writeMetric(env, observation, logger);
  return observation;
}

export async function observeRequest(request, env, operation, {
  clock = performance,
  logger = console,
} = {}) {
  const startedAt = clock.now();
  const route = classifyOperationalRoute(new URL(request.url).pathname);
  try {
    const response = await operation();
    recordOperationObservation({
      env,
      route,
      method: request.method,
      status: response.status,
      outcome: response.status >= 500 ? "failure" : "success",
      durationMs: clock.now() - startedAt,
      logger,
      cfRay: request.headers.get("cf-ray"),
    });
    return response;
  } catch (cause) {
    logger.error(JSON.stringify({
      event: "operation.failed",
      environment: environmentLabel(env),
      release: releaseLabel(env),
      route,
      method: methodLabel(request.method),
      errorType: safeErrorType(cause),
    }));
    recordOperationObservation({
      env,
      route,
      method: request.method,
      status: 500,
      outcome: "failure",
      durationMs: clock.now() - startedAt,
      logger,
      cfRay: request.headers.get("cf-ray"),
    });
    throw cause;
  }
}

export async function healthResponse(env, { logger = console } = {}) {
  try {
    const result = await env.DB.prepare("SELECT 1 AS ok").first();
    if (result?.ok !== 1) throw new Error("Unexpected health result");
    return Response.json(
      {
        status: "ok",
        environment: environmentLabel(env),
        release: releaseLabel(env),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    logger.error(JSON.stringify({
      event: "health.database_unavailable",
      environment: environmentLabel(env),
      release: releaseLabel(env),
      errorType: safeErrorType(cause),
    }));
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
