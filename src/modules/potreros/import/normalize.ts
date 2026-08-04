import area from "@turf/area";
import { polygon } from "@turf/helpers";
import simplify from "@turf/simplify";
import type { Feature, Polygon } from "geojson";
import type { Coordinate } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculatePathLengthMeters, containsPolygon, selfIntersects, toGeoJsonPolygon } from "../utils/geometry.ts";
import {
  MAX_PREVIEW_FEATURES,
  MAX_PREVIEW_VERTICES_PER_RING,
  MAX_PREVIEW_VERTICES_TOTAL,
  MAX_RAW_VERTICES_PER_RING,
  MAX_RAW_VERTICES_TOTAL,
  MAX_SOURCE_FEATURES,
  SIMPLIFY_TOLERANCE_METERS,
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
} from "./limits.ts";
import type {
  GisPreviewFeature,
  ImportedGeometry,
  ImportedPolygon,
  JsonScalar,
} from "./types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { GisImportError } from "./types.ts";

export type RawFeature = {
  id: string | number | null;
  properties: Record<string, unknown>;
  geometry: unknown;
};

export type NormalizedFeatures = {
  features: GisPreviewFeature[];
  sourceFeatureCount: number;
  totalRawVertices: number;
  totalPreviewVertices: number;
};

type VertexBudget = {
  raw: number;
  preview: number;
};

type NormalizedGeometry = {
  geometry: ImportedGeometry;
  areaSquareMeters: number | null;
  perimeterMeters: number | null;
  vertexCount: number;
  warnings: string[];
  commitBlockers: string[];
  category: GisPreviewFeature["category"];
};

class FeatureGeometryError extends Error {}

export function normalizeImportFeatures(rawFeatures: RawFeature[], previewId: string): NormalizedFeatures {
  if (rawFeatures.length === 0) {
    throw new GisImportError("El archivo no contiene geometrías para previsualizar.", "EMPTY_IMPORT", 422);
  }
  if (rawFeatures.length > MAX_SOURCE_FEATURES) {
    throw new GisImportError(
      `El archivo supera el límite de ${MAX_SOURCE_FEATURES} features de origen.`,
      "FEATURE_LIMIT",
      413,
    );
  }

  const budget: VertexBudget = { raw: 0, preview: 0 };
  const features: GisPreviewFeature[] = [];
  rawFeatures.forEach((rawFeature, sourceIndex) => {
    const geometry = asRecord(rawFeature.geometry);
    if (geometry?.type === "MultiPolygon") {
      const parts = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
      if (parts.length === 0) {
        features.push(invalidFeature(rawFeature, previewId, sourceIndex, null, "El MultiPolygon no contiene partes."));
      } else {
        parts.forEach((part, partIndex) => {
          ensurePreviewFeatureCapacity(features.length + 1);
          features.push(normalizeSingleFeature(
            rawFeature,
            { type: "Polygon", coordinates: part },
            previewId,
            sourceIndex,
            partIndex,
            parts.length,
            budget,
          ));
        });
      }
      return;
    }
    ensurePreviewFeatureCapacity(features.length + 1);
    features.push(normalizeSingleFeature(rawFeature, rawFeature.geometry, previewId, sourceIndex, null, 1, budget));
  });

  return {
    features,
    sourceFeatureCount: rawFeatures.length,
    totalRawVertices: budget.raw,
    totalPreviewVertices: budget.preview,
  };
}

function normalizeSingleFeature(
  rawFeature: RawFeature,
  rawGeometry: unknown,
  previewId: string,
  sourceIndex: number,
  partIndex: number | null,
  partCount: number,
  budget: VertexBudget,
): GisPreviewFeature {
  const sanitized = sanitizeProperties(rawFeature.properties);
  const baseName = featureName(sanitized.properties, sourceIndex);
  const name = partIndex === null ? baseName : `${baseName} · Parte ${partIndex + 1}/${partCount}`;
  const previewFeatureId = `${previewId}:f${sourceIndex + 1}${partIndex === null ? "" : `:p${partIndex + 1}`}`;
  const sourceId = typeof rawFeature.id === "string" || typeof rawFeature.id === "number"
    ? String(rawFeature.id).slice(0, 160)
    : null;

  try {
    const normalized = normalizeGeometry(rawGeometry, budget);
    return {
      previewFeatureId,
      sourceIndex,
      partIndex,
      sourceId,
      name,
      properties: sanitized.properties,
      category: normalized.category,
      geometry: normalized.geometry,
      areaSquareMeters: normalized.areaSquareMeters,
      perimeterMeters: normalized.perimeterMeters,
      vertexCount: normalized.vertexCount,
      canCommitV1: normalized.category === "paddock" && normalized.commitBlockers.length === 0,
      errors: [],
      warnings: [...sanitized.warnings, ...normalized.warnings],
      commitBlockers: normalized.commitBlockers,
    };
  } catch (cause) {
    if (!(cause instanceof FeatureGeometryError)) throw cause;
    return {
      previewFeatureId,
      sourceIndex,
      partIndex,
      sourceId,
      name,
      properties: sanitized.properties,
      category: "unsupported",
      geometry: null,
      areaSquareMeters: null,
      perimeterMeters: null,
      vertexCount: 0,
      canCommitV1: false,
      errors: [cause.message],
      warnings: sanitized.warnings,
      commitBlockers: ["Corrige la geometría antes de confirmar la importación."],
    };
  }
}

