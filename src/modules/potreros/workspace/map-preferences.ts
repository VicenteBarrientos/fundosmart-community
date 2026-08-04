import { MAP_BASEMAP_CATALOG, resolveBasemap } from "../../../core/maps/tile-policy.mjs";

export type BasemapId = "osm" | "satelite" | "topografico" | "relieve";
export type BasemapSurface = "operar" | "editar";

export type BasemapDefinition = {
  id: BasemapId;
  label: string;
  description: string;
  /** Solo las capas raster traen plantilla de URL; las vectoriales traen estilo. */
  url?: string;
  styleName?: string;
  attribution: string;
  maxNativeZoom: number;
  requiresCredential: boolean;
};

/**
 * La preferencia inicial sigue siendo OSM. El satelital se ofrece, no se impone:
 * §8.3 del plan maestro pide conservar la última elección válida del usuario.
 */
export const DEFAULT_BASEMAP_ID: BasemapId = "osm";

/**
 * Credencial pública de mapas base. Viaja al navegador por diseño; lo que la
 * protege es su alcance limitado a basemaps, no el ocultamiento. Ausente, todo
 * degrada a OSM sin bloquear nada.
 */
export function arcgisBasemapKey(): string | null {
  const key = process.env.NEXT_PUBLIC_ARCGIS_BASEMAP_KEY;
  return typeof key === "string" && key.length > 0 && !key.startsWith("REEMPLAZAR") ? key : null;
}

/**
 * Resuelve la capa que se dibuja realmente, aplicando degradación a OSM cuando
 * falta credencial, el proveedor falla o el derecho de uso no alcanza.
 */
export function activeBasemap({
  basemapId,
  surface,
  plan = "free",
  providerHealthy = true,
}: {
  basemapId: BasemapId;
  surface: BasemapSurface;
  plan?: string;
  providerHealthy?: boolean;
}): { basemap: BasemapDefinition; degraded: boolean; reason: string | null } {
  const resolved = resolveBasemap({
    basemapId,
    surface,
    plan,
    credentialPresent: arcgisBasemapKey() !== null,
    providerHealthy,
  });
  const resolvedBasemapId = isBasemapId(resolved.provider?.id)
    ? resolved.provider.id
    : DEFAULT_BASEMAP_ID;
  return {
    basemap: basemapById(resolvedBasemapId),
    degraded: resolved.degraded,
    reason: resolved.reason,
  };
}
export const DEFAULT_LABELS_ENABLED = true;
export const DEFAULT_PADDOCK_FILLS_ENABLED = false;
export const PADDOCK_LABEL_MIN_ZOOM = 15;

const BASEMAP_STORAGE_KEY = "fundosmart:potreros:basemap:v1";
const LABELS_STORAGE_KEY = "fundosmart:potreros:labels:v1";
const PADDOCK_FILLS_STORAGE_KEY = "fundosmart:potreros:paddock-fills:v1";

/** Deriva del catálogo central: ninguna URL ni estilo se declara dos veces. */
export const BASEMAPS: readonly BasemapDefinition[] = MAP_BASEMAP_CATALOG.providers.map((provider) => ({
  id: provider.id as BasemapId,
  label: provider.label,
  description: provider.description,
  url: provider.urlTemplate,
  styleName: provider.styleName,
  attribution: provider.attribution,
  maxNativeZoom: provider.maxNativeZoom,
  requiresCredential: provider.requiresCredential,
}));

export type MapPreferences = {
  basemapId: BasemapId;
  labelsEnabled: boolean;
  paddockFillsEnabled: boolean;
};

export function basemapById(id: BasemapId) {
  return BASEMAPS.find((basemap) => basemap.id === id) ?? BASEMAPS[0];
}

export function loadMapPreferences(): MapPreferences {
  const storage = browserStorage();
  if (!storage) return defaultMapPreferences();
  try {
    const storedBasemap = storage.getItem(BASEMAP_STORAGE_KEY);
    const storedLabels = storage.getItem(LABELS_STORAGE_KEY);
    const storedPaddockFills = storage.getItem(PADDOCK_FILLS_STORAGE_KEY);
    return {
      basemapId: isBasemapId(storedBasemap) ? storedBasemap : DEFAULT_BASEMAP_ID,
      labelsEnabled: storedLabels === "hidden" ? false : DEFAULT_LABELS_ENABLED,
      paddockFillsEnabled: storedPaddockFills === "visible" ? true : DEFAULT_PADDOCK_FILLS_ENABLED,
    };
  } catch {
    return defaultMapPreferences();
  }
}

export function saveMapPreferences(preferences: MapPreferences) {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(BASEMAP_STORAGE_KEY, preferences.basemapId);
    storage.setItem(LABELS_STORAGE_KEY, preferences.labelsEnabled ? "visible" : "hidden");
    storage.setItem(PADDOCK_FILLS_STORAGE_KEY, preferences.paddockFillsEnabled ? "visible" : "hidden");
  } catch {
    // Browser storage can be unavailable in private or hardened contexts.
  }
}

function defaultMapPreferences(): MapPreferences {
  return {
    basemapId: DEFAULT_BASEMAP_ID,
    labelsEnabled: DEFAULT_LABELS_ENABLED,
    paddockFillsEnabled: DEFAULT_PADDOCK_FILLS_ENABLED,
  };
}

function isBasemapId(value: unknown): value is BasemapId {
  return typeof value === "string" && BASEMAPS.some((basemap) => basemap.id === value);
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
