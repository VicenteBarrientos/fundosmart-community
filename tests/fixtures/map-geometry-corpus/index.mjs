export const MAP_GEOMETRY_CORPUS_VERSION = "fundosmart.map-geometry-corpus.v2";
export const MAP_GEOMETRY_CORPUS_PROVENANCE = "synthetic";

const ORIGIN_LATITUDE = -40.57;
const ORIGIN_LONGITUDE = -73.13;
const STEP = 0.0001;

function roundCoordinate(value) {
  return Number(value.toFixed(8));
}

function point(northSteps, eastSteps) {
  return [
    roundCoordinate(ORIGIN_LATITUDE + northSteps * STEP),
    roundCoordinate(ORIGIN_LONGITUDE + eastSteps * STEP),
  ];
}

function rectangle(southSteps, westSteps, northSteps, eastSteps) {
  return [
    point(southSteps, westSteps),
    point(southSteps, eastSteps),
    point(northSteps, eastSteps),
    point(northSteps, westSteps),
  ];
}

function closedGeoJsonRing(ring) {
  const coordinates = ring.map(([latitude, longitude]) => [longitude, latitude]);
  coordinates.push([...coordinates[0]]);
  return coordinates;
}

export const MAP_GEOMETRY_CASES = Object.freeze({
  simpleTriangle: {
    id: "simple-triangle",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    geometry: {
      outer: [point(0, 0), point(0, 6), point(5, 2)],
      holes: [],
    },
    expected: "valid",
  },
  simplePolygon: {
    id: "simple-polygon",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    geometry: {
      outer: rectangle(0, 0, 10, 12),
      holes: [],
    },
    expected: "valid",
  },
  concavePolygon: {
    id: "concave-polygon",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    geometry: {
      outer: [
        point(0, 0),
        point(0, 10),
        point(10, 10),
        point(10, 6),
        point(4, 6),
        point(4, 4),
        point(10, 4),
        point(10, 0),
      ],
      holes: [],
    },
    expected: "valid",
  },
  multipleHoles: {
    id: "multiple-holes",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    geometry: {
      outer: rectangle(0, 0, 20, 20),
      holes: [
        rectangle(3, 3, 7, 7),
        rectangle(12, 12, 17, 17),
      ],
    },
    holeKinds: ["laguna", "bosque"],
    expected: "valid",
  },
  sharedBoundaries: {
    id: "shared-boundaries-and-vertices",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygons: {
      west: rectangle(0, 0, 10, 5),
      east: rectangle(0, 5, 10, 10),
    },
    sharedSegment: [point(0, 5), point(10, 5)],
    expected: "linked",
  },
  fieldBoundaryChain: {
    id: "field-boundary-chain",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    field: rectangle(0, 0, 10, 20),
    paddocks: [
      rectangle(0, 0, 4, 5),
      rectangle(0, 5, 4, 10),
      rectangle(0, 10, 4, 15),
      rectangle(0, 15, 4, 20),
    ],
    expected: "linked",
  },
  tolerance: {
    id: "containment-tolerance-inside-outside",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    toleranceMeters: 2,
    field: rectangle(0, 0, 10, 10),
    withinTolerance: [
      point(1, -0.17),
      point(1, 5),
      point(8, 5),
      point(8, -0.17),
    ],
    outsideTolerance: [
      point(1, -0.3),
      point(1, 5),
      point(8, 5),
      point(8, -0.3),
    ],
    expected: {
      withinTolerance: true,
      outsideTolerance: false,
    },
  },
  tJunction: {
    id: "t-junction",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: rectangle(0, 0, 10, 10),
    dividers: [
      [point(0, 5), point(10, 5)],
      [point(5, 0), point(5, 5)],
    ],
    expectedPolygonCount: 3,
  },
  subdivisionTwoIntersections: {
    id: "subdivision-two-intersections",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: rectangle(0, 0, 10, 10),
    divider: [point(0, 5), point(10, 5)],
    expected: "split",
    expectedPolygonCount: 2,
  },
  subdivisionFourIntersections: {
    id: "subdivision-four-plus-intersections",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: [
      point(0, 0),
      point(0, 10),
      point(10, 10),
      point(10, 0),
      point(7, 0),
      point(7, 7),
      point(3, 7),
      point(3, 0),
    ],
    divider: [point(-1, 5), point(11, 5)],
    // Resuelto el 2026-07-28 por MAP-404. Este caso estuvo congelado como limitación
    // conocida mientras la Fase 1 prohibía cambios de conducta; el cambio de estado es
    // deliberado y quedó registrado en la bitácora de gates del plan maestro, no
    // normalizado en silencio. El divisor deja dos cuerdas dentro del arco y una fuera,
    // por la muesca inferior: tres piezas de 15, 15 y 42.
    expected: "split",
    expectedPolygonCount: 3,
    resolvedByTicket: "MAP-404",
  },
  subdivisionSixIntersections: {
    id: "subdivision-six-intersections",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: [
      point(0, 0),
      point(0, 12),
      point(10, 12),
      point(10, 10),
      point(3, 10),
      point(3, 8),
      point(10, 8),
      point(10, 4),
      point(3, 4),
      point(3, 2),
      point(10, 2),
      point(10, 0),
    ],
    divider: [point(6, -1), point(6, 13)],
    expected: "split",
    expectedPolygonCount: 4,
    resolvedByTicket: "MAP-404",
  },
  subdivisionExteriorOnly: {
    id: "subdivision-exterior-only",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: [
      point(0, 0),
      point(0, 10),
      point(10, 10),
      point(10, 0),
      point(7, 0),
      point(7, 7),
      point(3, 7),
      point(3, 0),
    ],
    divider: [point(5, 1), point(5, 6)],
    expected: "reject",
  },
  subdivisionPartialTail: {
    id: "subdivision-partial-tail",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: [
      point(0, 0),
      point(0, 12),
      point(10, 12),
      point(10, 10),
      point(3, 10),
      point(3, 8),
      point(10, 8),
      point(10, 4),
      point(3, 4),
      point(3, 2),
      point(10, 2),
      point(10, 0),
    ],
    divider: [point(6, -1), point(6, 11)],
    expected: "reject",
    reason: "divider-endpoint-inside",
  },
  subdivisionAtomicFailure: {
    id: "subdivision-atomic-failure",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: rectangle(0, 0, 10, 10),
    divider: [
      point(0, 2),
      point(0.02, 2.001),
      point(0, 2.002),
      point(-1, 4),
      point(0, 5),
      point(10, 5),
    ],
    expected: "reject",
    reason: "one-interior-chord-is-too-small",
  },
  subdivisionSelfIntersectingDivider: {
    id: "subdivision-self-intersecting-divider",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    polygon: rectangle(0, 0, 2, 2),
    divider: [
      point(0, 0.4),
      point(1.6, 1.6),
      point(0.4, 1.6),
      point(2, 0.4),
    ],
    expected: "reject",
    reason: "divider-self-intersects",
  },
  selfIntersecting: {
    id: "invalid-self-intersecting",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    geometry: {
      outer: [point(0, 0), point(10, 10), point(0, 8), point(8, 0)],
      holes: [],
    },
    expected: "invalid",
  },
});