function normalizeGeometry(rawGeometry: unknown, budget: VertexBudget): NormalizedGeometry {
  const geometry = asRecord(rawGeometry);
  if (!geometry || typeof geometry.type !== "string") {
    throw new FeatureGeometryError("La feature no contiene una geometría válida.");
  }

  if (geometry.type === "Polygon") return normalizePolygonGeometry(geometry.coordinates, budget);
  if (geometry.type === "Point") {
    const { coordinate, ignoredAltitude } = normalizePosition(geometry.coordinates, budget);
    addPreviewVertices(budget, 1);
    return {
      geometry: { type: "Point", coordinates: coordinate },
      areaSquareMeters: null,
      perimeterMeters: null,
      vertexCount: 1,
      category: "infrastructure_candidate",
      warnings: [
        "El punto se conserva como candidato futuro a infraestructura.",
        ...(ignoredAltitude ? ["La altitud se omitió; el modelo cartográfico V1 es bidimensional."] : []),
      ],
      commitBlockers: ["Los puntos todavía no se pueden confirmar como potreros."],
    };
  }
  if (geometry.type === "LineString") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
      throw new FeatureGeometryError("La línea necesita al menos dos vértices.");
    }
    if (geometry.coordinates.length > MAX_PREVIEW_VERTICES_PER_RING) {
      throw new FeatureGeometryError(`La línea supera ${MAX_PREVIEW_VERTICES_PER_RING} vértices.`);
    }
    const normalized = geometry.coordinates.map((position) => normalizePosition(position, budget));
    const coordinates = removeDuplicateNeighbors(normalized.map(({ coordinate }) => coordinate));
    if (coordinates.length < 2) throw new FeatureGeometryError("La línea es degenerada.");
    addPreviewVertices(budget, coordinates.length);
    return {
      geometry: { type: "LineString", coordinates },
      areaSquareMeters: null,
      perimeterMeters: calculatePathLengthMeters(coordinates),
      vertexCount: coordinates.length,
      category: "infrastructure_candidate",
      warnings: [
        "La línea se conserva como candidata futura a infraestructura.",
        ...(normalized.some(({ ignoredAltitude }) => ignoredAltitude)
          ? ["La altitud se omitió; el modelo cartográfico V1 es bidimensional."]
          : []),
      ],
      commitBlockers: ["Las líneas todavía no se pueden confirmar como potreros."],
    };
  }

  throw new FeatureGeometryError(`La geometría ${geometry.type} no está soportada en esta etapa.`);
}

