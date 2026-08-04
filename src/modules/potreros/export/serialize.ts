import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { Coordinate, ExclusionKind, PaddockLandUse, PolygonRings, Potrero, SoilAnalysis } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateGrossAreaSquareMeters, calculateNetAreaSquareMeters, calculatePerimeterMeters, toGeoJsonPolygon } from "../utils/geometry.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { decodeStoredPolygon } from "../utils/polygon-rings.ts";

export type PaddockExportProperties = {
  id: string;
  name: string;
  sector: string;
  areaHectares: number;
  areaSquareMeters: number;
  grossAreaHectares: number;
  netAreaHectares: number;
  grazeableAreaHectares: number | null;
  effectiveGrazeableAreaHectares: number;
  landUse: PaddockLandUse;
  holeKinds: ExclusionKind[];
  status: Potrero["status"];
  soil: SoilAnalysis;
  perimeterMeters: number;
};

export type PaddockFeatureCollection = FeatureCollection<Polygon, PaddockExportProperties> & {
  name: string;
};

export type PaddockExportFormat = "geojson" | "kml";

export type ParsedPaddockExportRequest =
  | { ok: true; fundoId: string; format: PaddockExportFormat }
  | { ok: false; status: 400; error: string };

export function parsePaddockExportRequest(url: string): ParsedPaddockExportRequest {
  const searchParams = new URL(url).searchParams;
  const fundoId = searchParams.get("fundoId")?.trim() ?? "";
  const format = searchParams.get("format")?.trim().toLowerCase() ?? "";
  if (!fundoId) return { ok: false, status: 400, error: "Falta el identificador del fundo." };
  if (format !== "geojson" && format !== "kml") {
    return { ok: false, status: 400, error: "El formato debe ser geojson o kml." };
  }
  return { ok: true, fundoId, format };
}

export function buildPaddockFeatureCollection(fundoName: string, paddocks: Potrero[]): PaddockFeatureCollection {
  return {
    type: "FeatureCollection",
    name: fundoName,
    features: paddocks.map((paddock): Feature<Polygon, PaddockExportProperties> => {
      const metrics = paddockGeometryMetrics(paddock);
      return {
        type: "Feature",
        id: paddock.id,
        geometry: toGeoJsonPolygon(metrics.geometry).geometry,
        properties: {
          id: paddock.id,
          name: paddock.name,
          sector: paddock.sector,
          areaHectares: metrics.grossAreaHectares,
          areaSquareMeters: metrics.grossAreaSquareMeters,
          grossAreaHectares: metrics.grossAreaHectares,
          netAreaHectares: metrics.netAreaHectares,
          grazeableAreaHectares: metrics.grazeableAreaHectares,
          effectiveGrazeableAreaHectares: metrics.effectiveGrazeableAreaHectares,
          landUse: paddock.landUse ?? "pradera_permanente",
          holeKinds: [...(paddock.holeKinds ?? [])],
          status: paddock.status,
          soil: { ...paddock.soil },
          perimeterMeters: calculatePerimeterMeters(metrics.geometry),
        },
      };
    }),
  };
}

export function serializePaddocksToGeoJson(fundoName: string, paddocks: Potrero[]): string {
  return JSON.stringify(buildPaddockFeatureCollection(fundoName, paddocks), null, 2);
}

export function serializePaddocksToKml(fundoName: string, paddocks: Potrero[]): string {
  const placemarks = paddocks.map((paddock) => {
    const metrics = paddockGeometryMetrics(paddock);
    const fields: Array<[string, string | number | null]> = [
      ["id", paddock.id],
      ["sector", paddock.sector],
      ["areaHectares", metrics.grossAreaHectares],
      ["areaSquareMeters", metrics.grossAreaSquareMeters],
      ["grossAreaHectares", metrics.grossAreaHectares],
      ["netAreaHectares", metrics.netAreaHectares],
      ["grazeableAreaHectares", metrics.grazeableAreaHectares],
      ["effectiveGrazeableAreaHectares", metrics.effectiveGrazeableAreaHectares],
      ["landUse", paddock.landUse ?? "pradera_permanente"],
      ["holeKinds", (paddock.holeKinds ?? []).join(",")],
      ["status", paddock.status],
      ["soil.ph", paddock.soil.ph],
      ["soil.nitrogen", paddock.soil.nitrogen],
      ["soil.phosphorus", paddock.soil.phosphorus],
      ["soil.potassium", paddock.soil.potassium],
      ["perimeterMeters", calculatePerimeterMeters(metrics.geometry)],
    ];
    const extendedData = fields
      .map(([name, value]) => `<Data name="${escapeXml(name)}"><value>${escapeXml(value ?? "")}</value></Data>`)
      .join("");
    return `<Placemark><name>${escapeXml(paddock.name)}</name><ExtendedData>${extendedData}</ExtendedData>${coordinateRingsToKml([metrics.geometry.outer, ...metrics.geometry.holes])}</Placemark>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(fundoName)}</name>${placemarks}</Document></kml>\n`;
}

/**
 * Serializes one outer ring and any future holes. Application coordinates are
 * [latitude, longitude]; KML is always longitude,latitude,altitude.
 */
export function coordinateRingsToKml(rings: Coordinate[][]): string {
  if (rings.length === 0) return "<Polygon/>";
  const outerBoundary = `<outerBoundaryIs><LinearRing><coordinates>${ringToKmlCoordinates(rings[0])}</coordinates></LinearRing></outerBoundaryIs>`;
  const innerBoundaries = rings.slice(1)
    .map((ring) => `<innerBoundaryIs><LinearRing><coordinates>${ringToKmlCoordinates(ring)}</coordinates></LinearRing></innerBoundaryIs>`)
    .join("");
  return `<Polygon>${outerBoundary}${innerBoundaries}</Polygon>`;
}

export function sanitizedPaddockExportFilename(fundoName: string, format: PaddockExportFormat): string {
  const safeName = fundoName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 72)
    .toLowerCase() || "fundo";
  return `potreros-${safeName}.${format}`;
}

export function paddockExportHeaders(
  fundoName: string,
  format: PaddockExportFormat,
): Record<string, string> {
  const filename = sanitizedPaddockExportFilename(fundoName, format);
  return {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Type": format === "geojson"
      ? "application/geo+json; charset=utf-8"
      : "application/vnd.google-earth.kml+xml; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

export function privateNoStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function ringToKmlCoordinates(ring: Coordinate[]): string {
  if (ring.length === 0) return "";
  const closed = coordinatesEqual(ring[0], ring[ring.length - 1]) ? ring : [...ring, ring[0]];
  return closed.map(([latitude, longitude]) => `${longitude},${latitude},0`).join(" ");
}

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function paddockGeometryMetrics(paddock: Potrero): {
  geometry: PolygonRings;
  grossAreaSquareMeters: number;
  grossAreaHectares: number;
  netAreaHectares: number;
  grazeableAreaHectares: number | null;
  effectiveGrazeableAreaHectares: number;
} {
  const geometry = decodeStoredPolygon(paddock.geometry ?? paddock.coordinates);
  const grossAreaSquareMeters = calculateGrossAreaSquareMeters(geometry);
  const netAreaHectares = calculateNetAreaSquareMeters(geometry) / 10_000;
  const grazeableAreaHectares = paddock.grazeableAreaHectares ?? null;
  return {
    geometry,
    grossAreaSquareMeters,
    grossAreaHectares: grossAreaSquareMeters / 10_000,
    netAreaHectares,
    grazeableAreaHectares,
    effectiveGrazeableAreaHectares: grazeableAreaHectares ?? netAreaHectares,
  };
}