const multipolygonWest = rectangle(30, 0, 36, 6);
const multipolygonEast = rectangle(30, 8, 36, 14);

export const CORPUS_MULTIPOLYGON_GEOJSON = Object.freeze({
  type: "Feature",
  id: "synthetic-multipolygon",
  properties: {
    name: "Paños sintéticos",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
  },
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [closedGeoJsonRing(multipolygonWest)],
      [closedGeoJsonRing(multipolygonEast)],
    ],
  },
});

export const CORPUS_UTM_18S = Object.freeze({
  id: "shapefile-utm-18s",
  provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
  prj: 'PROJCS["WGS_1984_UTM_Zone_18S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000],PARAMETER["False_Northing",10000000],PARAMETER["Central_Meridian",-75],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0],UNIT["Meter",1]]',
  projectedRing: [
    [658291.8838856283, 5507294.896114352],
    [658296.5982586285, 5507516.916904641],
    [658550.5641259346, 5507511.519993476],
    [658545.842183088, 5507289.499144018],
    [658291.8838856283, 5507294.896114352],
  ],
  expectedWgs84Ring: [
    [-40.57, -73.13],
    [-40.568, -73.13],
    [-40.568, -73.127],
    [-40.57, -73.127],
  ],
  maximumCoordinateErrorDegrees: 1e-7,
});

export const CORPUS_GRID_PADDOCK_COUNT = 200;
export const CORPUS_IMPORT_FEATURE_COUNT = 500;
export const CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE = 198;
export const CORPUS_IMPORT_RAW_VERTEX_COUNT = (
  CORPUS_IMPORT_FEATURE_COUNT * (CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE + 1)
);

