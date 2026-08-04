import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MILK_QUALITY_THRESHOLDS,
  analyzeMilkSettlement,
  calculateMilkPaymentComposition,
  classifyMilkLineItem,
  parseChileanNumber,
} from "../src/modules/leche/domain/milk-settlement-analysis.mjs";

function syntheticSettlement() {
  const lineItems = [
    { description: "Precio base", measurement: "10.000 L", unitPriceClp: 300, amountClp: 3_000_000 },
    { description: "Pago por grasa", measurement: "Grasa 4,20%", unitPriceClp: 20, amountClp: 200_000 },
    { description: "Pago por proteína", measurement: "Proteína 3,50%", unitPriceClp: 15, amountClp: 150_000 },
    { description: "Bono células somáticas", measurement: "250.000 células/ml", unitPriceClp: 10, amountClp: 100_000 },
    { description: "Bono UFC", measurement: "12.000 UFC/ml", unitPriceClp: 5, amountClp: 50_000 },
  ];
  return {
    id: "synthetic-settlement",
    period: "2026-01",
    litersFirstHalf: 5_000,
    litersSecondHalf: 5_000,
    totalLiters: 10_000,
    netAmountClp: lineItems.reduce((sum, entry) => sum + entry.amountClp, 0),
    lineItems,
  };
}

test("parses Chilean decimal, thousands, currency and unit formats", () => {
  assert.equal(parseChileanNumber("4,42"), 4.42);
  assert.equal(parseChileanNumber("22.991 L"), 22_991);
  assert.equal(parseChileanNumber("$ 1.234,56/L"), 1_234.56);
  assert.equal(parseChileanNumber("1.000.000 UFC/ml"), 1_000_000);
  assert.equal(parseChileanNumber("4.42"), 4.42);
  assert.equal(parseChileanNumber(null), null);
  assert.equal(parseChileanNumber("sin medición"), null);
  assert.equal(parseChileanNumber("A1-A1"), null);
});

test("classifies the six payment concepts without customer fixtures", () => {
  const examples = [
    ["Precio base", "base"],
    ["Pago por proteína", "composicion"],
    ["Células somáticas", "calidad"],
    ["Calidad sanitaria TBC y brucelosis", "sanitario"],
    ["Bono estacional", "bonos"],
    ["Ajuste de redondeo", "otros"],
  ];
  for (const [label, expected] of examples) assert.equal(classifyMilkLineItem(label), expected);
});

test("normalizes synthetic quality readings and reconciles payment composition", () => {
  const settlement = syntheticSettlement();
  const analysis = analyzeMilkSettlement(settlement);
  const payment = calculateMilkPaymentComposition(settlement);

  assert.equal(analysis.quality.fatPct, 4.2);
  assert.equal(analysis.quality.proteinPct, 3.5);
  assert.equal(analysis.quality.somaticCellCount, 250_000);
  assert.equal(analysis.quality.bacterialCountUfc, 12_000);
  assert.deepEqual(analysis.alerts, []);
  assert.equal(payment.totalAmountClp, settlement.netAmountClp);
  assert.equal(payment.reconciliationDifferenceClp, 0);
  assert.equal(payment.categories.reduce((sum, entry) => sum + entry.amountClp, 0), settlement.netAmountClp);
});

test("raises RCS and UFC alerts with defaults and configurable thresholds", () => {
  assert.deepEqual(DEFAULT_MILK_QUALITY_THRESHOLDS, { rcs: 700_000, ufc: 1_000_000 });
  const settlement = {
    litersFirstHalf: 10_000,
    litersSecondHalf: 10_000,
    totalLiters: 20_000,
    netAmountClp: 0,
    lineItems: [
      { description: "RCS primera quincena", measurement: "701 mil células/ml", unitPriceClp: 0, amountClp: 0 },
      { description: "UFC segunda quincena", measurement: "1.000.001 UFC/ml", unitPriceClp: 0, amountClp: 0 },
    ],
  };
  const result = analyzeMilkSettlement(settlement);
  assert.deepEqual(result.alerts.map((alert) => alert.code), ["RCS_THRESHOLD_EXCEEDED", "UFC_THRESHOLD_EXCEEDED"]);
  assert.equal(result.alerts[0].value, 701_000);
  assert.equal(result.alerts[0].periodPart, "firstHalf");

  const stricter = analyzeMilkSettlement(syntheticSettlement(), {
    thresholds: { rcs: "200.000", ufc: "10.000" },
  });
  assert.deepEqual(stricter.alerts.map((alert) => alert.metric), ["rcs", "ufc"]);
});

test("does not divide by zero and rejects invalid quality thresholds", () => {
  const payment = calculateMilkPaymentComposition([
    { description: "Precio base", measurement: null, unitPriceClp: null, amountClp: 100 },
  ], 0, 100);
  assert.equal(payment.totalAmountPerLiterClp, null);
  assert.equal(payment.categories[0].amountPerLiterClp, null);
  assert.throws(
    () => analyzeMilkSettlement({ lineItems: [], totalLiters: 0, netAmountClp: 0 }, { thresholds: { rcs: "inválido" } }),
    /umbral rcs/,
  );
});
