import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  buildPaddockFeatureCollection,
  serializePaddocksToGeoJson,
  serializePaddocksToKml,
} from "../src/modules/potreros/export/serialize.ts";
import { splitPrintLegendRows } from "../src/modules/potreros/export/print-layout.ts";
import {
  MAX_CLIENT_COMPRESSED_FILE_BYTES,
  MAX_RAW_VERTICES_TOTAL,
  MAX_SOURCE_FEATURES,
} from "../src/modules/potreros/import/limits.ts";
import { previewGisImport } from "../src/modules/potreros/import/parser.ts";
import {
  buildPaddockGeometryVersion,
  decidePaddockGeometryLww,
  validateGeographicSyncMutation,
} from "../src/modules/potreros/sync/geographic-sync-rules.mjs";
import {
  insertBoundaryVertex,
  moveBoundaryVertex,
} from "../src/modules/potreros/utils/boundary-editor.ts";
import {
  calculateGrossAreaSquareMeters,
  calculateNetAreaSquareMeters,
  containsPolygon,
  fromGeoJsonPolygonRings,
  selfIntersects,
  toGeoJsonPolygon,
} from "../src/modules/potreros/utils/geometry.ts";
import { decodeStoredPolygon } from "../src/modules/potreros/utils/polygon-rings.ts";
import { subdividePolygons } from "../src/modules/potreros/utils/subdivide.ts";
import { validatePotreroGeometry } from "../src/modules/potreros/utils/validate.ts";
import { buildDbf, buildPolygonShp } from "./fixtures/paddock-import-osorno.mjs";
import {
  CORPUS_GOLDEN_EXPORT,
  CORPUS_GOLDEN_PADDOCKS,
  CORPUS_GRID_PADDOCK_COUNT,
  CORPUS_IMPORT_FEATURE_COUNT,
  CORPUS_IMPORT_RAW_VERTEX_COUNT,
  CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE,
  CORPUS_MULTIPOLYGON_GEOJSON,
  CORPUS_SYNC_SCENARIOS,
  CORPUS_UTM_18S,
  createCorpusPaddockGrid,
  createNearBudgetImportFeatureCollection,
  MAP_GEOMETRY_CASES,
  MAP_GEOMETRY_CORPUS_MANIFEST,
  MAP_GEOMETRY_CORPUS_PROVENANCE,
  MAP_GEOMETRY_CORPUS_VERSION,
} from "./fixtures/map-geometry-corpus/index.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const encoder = new TextEncoder();
const FIXED_ZIP_DATE = new Date("2026-07-28T00:00:00.000Z");

test("MAP-002 publica un manifiesto sintético, versionado y completo", () => {
  assert.equal(MAP_GEOMETRY_CORPUS_VERSION, "fundosmart.map-geometry-corpus.v2");
  assert.equal(MAP_GEOMETRY_CORPUS_PROVENANCE, "synthetic");
  assert.equal(new Set(MAP_GEOMETRY_CORPUS_MANIFEST.map(({ id }) => id)).size, MAP_GEOMETRY_CORPUS_MANIFEST.length);
  assert.deepEqual(
    new Set(MAP_GEOMETRY_CORPUS_MANIFEST.map(({ coverage }) => coverage)),
    new Set([
      "simple/triangle",
      "simple/polygon",
      "concave",
      "multiple-holes",
      "shared-boundaries",
      "field-boundary-chain",
      "near-tolerance",
      "t-junction",
      "split-two-intersections",
      "split-four-plus-intersections",
      "split-six-intersections",
      "split-exterior-only-rejected",
      "split-partial-tail-rejected",
      "split-atomic-failure-rejected",
      "split-self-intersection-rejected",
      "invalid/self-intersecting",
      "multipolygon-import",
      "non-wgs84-crs",
      "200-paddocks",
      "500-features-near-budget",
      "replay",
      "stale",
      "offline-conflict",
      "offline-apply",
      "golden-formats",
      "a4-no-tiles",
    ]),
  );
  for (const fixture of Object.values(MAP_GEOMETRY_CASES)) {
    assert.equal(fixture.provenance, MAP_GEOMETRY_CORPUS_PROVENANCE, fixture.id);
    assert.ok(MAP_GEOMETRY_CORPUS_MANIFEST.some(({ id }) => id === fixture.id), fixture.id);
  }
  for (const fixture of CORPUS_SYNC_SCENARIOS) {
    assert.equal(fixture.provenance, MAP_GEOMETRY_CORPUS_PROVENANCE, fixture.id);
    assert.ok(MAP_GEOMETRY_CORPUS_MANIFEST.some(({ id }) => id === fixture.id), fixture.id);
  }
});

