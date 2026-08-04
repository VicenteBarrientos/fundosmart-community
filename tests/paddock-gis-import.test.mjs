import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_CLIENT_COMPRESSED_FILE_BYTES,
  MAX_SOURCE_FEATURES,
  MAX_WORKER_PREVIEW_FILE_BYTES,
  MAX_WORKER_PREVIEW_REQUEST_BYTES,
} from "../src/modules/potreros/import/limits.ts";
import { previewGisImport } from "../src/modules/potreros/import/parser.ts";
import { inspectZipEntries } from "../src/modules/potreros/import/safe-zip.ts";
import {
  buildDbf,
  buildPolygonShp,
  OSORNO_GEOJSON,
  OSORNO_KML,
  WGS84_PRJ,
} from "./fixtures/paddock-import-osorno.mjs";

const encoder = new TextEncoder();
const FIXED_ZIP_DATE = new Date("2026-07-20T00:00:00.000Z");

test("GeoJSON normaliza Osorno a [lat,lng], conserva huecos y aplana MultiPolygon", async () => {
  const input = encoder.encode(JSON.stringify(OSORNO_GEOJSON));
  const first = await previewGisImport({ bytes: input, fileName: "ejemplo.geojson", fieldId: "fundo-ejemplo-import" });
  const second = await previewGisImport({ bytes: input, fileName: "otro-nombre.geojson", fieldId: "fundo-ejemplo-import" });

  assert.equal(first.format, "geojson");
  assert.equal(first.sourceFeatureCount, 4);
  assert.equal(first.previewFeatureCount, 5);
  assert.equal(first.limits.maxCompressedFileBytes, MAX_CLIENT_COMPRESSED_FILE_BYTES);
  assert.ok(MAX_WORKER_PREVIEW_FILE_BYTES < first.limits.maxCompressedFileBytes);
  assert.equal(first.importPreviewId, second.importPreviewId);
  assert.match(first.importPreviewId, /^[a-f0-9]{64}$/u);
  const withHole = first.features[0];
  assert.deepEqual(withHole.geometry.outer[0], [-40.57, -73.13]);
  assert.equal(withHole.geometry.holes.length, 1);
  assert.equal(withHole.canCommitV1, false);
  assert.match(withHole.commitBlockers.join(" "), /asigna un tipo a cada hueco/iu);
  assert.equal(withHole.properties.name, "Pradera & Estero");
  assert.equal(withHole.properties.nested, '{"uso":"pradera"}');
  assert.ok(withHole.areaSquareMeters > 40_000);
  assert.ok(withHole.perimeterMeters > 800);

  assert.deepEqual(first.features.slice(1, 3).map((feature) => feature.name), [
    "Dos paños · Parte 1/2",
    "Dos paños · Parte 2/2",
  ]);
  assert.deepEqual(first.features.slice(1, 3).map((feature) => feature.partIndex), [0, 1]);
  assert.equal(first.features[3].category, "infrastructure_candidate");
  assert.equal(first.features[3].geometry.type, "Point");
  assert.deepEqual(first.features[3].geometry.coordinates, [-40.569, -73.128]);
  assert.equal(first.features[4].geometry.type, "LineString");
});

test("KML conserva XML decodificado y KMZ seguro produce la misma geometría", async () => {
  const kmlPreview = await previewGisImport({
    bytes: encoder.encode(OSORNO_KML),
    fileName: "potreros.kml",
    fieldId: "fundo-demo",
  });
  const zip = new JSZip();
  zip.file("capas/doc.kml", OSORNO_KML, { date: FIXED_ZIP_DATE });
  const kmzBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const kmzPreview = await previewGisImport({ bytes: kmzBytes, fileName: "potreros.kmz", fieldId: "fundo-demo" });

  assert.equal(kmlPreview.features[0].name, "Potrero & KML");
  assert.equal(kmlPreview.features[0].properties.sector, "Caracol & Norte");
  assert.deepEqual(kmlPreview.features[0].geometry.outer[0], [-40.57, -73.13]);
  assert.equal(kmzPreview.format, "kmz");
  assert.deepEqual(kmzPreview.features[0].geometry, kmlPreview.features[0].geometry);
  assert.ok(kmzPreview.expandedBytes >= encoder.encode(OSORNO_KML).byteLength);
});

