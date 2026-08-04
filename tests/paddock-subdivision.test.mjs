import assert from "node:assert/strict";
import test from "node:test";
import {
  compactSubdivisionHistory,
  nearestSubdivisionBoundaryPoint,
  selectSubdivisionStartingState,
  subdividePolygons,
} from "../src/modules/potreros/utils/subdivide.ts";
import { MAP_GEOMETRY_CASES } from "./fixtures/map-geometry-corpus/index.mjs";

const FIELD = [
  [0, 0],
  [0, 10],
  [10, 10],
  [10, 0],
];

test("a straight fence divides a paddock without changing its total area", () => {
  const result = subdividePolygons([FIELD], [[0, 5], [10, 5]]);

  assert.equal(result.error, null);
  assert.equal(result.splitCount, 1);
  assert.equal(result.polygons.length, 2);
  assert.ok(Math.abs(totalArea(result.polygons) - planarArea(FIELD)) < 1e-9);
  assert.deepEqual(result.polygons.map(planarArea).sort((a, b) => a - b), [50, 50]);
});

test("cuts can end on existing fences to build real T junctions", () => {
  let polygons = subdividePolygons([FIELD], [[0, 5], [10, 5]]).polygons;
  polygons = subdividePolygons(polygons, [[5, 0], [5, 5]]).polygons;
  polygons = subdividePolygons(polygons, [[5, 5], [5, 10]]).polygons;

  assert.equal(polygons.length, 4);
  assert.ok(Math.abs(totalArea(polygons) - planarArea(FIELD)) < 1e-9);
  assert.deepEqual(polygons.map(planarArea).sort((a, b) => a - b), [25, 25, 25, 25]);
});

test("curved fences and vertex-to-vertex cuts conserve the parent polygon", () => {
  const curved = subdividePolygons([FIELD], [[0, 3], [3, 4], [7, 6], [10, 7]]);
  const diagonal = subdividePolygons([FIELD], [[0, 0], [10, 10]]);

  assert.equal(curved.error, null);
  assert.ok(Math.abs(totalArea(curved.polygons) - planarArea(FIELD)) < 1e-9);
  assert.equal(diagonal.error, null);
  assert.deepEqual(diagonal.polygons.map(planarArea).sort((a, b) => a - b), [50, 50]);
});

test("a cut reports its two new pieces so the UI can warn about accidental slivers", () => {
  const result = subdividePolygons([FIELD], [[0, 0.1], [0.1, 0]]);

  assert.equal(result.error, null);
  assert.equal(result.createdPolygons.length, 2);
  const areas = result.createdPolygons.map(planarArea).sort((a, b) => a - b);
  assert.ok(Math.abs(areas[0] - 0.005) < 1e-12);
  assert.ok(Math.abs(areas[1] - 99.995) < 1e-12);
});

test("un corte que cruza cuatro veces un potrero cóncavo produce tres piezas", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionFourIntersections;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });

  assert.equal(result.error, null, "un corte válido sobre un potrero cóncavo no puede reportar error");
  assert.equal(result.splitCount, 1);
  assert.equal(result.polygons.length, fixture.expectedPolygonCount);
});

test("un corte cóncavo conserva la superficie total del potrero de origen", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionFourIntersections;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });

  assert.ok(
    Math.abs(totalArea(result.polygons) - planarArea(fixture.polygon)) < 1e-12,
    "dividir nunca puede crear ni perder superficie",
  );
  assert.equal(result.createdPolygons.length, 3, "las tres piezas se reportan para que la interfaz las revise");
});

test("un corte que cruza seis veces un potrero en peineta produce cuatro piezas", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionSixIntersections;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });

  assert.equal(result.error, null);
  assert.equal(result.polygons.length, fixture.expectedPolygonCount);
  assert.ok(Math.abs(totalArea(result.polygons) - planarArea(fixture.polygon)) < 1e-12);
});

test("un corte que termina dentro del potrero se rechaza sin aplicar tramos parciales", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionPartialTail;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });

  assert.ok(result.error);
  assert.equal(result.splitCount, 0);
  assert.deepEqual(result.polygons, [fixture.polygon]);
});

test("un corte que solo roza el exterior de una concavidad sigue siendo rechazado", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionExteriorOnly;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });

  assert.equal(result.splitCount, 0);
  assert.ok(result.error, "un corte que no divide superficie debe explicar por qué no se aplicó");
  assert.equal(result.polygons.length, 1);
});

