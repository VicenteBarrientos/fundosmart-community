import assert from "node:assert/strict";
import test from "node:test";
import {
  PastureDomainError,
  buildFeedWedge,
  calculateGrowthRate,
  calculateManualDryMatter,
  calculatePastureBudget,
  decideNdviProvider,
  deriveBiomassObservation,
  findRotationOverlaps,
  planLotRotations,
  planRotation,
} from "../src/modules/praderas/domain/pasture-planning.mjs";

const PADDOCKS = [
  { id: "p-1", name: "Uno", areaHectares: 2, currentKgDmPerHectare: 2600, residualKgDmPerHectare: 1500, utilizationPercent: 80 },
  { id: "p-2", name: "Dos", areaHectares: 2, currentKgDmPerHectare: 2200, residualKgDmPerHectare: 1500, utilizationPercent: 80 },
  { id: "p-3", name: "Tres", areaHectares: 2, currentKgDmPerHectare: 1800, residualKgDmPerHectare: 1500, utilizationPercent: 80 },
];
const HERD = { id: "herd-1", animalCount: 20, averageLiveWeightKg: 500, intakePercentLiveWeight: 3 };

test("convierte una muestra de cuadrante a kg MS/ha sin ocultar la evidencia", () => {
  assert.deepEqual(calculateManualDryMatter({
    sampleKind: "quadrat",
    freshWeightGrams: 500,
    dryMatterPercent: 20,
    quadratAreaSquareMeters: 0.25,
  }), {
    method: "manual_quadrat",
    kgDmPerHectare: 4000,
    evidence: { freshWeightGrams: 500, dryMatterPercent: 20, quadratAreaSquareMeters: 0.25 },
  });
});

test("NDVI exige proveedor decidido y calibración del mismo proveedor", () => {
  assert.deepEqual(decideNdviProvider({ mode: "unconfigured", decidedAt: "2026-07-21T00:00:00Z" }), {
    mode: "unconfigured",
    providerKey: null,
    decidedAt: "2026-07-21T00:00:00.000Z",
  });
  assert.throws(
    () => decideNdviProvider({ mode: "configured", decidedAt: "2026-07-21T00:00:00Z" }),
    (error) => error instanceof PastureDomainError && error.code === "NDVI_PROVIDER_UNCONFIGURED",
  );
  const estimate = deriveBiomassObservation({
    id: "obs-ndvi",
    paddockId: "p-1",
    capturedAt: "2026-07-20T12:00:00Z",
    kind: "ndvi",
    providerKey: "chosen-provider",
    meanNdvi: 0.65,
    usablePixelPercent: 88,
  }, {
    id: "cal-v1",
    providerKey: "chosen-provider",
    slopeKgDmPerHa: 3000,
    interceptKgDmPerHa: 400,
    minNdvi: 0.2,
    maxNdvi: 0.9,
  });
  assert.equal(estimate.kgDmPerHectare, 2350);
  assert.equal(estimate.calibrationId, "cal-v1");
  assert.throws(
    () => deriveBiomassObservation({ ...estimate, id: "obs", kind: "ndvi", providerKey: "other", meanNdvi: 0.5, usablePixelPercent: 90 }, { id: "cal", providerKey: "chosen-provider", slopeKgDmPerHa: 1, interceptKgDmPerHa: 1, minNdvi: 0, maxNdvi: 1 }),
    (error) => error.code === "NDVI_CALIBRATION_REQUIRED",
  );
});

test("calcula crecimiento, oferta, demanda y días disponibles con unidades explícitas", () => {
  assert.equal(calculateGrowthRate(
    { paddockId: "p-1", capturedAt: "2026-07-01T00:00:00Z", kgDmPerHectare: 1800 },
    { paddockId: "p-1", capturedAt: "2026-07-11T00:00:00Z", kgDmPerHectare: 2300 },
  ).kgDmPerHaPerDay, 50);
  const budget = calculatePastureBudget({ herd: HERD, paddocks: PADDOCKS });
  assert.equal(budget.dailyDemandKgDm, 300);
  assert.equal(budget.totalSupplyKgDm, 3360);
  assert.equal(budget.availableDays, 11.2);
});