function normalizePolygonGeometry(rawCoordinates: unknown, budget: VertexBudget): NormalizedGeometry {
  if (!Array.isArray(rawCoordinates) || rawCoordinates.length === 0) {
    throw new FeatureGeometryError("El polígono no contiene anillos.");
  }
  let ignoredAltitude = false;
  let wasOpen = false;
  let rings = rawCoordinates.map((rawRing) => {
    if (!Array.isArray(rawRing) || rawRing.length < 3) {
      throw new FeatureGeometryError("Cada anillo necesita al menos tres vértices.");
    }
    if (rawRing.length > MAX_RAW_VERTICES_PER_RING) {
      throw new GisImportError(
        `Un anillo supera el límite bruto de ${MAX_RAW_VERTICES_PER_RING} vértices.`,
        "RAW_VERTEX_LIMIT",
        413,
      );
    }
    const normalized = rawRing.map((position) => normalizePosition(position, budget));
    ignoredAltitude ||= normalized.some((position) => position.ignoredAltitude);
    const points = removeDuplicateNeighbors(normalized.map(({ coordinate }) => coordinate));
    if (!coordinatesEqual(points[0], points[points.length - 1])) wasOpen = true;
    const open = removeClosingPoint(points);
    if (open.length < 3) throw new FeatureGeometryError("Un anillo es degenerado.");
    return open;
  });

  let simplified = false;
  if (rings.some((ring) => ring.length > MAX_PREVIEW_VERTICES_PER_RING)) {
    rings = simplifyRingsMetric(rings, SIMPLIFY_TOLERANCE_METERS);
    simplified = true;
  }
  if (rings.some((ring) => ring.length > MAX_PREVIEW_VERTICES_PER_RING)) {
    throw new FeatureGeometryError(
      `La geometría sigue superando ${MAX_PREVIEW_VERTICES_PER_RING} vértices por anillo después de simplificar a ${SIMPLIFY_TOLERANCE_METERS} m.`,
    );
  }

  rings.forEach((ring, index) => {
    if (ring.length < 3) throw new FeatureGeometryError(`El anillo ${index + 1} quedó degenerado.`);
    if (selfIntersects(ring)) throw new FeatureGeometryError(`El anillo ${index + 1} se cruza consigo mismo.`);
  });
  const [outer, ...holes] = rings;
  holes.forEach((hole, index) => {
    if (!containsPolygon(outer, hole)) {
      throw new FeatureGeometryError(`El hueco ${index + 1} no está contenido por el anillo exterior.`);
    }
  });

  const feature = toGeoJsonPolygon(rings);
  const areaSquareMeters = area(feature);
  if (!Number.isFinite(areaSquareMeters) || areaSquareMeters <= 0.01) {
    throw new FeatureGeometryError("El polígono no tiene un área utilizable.");
  }
  const vertexCount = rings.reduce((sum, ring) => sum + ring.length, 0);
  addPreviewVertices(budget, vertexCount);
  const imported: ImportedPolygon = { type: "Polygon", outer, holes };
  return {
    geometry: imported,
    areaSquareMeters,
    perimeterMeters: rings.reduce((sum, ring) => sum + calculatePathLengthMeters([...ring, ring[0]]), 0),
    vertexCount,
    category: "paddock",
    warnings: [
      ...(wasOpen ? ["Se cerraron anillos que venían abiertos en el archivo."] : []),
      ...(ignoredAltitude ? ["La altitud se omitió; el modelo cartográfico V1 es bidimensional."] : []),
      ...(simplified ? [`La geometría se simplificó con tolerancia métrica de ${SIMPLIFY_TOLERANCE_METERS} m.`] : []),
      ...(holes.length > 0 ? [`Se conservaron ${holes.length} hueco(s) para la vista previa.`] : []),
    ],
    commitBlockers: holes.length > 0
      ? ["Asigna un tipo a cada hueco antes de confirmar la importación."]
      : [],
  };
}

function simplifyRingsMetric(rings: Coordinate[][], toleranceMeters: number): Coordinate[][] {
  const projection = metricProjection(rings[0]);
  const projected = rings.map((ring) => closeRing(ring).map(([latitude, longitude]) => [
    degreesToRadians(longitude - projection.longitude) * 6_371_008.8 * projection.longitudeScale,
    degreesToRadians(latitude - projection.latitude) * 6_371_008.8,
  ]));
  const feature = polygon(projected) as Feature<Polygon>;
  const simplified = simplify(feature, { tolerance: toleranceMeters, highQuality: true, mutate: false });
  return simplified.geometry.coordinates.map((ring) => removeClosingPoint(ring.map(([east, north]) => [
    projection.latitude + radiansToDegrees(north / 6_371_008.8),
    projection.longitude + radiansToDegrees(east / (6_371_008.8 * projection.longitudeScale)),
  ] as Coordinate)));
}

function metricProjection(outer: Coordinate[]) {
  const sums = outer.reduce(([latitude, longitude], point) => [latitude + point[0], longitude + point[1]], [0, 0]);
  const latitude = sums[0] / outer.length;
  const longitudeScale = Math.cos(degreesToRadians(latitude));
  if (Math.abs(longitudeScale) < 1e-8) throw new FeatureGeometryError("No se puede simplificar geometría polar.");
  return { latitude, longitude: sums[1] / outer.length, longitudeScale };
}

