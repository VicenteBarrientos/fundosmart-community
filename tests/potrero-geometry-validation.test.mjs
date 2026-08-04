import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateAreaSquareMeters,
  calculateHectares,
  calculatePathLengthMeters,
  calculatePerimeterMeters,
  containsPolygon,
  coordinateDistanceMeters,
  fromGeoJsonPolygon,
  metersToDegrees,
  polygonsOverlap,
  selfIntersects,
  toGeoJsonPolygon,
} from "../src/modules/potreros/utils/geometry.ts";
import {
  closestPointOnSegment,
  nearestSubdivisionBoundaryPoint,
  subdividePolygons,
} from "../src/modules/potreros/utils/subdivide.ts";
import { validatePotreroGeometry, validatePotreroGeometryCollection } from "../src/modules/potreros/utils/validate.ts";
import {
  LOS_LAGOS_FUNDO,
  LOS_LAGOS_OUTSIDE_POTRERO,
  LOS_LAGOS_OVERLAPPING_SIBLING,
  LOS_LAGOS_POTRERO,
  LOS_LAGOS_SELF_INTERSECTING,
  LOS_LAGOS_SUBDIVISION_FIELD,
} from "./fixtures/potreros-los-lagos.mjs";

test("GeoJSON conversion swaps coordinate order, closes rings, preserves holes, and round-trips", () => {
  const outer = LOS_LAGOS_POTRERO.map((point) => [...point]);
  const hole = [
    [-40.6098, -73.1203],
    [-40.6098, -73.1201],
    [-40.6096, -73.1201],
    [-40.6096, -73.1203],
  ];
  const feature = toGeoJsonPolygon([outer, hole]);

  assert.equal(feature.type, "Feature");
  assert.equal(feature.geometry.type, "Polygon");
  assert.deepEqual(feature.geometry.coordinates[0][0], [-73.1205, -40.61]);
  assert.deepEqual(feature.geometry.coordinates[0].at(-1), feature.geometry.coordinates[0][0]);
  assert.deepEqual(fromGeoJsonPolygon(feature), [outer, hole]);
  assert.deepEqual(fromGeoJsonPolygon(feature.geometry), [outer, hole]);
  assert.equal(outer.length, 4, "conversion must not mutate application coordinates");
});

test("metric area and perimeter stay accurate at latitude -40 degrees", () => {
  const latitude = -40.6;
  const sideMeters = 100;
  const square = [
    [latitude, -73.12],
    [latitude, -73.12 + metersToDegrees(sideMeters, latitude)],
    [latitude + metersToDegrees(sideMeters, latitude, "latitude"), -73.12 + metersToDegrees(sideMeters, latitude)],
    [latitude + metersToDegrees(sideMeters, latitude, "latitude"), -73.12],
  ];

  assert.ok(Math.abs(calculateAreaSquareMeters(square) - 10_000) < 150);
  assert.ok(Math.abs(calculatePerimeterMeters(square) - 400) < 2);
  assert.ok(Math.abs(calculatePathLengthMeters(square.slice(0, 3)) - 200) < 1);
  assert.ok(Math.abs(calculateHectares(square) - 1) < 0.02);
});

test("meter-to-degree and point distance account for longitude compression at latitude -40", () => {
  const latitude = -40;
  const longitudeDegrees = metersToDegrees(15, latitude);
  const latitudeDegrees = metersToDegrees(15, latitude, "latitude");

  assert.ok(longitudeDegrees > latitudeDegrees);
  assert.ok(Math.abs(longitudeDegrees / latitudeDegrees - 1 / Math.cos(latitude * Math.PI / 180)) < 1e-12);
  assert.ok(Math.abs(coordinateDistanceMeters([latitude, -73], [latitude, -73 + longitudeDegrees]) - 15) < 0.01);
});

test("self-intersection, overlap, and tolerant containment have area semantics", () => {
  assert.equal(selfIntersects(LOS_LAGOS_POTRERO), false);
  assert.equal(selfIntersects(LOS_LAGOS_SELF_INTERSECTING), true);
  assert.equal(polygonsOverlap(LOS_LAGOS_POTRERO, LOS_LAGOS_OVERLAPPING_SIBLING), true);

  const touching = LOS_LAGOS_POTRERO.map(([latitude, longitude]) => [latitude, longitude + 0.0015]);
  assert.equal(polygonsOverlap(LOS_LAGOS_POTRERO, touching), false, "a shared boundary has no overlap area");
  assert.equal(containsPolygon(LOS_LAGOS_FUNDO, LOS_LAGOS_POTRERO), true);

  const fiveMetersOutside = LOS_LAGOS_POTRERO.map(([latitude, longitude]) => [
    latitude,
    longitude === -73.1205 ? -73.121 - metersToDegrees(5, latitude) : longitude,
  ]);
  assert.equal(containsPolygon(LOS_LAGOS_FUNDO, fiveMetersOutside, 2), false);
  assert.equal(containsPolygon(LOS_LAGOS_FUNDO, fiveMetersOutside, 10), true);
});

