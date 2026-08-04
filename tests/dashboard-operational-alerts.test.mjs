import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationalAlerts } from "../src/modules/dashboard/operational-alerts.mjs";

const healthyMetrics = {
  activeAnimals: 120,
  activeLots: 4,
  latestMilk: { grossAmountClp: 1, netAmountClp: 1, netPricePerLiterClp: 1, period: "2026-07", totalLiters: 1 },
  latestWeightDate: "2026-07-15",
  litersPerMilkingCowDay: 19,
  milkChangePercent: 2,
  milkingCows: 50,
  operatingResultClp: 500_000,
  periodCostsClp: 300_000,
  weightCoveragePercent: 92,
};

test("prioritizes production and finance signals before operational warnings", () => {
  const alerts = buildOperationalAlerts({
    availablePaddockCount: 0,
    canViewFinance: true,
    lastActivityDate: "2026-07-01",
    metrics: { ...healthyMetrics, milkChangePercent: -8.25, operatingResultClp: -50_000, weightCoveragePercent: 55 },
    paddockCount: 8,
    referenceDate: "2026-07-18T12:00:00.000Z",
  });

  assert.deepEqual(alerts.map((alert) => alert.id), [
    "milk-drop",
    "negative-operating-result",
    "no-available-paddocks",
    "weight-coverage",
  ]);
  assert.equal(alerts.every((alert) => alert.href.startsWith("/app/")), true);
});

test("never exposes a financial alert without finance capability", () => {
  const alerts = buildOperationalAlerts({
    availablePaddockCount: 2,
    canViewFinance: false,
    lastActivityDate: "2026-07-17",
    metrics: { ...healthyMetrics, operatingResultClp: -1_000_000 },
    paddockCount: 4,
    referenceDate: "2026-07-18T12:00:00.000Z",
  });

  assert.equal(alerts.some((alert) => alert.id === "negative-operating-result"), false);
});

test("returns no alert when current operational thresholds are healthy", () => {
  const alerts = buildOperationalAlerts({
    availablePaddockCount: 2,
    canViewFinance: true,
    lastActivityDate: "2026-07-17",
    metrics: healthyMetrics,
    paddockCount: 4,
    referenceDate: "2026-07-18T12:00:00.000Z",
  });

  assert.deepEqual(alerts, []);
});

test("flags missing traceability without treating it as a critical signal", () => {
  const alerts = buildOperationalAlerts({
    availablePaddockCount: 1,
    canViewFinance: false,
    lastActivityDate: null,
    metrics: { ...healthyMetrics, operatingResultClp: null, periodCostsClp: null },
    paddockCount: 1,
    referenceDate: "2026-07-18T12:00:00.000Z",
  });

  assert.deepEqual(alerts.map(({ id, tone }) => ({ id, tone })), [{ id: "activity-gap", tone: "info" }]);
});