test("ZIP Shapefile exige y procesa .prj, DBF y orden de coordenadas WGS84", async () => {
  const zip = new JSZip();
  zip.file("potreros.shp", buildPolygonShp(), { date: FIXED_ZIP_DATE });
  zip.file("potreros.dbf", buildDbf(), { date: FIXED_ZIP_DATE });
  zip.file("potreros.prj", WGS84_PRJ, { date: FIXED_ZIP_DATE });
  zip.file("potreros.cpg", "UTF-8", { date: FIXED_ZIP_DATE });
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });

  const preview = await previewGisImport({ bytes, fileName: "potreros.zip", fieldId: "fundo-ejemplo-import" });

  assert.equal(preview.format, "shapefile");
  assert.equal(preview.features.length, 1);
  assert.equal(preview.features[0].name.trim(), "Potrero SHP");
  assert.equal(preview.features[0].properties.SECTOR.trim(), "Caracol");
  assert.deepEqual(preview.features[0].geometry.outer[0], [-40.57, -73.13]);
  assert.equal(preview.features[0].canCommitV1, true);
});

test("CRS, coordenadas, XML y archivos corruptos fallan sin filtrar errores internos", async () => {
  const wrongCrs = structuredClone(OSORNO_GEOJSON);
  wrongCrs.crs.properties.name = "EPSG:3857";
  await assert.rejects(
    previewGisImport({ bytes: encoder.encode(JSON.stringify(wrongCrs)), fileName: "wrong.json", fieldId: "f" }),
    (error) => error.code === "UNSUPPORTED_GEOJSON_CRS" && !/stack|proj4|JSON\.parse/iu.test(error.message),
  );

  const outOfRange = {
    type: "Feature",
    properties: { name: "Fuera" },
    geometry: { type: "Point", coordinates: [-190, -40] },
  };
  const invalidPreview = await previewGisImport({
    bytes: encoder.encode(JSON.stringify(outOfRange)),
    fileName: "outside.geojson",
    fieldId: "f",
  });
  assert.equal(invalidPreview.features[0].geometry, null);
  assert.match(invalidPreview.features[0].errors[0], /fuera del rango WGS84/iu);

  await assert.rejects(
    previewGisImport({ bytes: encoder.encode('<!DOCTYPE kml [<!ENTITY x "boom">]><kml>&x;</kml>'), fileName: "bad.kml", fieldId: "f" }),
    (error) => error.code === "UNSAFE_XML",
  );
  await assert.rejects(
    previewGisImport({ bytes: new Uint8Array([1, 2, 3, 4]), fileName: "bad.kmz", fieldId: "f" }),
    (error) => error.code === "CORRUPT_ZIP",
  );
});

test("Shapefile rechaza .prj ausente, ambiguo o no procesable", async () => {
  const missing = new JSZip();
  missing.file("layer.shp", buildPolygonShp(), { date: FIXED_ZIP_DATE });
  const missingBytes = await missing.generateAsync({ type: "uint8array" });
  await assert.rejects(
    previewGisImport({ bytes: missingBytes, fileName: "missing.zip", fieldId: "f" }),
    (error) => error.code === "SHAPEFILE_CRS_REQUIRED",
  );

  const ambiguous = new JSZip();
  ambiguous.file("layer.shp", buildPolygonShp(), { date: FIXED_ZIP_DATE });
  ambiguous.file("layer.prj", WGS84_PRJ, { date: FIXED_ZIP_DATE });
  ambiguous.file("other.prj", WGS84_PRJ, { date: FIXED_ZIP_DATE });
  const ambiguousBytes = await ambiguous.generateAsync({ type: "uint8array" });
  await assert.rejects(
    previewGisImport({ bytes: ambiguousBytes, fileName: "ambiguous.zip", fieldId: "f" }),
    (error) => error.code === "SHAPEFILE_CRS_REQUIRED",
  );

  const invalid = new JSZip();
  invalid.file("layer.shp", buildPolygonShp(), { date: FIXED_ZIP_DATE });
  invalid.file("layer.prj", "NOT_A_PROJECTION", { date: FIXED_ZIP_DATE });
  const invalidBytes = await invalid.generateAsync({ type: "uint8array" });
  await assert.rejects(
    previewGisImport({ bytes: invalidBytes, fileName: "invalid.zip", fieldId: "f" }),
    (error) => error.code === "UNSUPPORTED_SHAPEFILE_CRS",
  );
});