test("topological validation reports blocking errors independently", () => {
  const tooFew = validatePotreroGeometry(LOS_LAGOS_POTRERO.slice(0, 2), [], LOS_LAGOS_FUNDO);
  assert.ok(tooFew.errors.includes("El potrero debe tener al menos 3 vértices."));
  assert.ok(tooFew.errors.includes("El potrero debe tener un área mayor que 0."));

  const collinear = validatePotreroGeometry([
    [-40.61, -73.12],
    [-40.6095, -73.1195],
    [-40.609, -73.119],
  ], [], LOS_LAGOS_FUNDO);
  assert.ok(collinear.errors.includes("El potrero debe tener un área mayor que 0."));

  const kinked = validatePotreroGeometry(LOS_LAGOS_SELF_INTERSECTING, [], LOS_LAGOS_FUNDO);
  assert.ok(kinked.errors.includes("El límite del potrero se cruza consigo mismo."));
});

test("topological validation warns about overlap, field escape, and accidental tiny areas", () => {
  const overlap = validatePotreroGeometry(
    LOS_LAGOS_POTRERO,
    [LOS_LAGOS_OVERLAPPING_SIBLING],
    LOS_LAGOS_FUNDO,
  );
  assert.deepEqual(overlap.errors, []);
  assert.ok(overlap.warnings.includes("El potrero se superpone más de 0,1 ha con otro potrero."));

  const outside = validatePotreroGeometry(LOS_LAGOS_OUTSIDE_POTRERO, [], LOS_LAGOS_FUNDO);
  assert.ok(outside.warnings.includes("Más del 1 % del potrero queda fuera del límite del fundo."));

  const latitude = -40.609;
  const tiny = [
    [latitude, -73.12],
    [latitude, -73.12 + metersToDegrees(10, latitude)],
    [latitude + metersToDegrees(10, latitude, "latitude"), -73.12 + metersToDegrees(10, latitude)],
    [latitude + metersToDegrees(10, latitude, "latitude"), -73.12],
  ];
  const small = validatePotreroGeometry(tiny, [], LOS_LAGOS_FUNDO);
  assert.ok(small.warnings.includes("El potrero tiene menos de 0,05 ha; revisa si fue un clic accidental."));

  const valid = validatePotreroGeometry(LOS_LAGOS_POTRERO, [], LOS_LAGOS_FUNDO);
  assert.deepEqual(valid, { errors: [], warnings: [] });
});

test("collection validation checks each overlap pair once and labels both affected paddocks", () => {
  const result = validatePotreroGeometryCollection(
    [LOS_LAGOS_POTRERO, LOS_LAGOS_OVERLAPPING_SIBLING],
    LOS_LAGOS_FUNDO,
    ["Potrero norte", "Potrero sur"],
  );

  assert.ok(result.warnings.includes("Potrero norte: El potrero se superpone más de 0,1 ha con otro potrero."));
  assert.ok(result.warnings.includes("Potrero sur: El potrero se superpone más de 0,1 ha con otro potrero."));
});

test("subdivision snaps endpoints with a configurable metric threshold at latitude -40", () => {
  const middleLatitude = (LOS_LAGOS_SUBDIVISION_FIELD[0][0] + LOS_LAGOS_SUBDIVISION_FIELD[2][0]) / 2;
  const inset = metersToDegrees(10, middleLatitude);
  const divider = [
    [middleLatitude, LOS_LAGOS_SUBDIVISION_FIELD[0][1] + inset],
    [middleLatitude, LOS_LAGOS_SUBDIVISION_FIELD[1][1] - inset],
  ];
  const nearest = nearestSubdivisionBoundaryPoint(divider[0], [LOS_LAGOS_SUBDIVISION_FIELD]);

  assert.ok(nearest);
  assert.ok(Math.abs(nearest.distanceMeters - 10) < 0.05);
  assert.equal(nearestSubdivisionBoundaryPoint(divider[0], [LOS_LAGOS_SUBDIVISION_FIELD], 5), null);
  assert.ok(nearestSubdivisionBoundaryPoint(divider[0], [LOS_LAGOS_SUBDIVISION_FIELD], 15));
  assert.equal(subdividePolygons([LOS_LAGOS_SUBDIVISION_FIELD], divider).error, null);
  assert.notEqual(
    subdividePolygons([LOS_LAGOS_SUBDIVISION_FIELD], divider, { snapDistanceMeters: 5 }).error,
    null,
  );
});

test("closest-point helper is exported for drawing snap and handles degenerate edges", () => {
  const point = closestPointOnSegment(
    [-40.6095, -73.1195],
    [-40.61, -73.12],
    [-40.609, -73.12],
  );
  assert.ok(Math.abs(point[0] - -40.6095) < 1e-12);
  assert.ok(Math.abs(point[1] - -73.12) < 1e-12);
  assert.deepEqual(
    closestPointOnSegment([-40.609, -73.119], LOS_LAGOS_POTRERO[0], LOS_LAGOS_POTRERO[0]),
    LOS_LAGOS_POTRERO[0],
  );
});
