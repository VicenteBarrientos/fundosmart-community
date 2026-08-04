import assert from "node:assert/strict";
import test from "node:test";
import { calculateAreaSquareMeters, metersToDegrees } from "../src/modules/potreros/utils/geometry.ts";
import {
  buildRotationOverview,
  evaluatePaddockRotation,
  summarizeReadyPaddocks,
} from "../src/modules/potreros/utils/rotation.ts";
import { generateStripCells } from "../src/modules/potreros/utils/strips.ts";
import { DEMO_LA_VEGA_PADDOCK, DEMO_ROTATION_PADDOCKS } from "./fixtures/paddock-phase5-demo.mjs";

const ORIGIN_LATITUDE = -40;
const ORIGIN_LONGITUDE = -73;

function coordinate(northMeters, eastMeters) {
  return [
    ORIGIN_LATITUDE + metersToDegrees(northMeters, ORIGIN_LATITUDE, "latitude"),
    ORIGIN_LONGITUDE + metersToDegrees(eastMeters, ORIGIN_LATITUDE, "longitude"),
  ];
}

function polygonFromMeters(id, name, points) {
  return { id, name, coordinates: points.map(([north, east]) => coordinate(north, east)) };
}

function averageAxis(coordinates, axis) {
  return coordinates.reduce((sum, point) => sum + point[axis], 0) / coordinates.length;
}

test("generateStripCells crea ocho franjas métricas estables en 6 ha y no muta el potrero", () => {
  const paddock = polygonFromMeters("six-ha", "Seis hectáreas", [
    [0, 0],
    [0, 300],
    [200, 300],
    [200, 0],
  ]);
  const original = structuredClone(paddock);

  const result = generateStripCells(paddock, 8, 0);
  const equivalentBearing = generateStripCells(paddock, 8, 360);

  assert.equal(result.cells.length, 8);
  assert.equal(result.bearingDegrees, 0);
  assert.ok(Math.abs(result.sourceAreaSquareMeters - 60_000) < 100);
  assert.ok(Math.abs(result.areaDeltaSquareMeters) <= result.areaToleranceSquareMeters);
  assert.ok(Math.abs(result.stripWidthMeters - 25) < 0.05);
  assert.deepEqual(result.cells, equivalentBearing.cells);
  assert.deepEqual(paddock, original);
  assert.deepEqual(result.cells.map((cell) => cell.id), [
    "six-ha:strip:8:0:1",
    "six-ha:strip:8:0:2",
    "six-ha:strip:8:0:3",
    "six-ha:strip:8:0:4",
    "six-ha:strip:8:0:5",
    "six-ha:strip:8:0:6",
    "six-ha:strip:8:0:7",
    "six-ha:strip:8:0:8",
  ]);
  assert.equal(result.cells[2].name, "Seis hectáreas · Franja 3/8");
  result.cells.forEach((cell, index) => {
    assert.equal(cell.index, index + 1);
    assert.ok(Math.abs(cell.areaSquareMeters - result.sourceAreaSquareMeters / 8) < 1);
    if (index > 0) {
      assert.ok(averageAxis(cell.coordinates, 0) > averageAxis(result.cells[index - 1].coordinates, 0));
    }
  });
});

test("generateStripCells conserva área en un polígono cóncavo real a latitud -40", () => {
  const concave = polygonFromMeters("concave", "Potrero cóncavo", [
    [0, 0],
    [0, 200],
    [50, 200],
    [50, 80],
    [200, 80],
    [200, 0],
  ]);

  const result = generateStripCells(concave, 4, 0);

  assert.equal(result.cells.length, 4);
  assert.ok(Math.abs(result.areaDeltaSquareMeters) <= result.areaToleranceSquareMeters);
  assert.ok(result.cells.every((cell) => cell.coordinates.length >= 4));
  assert.ok(result.cells[0].areaSquareMeters > result.cells[3].areaSquareMeters);
});

test("generateStripCells usa fixtures demo y ordena desde el origen de una flecha al este", () => {
  const result = generateStripCells(DEMO_LA_VEGA_PADDOCK, 4, 90);

  assert.equal(result.paddockId, "demo-potrero-la-vega");
  assert.ok(Math.abs(result.areaDeltaSquareMeters) <= result.areaToleranceSquareMeters);
  result.cells.forEach((cell, index) => {
    if (index > 0) {
      assert.ok(averageAxis(cell.coordinates, 1) > averageAxis(result.cells[index - 1].coordinates, 1));
    }
  });
});