test("triángulo, polígono simple, concavidad y huecos múltiples conservan el modelo outer/holes", () => {
  const validCases = [
    MAP_GEOMETRY_CASES.simpleTriangle,
    MAP_GEOMETRY_CASES.simplePolygon,
    MAP_GEOMETRY_CASES.concavePolygon,
    MAP_GEOMETRY_CASES.multipleHoles,
  ];
  for (const fixture of validCases) {
    assert.equal(selfIntersects(fixture.geometry.outer), false, fixture.id);
    const decoded = decodeStoredPolygon(fixture.geometry);
    assert.deepEqual(decoded, fixture.geometry, fixture.id);
    assert.deepEqual(fromGeoJsonPolygonRings(toGeoJsonPolygon(decoded)), fixture.geometry, fixture.id);
    assert.deepEqual(validatePotreroGeometry(decoded.outer, [], []).errors, [], fixture.id);
  }

  const holes = MAP_GEOMETRY_CASES.multipleHoles.geometry;
  assert.equal(holes.holes.length, 2);
  assert.ok(calculateNetAreaSquareMeters(holes) < calculateGrossAreaSquareMeters(holes));
});

test("el corpus bloquea autointersecciones sin normalizarlas silenciosamente", () => {
  const fixture = MAP_GEOMETRY_CASES.selfIntersecting;
  assert.equal(selfIntersects(fixture.geometry.outer), true);
  assert.ok(validatePotreroGeometry(fixture.geometry.outer).errors.some((message) => /cruza consigo mismo/u.test(message)));
  assert.throws(() => decodeStoredPolygon(fixture.geometry), /cruza consigo mismo/u);
});

test("insertar y mover un vértice exacto conserva ambos lados de un cerco compartido", () => {
  const fixture = MAP_GEOMETRY_CASES.sharedBoundaries;
  const midpoint = averageCoordinate(...fixture.sharedSegment);
  const inserted = insertBoundaryVertex(fixture.polygons, "west", 1, midpoint);

  assert.deepEqual(inserted.affectedIds.sort(), ["east", "west"]);
  assert.ok(inserted.drafts.west.some((coordinate) => coordinatesEqual(coordinate, midpoint)));
  assert.ok(inserted.drafts.east.some((coordinate) => coordinatesEqual(coordinate, midpoint)));

  const movedPoint = [midpoint[0], midpoint[1] + 0.00001];
  const westIndex = inserted.drafts.west.findIndex((coordinate) => coordinatesEqual(coordinate, midpoint));
  const moved = moveBoundaryVertex(inserted.drafts, "west", westIndex, movedPoint);
  assert.deepEqual(moved.affectedIds.sort(), ["east", "west"]);
  assert.ok(moved.drafts.east.some((coordinate) => coordinatesEqual(coordinate, movedPoint)));
});

test("la cadena del límite comparte aristas y cubre el borde completo", () => {
  const fixture = MAP_GEOMETRY_CASES.fieldBoundaryChain;
  assert.equal(fixture.paddocks.length, 4);
  assert.deepEqual(fixture.paddocks[0][0], fixture.field[0]);
  assert.deepEqual(fixture.paddocks.at(-1)[1], fixture.field[1]);

  fixture.paddocks.slice(0, -1).forEach((paddock, index) => {
    const next = fixture.paddocks[index + 1];
    assert.ok(coordinatesEqual(paddock[1], next[0]));
    assert.ok(coordinatesEqual(paddock[2], next[3]));
  });
});

test("la tolerancia de contención distingue puntos casi coincidentes dentro y fuera del límite", () => {
  const fixture = MAP_GEOMETRY_CASES.tolerance;
  assert.equal(containsPolygon(fixture.field, fixture.withinTolerance), false);
  assert.equal(
    containsPolygon(fixture.field, fixture.withinTolerance, fixture.toleranceMeters),
    fixture.expected.withinTolerance,
  );
  assert.equal(
    containsPolygon(fixture.field, fixture.outsideTolerance, fixture.toleranceMeters),
    fixture.expected.outsideTolerance,
  );
});

