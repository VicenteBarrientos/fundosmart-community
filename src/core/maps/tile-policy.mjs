const MEBIBYTE = 1024 * 1024;

/**
 * Hosts que nunca pueden reaparecer en el runtime. Son los endpoints anónimos de
 * ArcGIS retirados por la política de proveedores: se usaban sin relación contractual y sus términos
 * exigen software o suscripción Esri. Que hoy exista un catálogo licenciado no los
 * rehabilita; el problema nunca fue el proveedor sino la ausencia de licencia.
 */
export const FORBIDDEN_TILE_HOSTS = Object.freeze([
  "server.arcgisonline.com",
  "services.arcgisonline.com",
  "ibasemaps-api.arcgis.com",
]);

/**
 * Host del servicio licenciado de estilos de mapa base. Solo puede aparecer detrás
 * de una entrada de catálogo que declare `requiresCredential: true`.
 */
export const LICENSED_BASEMAP_HOST = "basemapstyles-api.arcgis.com";

export const MAP_TILE_POLICY = {
  version: "fundosmart.map-tiles.v1",
  online: {
    id: "osm",
    provider: "OpenStreetMap Standard",
    mode: "interactive_online_only",
    urlTemplate: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
    prefetchAllowed: false,
    applicationCacheAllowed: false,
  },
  offline: {
    enabled: false,
    selectedArchitecture: "self_hosted_pmtiles_on_r2",
    maximumPackBytes: 512 * MEBIBYTE,
    maximumTileEquivalents: 11_000,
  },
  exports: {
    thirdPartyBasemapEnabled: false,
  },
};

/**
 * Catálogo de mapas base. Se agrega de forma aditiva sobre `MAP_TILE_POLICY`, que
 * conserva su versión: `online` sigue describiendo el fallback incondicional y no
 * cambió de forma.
 *
 * Las entradas de ArcGIS declaran el nombre de estilo, no una URL. Construir el
 * endpoint es responsabilidad del plugin oficial, para que este módulo no fije una
 * ruta que el proveedor puede cambiar.
 *
 * Ninguna entrada licenciada participa del service worker, de descargas offline ni
 * de exportaciones impresas: `exports.thirdPartyBasemapEnabled` sigue en `false` y
 * `offline.enabled` también.
 */
export const MAP_BASEMAP_CATALOG = {
  version: "fundosmart.map-catalog.v1",
  fallbackId: "osm",
  providers: Object.freeze([
    {
      id: "osm",
      label: "OpenStreetMap",
      description: "Mapa colaborativo · solo con conexión",
      surface: "raster",
      urlTemplate: MAP_TILE_POLICY.online.urlTemplate,
      attribution: MAP_TILE_POLICY.online.attribution,
      maxNativeZoom: MAP_TILE_POLICY.online.maxNativeZoom,
      requiresCredential: false,
      isFallback: true,
    },
    {
      id: "satelite",
      label: "Satélite",
      description: "Imagen satelital · requiere conexión",
      surface: "vector-basemap",
      styleName: "arcgis/imagery",
      attribution: "Powered by Esri · Vantor, Earthstar Geographics",
      maxNativeZoom: 18,
      requiresCredential: true,
      isFallback: false,
    },
    {
      id: "topografico",
      label: "Topográfico",
      description: "Curvas de nivel y referencias · requiere conexión",
      surface: "vector-basemap",
      styleName: "arcgis/topographic",
      attribution: "Powered by Esri",
      maxNativeZoom: 19,
      requiresCredential: true,
      isFallback: false,
    },
    {
      id: "relieve",
      label: "Relieve",
      description: "Sombreado de terreno · requiere conexión",
      surface: "vector-basemap",
      styleName: "arcgis/terrain",
      attribution: "Powered by Esri",
      maxNativeZoom: 19,
      requiresCredential: true,
      isFallback: false,
    },
  ]),
};

/** Superficies del producto donde puede pedirse un mapa base. */
export const BASEMAP_SURFACES = Object.freeze(["operar", "editar"]);

/**
 * Costura de derecho de uso. Hoy autoriza todo: la decisión de producto es que las
 * teselas estén siempre disponibles mientras se mide el consumo real.
 *
 * Existe desde ahora, y no después, porque convertir esto en un límite de plan más
 * adelante debe ser un cambio en esta función y no una comprobación nueva repartida
 * por todo el mapa. El caso previsto —Satélite gratis en `editar`, de pago en
 * `operar`— ya está escrito abajo, inactivo.
 */
