import { calculateAreaSquareMeters, calculatePerimeterMeters } from "../../src/modules/potreros/utils/geometry.ts";

export const OSORNO_CURRENT_BOUNDARY = rectangle(-40.581, -73.151, -40.559, -73.119);
export const OSORNO_IMPORTED_BOUNDARY = rectangle(-40.58, -73.15, -40.56, -73.12);
export const OSORNO_PADDOCK_WEST = rectangle(-40.576, -73.146, -40.57, -73.136);
export const OSORNO_PADDOCK_EAST = rectangle(-40.576, -73.134, -40.57, -73.124);
export const OSORNO_WEST_HOLE = rectangle(-40.5745, -73.1435, -40.5725, -73.1415);

export function createOsornoMappingPreview() {
  return makePreview([
    polygonFeature({
      previewFeatureId: "preview-osorno:f1",
      sourceIndex: 0,
      name: "Límite Fundo Osorno",
      sector: "",
      outer: OSORNO_IMPORTED_BOUNDARY,
    }),
    polygonFeature({
      previewFeatureId: "preview-osorno:f2:p1",
      sourceIndex: 1,
      partIndex: 0,
      sourceId: "multi-paddocks",
      name: "Paños Norte · Parte 1/2",
      sector: "Caracol",
      outer: OSORNO_PADDOCK_WEST,
      holes: [OSORNO_WEST_HOLE],
    }),
    polygonFeature({
      previewFeatureId: "preview-osorno:f2:p2",
      sourceIndex: 1,
      partIndex: 1,
      sourceId: "multi-paddocks",
      name: "Paños Norte · Parte 2/2",
      sector: "Caracol",
      outer: OSORNO_PADDOCK_EAST,
    }),
    pointFeature({
      previewFeatureId: "preview-osorno:f3",
      sourceIndex: 2,
      name: "Bebedero principal",
      coordinate: [-40.573, -73.139],
    }),
    lineFeature({
      previewFeatureId: "preview-osorno:f4",
      sourceIndex: 3,
      name: "Cerco eléctrico",
      coordinates: [[-40.576, -73.135], [-40.57, -73.135]],
    }),
  ]);
}

export function makePreview(features, overrides = {}) {
  return {
    importPreviewId: "preview-osorno-2026-07-20",
    parserVersion: "gis-v1",
    fieldId: "fundo-osorno",
    fileName: "potreros-osorno.geojson",
    fileSha256: "a".repeat(64),
    format: "geojson",
    compressedBytes: 1_024,
    expandedBytes: 1_024,
    sourceFeatureCount: features.length,
    previewFeatureCount: features.length,
    totalRawVertices: features.reduce((sum, feature) => sum + feature.vertexCount, 0),
    totalPreviewVertices: features.reduce((sum, feature) => sum + feature.vertexCount, 0),
    features,
    warnings: [],
    limits: {
      maxCompressedFileBytes: 1_000_000,
      maxArchiveEntries: 100,
      maxExpandedArchiveBytes: 10_000_000,
      maxSourceFeatures: 1_000,
      maxPreviewFeatures: 2_000,
      maxRawVerticesPerRing: 10_000,
      maxRawVerticesTotal: 100_000,
      maxPreviewVerticesPerRing: 2_000,
      maxPreviewVerticesTotal: 50_000,
      simplifyToleranceMeters: 1,
    },
    ...overrides,
  };
}

export function polygonFeature({
  previewFeatureId,
  sourceIndex,
  partIndex = null,
  sourceId = null,
  name,
  sector = "Sector Osorno",
  outer,
  holes = [],
}) {
  const geometry = {
    type: "Polygon",
    outer: cloneRing(outer),
    holes: holes.map(cloneRing),
  };
  let areaSquareMeters = 0;
  let perimeterMeters = 0;
  try {
    areaSquareMeters = calculateAreaSquareMeters(geometry);
    perimeterMeters = calculatePerimeterMeters(geometry);
  } catch {
    // Adversarial fixtures deliberately reach the planner before parser guarantees.
  }
  return {
    previewFeatureId,
    sourceIndex,
    partIndex,
    sourceId,
    name,
    properties: sector ? { name, sector } : { name },
    category: "paddock",
    geometry,
    areaSquareMeters,
    perimeterMeters,
    vertexCount: geometry.outer.length + geometry.holes.reduce((sum, hole) => sum + hole.length, 0),
    canCommitV1: holes.length === 0,
    errors: [],
    warnings: holes.length > 0 ? [`Se conservaron ${holes.length} hueco(s) para la vista previa.`] : [],
    commitBlockers: holes.length > 0 ? ["Asigna un tipo a cada hueco antes de confirmar la importación."] : [],
  };
}

export function pointFeature({ previewFeatureId, sourceIndex, name, coordinate }) {
  return {
    previewFeatureId,
    sourceIndex,
    partIndex: null,
    sourceId: null,
    name,
    properties: { name },
    category: "infrastructure_candidate",
    geometry: { type: "Point", coordinates: [...coordinate] },
    areaSquareMeters: null,
    perimeterMeters: null,
    vertexCount: 1,
    canCommitV1: false,
    errors: [],
    warnings: ["El punto se conserva como candidato futuro a infraestructura."],
    commitBlockers: ["Los puntos todavía no se pueden confirmar como potreros."],
  };
}

export function lineFeature({ previewFeatureId, sourceIndex, name, coordinates }) {
  return {
    previewFeatureId,
    sourceIndex,
    partIndex: null,
    sourceId: null,
    name,
    properties: { name },
    category: "infrastructure_candidate",
    geometry: { type: "LineString", coordinates: coordinates.map((coordinate) => [...coordinate]) },
    areaSquareMeters: null,
    perimeterMeters: null,
    vertexCount: coordinates.length,
    canCommitV1: false,
    errors: [],
    warnings: ["La línea se conserva como candidata futura a infraestructura."],
    commitBlockers: ["Las líneas todavía no se pueden confirmar como potreros."],
  };
}

export function unsupportedFeature(previewFeatureId, sourceIndex) {
  return {
    previewFeatureId,
    sourceIndex,
    partIndex: null,
    sourceId: null,
    name: "Geometría inválida",
    properties: {},
    category: "unsupported",
    geometry: null,
    areaSquareMeters: null,
    perimeterMeters: null,
    vertexCount: 0,
    canCommitV1: false,
    errors: ["La geometría no está soportada."],
    warnings: [],
    commitBlockers: ["Corrige la geometría antes de confirmar la importación."],
  };
}

export function rectangle(south, west, north, east) {
  return [[south, west], [south, east], [north, east], [north, west]];
}

function cloneRing(ring) {
  return ring.map((coordinate) => [...coordinate]);
}
