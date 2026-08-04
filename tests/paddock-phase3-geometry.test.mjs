import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateGrossHectares,
  calculateNetHectares,
  fromGeoJsonPolygonRings,
  metersToDegrees,
  toGeoJsonPolygon,
} from "../src/modules/potreros/utils/geometry.ts";
import {
  addPolygonExclusion,
  decodeStoredPolygon,
  encodeStoredPolygon,
  removePolygonExclusion,
} from "../src/modules/potreros/utils/polygon-rings.ts";
import {
  buildPaddockFeatureCollection,
  serializePaddocksToKml,
} from "../src/modules/potreros/export/serialize.ts";

const ORIGIN_LATITUDE = -40;
const ORIGIN_LONGITUDE = -73;

function coordinate(northMeters, eastMeters) {
  return [
    ORIGIN_LATITUDE + metersToDegrees(northMeters, ORIGIN_LATITUDE, "latitude"),
    ORIGIN_LONGITUDE + metersToDegrees(eastMeters, ORIGIN_LATITUDE, "longitude"),
  ];
}

function rectangle(westMeters, eastMeters, southMeters, northMeters) {
  return [
    coordinate(southMeters, westMeters),
    coordinate(southMeters, eastMeters),
    coordinate(northMeters, eastMeters),
    coordinate(northMeters, westMeters),
  ];
}

function phase3Geometry() {
  return {
    outer: rectangle(0, 400, 0, 250),
    holes: [rectangle(100, 300, 75, 175)],
  };
}

function paddock(overrides = {}) {
  const geometry = phase3Geometry();
  return {
    id: "phase3-paddock",
    fieldId: "phase3-field",
    name: "Potrero con laguna",
    sector: "Norte",
    areaHectares: 999,
    coordinates: geometry.outer,
    geometry,
    grazeableAreaHectares: null,
    landUse: "pradera_permanente",
    holeKinds: ["laguna"],
    soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    lastActivity: "Creado",
    status: "Disponible",
    ...overrides,
  };
}

test("legacy polygons decode without holes and all new encodings are canonical", () => {
  const legacy = rectangle(0, 100, 0, 100);
  assert.deepEqual(decodeStoredPolygon(JSON.stringify(legacy)), { outer: legacy, holes: [] });
  const stored = encodeStoredPolygon(legacy);
  assert.deepEqual(stored, { outer: legacy, holes: [] });
  assert.notEqual(stored.outer, legacy);
});

test("gross, net, effective override and GeoJSON round-trip preserve every ring", () => {
  const geometry = phase3Geometry();
  const gross = calculateGrossHectares(geometry);
  const net = calculateNetHectares(geometry);
  assert.ok(Math.abs(gross - 10) < 0.05, `gross ${gross}`);
  assert.ok(Math.abs(net - 8) < 0.05, `net ${net}`);
  assert.deepEqual(fromGeoJsonPolygonRings(toGeoJsonPolygon(geometry)), geometry);

  const derived = buildPaddockFeatureCollection("Fundo", [paddock()]).features[0];
  assert.equal(derived.geometry.coordinates.length, 2);
  assert.ok(Math.abs(derived.properties.grossAreaHectares - 10) < 0.05);
  assert.ok(Math.abs(derived.properties.netAreaHectares - 8) < 0.05);
  assert.ok(Math.abs(derived.properties.effectiveGrazeableAreaHectares - 8) < 0.05);
  assert.equal(derived.properties.landUse, "pradera_permanente");
  assert.deepEqual(derived.properties.holeKinds, ["laguna"]);

  const overridden = buildPaddockFeatureCollection("Fundo", [paddock({ grazeableAreaHectares: 6.5 })]).features[0];
  assert.equal(overridden.properties.effectiveGrazeableAreaHectares, 6.5);
  const kml = serializePaddocksToKml("Fundo", [paddock({ grazeableAreaHectares: 6.5 })]);
  assert.match(kml, /<innerBoundaryIs>/);
  assert.match(kml, /<Data name="grossAreaHectares">/);
  assert.match(kml, /<Data name="effectiveGrazeableAreaHectares"><value>6\.5<\/value>/);
  assert.match(kml, /<Data name="landUse"><value>pradera_permanente<\/value>/);
});

test("strict polygon decoder rejects malformed rings, invalid holes and V1 MultiPolygon", () => {
  const outer = rectangle(0, 400, 0, 250);
  const cases = [
    { outer, holes: [rectangle(0, 100, 50, 150)] },
    { outer, holes: [rectangle(500, 600, 50, 150)] },
    { outer, holes: [rectangle(50, 200, 50, 150), rectangle(150, 300, 75, 175)] },
    { outer, holes: [[[...coordinate(50, 50)], [...coordinate(150, 150)], [...coordinate(50, 150)], [...coordinate(150, 50)]]] },
  ];
  for (const candidate of cases) assert.throws(() => decodeStoredPolygon(candidate));
  assert.throws(
    () => decodeStoredPolygon({ type: "MultiPolygon", coordinates: [] }),
    (error) => error.code === "MULTIPOLYGON_UNSUPPORTED",
  );
  assert.throws(() => decodeStoredPolygon({ outer: [[0, 0], [1, 1]], holes: [] }));
  assert.throws(() => decodeStoredPolygon({ outer: [[0, 0], [Number.NaN, 1], [1, 0]], holes: [] }));

  const tooMany = Array.from({ length: 2_001 }, (_, index) => {
    const angle = index * Math.PI * 2 / 2_001;
    return [ORIGIN_LATITUDE + Math.sin(angle) * 0.01, ORIGIN_LONGITUDE + Math.cos(angle) * 0.01];
  });
  assert.throws(
    () => decodeStoredPolygon({ outer: tooMany, holes: [] }),
    /2000 .*rtices/u,
  );
});

test("adding and removing exclusions keeps geometry and exclusion kinds aligned without mutation", () => {
  const outer = rectangle(0, 400, 0, 250);
  const original = { outer, holes: [] };
  const added = addPolygonExclusion(original, [], rectangle(100, 300, 75, 175), "humedal");
  assert.deepEqual(original.holes, []);
  assert.deepEqual(added.holeKinds, ["humedal"]);
  assert.equal(added.geometry.holes.length, 1);

  const removed = removePolygonExclusion(added.geometry, added.holeKinds, 0);
  assert.equal(removed.removedKind, "humedal");
  assert.deepEqual(removed.geometry, { outer, holes: [] });
  assert.deepEqual(removed.holeKinds, []);
});