test("generateStripCells rechaza conteos, geometría degenerada, huecos y MultiPolygon de salida", () => {
  const square = polygonFromMeters("square", "Cuadrado", [[0, 0], [0, 100], [100, 100], [100, 0]]);
  const line = polygonFromMeters("line", "Línea", [[0, 0], [50, 0], [100, 0]]);
  const uShape = polygonFromMeters("u-shape", "U", [
    [0, 0],
    [0, 100],
    [100, 100],
    [100, 70],
    [30, 70],
    [30, 30],
    [100, 30],
    [100, 0],
  ]);
  const hole = polygonFromMeters("hole", "Hueco", [[0, 0], [0, 100], [100, 100], [100, 0]]);
  hole.coordinates = [hole.coordinates, polygonFromMeters("inner", "Interior", [[30, 30], [30, 70], [70, 70], [70, 30]]).coordinates];

  assert.throws(() => generateStripCells(square, 1, 0), /entero entre 2 y 200/iu);
  assert.throws(() => generateStripCells(square, 2.5, 0), /entero entre 2 y 200/iu);
  assert.throws(() => generateStripCells(square, 2, Number.NaN), /orientación/iu);
  assert.throws(() => generateStripCells(line, 2, 0), /degenerado/iu);
  assert.throws(() => generateStripCells(hole, 2, 0), /huecos/iu);
  assert.throws(() => generateStripCells(uShape, 2, 0), /MultiPolygon/iu);
});

test("evaluatePaddockRotation respeta ocupado, límites 15/30 y umbrales por fundo", () => {
  const referenceDate = "2026-07-20";
  const occupied = evaluatePaddockRotation({
    id: "occupied",
    name: "Ocupado",
    grazingDates: ["2026-05-01"],
    assignedLotCount: 2,
  }, { referenceDate });
  const fourteen = evaluatePaddockRotation({ id: "d14", name: "D14", grazingDates: ["2026-07-06"] }, { referenceDate });
  const fifteen = evaluatePaddockRotation({ id: "d15", name: "D15", grazingDates: ["2026-07-05"] }, { referenceDate });
  const thirty = evaluatePaddockRotation({ id: "d30", name: "D30", grazingDates: ["2026-06-20"] }, { referenceDate });
  const thirtyOne = evaluatePaddockRotation({ id: "d31", name: "D31", grazingDates: ["2026-06-19"] }, { referenceDate });
  const custom = evaluatePaddockRotation({ id: "custom", name: "Custom", grazingDates: ["2026-07-10"] }, {
    referenceDate,
    recentDays: 7,
    longRestDays: 21,
  });

  assert.deepEqual([occupied.classification, occupied.restDays], ["occupied", 0]);
  assert.deepEqual([fourteen.classification, fourteen.restDays], ["recent", 14]);
  assert.deepEqual([fifteen.classification, fifteen.restDays], ["ready", 15]);
  assert.deepEqual([thirty.classification, thirty.restDays], ["ready", 30]);
  assert.deepEqual([thirtyOne.classification, thirtyOne.restDays], ["long_rest", 31]);
  assert.deepEqual([custom.classification, custom.restDays], ["ready", 10]);
  assert.equal(occupied.isReady, false);
  assert.equal(thirtyOne.isReady, true);
});

