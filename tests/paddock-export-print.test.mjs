import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateAreaSquareMeters, calculatePerimeterMeters, fromGeoJsonPolygon } from "../src/modules/potreros/utils/geometry.ts";
import {
  buildPaddockFeatureCollection,
  coordinateRingsToKml,
  paddockExportHeaders,
  parsePaddockExportRequest,
  sanitizedPaddockExportFilename,
  serializePaddocksToGeoJson,
  serializePaddocksToKml,
} from "../src/modules/potreros/export/serialize.ts";
import { splitPrintLegendRows } from "../src/modules/potreros/export/print-layout.ts";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

const coordinates = [
  [-40, -73],
  [-40, -72.999],
  [-39.999, -72.999],
  [-39.999, -73],
];

const paddock = {
  id: "paddock-special",
  fieldId: "field-a",
  name: "Potrero <Uno> & \"Sur\"",
  sector: "Sector's Norte",
  areaHectares: 999,
  coordinates,
  soil: { ph: 5.6, nitrogen: null, phosphorus: 23.4, potassium: 213.7 },
  lastActivity: "Sin actividad",
  status: "Disponible",
};

test("GeoJSON conserva coordenadas y recalcula área y perímetro crudos", () => {
  const collection = buildPaddockFeatureCollection("Fundo prueba", [paddock]);
  const serialized = JSON.parse(serializePaddocksToGeoJson("Fundo prueba", [paddock]));
  const feature = collection.features[0];

  assert.equal(collection.type, "FeatureCollection");
  assert.equal(collection.name, "Fundo prueba");
  assert.equal(feature.properties.name, paddock.name);
  assert.equal(feature.properties.sector, paddock.sector);
  assert.equal(feature.properties.status, paddock.status);
  assert.deepEqual(feature.properties.soil, paddock.soil);
  assert.notEqual(feature.properties.areaHectares, paddock.areaHectares);
  assert.equal(feature.properties.areaSquareMeters, calculateAreaSquareMeters(coordinates));
  assert.equal(feature.properties.perimeterMeters, calculatePerimeterMeters(coordinates));
  assert.deepEqual(fromGeoJsonPolygon(feature.geometry)[0], coordinates);
  assert.deepEqual(serialized.features[0].geometry.coordinates[0][0], [-73, -40]);
  assert.deepEqual(serialized.features[0].geometry.coordinates[0].at(-1), [-73, -40]);
});

test("KML escapa XML, usa longitud-latitud y queda preparado para innerBoundaryIs", () => {
  const kml = serializePaddocksToKml("Las <Lomas> & \"Sur\"", [paddock]);
  assert.match(kml, /Las &lt;Lomas&gt; &amp; &quot;Sur&quot;/);
  assert.match(kml, /Potrero &lt;Uno&gt; &amp; &quot;Sur&quot;/);
  assert.match(kml, /Sector&apos;s Norte/);
  assert.match(kml, /-73,-40,0/);
  assert.doesNotMatch(kml, /-40,-73,0/);
  assert.equal((kml.match(/-73,-40,0/g) ?? []).length, 2, "el anillo KML debe cerrarse");

  const hole = [
    [-39.9998, -72.9998],
    [-39.9998, -72.9996],
    [-39.9996, -72.9996],
    [-39.9996, -72.9998],
  ];
  const polygonWithHole = coordinateRingsToKml([coordinates, hole]);
  assert.match(polygonWithHole, /outerBoundaryIs/);
  assert.match(polygonWithHole, /innerBoundaryIs/);
});