export function createCorpusPaddockGrid(count = CORPUS_GRID_PADDOCK_COUNT) {
  if (!Number.isSafeInteger(count) || count < 1 || count > CORPUS_GRID_PADDOCK_COUNT) {
    throw new RangeError(`El corpus admite entre 1 y ${CORPUS_GRID_PADDOCK_COUNT} potreros.`);
  }
  const columns = 20;
  const rows = Math.ceil(count / columns);
  const cellStep = 0.00012;
  const baseLatitude = -40.61;
  const baseLongitude = -73.16;
  const statuses = ["Disponible", "En pastoreo", "En descanso"];
  const paddocks = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const south = roundCoordinate(baseLatitude + row * cellStep);
    const north = roundCoordinate(south + cellStep);
    const west = roundCoordinate(baseLongitude + column * cellStep);
    const east = roundCoordinate(west + cellStep);
    const outer = [[south, west], [south, east], [north, east], [north, west]];
    return {
      id: `corpus-paddock-${String(index + 1).padStart(3, "0")}`,
      fieldId: "corpus-field-200",
      name: `Potrero sintético ${String(index + 1).padStart(3, "0")}`,
      sector: `Fila ${String(row + 1).padStart(2, "0")}`,
      areaHectares: 0,
      coordinates: outer,
      geometry: { outer, holes: [] },
      grazeableAreaHectares: null,
      landUse: "pradera_permanente",
      holeKinds: [],
      soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
      lastActivity: "Fixture sintético",
      status: statuses[index % statuses.length],
    };
  });
  return {
    id: "grid-200-paddocks",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    fieldBoundary: [
      [baseLatitude, baseLongitude],
      [baseLatitude, roundCoordinate(baseLongitude + columns * cellStep)],
      [roundCoordinate(baseLatitude + rows * cellStep), roundCoordinate(baseLongitude + columns * cellStep)],
      [roundCoordinate(baseLatitude + rows * cellStep), baseLongitude],
    ],
    paddocks,
  };
}