export function basemapEntitlement({ basemapId, surface, plan = "free" }) {
  if (!BASEMAP_SURFACES.includes(surface)) {
    return { allowed: false, reason: "unknown-surface" };
  }
  const provider = basemapProviderById(basemapId);
  if (!provider) return { allowed: false, reason: "unknown-basemap" };

  // Variante prevista, deliberadamente inactiva hasta que el consumo medido la
  // justifique. Activarla es cambiar esta condición y nada más:
  // if (provider.requiresCredential && surface === "operar" && plan === "free") {
  //   return { allowed: false, reason: "requires-paid-plan" };
  // }
  void plan;

  return { allowed: true, reason: "always-available-while-measuring" };
}

export function basemapProviderById(basemapId) {
  return MAP_BASEMAP_CATALOG.providers.find((provider) => provider.id === basemapId) ?? null;
}

export function fallbackBasemap() {
  return basemapProviderById(MAP_BASEMAP_CATALOG.fallbackId);
}

/**
 * Resuelve qué mapa base se dibuja realmente. Degrada a OSM sin excepción cuando
 * falta la credencial, cuando el proveedor falla o cuando el derecho de uso no
 * alcanza. Nunca devuelve `null`: la ausencia de mapa base jamás puede bloquear la
 * captura, el guardado, la exportación ni la sincronización.
 */
export function resolveBasemap({
  basemapId,
  surface,
  plan = "free",
  credentialPresent = false,
  providerHealthy = true,
}) {
  const requested = basemapProviderById(basemapId);
  const fallback = fallbackBasemap();
  if (!requested) return { provider: fallback, degraded: true, reason: "unknown-basemap" };
  if (!requested.requiresCredential) return { provider: requested, degraded: false, reason: null };

  const entitlement = basemapEntitlement({ basemapId, surface, plan });
  if (!entitlement.allowed) return { provider: fallback, degraded: true, reason: entitlement.reason };
  if (!credentialPresent) return { provider: fallback, degraded: true, reason: "missing-credential" };
  if (!providerHealthy) return { provider: fallback, degraded: true, reason: "provider-unavailable" };

  return { provider: requested, degraded: false, reason: null };
}

/** Respuestas del proveedor que obligan a degradar a OSM sin reintentar en caliente. */
export const PROVIDER_DEGRADE_STATUSES = Object.freeze([401, 403, 429, 500, 502, 503, 504]);

export function shouldDegradeOnStatus(status) {
  return PROVIDER_DEGRADE_STATUSES.includes(status);
}

/**
 * Contrato del contador de consumo. Las teselas las pide el navegador directo al
 * proveedor, así que el servidor no puede contarlas: el cliente reporta un agregado.
 *
 * Por eso el contrato es deliberadamente pobre. Cumple la sección 12.1 del plan
 * maestro: enums cerrados y conteos, jamás coordenadas, geometría, superficie,
 * nombres, identificadores reales ni texto libre. Un reporte que incluya cualquier
 * campo fuera de esta lista es un defecto, no una mejora.
 */
export const TILE_USAGE_REPORT_CONTRACT = Object.freeze({
  version: "fundosmart.map-tile-usage.v1",
  allowedFields: Object.freeze(["basemapId", "surface", "tileCount", "degraded", "sessionSeq"]),
  forbiddenFields: Object.freeze([
    "latitude",
    "longitude",
    "bbox",
    "center",
    "zoom",
    "geometry",
    "paddockId",
    "fieldId",
    "name",
    "areaHectares",
  ]),
});

export const MAX_TILE_USAGE_REPORT_TILES = 512;
export const MAX_TILE_USAGE_SESSION_SEQ = 2_147_483_647;

export function isValidTileUsageReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  const keys = Object.keys(report);
  if (keys.length !== TILE_USAGE_REPORT_CONTRACT.allowedFields.length) return false;
  if (keys.some((key) => !TILE_USAGE_REPORT_CONTRACT.allowedFields.includes(key))) return false;
  if (TILE_USAGE_REPORT_CONTRACT.allowedFields.some((key) => !Object.hasOwn(report, key))) return false;
  if (!Number.isSafeInteger(report.tileCount)
    || report.tileCount < 0
    || report.tileCount > MAX_TILE_USAGE_REPORT_TILES) return false;
  if (typeof report.degraded !== "boolean") return false;
  if (!Number.isSafeInteger(report.sessionSeq)
    || report.sessionSeq < 1
    || report.sessionSeq > MAX_TILE_USAGE_SESSION_SEQ) return false;
  if (!BASEMAP_SURFACES.includes(report.surface)) return false;
  return basemapProviderById(report.basemapId) !== null;
}