test("la solicitud y los headers de descarga son cerrados, privados y saneados", () => {
  assert.deepEqual(
    parsePaddockExportRequest("https://example.com/api/potreros/export?fundoId=field-a&format=KML"),
    { ok: true, fundoId: "field-a", format: "kml" },
  );
  assert.equal(parsePaddockExportRequest("https://example.com/api/potreros/export?format=kml").ok, false);
  assert.equal(parsePaddockExportRequest("https://example.com/api/potreros/export?fundoId=field-a&format=csv").ok, false);

  const filename = sanitizedPaddockExportFilename("../Fundo\r\n\"Chifcá\"", "geojson");
  const headers = paddockExportHeaders("../Fundo\r\n\"Chifcá\"", "geojson");
  assert.doesNotMatch(filename, /[\r\n"/\\]/);
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Content-Type"], "application/geo+json; charset=utf-8");
  assert.match(headers["Content-Disposition"], /^attachment; filename="[a-z0-9._-]+"; filename\*=UTF-8''/);
});

test("la ruta export exige view, fundo obligatorio y conserva el tenant en ambos repositorios", async () => {
  const [route, paddockRepository, fieldRepository] = await Promise.all([
    readSource("../app/api/potreros/export/route.ts"),
    readSource("../src/modules/potreros/server/potrero-repository.ts"),
    readSource("../src/modules/potreros/server/fundo-repository.ts"),
  ]);

  assert.match(route, /authorizeApiAccess\("view"\)/);
  assert.match(route, /requireContextField\(access, parsed\.fundoId\)/);
  assert.match(route, /listFundos\(access\)/);
  assert.match(route, /listPotreros\(access, parsed\.fundoId\)/);
  assert.match(route, /parsePaddockExportRequest\(request\.url\)/);
  assert.match(route, /withPrivateExportHeaders\(access\)/);
  assert.match(route, /reauthorizeApiAccess\(access, "view", parsed\.fundoId\)/);
  assert.match(route, /serializePaddocksTo(?:GeoJson|Kml)[\s\S]+reauthorizeApiAccess/);
  assert.match(route, /withPrivateExportHeaders\(currentAccess\)/);
  assert.match(paddockRepository, /eq\(fields\.organizationId, scope\.organizationId\)/);
  assert.match(paddockRepository, /inArray\(fields\.id, scope\.fieldIds\)/);
  assert.match(fieldRepository, /eq\(fields\.organizationId, scope\.organizationId\)/);
  assert.match(fieldRepository, /inArray\(fields\.id, scope\.fieldIds\)/);
});

test("la barrera final de export exige la misma membresía, organización y correo", async () => {
  const access = await readSource("../app/access.ts");
  assert.match(access, /export async function reauthorizeApiAccess/);
  assert.match(access, /export async function reauthorizePageAccess/);
  assert.match(access, /current\.membershipId !== expected\.membershipId/);
  assert.match(access, /current\.organizationId !== expected\.organizationId/);
  assert.match(access, /current\.email !== expected\.email/);
  assert.match(access, /ACCESS_CONTEXT_CHANGED/);
});

test("la impresión A4 preserva el plano vectorial sin depender de teselas", async () => {
  const [page, sheet, map, css, dialog] = await Promise.all([
    readSource("../app/(producto)/potreros/imprimir/page.tsx"),
    readSource("../app/(producto)/potreros/imprimir/PrintPaddockSheet.tsx"),
    readSource("../app/(producto)/potreros/imprimir/PrintPaddockMap.tsx"),
    readSource("../app/(producto)/potreros/imprimir/print.module.css"),
    readSource("../src/modules/potreros/components/ManageFundoDialog.tsx"),
  ]);

  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /export const fetchCache = "force-no-store"/);
  assert.match(page, /requirePageAccess\(returnTo, "view", fundoId \|\| undefined\)/);
  assert.match(page, /reauthorizePageAccess\(access, returnTo, "view", fundoId\)/);
  assert.match(page, /listPotreros\(access, fundoId\)[\s\S]+reauthorizePageAccess/);
  assert.match(page, /`\/app\/potreros\/imprimir\?fundoId=/);
  assert.match(page, /listPotreros\(access, fundoId\)/);
  assert.match(sheet, /dynamic\([\s\S]+?ssr: false/);
  assert.match(sheet, /disabled=\{!mapReady\}/);
  assert.match(sheet, /window\.print\(\)/);
  assert.match(sheet, /aunque el proveedor de mapas online no esté disponible/u);
  assert.match(sheet, /Sin teselas de terceros/u);
  assert.doesNotMatch(sheet, /tileError|imagen satelital|mute=/iu);
  assert.doesNotMatch(map, /TileLayer|arcgisonline|openstreetmap/iu);
  assert.match(map, /whenReady=\{onReady\}/u);
  assert.match(map, /Polygon/u);
  assert.match(map, /zoomControl=\{false\}/);
  assert.match(map, /dragging=\{false\}/);
  assert.match(map, /ScaleControl/);
  assert.match(map, /AttributionControl/);
  assert.match(css, /@page\s*\{[\s\S]*size: A4 landscape/);
  assert.match(dialog, /format=geojson/);
  assert.match(dialog, /format=kml/);
  assert.match(dialog, /\/app\/potreros\/imprimir\?fundoId=/);
  assert.match(dialog, /no dependen de teselas externas/u);
  assert.doesNotMatch(dialog, /mute=/u);
  assert.doesNotMatch(dialog, /href=\{`\/potreros\/imprimir/);
});

test("la leyenda distribuye 30 filas sin perder orden", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `p-${index + 1}` }));
  const columns = splitPrintLegendRows(rows, 15);
  assert.deepEqual(columns.map((column) => column.length), [15, 15]);
  assert.deepEqual(columns.flat(), rows);
});
