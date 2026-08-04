import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import {
  buildGisImportCommitPlan,
  createGisImportMappingPlan,
  setGisImportHoleKind,
  updateGisImportMappingFeature,
} from "../src/modules/potreros/import/mapping.ts";
import {
  createDefaultImportLandmarkDrafts,
  decimateImportPreviewPath,
  executeImportPersistencePlan,
  importCommitUiBlockers,
  importPersistenceOperations,
  MAX_IMPORT_PREVIEW_RENDER_VERTICES,
  parseGisBoundaryFile,
} from "../src/modules/potreros/components/import/import-boundaries-state.ts";
import {
  serializePaddocksToGeoJson,
  serializePaddocksToKml,
} from "../src/modules/potreros/export/serialize.ts";
import { calculateAreaSquareMeters } from "../src/modules/potreros/utils/geometry.ts";
import { OSORNO_KML } from "./fixtures/paddock-import-osorno.mjs";

const encoder = new TextEncoder();
const FIXED_ZIP_DATE = new Date("2026-07-20T00:00:00.000Z");

const IMPORT_DOCUMENT = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "limite",
      properties: { name: "Límite Fundo" },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [-73.15, -40.59], [-73.10, -40.59], [-73.10, -40.54], [-73.15, -40.54], [-73.15, -40.59],
        ]],
      },
    },
    {
      type: "Feature",
      id: "potrero-con-hueco",
      properties: { name: "Pradera Norte", sector: "Caracol" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [[-73.14, -40.58], [-73.12, -40.58], [-73.12, -40.56], [-73.14, -40.56], [-73.14, -40.58]],
          [[-73.135, -40.575], [-73.13, -40.575], [-73.13, -40.57], [-73.135, -40.57], [-73.135, -40.575]],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Bebedero" },
      geometry: { type: "Point", coordinates: [-73.125, -40.565] },
    },
    {
      type: "Feature",
      properties: { name: "Camino interior" },
      geometry: { type: "LineString", coordinates: [[-73.14, -40.585], [-73.11, -40.55]] },
    },
  ],
};