test("evaluatePaddockRotation hace explícitas fechas futuras, inválidas y ausencia de historial", () => {
  const future = evaluatePaddockRotation({
    id: "future",
    name: "Futuro",
    grazingDates: ["fecha-mala", "2026-07-18", "2026-07-22"],
  }, { referenceDate: "2026-07-20" });
  const invalid = evaluatePaddockRotation({
    id: "invalid",
    name: "Inválido",
    grazingDates: ["2026-02-30", "sin-fecha"],
  }, { referenceDate: "2026-07-20" });
  const missing = evaluatePaddockRotation({ id: "missing", name: "Sin historial" }, { referenceDate: "2026-07-20" });

  assert.deepEqual({
    classification: future.classification,
    restDays: future.restDays,
    lastGrazingAt: future.lastGrazingAt,
    dataQuality: future.dataQuality,
    invalid: future.invalidGrazingDateCount,
    future: future.futureGrazingDateCount,
    ready: future.isReady,
  }, {
    classification: "recent",
    restDays: 0,
    lastGrazingAt: "2026-07-22",
    dataQuality: "future_history",
    invalid: 1,
    future: 1,
    ready: false,
  });
  assert.deepEqual([invalid.classification, invalid.restDays, invalid.dataQuality, invalid.isReady], [
    "long_rest", null, "invalid_history", false,
  ]);
  assert.deepEqual([missing.classification, missing.restDays, missing.dataQuality, missing.isReady], [
    "long_rest", null, "no_history", false,
  ]);
  assert.throws(
    () => evaluatePaddockRotation({ id: "x", name: "X" }, { referenceDate: "inválida" }),
    /referencia no es válida/iu,
  );
  assert.throws(
    () => evaluatePaddockRotation({ id: "x", name: "X" }, { referenceDate: "2026-07-20", recentDays: 31, longRestDays: 30 }),
    /umbrales/iu,
  );
});

test("buildRotationOverview rankea descanso, resume listos y procesa fixtures demo", () => {
  const inputs = [
    { id: "ready-28", name: "Loma 1", grazingDates: ["2026-06-22"] },
    { id: "long-32", name: "Norte 2", grazingDates: ["2026-06-18"] },
    { id: "ready-15", name: "Vega", grazingDates: ["2026-07-05"] },
    { id: "recent", name: "Reciente", grazingDates: ["2026-07-06"] },
    { id: "future", name: "Futuro", grazingDates: ["2026-07-22"] },
    { id: "unknown", name: "Sin historial" },
    { id: "invalid", name: "Dato inválido", grazingDates: ["mal"] },
    { id: "occupied", name: "Con lote", grazingDates: ["2026-05-01"], assignedLotCount: 1 },
  ];
  const overview = buildRotationOverview(inputs, { referenceDate: "2026-07-20", summaryLimit: 2 });

  assert.deepEqual(overview.readyPaddocks.map((paddock) => paddock.paddockId), ["long-32", "ready-28", "ready-15"]);
  assert.deepEqual(overview.readyPaddocks.map((paddock) => paddock.rank), [1, 2, 3]);
  assert.equal(overview.summary, "Potreros listos para pastorear: Norte 2 (32 días), Loma 1 (28 días).");
  assert.deepEqual(overview.counts, { occupied: 1, recent: 2, ready: 2, long_rest: 3 });
  assert.equal(summarizeReadyPaddocks(overview.paddocks, 3), "Potreros listos para pastorear: Norte 2 (32 días), Loma 1 (28 días), Vega (15 días).");
  assert.equal(summarizeReadyPaddocks(overview.paddocks.filter((item) => !item.isReady)), "No hay potreros listos para pastorear.");

  const demo = buildRotationOverview(DEMO_ROTATION_PADDOCKS, { referenceDate: "2026-07-20" });
  assert.equal(demo.counts.occupied, 1);
  assert.equal(demo.counts.recent, 1);
  assert.equal(demo.counts.long_rest, 1);
  assert.equal(demo.readyPaddocks.length, 0);
});

test("motor de rotación valida lotes y límite del resumen", () => {
  assert.throws(
    () => evaluatePaddockRotation({ id: "x", name: "X", assignedLotCount: -1 }, { referenceDate: "2026-07-20" }),
    /lotes asignados/iu,
  );
  assert.throws(() => summarizeReadyPaddocks([], 0), /límite/iu);
});

test("área del fixture demo permanece intacta tras generar celdas temporales", () => {
  const before = calculateAreaSquareMeters(DEMO_LA_VEGA_PADDOCK.coordinates);
  const snapshot = structuredClone(DEMO_LA_VEGA_PADDOCK);

  generateStripCells(DEMO_LA_VEGA_PADDOCK, 3, 180);

  assert.equal(calculateAreaSquareMeters(DEMO_LA_VEGA_PADDOCK.coordinates), before);
  assert.deepEqual(DEMO_LA_VEGA_PADDOCK, snapshot);
});