test("una T-junction y una división de dos intersecciones conservan el área", () => {
  const tJunction = MAP_GEOMETRY_CASES.tJunction;
  let tJunctionPolygons = [tJunction.polygon];
  for (const divider of tJunction.dividers) {
    const result = subdividePolygons(tJunctionPolygons, divider, { snapDistanceMeters: 0 });
    assert.equal(result.error, null);
    tJunctionPolygons = result.polygons;
  }
  assert.equal(tJunctionPolygons.length, tJunction.expectedPolygonCount);

  const split = MAP_GEOMETRY_CASES.subdivisionTwoIntersections;
  const originalArea = calculateGrossAreaSquareMeters({ outer: split.polygon, holes: [] });
  const result = subdividePolygons([split.polygon], split.divider, { snapDistanceMeters: 0 });
  assert.equal(result.error, null);
  assert.equal(result.polygons.length, split.expectedPolygonCount);
  const splitArea = result.polygons.reduce(
    (sum, outer) => sum + calculateGrossAreaSquareMeters({ outer, holes: [] }),
    0,
  );
  assert.ok(Math.abs(splitArea - originalArea) <= Math.min(originalArea * 5e-6, 5));
});

test("MAP-404 divide un arco cruzado cuatro veces en lugar de rechazarlo", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionFourIntersections;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });
  const manifestEntry = MAP_GEOMETRY_CORPUS_MANIFEST.find(({ id }) => id === fixture.id);
  const originalArea = calculateGrossAreaSquareMeters({ outer: fixture.polygon, holes: [] });

  assert.equal(fixture.expected, "split");
  assert.equal(fixture.resolvedByTicket, "MAP-404");
  assert.equal(manifestEntry?.status, "blocking-pass");
  assert.equal(result.error, null);
  assert.equal(result.splitCount, 1);
  assert.equal(result.polygons.length, fixture.expectedPolygonCount);

  // Las dos patas del arco quedan bajo el corte y el resto sobre él, en proporción
  // 15 : 15 : 42 sobre la superficie original. La fixture abarca 0,001° y usa la
  // misma tolerancia relativa 5e-6 declarada por la invariante de conservación.
  const proporciones = result.polygons
    .map((outer) => calculateGrossAreaSquareMeters({ outer, holes: [] }) / originalArea)
    .sort((a, b) => a - b);
  [15 / 72, 15 / 72, 42 / 72].forEach((esperada, indice) => {
    assert.ok(Math.abs(proporciones[indice] - esperada) < 5e-6, `pieza ${indice}: ${proporciones[indice]}`);
  });

  const splitArea = result.polygons.reduce(
    (sum, outer) => sum + calculateGrossAreaSquareMeters({ outer, holes: [] }),
    0,
  );
  assert.ok(Math.abs(splitArea - originalArea) <= Math.min(originalArea * 5e-6, 5));
});

test("MAP-404 divide seis intersecciones y rechaza cualquier resultado parcial", () => {
  const six = MAP_GEOMETRY_CASES.subdivisionSixIntersections;
  const sixResult = subdividePolygons([six.polygon], six.divider, { snapDistanceMeters: 0 });

  assert.equal(sixResult.error, null);
  assert.equal(sixResult.polygons.length, six.expectedPolygonCount);

  for (const fixture of [
    MAP_GEOMETRY_CASES.subdivisionExteriorOnly,
    MAP_GEOMETRY_CASES.subdivisionPartialTail,
    MAP_GEOMETRY_CASES.subdivisionAtomicFailure,
    MAP_GEOMETRY_CASES.subdivisionSelfIntersectingDivider,
  ]) {
    const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });
    assert.equal(fixture.expected, "reject");
    assert.ok(result.error, fixture.id);
    assert.equal(result.splitCount, 0, fixture.id);
    assert.deepEqual(result.polygons, [fixture.polygon], fixture.id);
  }
});

test("un MultiPolygon importado se divide en entidades explícitas", async () => {
  const preview = await previewGisImport({
    bytes: encoder.encode(JSON.stringify(CORPUS_MULTIPOLYGON_GEOJSON)),
    fileName: "corpus-multipolygon.geojson",
    fieldId: "corpus-field",
  });

  assert.equal(preview.sourceFeatureCount, 1);
  assert.equal(preview.previewFeatureCount, 2);
  assert.deepEqual(preview.features.map(({ partIndex }) => partIndex), [0, 1]);
  assert.deepEqual(preview.features.map(({ category }) => category), ["paddock", "paddock"]);
  assert.ok(preview.features.every(({ canCommitV1 }) => canCommitV1));
});