function browserFile(name, value, type = "") {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  return {
    name,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function confirmableFixturePlan() {
  const preview = await parseGisBoundaryFile(
    browserFile("fundo.geojson", JSON.stringify(IMPORT_DOCUMENT), "application/geo+json"),
    "fundo-import-ui",
  );
  let plan = createGisImportMappingPlan(preview);
  const paddock = plan.features.find((feature) => feature.kind === "polygon" && feature.role === "paddock");
  assert.ok(paddock);
  plan = updateGisImportMappingFeature(plan, paddock.planFeatureId, { name: "Pradera editada", sector: "Caracol editado" });
  plan = setGisImportHoleKind(plan, paddock.planFeatureId, 0, "humedal");
  return { preview, plan, paddockId: paddock.planFeatureId };
}

test("la entrada accesible abre desde FundoSelector y mantiene parser lazy sin fetch directo", async () => {
  const [selector, dialog, helper, page] = await Promise.all([
    readFile(new URL("../src/modules/potreros/components/FundoSelector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/ImportBoundariesDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/import/import-boundaries-state.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/PotrerosPage.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(selector, /onImport: \(\) => void/);
  assert.match(selector, /Importar mapa/);
  assert.match(page, /onImport=\{\(\) => setImportMapOpen\(true\)\}/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /onDrop=\{handleDrop\}/);
  assert.match(dialog, /GIS_IMPORT_ACCEPT/);
  assert.match(helper, /import\("\.\.\/\.\.\/import\/parser\.ts"\)/);
  assert.doesNotMatch(`${dialog}\n${helper}`, /\bfetch\s*\(/);
});

test("roles, edición, huecos y candidatos point/line atraviesan preview y mapping", async () => {
  const { preview, plan } = await confirmableFixturePlan();
  assert.equal(preview.features.length, 4);
  assert.equal(plan.heuristic.status, "unique_container");
  assert.equal(plan.summary.fieldBoundaries, 1);
  assert.equal(plan.summary.paddocks, 1);
  assert.equal(plan.summary.landmarkCandidates, 2);
  assert.equal(plan.summary.unclassifiedHoles, 0);

  const edited = plan.features.find((feature) => feature.kind === "polygon" && feature.role === "paddock");
  assert.equal(edited.name, "Pradera editada");
  assert.equal(edited.sector, "Caracol editado");
  assert.deepEqual(edited.holeKinds, ["humedal"]);
  const landmarks = plan.features.filter((feature) => feature.kind === "landmark");
  assert.deepEqual(landmarks.map((feature) => feature.geometry.type), ["Point", "LineString"]);
  assert.ok(landmarks.every((feature) => feature.confirmable && feature.blockers.length === 0));

  const built = buildGisImportCommitPlan(plan);
  assert.equal(built.ok, true);
  assert.equal(built.plan.paddocks[0].id, edited.targetId);
  assert.deepEqual(built.plan.paddocks[0].geometry, edited.geometry);
  assert.deepEqual(built.plan.paddocks[0].holeKinds, ["humedal"]);
  assert.equal(built.plan.landmarkCandidates.length, 2);
});

test("bloquea read-only y pérdida de huecos del fundo; offline sólo bloquea ese límite", async () => {
  const { plan } = await confirmableFixturePlan();
  const built = buildGisImportCommitPlan(plan);
  assert.equal(built.ok, true);

  const landmarkDrafts = createDefaultImportLandmarkDrafts(built.plan);
  assert.ok(landmarkDrafts.every(({ kind }) => kind === "otro"), "el tipo visible por defecto siempre es otro");
  assert.match(importCommitUiBlockers(built.plan, false, true, landmarkDrafts).join(" "), /solo lectura/iu);
  assert.match(importCommitUiBlockers(built.plan, true, false, landmarkDrafts).join(" "), /requiere conexión/iu);
  const lossy = structuredClone(built.plan);
  lossy.fieldBoundary.geometry.holes = [[
    [-40.575, -73.135], [-40.575, -73.13], [-40.57, -73.13], [-40.57, -73.135],
  ]];
  assert.match(importCommitUiBlockers(lossy, true, true, landmarkDrafts).join(" "), /sólo conserva el anillo exterior/iu);

  const paddocksOnly = { ...built.plan, fieldBoundary: null, landmarkCandidates: [] };
  assert.deepEqual(importCommitUiBlockers(paddocksOnly, true, false, []), []);
});

test("persistencia secuencial reporta fallo parcial y reintenta sin repetir lo completado", async () => {
  const { plan } = await confirmableFixturePlan();
  const built = buildGisImportCommitPlan(plan);
  assert.equal(built.ok, true);
  const landmarkDrafts = createDefaultImportLandmarkDrafts(built.plan).map((draft, index) => ({
    ...draft,
    kind: index === 0 ? "bebedero" : "cerco_electrico",
    notes: index === 0 ? "Punto verificado" : "Trazado importado",
  }));
  const calls = [];
  let failPaddock = true;
  const callbacks = {
    async persistFieldBoundary(polygon) {
      calls.push(`field:${polygon.id}`);
      return "applied";
    },
    async persistPaddock(polygon) {
      calls.push(`paddock:${polygon.id}`);
      if (failPaddock) throw new Error("sin conexión simulada");
      return "queued";
    },
    async persistLandmark(request) {
      calls.push(`landmark:${request.id}:${request.operationId}:${request.geometryType}`);
      return "applied";
    },
  };

  const partial = await executeImportPersistencePlan(built.plan, callbacks, [], undefined, landmarkDrafts);
  assert.equal(partial.complete, false);
  assert.equal(partial.completed.length, 1);
  assert.match(partial.failure.message, /sin conexión/);
  failPaddock = false;
  const complete = await executeImportPersistencePlan(built.plan, callbacks, partial.completed, undefined, landmarkDrafts);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.completed.map((entry) => entry.disposition), ["applied", "queued", "applied", "applied"]);
  assert.equal(calls.filter((call) => call.startsWith("field:")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("paddock:")).length, 2);
  assert.deepEqual(calls.filter((call) => call.startsWith("landmark:")).map((call) => call.split(":").at(-1)), ["point", "line"]);

  const operations = importPersistenceOperations(built.plan, landmarkDrafts).filter(({ kind }) => kind === "landmark");
  const replay = importPersistenceOperations(built.plan, landmarkDrafts).filter(({ kind }) => kind === "landmark");
  assert.deepEqual(operations.map(({ key }) => key), replay.map(({ key }) => key));
  assert.deepEqual(operations.map(({ request }) => request.operationId), replay.map(({ request }) => request.operationId));
  assert.deepEqual(operations.map(({ request }) => request.kind), ["bebedero", "cerco_electrico"]);
  assert.deepEqual(operations.map(({ request }) => request.geometryType), ["point", "line"]);
  assert.deepEqual(operations.map(({ request }) => request.notes), ["Punto verificado", "Trazado importado"]);
  const ignoredCandidateDraft = { candidateId: "ignored-landmark", kind: "otro", name: "", notes: "ignorado" };
  assert.equal(importPersistenceOperations(built.plan, [...landmarkDrafts, ignoredCandidateDraft]).filter(({ kind }) => kind === "landmark").length, 2);
  assert.deepEqual(importCommitUiBlockers(built.plan, true, true, [...landmarkDrafts, ignoredCandidateDraft]), []);
});

test("callbacks de PotrerosPage preservan IDs/anillos/tipos y pasan por la outbox normal", async () => {
  const page = await readFile(new URL("../src/modules/potreros/PotrerosPage.tsx", import.meta.url), "utf8");
  assert.match(page, /id: polygon\.id/);
  assert.match(page, /geometry,\s+netAreaHectares:/);
  assert.match(page, /holeKinds: \[\.\.\.polygon\.holeKinds\]/);
  assert.match(page, /getOfflineOutbox\(\)\.executeOrQueue/);
  assert.match(page, /onPersistFieldBoundary=\{persistImportedFieldBoundary\}/);
  assert.match(page, /onPersistPaddock=\{persistImportedPaddock\}/);
  assert.match(page, /No se sobrescribió el registro existente/);
});

test("round-trip cliente GeoJSON/KML conserva nombre, sector y área bajo 0,1 %", async () => {
  const coordinates = [
    [-40.57482, -73.14011],
    [-40.57431, -73.13762],
    [-40.57243, -73.13804],
    [-40.57279, -73.14052],
  ];
  const paddock = {
    id: "potrero-ui-roundtrip",
    fieldId: "fundo-ui-roundtrip",
    name: "Pradera UI Osorno",
    sector: "Sector Caracol",
    areaHectares: 0,
    coordinates,
    soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    lastActivity: "Sin actividad",
    status: "Disponible",
  };
  const sourceArea = calculateAreaSquareMeters(coordinates);

  for (const [extension, serialized] of [
    ["geojson", serializePaddocksToGeoJson("Fundo UI", [paddock])],
    ["kml", serializePaddocksToKml("Fundo UI", [paddock])],
  ]) {
    const preview = await parseGisBoundaryFile(browserFile(`roundtrip.${extension}`, serialized), paddock.fieldId);
    const imported = preview.features[0];
    assert.equal(imported.name, paddock.name);
    assert.equal(imported.properties.sector, paddock.sector);
    assert.ok(Math.abs(imported.areaSquareMeters - sourceArea) / sourceArea < 0.001, extension);
  }
});

test("KMZ cliente conserva nombres XML y geometría de su KML", async () => {
  const zip = new JSZip();
  zip.file("capas/doc.kml", OSORNO_KML, { date: FIXED_ZIP_DATE });
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const preview = await parseGisBoundaryFile(browserFile("nombres.kmz", bytes, "application/vnd.google-earth.kmz"), "fundo-kmz-ui");
  assert.equal(preview.format, "kmz");
  assert.equal(preview.features[0].name, "Potrero & KML");
  assert.equal(preview.features[0].properties.sector, "Caracol & Norte");
  assert.deepEqual(preview.features[0].geometry.outer[0], [-40.57, -73.13]);
});

test("la vista canvas acota 100k vértices sin spread ni alterar el plan", async () => {
  const coordinates = Array.from({ length: 100_000 }, (_, index) => [
    -40.6 + index / 10_000_000,
    -73.2 + index / 10_000_000,
  ]);
  const sampled = decimateImportPreviewPath(coordinates, 400);
  assert.equal(sampled.length, 400);
  assert.deepEqual(sampled[0], coordinates[0]);
  assert.deepEqual(sampled.at(-1), coordinates.at(-1));
  assert.equal(coordinates.length, 100_000);
  assert.equal(MAX_IMPORT_PREVIEW_RENDER_VERTICES, 25_000);

  const canvas = await readFile(new URL("../src/modules/potreros/components/import/ImportGeometryPreview.tsx", import.meta.url), "utf8");
  assert.match(canvas, /remainingVertices = MAX_IMPORT_PREVIEW_RENDER_VERTICES/);
  assert.match(canvas, /coordinateBounds\(plan\.features\)/);
  assert.doesNotMatch(canvas, /Math\.(?:min|max)\(\.\.\./);
  assert.doesNotMatch(canvas, /flatMap\(featureCoordinates\)/);
});