function normalizePosition(value: unknown, budget: VertexBudget): { coordinate: Coordinate; ignoredAltitude: boolean } {
  addRawVertices(budget, 1);
  if (!Array.isArray(value) || value.length < 2) {
    throw new FeatureGeometryError("Una coordenada no contiene longitud y latitud.");
  }
  const longitude = value[0];
  const latitude = value[1];
  if (
    typeof longitude !== "number"
    || typeof latitude !== "number"
    || !Number.isFinite(longitude)
    || !Number.isFinite(latitude)
    || longitude < -180
    || longitude > 180
    || latitude < -90
    || latitude > 90
  ) {
    throw new FeatureGeometryError("Una coordenada queda fuera del rango WGS84 longitud/latitud.");
  }
  return { coordinate: [latitude, longitude], ignoredAltitude: value.length > 2 };
}

function sanitizeProperties(input: Record<string, unknown>): {
  properties: Record<string, JsonScalar>;
  warnings: string[];
} {
  const properties: Record<string, JsonScalar> = {};
  const warnings: string[] = [];
  const entries = Object.entries(input);
  for (const [rawKey, rawValue] of entries.slice(0, 32)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") continue;
    if (rawValue === null || typeof rawValue === "boolean" || typeof rawValue === "number") {
      properties[key] = typeof rawValue === "number" && !Number.isFinite(rawValue) ? null : rawValue;
    } else if (typeof rawValue === "string") {
      properties[key] = rawValue.slice(0, 1_000);
    } else {
      try {
        properties[key] = JSON.stringify(rawValue).slice(0, 1_000);
      } catch {
        properties[key] = "[valor no serializable]";
      }
    }
  }
  if (entries.length > 32) warnings.push("Se conservaron sólo las primeras 32 propiedades de la feature.");
  return { properties, warnings };
}

function featureName(properties: Record<string, JsonScalar>, sourceIndex: number): string {
  for (const key of ["name", "Name", "NAME", "nombre", "NOMBRE", "title", "TITLE"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return `Potrero importado ${sourceIndex + 1}`;
}

function invalidFeature(
  rawFeature: RawFeature,
  previewId: string,
  sourceIndex: number,
  partIndex: number | null,
  error: string,
): GisPreviewFeature {
  const sanitized = sanitizeProperties(rawFeature.properties);
  return {
    previewFeatureId: `${previewId}:f${sourceIndex + 1}`,
    sourceIndex,
    partIndex,
    sourceId: rawFeature.id === null ? null : String(rawFeature.id).slice(0, 160),
    name: featureName(sanitized.properties, sourceIndex),
    properties: sanitized.properties,
    category: "unsupported",
    geometry: null,
    areaSquareMeters: null,
    perimeterMeters: null,
    vertexCount: 0,
    canCommitV1: false,
    errors: [error],
    warnings: sanitized.warnings,
    commitBlockers: ["Corrige la geometría antes de confirmar la importación."],
  };
}

function ensurePreviewFeatureCapacity(nextCount: number): void {
  if (nextCount > MAX_PREVIEW_FEATURES) {
    throw new GisImportError(
      `El archivo supera el límite de ${MAX_PREVIEW_FEATURES} features previsualizadas al aplanar MultiPolygon.`,
      "FEATURE_LIMIT",
      413,
    );
  }
}

function addRawVertices(budget: VertexBudget, count: number): void {
  budget.raw += count;
  if (budget.raw > MAX_RAW_VERTICES_TOTAL) {
    throw new GisImportError(
      `El archivo supera el límite bruto de ${MAX_RAW_VERTICES_TOTAL} vértices.`,
      "RAW_VERTEX_LIMIT",
      413,
    );
  }
}

function addPreviewVertices(budget: VertexBudget, count: number): void {
  budget.preview += count;
  if (budget.preview > MAX_PREVIEW_VERTICES_TOTAL) {
    throw new GisImportError(
      `La vista previa supera el límite de ${MAX_PREVIEW_VERTICES_TOTAL} vértices.`,
      "PREVIEW_VERTEX_LIMIT",
      413,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function removeDuplicateNeighbors(points: Coordinate[]): Coordinate[] {
  return points.filter((point, index) => index === 0 || !coordinatesEqual(point, points[index - 1]));
}

function removeClosingPoint(points: Coordinate[]): Coordinate[] {
  return points.length > 1 && coordinatesEqual(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
}

function closeRing(points: Coordinate[]): Coordinate[] {
  return coordinatesEqual(points[0], points[points.length - 1]) ? points : [...points, points[0]];
}

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