test("un Shapefile UTM 18S se normaliza a WGS84 con error acotado", async () => {
  const zip = new JSZip();
  zip.file("corpus.shp", buildPolygonShp(CORPUS_UTM_18S.projectedRing), { date: FIXED_ZIP_DATE });
  zip.file("corpus.dbf", buildDbf({ NAME: "UTM sintético", SECTOR: "MAP-002" }), { date: FIXED_ZIP_DATE });
  zip.file("corpus.prj", CORPUS_UTM_18S.prj, { date: FIXED_ZIP_DATE });
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const preview = await previewGisImport({
    bytes,
    fileName: "corpus-utm-18s.zip",
    fieldId: "corpus-field",
  });

  assert.equal(preview.format, "shapefile");
  assert.equal(preview.features.length, 1);
  const actual = preview.features[0].geometry.outer;
  assert.equal(actual.length, CORPUS_UTM_18S.expectedWgs84Ring.length);
  actual.forEach((coordinate, index) => {
    assert.ok(
      Math.abs(coordinate[0] - CORPUS_UTM_18S.expectedWgs84Ring[index][0])
        <= CORPUS_UTM_18S.maximumCoordinateErrorDegrees,
      `latitud ${index}`,
    );
    assert.ok(
      Math.abs(coordinate[1] - CORPUS_UTM_18S.expectedWgs84Ring[index][1])
        <= CORPUS_UTM_18S.maximumCoordinateErrorDegrees,
      `longitud ${index}`,
    );
  });
});

test("el volumen de 200 potreros es determinista, contiguo y serializable", () => {
  const first = createCorpusPaddockGrid();
  const second = createCorpusPaddockGrid();
  assert.equal(first.paddocks.length, CORPUS_GRID_PADDOCK_COUNT);
  assert.equal(new Set(first.paddocks.map(({ id }) => id)).size, CORPUS_GRID_PADDOCK_COUNT);
  assert.deepEqual(first, second);
  assert.ok(first.paddocks.every(({ coordinates }) => containsPolygon(first.fieldBoundary, coordinates)));

  for (let index = 0; index < 19; index += 1) {
    assert.deepEqual(first.paddocks[index].coordinates[1], first.paddocks[index + 1].coordinates[0]);
    assert.deepEqual(first.paddocks[index].coordinates[2], first.paddocks[index + 1].coordinates[3]);
  }

  const exported = buildPaddockFeatureCollection("Corpus 200", first.paddocks);
  assert.equal(exported.features.length, CORPUS_GRID_PADDOCK_COUNT);
  assert.equal(hash(JSON.stringify(exported)), hash(JSON.stringify(buildPaddockFeatureCollection("Corpus 200", second.paddocks))));
});

test("500 features quedan cerca del presupuesto sin superarlo y producen preview completo", async () => {
  const collection = createNearBudgetImportFeatureCollection();
  const bytes = encoder.encode(JSON.stringify(collection));
  assert.equal(collection.features.length, CORPUS_IMPORT_FEATURE_COUNT);
  assert.equal(CORPUS_IMPORT_FEATURE_COUNT, MAX_SOURCE_FEATURES);
  assert.equal(
    CORPUS_IMPORT_RAW_VERTEX_COUNT,
    CORPUS_IMPORT_FEATURE_COUNT * (CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE + 1),
  );
  assert.ok(CORPUS_IMPORT_RAW_VERTEX_COUNT >= MAX_RAW_VERTICES_TOTAL * 0.99);
  assert.ok(CORPUS_IMPORT_RAW_VERTEX_COUNT <= MAX_RAW_VERTICES_TOTAL);
  assert.ok(bytes.byteLength < MAX_CLIENT_COMPRESSED_FILE_BYTES);
  assert.equal(hash(JSON.stringify(collection)), hash(JSON.stringify(createNearBudgetImportFeatureCollection())));

  const preview = await previewGisImport({
    bytes,
    fileName: "corpus-500-features.geojson",
    fieldId: "corpus-field",
  });
  assert.equal(preview.sourceFeatureCount, CORPUS_IMPORT_FEATURE_COUNT);
  assert.equal(preview.previewFeatureCount, CORPUS_IMPORT_FEATURE_COUNT);
  assert.equal(preview.totalRawVertices, CORPUS_IMPORT_RAW_VERTEX_COUNT);
  assert.equal(
    preview.totalPreviewVertices,
    CORPUS_IMPORT_FEATURE_COUNT * CORPUS_IMPORT_UNIQUE_VERTICES_PER_FEATURE,
  );
  assert.ok(preview.features.every(({ canCommitV1, errors }) => canCommitV1 && errors.length === 0));
});

