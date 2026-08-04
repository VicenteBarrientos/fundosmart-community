import assert from "node:assert/strict";
import test from "node:test";

import {
  buildForageBudget,
  calculateLotForageDemand,
  estimateBiomassFromNdvi,
  forageStorageKey,
  parseForageObservations,
} from "../src/modules/ganado/lib/forage-rules.ts";

function fundo(overrides = {}) {
  return {
    id: "field-1",
    name: "Fundo Norte",
    location: "Los Lagos",
    areaHectares: 100,
    coordinates: [],
    soilReport: null,
    ...overrides,
  };
}

function potrero(overrides = {}) {
  return {
    id: "paddock-1",
    fieldId: "field-1",
    name: "Potrero Uno",
    sector: "Norte",
    areaHectares: 10,
    coordinates: [],
    soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    lastActivity: "Sin actividad",
    status: "Disponible",
    ...overrides,
  };
}

function lot(overrides = {}) {
  return {
    id: "lot-1",
    fieldId: "field-1",
    paddockId: "paddock-1",
    name: "Vacas",
    category: "dairy_cow",
    animalCount: 10,
    averageWeightKg: 400,
    entryDate: "2026-01-01",
    status: "active",
    ownerName: null,
    trackingMode: "summary",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function animal(overrides = {}) {
  return {
    id: "animal-1",
    lotId: "lot-1",
    tag: "DIIO-1",
    sex: "female",
    status: "active",
    statusDate: null,
    statusReason: null,
    birthDate: null,
    purchasePriceClp: null,
    purchaseDate: null,
    salePriceClp: null,
    saleBuyer: null,
    saleWeightKg: null,
    origin: null,
    notes: "",
    source: "Prueba",
    latestWeightKg: 400,
    latestWeightDate: "2026-07-20",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    id: "plan-1",
    lotId: "lot-1",
    productName: "Concentrado",
    kgPerAnimalDay: 2,
    sackWeightKg: 25,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    id: "obs-1",
    paddockId: "paddock-1",
    observedAt: "2026-07-20",
    ndvi: 0.7,
    biomassKgDmHa: 2_000,
    utilizationPct: 70,
    source: "manual",
    notes: "Aforo",
    createdAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

test("parses semicolon observations with Spanish headers and decimal comma", () => {
  const result = parseForageObservations([
    "\uFEFFPotrero;Fecha;NDVI;Biomasa kg MS/ha;Aprovechamiento;Notas",
    'Potrero Uno;2026-07-20;0,68;1850,5;70%;"Aforo de plato"',
  ].join("\r\n"));

  assert.deepEqual(result, {
    observations: [{
      paddockRef: "Potrero Uno",
      observedAt: "2026-07-20",
      ndvi: 0.68,
      biomassKgDmHa: 1850.5,
      utilizationPct: 70,
      source: "imported",
      notes: "Aforo de plato",
      line: 2,
    }],
    rejected: [],
  });
});

test("parses comma CSV with quoted localized numbers", () => {
  const result = parseForageObservations([
    "Paddock,Date,NDVI,Biomass kg DM/ha,Utilization,Notes",
    'paddock-1,2026-07-19,"0,61","1.750,5",65,"Imported, handheld"',
  ].join("\n"));

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.observations[0], {
    paddockRef: "paddock-1",
    observedAt: "2026-07-19",
    ndvi: 0.61,
    biomassKgDmHa: 1750.5,
    utilizationPct: 65,
    source: "imported",
    notes: "Imported, handheld",
    line: 2,
  });
});

test("parses reordered tab data and applies explicit defaults to omitted columns", () => {
  const result = parseForageObservations([
    "Biomasa\tPotrero\tFecha\tNDVI",
    "2100\tPotrero Dos\t2026-07-18\t0,72",
  ].join("\n"), { defaultUtilizationPct: 62 });

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.observations[0], {
    paddockRef: "Potrero Dos",
    observedAt: "2026-07-18",
    ndvi: 0.72,
    biomassKgDmHa: 2100,
    utilizationPct: 62,
    source: "imported",
    notes: "",
    line: 2,
  });
});

test("parses headerless rows and supplies the requested default date", () => {
  const result = parseForageObservations("paddock-1;;0,55;;60", { defaultObservedAt: "2026-07-17" });
  assert.deepEqual(result.observations, [{
    paddockRef: "paddock-1",
    observedAt: "2026-07-17",
    ndvi: 0.55,
    biomassKgDmHa: null,
    utilizationPct: 60,
    source: "imported",
    notes: "",
    line: 1,
  }]);
  assert.deepEqual(result.rejected, []);
});

test("rejects malformed observation rows with line-specific reasons", () => {
  const result = parseForageObservations([
    "Potrero;Fecha;NDVI;Biomasa;Utilización",
    ";2026-07-20;0,6;;70",
    "P1;20-07-2026;0,6;;70",
    "P1;2026-07-20;1,2;;70",
    "P1;2026-07-20;;;;",
    "P1;2026-07-20;;-5;70",
    "P1;2026-07-20;0,6;;120",
    "P1;2026-07-20;0,6;;70",
  ].join("\n"));

  assert.deepEqual(result.observations.map((entry) => entry.line), [8]);
  assert.deepEqual(result.rejected.map((entry) => entry.line), [2, 3, 4, 5, 6, 7]);
  assert.match(result.rejected[0].reason, /potrero/i);
  assert.match(result.rejected[1].reason, /fecha/i);
  assert.match(result.rejected[2].reason, /NDVI/);
  assert.match(result.rejected[3].reason, /NDVI o biomasa/);
  assert.match(result.rejected[4].reason, /biomasa/i);
  assert.match(result.rejected[5].reason, /aprovechamiento/i);
});

test("calculates individual-lot demand from active measured animals and feeding plan", () => {
  const result = calculateLotForageDemand({
    lot: lot({ trackingMode: "individual", animalCount: 9, averageWeightKg: 999 }),
    animals: [
      animal({ id: "a1", latestWeightKg: 400 }),
      animal({ id: "a2", latestWeightKg: 500 }),
      animal({ id: "a3", status: "sold", latestWeightKg: 600 }),
    ],
    feedingPlan: plan(),
  });

  assert.deepEqual(result, {
    lotId: "lot-1",
    lotName: "Vacas",
    paddockId: "paddock-1",
    headCount: 2,
    averageWeightKg: 450,
    grossDemandKgDmDay: 22.5,
    supplementKgDay: 4,
    supplementKgDmDay: 3.6,
    pastureDemandKgDmDay: 18.9,
  });
});

test("summary-lot demand uses declared headcount and average weight", () => {
  const result = calculateLotForageDemand({
    lot: lot({ animalCount: 10, averageWeightKg: 300 }),
    animals: [],
    feedingPlan: plan({ kgPerAnimalDay: 1 }),
  });

  assert.equal(result.headCount, 10);
  assert.equal(result.grossDemandKgDmDay, 75);
  assert.equal(result.supplementKgDmDay, 9);
  assert.equal(result.pastureDemandKgDmDay, 66);
});

test("NDVI biomass estimation is explicit, calibrated and never negative", () => {
  assert.equal(estimateBiomassFromNdvi(0.7), 2_000);
  assert.equal(estimateBiomassFromNdvi(0.1), 0);
  assert.equal(estimateBiomassFromNdvi(0.6, { bareSoilNdvi: 0.3, kgDmHaPerNdviUnit: 5_000 }), 1_500);
  assert.equal(estimateBiomassFromNdvi(1.5), 0);
});

test("builds offer, lot demand and coverage while prioritizing measured biomass", () => {
  const paddock2 = potrero({ id: "paddock-2", name: "Potrero Dos", areaHectares: 5 });
  const lot2 = lot({ id: "lot-2", name: "Vaquillas", paddockId: "paddock-2", animalCount: 5, averageWeightKg: 300, category: "heifer" });
  const lot3 = lot({ id: "lot-3", name: "Secas", paddockId: null, animalCount: 2, averageWeightKg: 500, category: "dry_cow" });
  const result = buildForageBudget({
    fundos: [fundo()],
    potreros: [potrero(), paddock2],
    lots: [lot(), lot2, lot3, lot({ id: "inactive", status: "sold" })],
    animals: [],
    feedingPlans: [plan()],
    observations: [
      observation({ id: "old", observedAt: "2026-07-01", biomassKgDmHa: 4_000 }),
      observation({ id: "latest", ndvi: 0.95, biomassKgDmHa: 2_000 }),
      observation({ id: "ndvi-only", paddockId: "paddock-2", ndvi: 0.7, biomassKgDmHa: null, utilizationPct: 50 }),
    ],
  });

  assert.equal(result.potreros[0].observation?.id, "latest");
  assert.equal(result.potreros[0].biomassBasis, "observed_biomass");
  assert.equal(result.potreros[0].biomassKgDmHa, 2_000);
  assert.equal(result.potreros[0].usableOfferKgDm, 14_000);
  assert.equal(result.potreros[0].dailyDemandKgDm, 82);
  assert.equal(result.potreros[0].coverageDays, 170.7);

  assert.equal(result.potreros[1].biomassBasis, "ndvi_estimate");
  assert.equal(result.potreros[1].biomassKgDmHa, 2_000);
  assert.equal(result.potreros[1].usableOfferKgDm, 5_000);
  assert.equal(result.potreros[1].dailyDemandKgDm, 37.5);
  assert.equal(result.potreros[1].coverageDays, 133.3);

  assert.equal(result.totalOfferKgDm, 19_000);
  assert.equal(result.assignedDemandKgDmDay, 119.5);
  assert.equal(result.unassignedDemandKgDmDay, 25);
  assert.equal(result.totalDemandKgDmDay, 144.5);
  assert.equal(result.coverageDays, 131.5);
  assert.equal(result.observedPaddocks, 2);
  assert.equal(result.lots.length, 3);
});

test("coverage remains unavailable without observations or daily demand", () => {
  const noObservation = buildForageBudget({
    fundos: [fundo()],
    potreros: [potrero()],
    lots: [lot()],
    animals: [],
    feedingPlans: [],
    observations: [],
  });
  assert.equal(noObservation.coverageDays, null);
  assert.equal(noObservation.potreros[0].coverageDays, null);

  const noDemand = buildForageBudget({
    fundos: [fundo()],
    potreros: [potrero()],
    lots: [],
    animals: [],
    feedingPlans: [],
    observations: [observation()],
  });
  assert.equal(noDemand.coverageDays, null);
  assert.equal(noDemand.potreros[0].coverageDays, null);
});

test("local persistence keys partition observations by offlineScope", () => {
  const first = forageStorageKey("user-a:field-1");
  const second = forageStorageKey("user-b:field-1");
  assert.notEqual(first, second);
  assert.match(first, /^fundosmart:forage-observations:v1:/);
  assert.throws(() => forageStorageKey("  "), /offlineScope/);
});