export function createNearBudgetImportFeatureCollection() {
  const columns = 25;
  const centerStep = 0.0005;
  const radius = 0.0002;
  const features = Array.from({ length: CORPUS_IMPORT_FEATURE_COUNT }, (_, featureIndex) => {
    const row = Math.floor(featureIndex / columns);
    const column = featureIndex % columns;
    const centerLongitude = -73.19 + column * centerStep;
    const centerLatitude = -40.64 + row * centerStep;
    const ring = Array.from(
      { length: CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE },
      (_, vertexIndex) => {
        const angle = vertexIndex / CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE * Math.PI * 2;
        return [
          roundCoordinate(centerLongitude + Math.cos(angle) * radius),
          roundCoordinate(centerLatitude + Math.sin(angle) * radius),
        ];
      },
    );
    ring.push([...ring[0]]);
    return {
      type: "Feature",
      id: `near-budget-${String(featureIndex + 1).padStart(3, "0")}`,
      properties: {
        name: `Feature sintética ${String(featureIndex + 1).padStart(3, "0")}`,
        provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  });
  return {
    type: "FeatureCollection",
    id: "near-budget-500-features",
    name: "Corpus sintético cercano al presupuesto",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    features,
  };
}

export const CORPUS_GOLDEN_PADDOCKS = Object.freeze([
  {
    id: "corpus-golden-paddock",
    fieldId: "corpus-golden-field",
    name: "Potrero Dorado & Humedal",
    sector: "Sintético Norte",
    areaHectares: 0,
    coordinates: MAP_GEOMETRY_CASES.multipleHoles.geometry.outer,
    geometry: MAP_GEOMETRY_CASES.multipleHoles.geometry,
    grazeableAreaHectares: null,
    landUse: "pradera_permanente",
    holeKinds: MAP_GEOMETRY_CASES.multipleHoles.holeKinds,
    soil: { ph: 5.8, nitrogen: 18, phosphorus: 22, potassium: 190 },
    lastActivity: "Fixture sintético",
    status: "Disponible",
  },
]);

export const CORPUS_GOLDEN_EXPORT = Object.freeze({
  fundoName: "Fundo Sintético MAP-002",
  geoJsonPath: "tests/fixtures/map-geometry-corpus/golden/paddocks.geojson",
  kmlPath: "tests/fixtures/map-geometry-corpus/golden/paddocks.kml",
});

const syncGeometry = MAP_GEOMETRY_CASES.simplePolygon.geometry;
const syncUpdate = Object.freeze({
  id: "corpus-sync-paddock",
  expectedVersion: "2026-07-28T10:00:00.000Z",
  geometry: syncGeometry,
  holeKinds: [],
});
const syncExpectedVersion = 'paddock-geometry-v1:[{"id":"corpus-sync-paddock","expectedVersion":"2026-07-28T10:00:00.000Z"}]';
const syncPayload = Object.freeze({
  capturedAt: "2026-07-28T10:02:00.000Z",
  source: "map",
  updates: [syncUpdate],
});
const syncMutation = Object.freeze({
  id: "corpus-sync-operation-001",
  fieldId: "corpus-sync-field",
  entity: "paddock_geometry",
  entityId: "corpus-sync-paddock",
  op: "update",
  payload: syncPayload,
  clientTs: syncPayload.capturedAt,
  expectedVersion: syncExpectedVersion,
});

export const CORPUS_SYNC_SCENARIOS = Object.freeze([
  {
    id: "exact-idempotent-replay",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    mode: "replay",
    firstAttempt: syncMutation,
    replayAttempt: JSON.parse(JSON.stringify(syncMutation)),
    expected: {
      disposition: "idempotent-replay",
      additionalWrites: 0,
      payloadMustMatchExactly: true,
    },
  },
  {
    id: "stale-server-version",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    mode: "stale",
    mutation: syncMutation,
    lww: {
      clientTs: "2026-07-28T10:02:00.000Z",
      nowIso: "2026-07-28T10:03:00.000Z",
      currentUpdatedAt: "2026-07-28T10:04:00.000Z",
      acceptedProjectionMatchesCurrent: false,
      lastAcceptedClientTs: null,
    },
    expected: {
      action: "conflict",
      reasonIncludes: "no es posterior",
    },
  },
  {
    id: "offline-concurrent-conflict",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    mode: "offline-conflict",
    mutation: syncMutation,
    lww: {
      clientTs: "2026-07-28T10:05:00.000Z",
      nowIso: "2026-07-28T10:06:00.000Z",
      currentUpdatedAt: "2026-07-28T10:01:00.000Z",
      acceptedProjectionMatchesCurrent: true,
      lastAcceptedClientTs: "2026-07-28T10:05:30.000Z",
    },
    expected: {
      action: "conflict",
      reasonIncludes: "no es posterior",
    },
  },
  {
    id: "offline-newer-apply",
    provenance: MAP_GEOMETRY_CORPUS_PROVENANCE,
    mode: "offline-apply",
    mutation: syncMutation,
    lww: {
      clientTs: "2026-07-28T10:05:00.000Z",
      nowIso: "2026-07-28T10:06:00.000Z",
      currentUpdatedAt: "2026-07-28T10:01:00.000Z",
      acceptedProjectionMatchesCurrent: false,
      lastAcceptedClientTs: null,
    },
    expected: {
      action: "apply",
      reasonIncludes: null,
    },
  },
]);

export const MAP_GEOMETRY_CORPUS_MANIFEST = Object.freeze([
  { id: "simple-triangle", coverage: "simple/triangle", status: "blocking-pass" },
  { id: "simple-polygon", coverage: "simple/polygon", status: "blocking-pass" },
  { id: "concave-polygon", coverage: "concave", status: "blocking-pass" },
  { id: "multiple-holes", coverage: "multiple-holes", status: "blocking-pass" },
  { id: "shared-boundaries-and-vertices", coverage: "shared-boundaries", status: "blocking-pass" },
  { id: "field-boundary-chain", coverage: "field-boundary-chain", status: "blocking-pass" },
  { id: "containment-tolerance-inside-outside", coverage: "near-tolerance", status: "blocking-pass" },
  { id: "t-junction", coverage: "t-junction", status: "blocking-pass" },
  { id: "subdivision-two-intersections", coverage: "split-two-intersections", status: "blocking-pass" },
  {
    id: "subdivision-four-plus-intersections",
    coverage: "split-four-plus-intersections",
    status: "blocking-pass",
    resolvedByTicket: "MAP-404",
  },
  {
    id: "subdivision-six-intersections",
    coverage: "split-six-intersections",
    status: "blocking-pass",
    resolvedByTicket: "MAP-404",
  },
  {
    id: "subdivision-exterior-only",
    coverage: "split-exterior-only-rejected",
    status: "blocking-pass",
  },
  {
    id: "subdivision-partial-tail",
    coverage: "split-partial-tail-rejected",
    status: "blocking-pass",
  },
  {
    id: "subdivision-atomic-failure",
    coverage: "split-atomic-failure-rejected",
    status: "blocking-pass",
  },
  {
    id: "subdivision-self-intersecting-divider",
    coverage: "split-self-intersection-rejected",
    status: "blocking-pass",
  },
  { id: "invalid-self-intersecting", coverage: "invalid/self-intersecting", status: "blocking-pass" },
  { id: "synthetic-multipolygon", coverage: "multipolygon-import", status: "blocking-pass" },
  { id: "shapefile-utm-18s", coverage: "non-wgs84-crs", status: "blocking-pass" },
  { id: "grid-200-paddocks", coverage: "200-paddocks", status: "blocking-pass" },
  { id: "near-budget-500-features", coverage: "500-features-near-budget", status: "blocking-pass" },
  { id: "exact-idempotent-replay", coverage: "replay", status: "blocking-pass" },
  { id: "stale-server-version", coverage: "stale", status: "blocking-pass" },
  { id: "offline-concurrent-conflict", coverage: "offline-conflict", status: "blocking-pass" },
  { id: "offline-newer-apply", coverage: "offline-apply", status: "blocking-pass" },
  { id: "golden-geojson-kml", coverage: "golden-formats", status: "blocking-pass" },
  { id: "a4-without-tiles", coverage: "a4-no-tiles", status: "blocking-pass" },
]);
