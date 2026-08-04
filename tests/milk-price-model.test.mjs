import assert from "node:assert/strict";
import test from "node:test";

import {
  MILK_PRICE_MODEL_SCHEMA_VERSION,
  backtestMilkPriceModel,
  calculateQualitySensitivityTable,
  extractMilkRateObservations,
  fitMilkPriceModel,
  projectMilkSettlement,
  projectionInputFromSettlement,
  resolveMilkComponentKey,
} from "../src/modules/leche/domain/milk-price-model.mjs";

function line(description, measurement, rate, liters) {
  return {
    description,
    measurement,
    unitPriceClp: rate,
    amountClp: rate * liters,
  };
}

function syntheticSettlement({ period, halfLiters, fatFirst, fatSecond, winterRate }) {
  const totalLiters = halfLiters * 2;
  const lineItems = [
    line("Precio base primera quincena", null, 300, halfLiters),
    line("Precio base segunda quincena", null, 300, halfLiters),
    line("Pago por grasa primera quincena", `Grasa ${String(fatFirst).replace(".", ",")}%`, 20 * fatFirst - 60, halfLiters),
    line("Pago por grasa segunda quincena", `Grasa ${String(fatSecond).replace(".", ",")}%`, 20 * fatSecond - 60, halfLiters),
    line("Bono de invierno", null, winterRate, totalLiters),
  ];
  const netAmountClp = lineItems.reduce((sum, entry) => sum + entry.amountClp, 0);
  return {
    id: `synthetic-${period}`,
    fieldId: "field-synthetic",
    period,
    generatedAt: `${period}-28T12:00:00.000Z`,
    plant: "Planta Demostración",
    purchaseOrder: `DEMO-${period}`,
    producerCode: "DEMO-001",
    producerName: "Productor Ficticio",
    buyerName: "Cooperativa Demostración",
    litersFirstHalf: halfLiters,
    litersSecondHalf: halfLiters,
    totalLiters,
    netAmountClp,
    taxAmountClp: Math.round(netAmountClp * 0.19),
    grossAmountClp: netAmountClp + Math.round(netAmountClp * 0.19),
    netPricePerLiterClp: netAmountClp / totalLiters,
    grossPricePerLiterClp: (netAmountClp + Math.round(netAmountClp * 0.19)) / totalLiters,
    sourceDocumentName: `synthetic-${period}.pdf`,
    notes: "Fixture generado para pruebas públicas.",
    lineItems,
  };
}

const SYNTHETIC_SETTLEMENTS = [
  syntheticSettlement({ period: "2026-01", halfLiters: 500, fatFirst: 4, fatSecond: 4.2, winterRate: 10 }),
  syntheticSettlement({ period: "2026-02", halfLiters: 600, fatFirst: 4.1, fatSecond: 4.3, winterRate: 12 }),
];

const component = (model, key) => model.components.find((entry) => entry.componentKey === key);

test("normalizes component labels without merging unknown concepts", () => {
  assert.equal(resolveMilkComponentKey("Pago base primera quincena").key, "base");
  assert.equal(resolveMilkComponentKey("Grasa segunda quincena").key, "grasa");
  assert.equal(resolveMilkComponentKey("Bono de invierno").key, "invierno");
  const unknown = resolveMilkComponentKey("Retención judicial");
  assert.equal(unknown.recognized, false);
  assert.ok(unknown.key.startsWith("otros:"));
});

test("extracts contractual rates and fortnight scopes from synthetic lines", () => {
  const observations = extractMilkRateObservations(SYNTHETIC_SETTLEMENTS[0]);
  assert.equal(observations.length, 5);
  assert.deepEqual(observations.slice(0, 2).map((entry) => entry.scope), ["firstHalf", "secondHalf"]);
  assert.ok(observations.every((entry) => entry.provenance === "contractual"));
  assert.equal(observations.find((entry) => entry.componentKey === "invierno").scope, "total");
});

test("fits a buyer-scoped model and a linear synthetic fat response", () => {
  const model = fitMilkPriceModel(SYNTHETIC_SETTLEMENTS);
  const fat = component(model, "grasa");

  assert.equal(model.schemaVersion, MILK_PRICE_MODEL_SCHEMA_VERSION);
  assert.equal(model.buyerName, "Cooperativa Demostración");
  assert.deepEqual(model.periods, ["2026-01", "2026-02"]);
  assert.equal(model.coverage.componentCount, 3);
  assert.equal(model.coverage.unrecognized, 0);
  assert.equal(fat.qualitySensitivity.rSquared, 1);
  assert.equal(fat.qualitySensitivity.pointCount, 4);
  assert.equal(fat.qualitySensitivity.slopeClpPerLiterPerPoint, 20);
  assert.equal(component(model, "base").rateStability.stable, true);
  assert.equal(component(model, "invierno").rateStability.stable, false);
  assert.deepEqual(component(model, "invierno").rateStability.ratesByPeriod, [
    { period: "2026-01", rateClpPerLiter: 10 },
    { period: "2026-02", rateClpPerLiter: 12 },
  ]);
});

test("projects known quality and can fail closed on an unstable bonus", () => {
  const model = fitMilkPriceModel(SYNTHETIC_SETTLEMENTS);
  const projection = projectMilkSettlement(model, {
    totalLiters: 1_000,
    quality: { fatPct: 4.15 },
    allowUnstableRates: false,
  });
  const base = projection.components.find((entry) => entry.componentKey === "base");
  const fat = projection.components.find((entry) => entry.componentKey === "grasa");
  const winter = projection.components.find((entry) => entry.componentKey === "invierno");

  assert.equal(base.amountClp, 300_000);
  assert.equal(fat.rateSource, "qualityFit");
  assert.ok(Math.abs(fat.parts[0].rateClpPerLiter - 23) < 0.001);
  assert.equal(winter.projected, false);
  assert.equal(winter.reason, "unstableRate");
  assert.equal(projection.complete, false);
});

test("backtests and sensitivity reports retain transparent coverage", () => {
  const model = fitMilkPriceModel(SYNTHETIC_SETTLEMENTS);
  const report = backtestMilkPriceModel(SYNTHETIC_SETTLEMENTS, { mode: "inSample" });
  const sensitivity = calculateQualitySensitivityTable(model, { totalLiters: 1_000 });

  assert.equal(report.results.length, 2);
  assert.ok(report.results.every((entry) => entry.components.length === 3));
  assert.equal(sensitivity.find((entry) => entry.componentKey === "grasa").usable, true);
  assert.deepEqual(projectionInputFromSettlement(SYNTHETIC_SETTLEMENTS[0]), {
    litersFirstHalf: 500,
    litersSecondHalf: 500,
    qualityFirstHalf: { fatPct: 4 },
    qualitySecondHalf: { fatPct: 4.2 },
  });
});

test("rejects empty or mixed-buyer histories and never mutates fixtures", () => {
  const snapshot = JSON.stringify(SYNTHETIC_SETTLEMENTS);
  assert.throws(() => fitMilkPriceModel([]), /al menos una liquidación/);
  assert.throws(
    () => fitMilkPriceModel([
      SYNTHETIC_SETTLEMENTS[0],
      { ...SYNTHETIC_SETTLEMENTS[1], buyerName: "Otro comprador" },
    ]),
    /se ajusta por comprador/,
  );
  fitMilkPriceModel(SYNTHETIC_SETTLEMENTS);
  assert.equal(JSON.stringify(SYNTHETIC_SETTLEMENTS), snapshot);
});
