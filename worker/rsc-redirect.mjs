/* vinext responde 307 para normalizar `?_rsc=<hash>` a `?_rsc`, y ese salto le
   costaba un viaje completo al navegador en cada cambio de módulo y en cada
   prefetch. La reescritura la absorbe el Worker: sigue el redirect por dentro y
   devuelve la respuesta final, así el navegador conserva su URL y paga un solo
   viaje.

   La condición es deliberadamente estrecha —mismo origen, misma ruta y única
   diferencia en `_rsc`— porque los redirects que sí importan (a `/cuenta`
   cuando falta sesión, a `/app/espacios` cuando la membresía es ambigua) cambian
   de ruta y tienen que seguir llegando al navegador. */

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const RSC_QUERY_PARAM = "_rsc";

function queryWithoutRsc(url) {
  const params = new URLSearchParams(url.search);
  params.delete(RSC_QUERY_PARAM);
  params.sort();
  return params.toString();
}

/**
 * Devuelve la URL final cuando la respuesta es sólo la normalización de `_rsc`,
 * o `null` cuando es un redirect real que el navegador debe ver.
 */
export function rscNormalizationTarget(request, response) {
  if (!SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if (response.status !== 307 && response.status !== 308) return null;

  const location = response.headers.get("Location");
  if (!location) return null;

  let requestUrl;
  let targetUrl;
  try {
    requestUrl = new URL(request.url);
    targetUrl = new URL(location, requestUrl);
  } catch {
    return null;
  }

  if (targetUrl.origin !== requestUrl.origin) return null;
  if (targetUrl.pathname !== requestUrl.pathname) return null;
  if (!requestUrl.searchParams.has(RSC_QUERY_PARAM)) return null;
  if (!targetUrl.searchParams.has(RSC_QUERY_PARAM)) return null;
  if (queryWithoutRsc(requestUrl) !== queryWithoutRsc(targetUrl)) return null;

  return targetUrl;
}
