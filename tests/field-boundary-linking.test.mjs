import assert from "node:assert/strict";
import test from "node:test";
import {
  insertLinkedFieldBoundaryVertex,
  moveLinkedFieldBoundaryVertex,
  removeLinkedFieldBoundaryVertex,
} from "../src/modules/potreros/utils/boundary-editor.ts";

const FIELD = [
  [0, 0],
  [0, 0.01],
  [0.01, 0.01],
  [0.01, 0],
];

const SOUTH = [
  [0, 0],
  [0, 0.01],
  [0.0025, 0.01],
  [0.005, 0.01],
  [0.005, 0],
];

const NORTH = [
  [0.005, 0],
  [0.005, 0.01],
  [0.01, 0.01],
  [0.01, 0],
];

test("mover una esquina del fundo transforma toda la cadena de potreros pegada", () => {
  const pointContact = [
    [0.01, 0.01],
    [0.009, 0.009],
    [0.008, 0.009],
  ];
  const result = moveLinkedFieldBoundaryVertex(
    FIELD,
    { south: SOUTH, north: NORTH, point: pointContact },
    1,
    [0, 0.012],
  );

  assert.deepEqual(result.boundary[1], [0, 0.012]);
  assertCoordinateNear(result.drafts.south[1], [0, 0.012]);
  assertCoordinateNear(result.drafts.south[2], [0.0025, 0.0115]);
  assertCoordinateNear(result.drafts.south[3], [0.005, 0.011]);
  assertCoordinateNear(result.drafts.north[1], [0.005, 0.011]);
  assertCoordinateNear(result.drafts.north[2], [0.01, 0.01]);
  assert.deepEqual(result.drafts.point, pointContact, "un contacto de un solo punto no se considera un borde pegado");
  assert.deepEqual(result.affectedIds.sort(), ["north", "south"]);
  assert.deepEqual(FIELD[1], [0, 0.01], "la operación no muta el límite persistido");
  assert.deepEqual(SOUTH[1], [0, 0.01], "la operación no muta los potreros persistidos");
});

test("la tolerancia enlaza bordes dibujados a menos de dos metros", () => {
  const offset = SOUTH.map(([latitude, longitude]) => (
    longitude === 0.01 ? [latitude, longitude + 0.00001] : [latitude, longitude]
  ));
  const result = moveLinkedFieldBoundaryVertex(FIELD, { offset }, 1, [0, 0.012]);

  assert.deepEqual(result.affectedIds, ["offset"]);
  assertCoordinateNear(result.drafts.offset[1], [0, 0.012]);
  assertCoordinateNear(result.drafts.offset[3], [0.005, 0.011]);
});

test("agregar un punto al fundo lo inserta sólo en el potrero que ocupa ese tramo", () => {
  const result = insertLinkedFieldBoundaryVertex(
    FIELD,
    { south: SOUTH, north: NORTH },
    1,
    [0.003, 0.01],
  );

  assert.deepEqual(result.boundary[2], [0.003, 0.01]);
  assert.ok(result.drafts.south.some((coordinate) => coordinatesNear(coordinate, [0.003, 0.01])));
  assert.equal(result.drafts.north.length, NORTH.length);
  assert.deepEqual(result.affectedIds, ["south"]);
});

test("agregar un punto no mueve un vértice cercano que pertenece a otro borde", () => {
  const unrelated = [
    [0.003, 0.01001],
    [0.0035, 0.0095],
    [0.0025, 0.0095],
  ];
  const result = insertLinkedFieldBoundaryVertex(
    FIELD,
    { south: SOUTH, unrelated },
    1,
    [0.003, 0.01],
  );

  assert.deepEqual(result.drafts.unrelated, unrelated);
  assert.deepEqual(result.affectedIds, ["south"]);
});

test("eliminar un vértice del fundo conserva la unión entre potreros sobre el nuevo tramo", () => {
  const field = [
    [0, 0],
    [0, 0.01],
    [0.005, 0.012],
    [0.01, 0.01],
    [0.01, 0],
  ];
  const south = [
    [0, 0],
    [0, 0.01],
    [0.005, 0.012],
    [0.005, 0],
  ];
  const north = [
    [0.005, 0],
    [0.005, 0.012],
    [0.01, 0.01],
    [0.01, 0],
  ];
  const result = removeLinkedFieldBoundaryVertex(field, { south, north }, 2);

  assert.equal(result.boundary.length, 4);
  assertCoordinateNear(result.drafts.south[2], [0.005, 0.01]);
  assertCoordinateNear(result.drafts.north[1], [0.005, 0.01]);
  assert.deepEqual(result.affectedIds.sort(), ["north", "south"]);
});

function assertCoordinateNear(actual, expected, epsilon = 1e-10) {
  assert.equal(actual.length, 2);
  assert.ok(Math.abs(actual[0] - expected[0]) <= epsilon, `${actual[0]} no coincide con ${expected[0]}`);
  assert.ok(Math.abs(actual[1] - expected[1]) <= epsilon, `${actual[1]} no coincide con ${expected[1]}`);
}

function coordinatesNear(first, second, epsilon = 1e-10) {
  return Math.abs(first[0] - second[0]) <= epsilon && Math.abs(first[1] - second[1]) <= epsilon;
}
