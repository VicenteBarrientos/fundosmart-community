import assert from "node:assert/strict";
import test from "node:test";
import {
  serializePaddocksToGeoJson,
  serializePaddocksToKml,
} from "../src/modules/potreros/export/serialize.ts";
import { previewGisImport } from "../src/modules/potreros/import/parser.ts";
import { calculateAreaSquareMeters } from "../src/modules/potreros/utils/geometry.ts";

const encoder = new TextEncoder();
const coordinates = [
  [-40.57482, -73.14011],
  [-40.57431, -73.13762],
  [-40.57243, -73.13804],
  [-40.57279, -73.14052],
];

const paddock = {
  id: "potrero-roundtrip-osorno",
  fieldId: "fundo-roundtrip-osorno",
  name: "Pradera Osorno",
  sector: "Sector Norte",
  areaHectares: 0,
  coordinates,
  soil: { ph: 5.8, nitrogen: 18, phosphorus: 22, potassium: 190 },
  lastActivity: "Sin actividad",
  status: "Disponible",
};

for (const format of ["geojson", "kml"]) {
  test(`round-trip ${format} conserva geometría y área de Osorno bajo 0,1 %`, async () => {
    const serialized = format === "geojson"
      ? serializePaddocksToGeoJson("Fundo Osorno", [paddock])
      : serializePaddocksToKml("Fundo Osorno", [paddock]);

    const preview = await previewGisImport({
      bytes: encoder.encode(serialized),
      fileName: `fundo-osorno.${format}`,
      fieldId: paddock.fieldId,
    });

    assert.equal(preview.features.length, 1);
    const imported = preview.features[0];
    assert.equal(imported.category, "paddock");
    assert.equal(imported.canCommitV1, true);
    assert.equal(imported.name, paddock.name);
    assert.equal(imported.properties.sector, paddock.sector);
    assert.equal(imported.geometry.type, "Polygon");

    const sourceArea = calculateAreaSquareMeters(coordinates);
    const relativeAreaDifference = Math.abs(imported.areaSquareMeters - sourceArea) / sourceArea;
    assert.ok(
      relativeAreaDifference < 0.001,
      `la diferencia de área ${relativeAreaDifference * 100}% supera 0,1 %`,
    );
  });
}
