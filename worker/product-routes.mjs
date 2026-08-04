/* Las rutas públicas del producto viven bajo `/app`, pero el App Router las
   sirve desde su propio segmento (`/app` → `/dashboard`, `/app/x` → `/x`). */

/* El router cliente pide la carga RSC como `<ruta>.rsc`. `/app.rsc` no calzaba
   ni con `=== "/app"` ni con `startsWith("/app/")`, así que llegaba sin
   reescribir y Next respondía 404: cada vuelta al Resumen se degradaba a una
   recarga completa del documento en vez de una navegación de cliente. */
const RSC_SUFFIX = ".rsc";

export const PRODUCT_ROOT_ROUTE = "/dashboard";

export function productRoutePath(pathname) {
  const suffix = pathname.endsWith(RSC_SUFFIX) ? RSC_SUFFIX : "";
  const base = suffix ? pathname.slice(0, -RSC_SUFFIX.length) : pathname;
  if (base === "/app") return `${PRODUCT_ROOT_ROUTE}${suffix}`;
  if (base.startsWith("/app/")) return `${base.slice(4)}${suffix}`;
  return null;
}