test("replay exacto, stale y conflicto offline usan el contrato geográfico vigente", () => {
  const replay = scenario("exact-idempotent-replay");
  assert.equal(validateGeographicSyncMutation(replay.firstAttempt), null);
  assert.equal(validateGeographicSyncMutation(replay.replayAttempt), null);
  assert.equal(hash(JSON.stringify(replay.firstAttempt)), hash(JSON.stringify(replay.replayAttempt)));
  assert.equal(
    buildPaddockGeometryVersion(replay.firstAttempt.payload.updates),
    replay.firstAttempt.expectedVersion,
  );
  assert.deepEqual(replay.replayAttempt, replay.firstAttempt);

  for (const id of ["stale-server-version", "offline-concurrent-conflict", "offline-newer-apply"]) {
    const fixture = scenario(id);
    assert.equal(validateGeographicSyncMutation(fixture.mutation), null, id);
    const decision = decidePaddockGeometryLww(fixture.lww);
    assert.equal(decision.action, fixture.expected.action, id);
    if (fixture.expected.reasonIncludes) assert.match(decision.reason, new RegExp(fixture.expected.reasonIncludes, "u"), id);
    else assert.equal(decision.reason, null, id);
  }
});

test("los formatos dorados GeoJSON y KML coinciden exactamente y hacen round-trip", async () => {
  const [goldenGeoJson, goldenKml] = await Promise.all([
    readProjectFile(CORPUS_GOLDEN_EXPORT.geoJsonPath),
    readProjectFile(CORPUS_GOLDEN_EXPORT.kmlPath),
  ]);
  const generatedGeoJson = serializePaddocksToGeoJson(CORPUS_GOLDEN_EXPORT.fundoName, CORPUS_GOLDEN_PADDOCKS);
  const generatedKml = serializePaddocksToKml(CORPUS_GOLDEN_EXPORT.fundoName, CORPUS_GOLDEN_PADDOCKS);

  assert.equal(normalizeText(generatedGeoJson), normalizeText(goldenGeoJson));
  assert.equal(normalizeText(generatedKml), normalizeText(goldenKml));

  for (const [fileName, serialized] of [["golden.geojson", generatedGeoJson], ["golden.kml", generatedKml]]) {
    const preview = await previewGisImport({
      bytes: encoder.encode(serialized),
      fileName,
      fieldId: "corpus-golden-field",
    });
    assert.equal(preview.features.length, 1, fileName);
    assert.equal(preview.features[0].geometry.type, "Polygon", fileName);
    assert.deepEqual(
      {
        outer: preview.features[0].geometry.outer,
        holes: preview.features[0].geometry.holes,
      },
      CORPUS_GOLDEN_PADDOCKS[0].geometry,
      fileName,
    );
  }
});

test("el contrato A4 permanece vectorial, ordenado y sin tiles", async () => {
  const [mapSource, sheetSource, css] = await Promise.all([
    readProjectFile("app/(producto)/potreros/imprimir/PrintPaddockMap.tsx"),
    readProjectFile("app/(producto)/potreros/imprimir/PrintPaddockSheet.tsx"),
    readProjectFile("app/(producto)/potreros/imprimir/print.module.css"),
  ]);

  assert.match(mapSource, /\bPolygon\b/u);
  assert.match(mapSource, /\bScaleControl\b/u);
  assert.match(mapSource, /FundoSmart · sin mapa base/u);
  assert.doesNotMatch(mapSource, /TileLayer|https?:\/\//u);
  assert.match(sheetSource, /Sin teselas de terceros/u);
  assert.match(sheetSource, /no esté disponible/u);
  assert.match(css, /@page\s*\{[\s\S]*size:\s*A4 landscape/u);

  const legendRows = createCorpusPaddockGrid(30).paddocks;
  const columns = splitPrintLegendRows(legendRows, 15);
  assert.deepEqual(columns.map(({ length }) => length), [15, 15]);
  assert.deepEqual(columns.flat().map(({ id }) => id), legendRows.map(({ id }) => id));
});

function averageCoordinate(first, second) {
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
}

function coordinatesEqual(first, second) {
  return first[0] === second[0] && first[1] === second[1];
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function scenario(id) {
  const fixture = CORPUS_SYNC_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(fixture, `Falta escenario ${id}`);
  return fixture;
}

function normalizeText(value) {
  return value.replaceAll("\r\n", "\n").trimEnd();
}

function readProjectFile(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}
