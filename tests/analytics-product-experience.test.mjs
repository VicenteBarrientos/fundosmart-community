import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnalyticsCsv,
  buildOwnHistoryCsv,
  formatAnalyticsDate,
  formatAnalyticsDateTime,
  shiftAnalyticsPeriod,
} from "../src/modules/analytics/domain/analytics-presentation.mjs";

test("formats analytics dates deterministically across server and browser runtimes", () => {
  assert.equal(formatAnalyticsDate("2026-07-31"), "31 jul 2026");
  assert.equal(formatAnalyticsDate("2024-02-29"), "29 feb 2024");
  assert.equal(formatAnalyticsDate("2026-02-29"), "2026-02-29");
  assert.equal(formatAnalyticsDateTime("2026-07-31T23:59:59.000Z"), "31-07-2026, 19:59");
  assert.equal(/[\u00A0\u202F]/u.test(formatAnalyticsDateTime("2026-07-31T23:59:59.000Z")), false);
  assert.equal(formatAnalyticsDateTime("not-an-instant"), "not-an-instant");
});

test("shifts month selectors across year boundaries without time-zone arithmetic", () => {
  assert.equal(shiftAnalyticsPeriod("2026-01", -1), "2025-12");
  assert.equal(shiftAnalyticsPeriod("2026-12", 1), "2027-01");
  assert.equal(shiftAnalyticsPeriod("2026-07", -18), "2025-01");
  assert.throws(() => shiftAnalyticsPeriod("2026-13", 1), /YYYY-MM/u);
  assert.throws(() => shiftAnalyticsPeriod("2026-07", 0.5), /entero/u);
});

test("exports metrics and alert evidence as portable, formula-safe CSV", () => {
  const window = {
    period: "2026-07",
    start: "2026-07-01",
    end: "2026-07-20",
    requestedEnd: "2026-07-31",
    asOf: "2026-07-20",
    complete: false,
    dayCount: 20,
    timeZone: "America/Santiago",
    boundaries: "inclusive",
    comparison: { start: "2026-06-11", end: "2026-06-30", dayCount: 20 },
  };
  const csv = buildAnalyticsCsv({
    field: { id: "field-a", name: "  @SUM(A1:A2)", isDemo: false },
    projection: {
      schemaVersion: "fundosmart.analytics.projection.v1",
      window,
      reference: {
        organizationId: "org-a",
        fieldId: "field-a",
        datasetRevision: "a".repeat(64),
        sourceCounts: {},
        sourceCoverage: { outcomesComplete: false },
      },
      quality: { state: "partial", issues: [], domains: {} },
      recommendationEngine: {
        version: "fundosmart.analytics.recommendation-engine.v1",
        adapterId: "test",
        strategy: "rules",
      },
      metrics: [{
        key: "=DDE(metric)",
        status: "available",
        statusReason: null,
        value: -42,
        unit: "liters",
        numerator: -42,
        denominator: null,
        sampleCount: 1,
        window,
        method: "sum",
        references: [{
          kind: "milk_production",
          count: 1,
          sourceIds: ["source;one"],
          observedFrom: "2026-07-10",
          observedThrough: "2026-07-10",
        }],
      }],
      alertEvaluations: [{
        code: "+COMMAND",
        status: "triggered",
        severity: "critical",
        explanation: 'Incluye; separador y "comillas"',
        evidence: {
          metricKey: "=DDE(metric)",
          observed: -42,
          operator: "lte",
          threshold: -10,
          unit: "liters",
          numerator: -42,
          denominator: 1,
          sampleCount: 1,
        },
        window,
      }],
      alerts: [],
      computedAt: "2026-07-20T15:00:00.000Z",
    },
  });

  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"Indicador";"'  @SUM\(A1:A2\)"/u);
  assert.match(csv, /"'=DDE\(metric\)"/u);
  assert.match(csv, /"Regla";"'  @SUM\(A1:A2\)"/u);
  assert.match(csv, /"'\+COMMAND"/u);
  assert.match(csv, /"Incluye; separador y ""comillas"""/u);
  assert.match(csv, /"-42"/u);
  assert.match(csv, /source;one/u);
  assert.equal(csv.split("\r\n").length, 3);
});

test("exports own history comparison as portable, formula-safe CSV", () => {
  const csvEmpty = buildOwnHistoryCsv();
  assert.ok(csvEmpty.startsWith("\uFEFF"));
  assert.match(csvEmpty, /"Fundo";"Período";"Indicador"/u);

  const csvData = buildOwnHistoryCsv({
    fieldName: "Fundo Norte",
    comparison: {
      targetPeriod: "2026-07",
      yearOverYearBasisPeriod: "2025-07",
      minimumBandPeriods: 3,
      summary: { total: 1, changed: 1, unchanged: 0, insufficientData: 0, seasonalFallbackCount: 0 },
      comparisons: [{
        key: "milk.liters_total",
        target: { period: "2026-07", value: 17400, status: "available", statusReason: null },
        unit: "liters",
        primary: "yearOverYear",
        yearOverYear: {
          status: "available",
          statusReason: null,
          basisPeriod: "2025-07",
          basisValue: 19800,
          deltaAbsolute: -2400,
          deltaPct: -12.12,
          direction: "down",
        },
        periodOverPeriod: null,
        verdict: "changed",
        reason: null,
        band: {
          status: "available",
          statusReason: null,
          minimum: 19800,
          maximum: 28640,
          mean: 30000,
          periodsUsed: 5,
          position: "below",
        },
        notes: [],
      }],
    },
  });

  assert.ok(csvData.startsWith("\uFEFF"));
  assert.match(csvData, /"Fundo Norte";"2026-07";"milk.liters_total";"liters";"17400";"available";"19800";"2025-07";"Interanual";"-2400";"-12.12";"down";"changed"/u);
});