test("una cuerda interior inválida revierte también las cuerdas válidas del mismo gesto", () => {
  const fixture = MAP_GEOMETRY_CASES.subdivisionAtomicFailure;
  const result = subdividePolygons([fixture.polygon], fixture.divider, { snapDistanceMeters: 0 });

  assert.ok(result.error);
  assert.equal(result.splitCount, 0);
  assert.deepEqual(result.polygons, [fixture.polygon]);
});

test("un divisor autointersectado o solapado con el borde falla antes de producir anillos", () => {
  const selfIntersecting = subdividePolygons(
    [FIELD],
    [[0, 2], [8, 8], [2, 8], [10, 2]],
    { snapDistanceMeters: 0 },
  );
  const boundaryOverlap = subdividePolygons(
    [FIELD],
    [[0, 2], [0, 5], [10, 5]],
    { snapDistanceMeters: 0 },
  );
  const repeatedVertex = subdividePolygons(
    [FIELD],
    [[0, 2], [5, 5], [0, 2], [10, 8]],
    { snapDistanceMeters: 0 },
  );
  const adjacentBacktrack = subdividePolygons(
    [FIELD],
    [[0, 2], [5, 5], [3, 3.8], [10, 8]],
    { snapDistanceMeters: 0 },
  );

  for (const result of [selfIntersecting, boundaryOverlap, repeatedVertex, adjacentBacktrack]) {
    assert.ok(result.error);
    assert.equal(result.splitCount, 0);
    assert.deepEqual(result.polygons, [FIELD]);
  }
});

test("the nearest snap target includes internal shared fences", () => {
  const polygons = subdividePolygons([FIELD], [[0, 5], [10, 5]]).polygons;
  const snap = nearestSubdivisionBoundaryPoint([5, 5.1], polygons);

  assert.ok(snap);
  assert.deepEqual(snap.point, [5, 5]);
  assert.ok(Math.abs(snap.distance - 0.1) < 1e-9);
});

test("persisted undo history stays inside its coordinate budget while retaining the latest states", () => {
  const first = [FIELD];
  const second = [
    [[0, 0], [0, 5], [10, 5]],
    [[0, 5], [0, 10], [10, 5]],
  ];
  const third = [
    [[0, 0], [0, 5], [5, 5]],
    [[0, 5], [0, 10], [5, 5]],
    [[5, 0], [5, 10], [10, 5]],
  ];

  assert.deepEqual(compactSubdivisionHistory([first, second, third], 15), [second, third]);
  assert.deepEqual(compactSubdivisionHistory([first, second, third], 1), [third], "the current map is never discarded");
});

test("an older one-area draft never replaces thirteen saved paddocks", () => {
  const savedPolygons = Array.from({ length: 13 }, (_, index) => [
    [index, 0],
    [index, 1],
    [index + 0.5, 0.5],
  ]);
  const staleDraft = [[FIELD]];
  const startingState = selectSubdivisionStartingState({
    boundary: FIELD,
    savedPolygons,
    draftHistory: staleDraft,
    draftLine: [[0, 2], [10, 2]],
  });

  assert.equal(startingState.source, "saved-paddocks");
  assert.equal(startingState.history[0].length, 13);
  assert.deepEqual(startingState.line, []);
});

test("a draft with more completed areas than the saved map is restored", () => {
  const savedPolygons = subdividePolygons([FIELD], [[0, 5], [10, 5]]).polygons;
  const draftPolygons = subdividePolygons(savedPolygons, [[5, 0], [5, 5]]).polygons;
  const startingState = selectSubdivisionStartingState({
    boundary: FIELD,
    savedPolygons,
    draftHistory: [[FIELD], savedPolygons, draftPolygons],
    draftLine: [[5, 5], [5, 10]],
  });

  assert.equal(startingState.source, "draft");
  assert.equal(startingState.history.at(-1).length, 3);
  assert.deepEqual(startingState.line, [[5, 5], [5, 10]]);
});

function totalArea(polygons) {
  return polygons.reduce((sum, polygon) => sum + planarArea(polygon), 0);
}

function planarArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[1] * next[0] - next[1] * point[0];
  }, 0) / 2);
}
