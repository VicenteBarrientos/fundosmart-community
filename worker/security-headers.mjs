const RESPONSE_HEADER_DEFAULTS = Object.freeze({
  "Content-Security-Policy": "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  "Permissions-Policy": "camera=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const HSTS_VALUE = "max-age=31536000";
const NO_INDEX_VALUE = "noindex, nofollow";
const PRIVATE_NO_STORE_VALUE = "private, no-store";
const SENSITIVE_ROUTE_PREFIXES = Object.freeze([
  "/api",
  "/app",
  "/auth",
  "/configuracion",
  "/costos",
  "/cuenta",
  "/dashboard",
  "/demo",
  "/espacios",
  "/ganado",
  "/healthz",
  "/importaciones",
  "/integraciones",
  "/leche",
  "/potreros",
  "/sin-acceso",
]);

function isSensitiveRoute(pathname) {
  return SENSITIVE_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function withSecurityHeaders(response, requestUrl) {
  const secured = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  for (const [name, value] of Object.entries(RESPONSE_HEADER_DEFAULTS)) {
    if (!secured.headers.has(name)) secured.headers.set(name, value);
  }

  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const sensitiveRoute = isSensitiveRoute(url.pathname);
  if (url.protocol === "https:" && !secured.headers.has("Strict-Transport-Security")) {
    secured.headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
  if (sensitiveRoute) {
    secured.headers.set("Cache-Control", PRIVATE_NO_STORE_VALUE);
  }
  if (sensitiveRoute && !secured.headers.has("X-Robots-Tag")) {
    secured.headers.set("X-Robots-Tag", NO_INDEX_VALUE);
  }

  return secured;
}