test("feed wedge ordena biomasa y usa una línea objetivo reproducible", () => {
  const wedge = buildFeedWedge({ paddocks: PADDOCKS, entryTargetKgDmPerHectare: 2600, residualTargetKgDmPerHectare: 1500 });
  assert.deepEqual(wedge.map((item) => [item.paddockId, item.targetKgDmPerHectare, item.deviationKgDmPerHectare]), [
    ["p-1", 2600, 0],
    ["p-2", 2050, 150],
    ["p-3", 1500, 300],
  ]);
});

test("planifica intervalos semiabiertos sin solapes y declara la falta de oferta", () => {
  const plan = planRotation({
    startDate: "2026-07-21",
    horizonDays: 14,
    maxPaddockDays: 5,
    herd: HERD,
    paddocks: PADDOCKS,
    entryTargetKgDmPerHectare: 2600,
    residualTargetKgDmPerHectare: 1500,
  });
  assert.equal(plan.feasible, false);
  assert.equal(plan.coveredDays, 9);
  assert.equal(plan.shortageDays, 5);
  assert.deepEqual(plan.visits.map((visit) => [visit.paddockId, visit.startsOn, visit.endsOn]), [
    ["p-1", "2026-07-21", "2026-07-26"],
    ["p-2", "2026-07-26", "2026-07-29"],
    ["p-3", "2026-07-29", "2026-07-30"],
  ]);
  assert.deepEqual(findRotationOverlaps(plan.visits), []);
  assert.equal(plan.blockers[0], "Faltan 5 días de oferta para cubrir el horizonte.");
});

test("detecta solapes por rebaño aunque ocurran en potreros distintos", () => {
  const errors = findRotationOverlaps([
    { herdId: "herd-1", paddockId: "p-1", paddockName: "Uno", startsOn: "2026-07-21", endsOn: "2026-07-24" },
    { herdId: "herd-1", paddockId: "p-2", paddockName: "Dos", startsOn: "2026-07-23", endsOn: "2026-07-25" },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /solapan/);
});

test("asigna lotes a potreros y celdas sin doble uso y conserva el descanso", () => {
  const plan = planLotRotations({
    startDate: "2026-07-21",
    horizonDays: 2,
    maxPaddockDays: 2,
    restDays: 3,
    lots: [
      { id: "lot-a", name: "Lote A", animalCount: 10, averageLiveWeightKg: 500, intakePercentLiveWeight: 3 },
      { id: "lot-b", name: "Lote B", animalCount: 10, averageLiveWeightKg: 500, intakePercentLiveWeight: 3 },
    ],
    paddocks: [
      { id: "p-1", name: "Uno", areaHectares: 2, currentKgDmPerHectare: 3000, residualKgDmPerHectare: 1500, utilizationPercent: 80, cells: [{ id: "cell-1", name: "Franja 1" }] },
      { id: "p-2", name: "Dos", areaHectares: 2, currentKgDmPerHectare: 2900, residualKgDmPerHectare: 1500, utilizationPercent: 80, cells: [{ id: "cell-2", name: "Franja 2" }] },
    ],
    entryTargetKgDmPerHectare: 2600,
    residualTargetKgDmPerHectare: 1500,
  });
  assert.equal(plan.schemaVersion, "fundosmart.pasture.rotation-plan.v3");
  assert.equal(plan.feasible, true);
  assert.equal(plan.shortageDays, 0);
  assert.deepEqual(plan.visits.map((visit) => [visit.lotId, visit.paddockId, visit.cellId, visit.restUntil]), [
    ["lot-a", "p-1", "cell-1", "2026-07-26"],
    ["lot-b", "p-2", "cell-2", "2026-07-26"],
  ]);
  assert.deepEqual(findRotationOverlaps(plan.visits), []);
  assert.match(findRotationOverlaps([
    { lotId: "lot-a", paddockId: "p-1", paddockName: "Uno", startsOn: "2026-07-21", endsOn: "2026-07-23", restUntil: "2026-07-26" },
    { lotId: "lot-b", paddockId: "p-1", paddockName: "Uno", startsOn: "2026-07-24", endsOn: "2026-07-25", restUntil: "2026-07-28" },
  ])[0], /no cumple su descanso/u);
});