test("límites anti-abuso cubren bytes, entries, rutas, ratio, features y vértices", async () => {
  await assert.rejects(
    previewGisImport({ bytes: new Uint8Array(MAX_CLIENT_COMPRESSED_FILE_BYTES + 1), fileName: "large.json", fieldId: "f" }),
    (error) => error.code === "COMPRESSED_SIZE_LIMIT" && error.status === 413,
  );

  const entriesZip = new JSZip();
  for (let index = 0; index <= MAX_ARCHIVE_ENTRIES; index += 1) {
    entriesZip.file(`entry-${index}.txt`, "x", { date: FIXED_ZIP_DATE });
  }
  const entriesBytes = await entriesZip.generateAsync({ type: "uint8array" });
  assert.throws(() => inspectZipEntries(entriesBytes), (error) => error.code === "ZIP_ENTRY_LIMIT");

  const traversalZip = new JSZip();
  traversalZip.file("../doc.kml", OSORNO_KML, { date: FIXED_ZIP_DATE });
  const traversalBytes = await traversalZip.generateAsync({ type: "uint8array" });
  assert.throws(() => inspectZipEntries(traversalBytes), (error) => error.code === "UNSAFE_ZIP_PATH");

  const bombZip = new JSZip();
  bombZip.file("doc.kml", "A".repeat(200_000), { date: FIXED_ZIP_DATE });
  const bombBytes = await bombZip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  assert.throws(() => inspectZipEntries(bombBytes), (error) => error.code === "ZIP_BOMB");

  const tooManyFeatures = {
    type: "FeatureCollection",
    features: Array.from({ length: MAX_SOURCE_FEATURES + 1 }, (_, index) => ({
      type: "Feature",
      properties: { name: `P${index}` },
      geometry: { type: "Point", coordinates: [-73, -40] },
    })),
  };
  await assert.rejects(
    previewGisImport({ bytes: encoder.encode(JSON.stringify(tooManyFeatures)), fileName: "many.json", fieldId: "f" }),
    (error) => error.code === "FEATURE_LIMIT",
  );

  const rawRing = Array.from({ length: 10_001 }, (_, index) => [
    -73 + index * 0.000001,
    -40 + Math.sin(index / 20) * 0.00001,
  ]);
  const hugePolygon = { type: "Polygon", coordinates: [[...rawRing, rawRing[0]]] };
  await assert.rejects(
    previewGisImport({ bytes: encoder.encode(JSON.stringify(hugePolygon)), fileName: "vertices.json", fieldId: "f" }),
    (error) => error.code === "RAW_VERTEX_LIMIT",
  );
});

test("exceso razonable se simplifica en metros y queda bajo 2.000 vértices por anillo", async () => {
  const center = [-73.13, -40.57];
  const ring = Array.from({ length: 2_500 }, (_, index) => {
    const angle = index / 2_500 * Math.PI * 2;
    const radius = 0.001 + Math.sin(index * 0.7) * 0.000002;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  });
  ring.push(ring[0]);
  const preview = await previewGisImport({
    bytes: encoder.encode(JSON.stringify({ type: "Polygon", coordinates: [ring] })),
    fileName: "simplify.geojson",
    fieldId: "f",
  });

  assert.ok(preview.features[0].vertexCount <= 2_000);
  assert.match(preview.features[0].warnings.join(" "), /tolerancia métrica de 1 m/iu);
  assert.equal(preview.features[0].canCommitV1, true);
});

test("ruta preview exige manage_imports/tenant y fija headers privados; runtime evita APIs Node", async () => {
  const route = await readFile(new URL("../app/api/potreros/import/preview/route.ts", import.meta.url), "utf8");
  const runtimeFiles = await Promise.all([
    "limits.ts", "normalize.ts", "parser.ts", "safe-zip.ts", "types.ts",
  ].map((name) => readFile(new URL(`../src/modules/potreros/import/${name}`, import.meta.url), "utf8")));

  assert.match(route, /authorizeApiAccess\("manage_imports"\)/u);
  assert.match(route, /requireContextField\(access, fieldId\)/u);
  assert.ok(route.indexOf("requireContextField(access, fieldId)") < route.indexOf("file.arrayBuffer()"));
  assert.match(route, /MAX_WORKER_PREVIEW_REQUEST_BYTES/u);
  assert.match(route, /MAX_WORKER_PREVIEW_FILE_BYTES/u);
  assert.ok(MAX_WORKER_PREVIEW_REQUEST_BYTES < MAX_CLIENT_COMPRESSED_FILE_BYTES);
  assert.match(route, /private, no-store/u);
  assert.match(route, /X-Content-Type-Options/u);
  assert.match(route, /nosniff/u);
  assert.doesNotMatch(runtimeFiles.join("\n"), /(?:node:|\bfs\b|\bBuffer\b|\bprocess\b)/u);
  assert.doesNotMatch(runtimeFiles.join("\n"), /Math\.random|passThroughOnException/u);
});
