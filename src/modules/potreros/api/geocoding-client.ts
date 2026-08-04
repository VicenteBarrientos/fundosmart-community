export type GeocodingSearchResult = Readonly<{
  placeId: string;
  displayName: string;
  latitude: number;
  longitude: number;
  boundingBox: readonly [number, number, number, number] | null; // [minLat, maxLat, minLng, maxLng]
}>;

export type GeocodingClientState = Readonly<{
  query: string;
  results: readonly GeocodingSearchResult[];
  status: "idle" | "loading" | "success" | "error" | "offline";
  error: string | null;
}>;

export type GeocodingQueryOptions = Readonly<{
  limit?: number;
  countryCode?: string;
}>;

/**
 * Normalizes location query for rural Chilean regions (Los Lagos, Los Ríos, Araucanía).
 */
export function buildGeocodingUrl(query: string, options?: GeocodingQueryOptions): string {
  const trimmed = query.trim();
  if (!trimmed) throw new TypeError("Consulta de ubicación requerida.");

  const searchParams = new URLSearchParams({
    q: trimmed.toLowerCase().endsWith("chile") ? trimmed : `${trimmed}, Chile`,
    format: "json",
    addressdetails: "1",
    limit: String(options?.limit ?? 5),
    countrycodes: options?.countryCode?.toLowerCase() ?? "cl",
  });

  return `https://nominatim.openstreetmap.org/search?${searchParams.toString()}`;
}

/**
 * Parses raw geocoding JSON response while enforcing privacy (no logging of raw coordinates).
 */
export function parseGeocodingResponse(raw: unknown): GeocodingSearchResult[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item): GeocodingSearchResult | null => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.lat !== "string" ||
        typeof item.lon !== "string" ||
        typeof item.display_name !== "string"
      ) {
        return null;
      }

      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      if (isNaN(lat) || isNaN(lon)) return null;

      let boundingBox: readonly [number, number, number, number] | null = null;
      if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
        const [minLat, maxLat, minLng, maxLng] = item.boundingbox.map(Number);
        if (![minLat, maxLat, minLng, maxLng].some(isNaN)) {
          boundingBox = Object.freeze([minLat, maxLat, minLng, maxLng]);
        }
      }

      return Object.freeze({
        placeId: String(item.place_id ?? `${lat}-${lon}`),
        displayName: item.display_name,
        latitude: lat,
        longitude: lon,
        boundingBox,
      });
    })
    .filter((item): item is GeocodingSearchResult => item !== null);
}
