import assert from "node:assert/strict";
import test from "node:test";

import { buildMilkReconciliation } from "../src/modules/leche/domain/milk-reconciliation.mjs";

test("reconciles physical production with settled milk and real CLP per liter", () => {
  const rows = buildMilkReconciliation(
    [
      {
        fieldId: "field-1",
        recordedAt: "2026-07-01",
        kind: "tank_total",
        volumeLiters: 600,
      },
      {
        fieldId: "field-1",
        recordedAt: "2026-07-15",
        kind: "tank_total",
        volumeLiters: 400,
      },
    ],
    [
      {
        fieldId: "field-1",
        period: "2026-07",
        totalLiters: 950,
        netAmountClp: 475_000,
      },
    ],
  );
  assert.deepEqual(rows, [
    {
      fieldId: "field-1",
      period: "2026-07",
      litersProduced: 1_000,
      litersSettled: 950,
      deltaLiters: -50,
      deltaPercent: -5,
      netAmountClp: 475_000,
      realPricePerLiterClp: 475,
    },
  ]);
});

test("uses source precedence to avoid double-counting milk", () => {
  const [row] = buildMilkReconciliation(
    [
      {
        fieldId: "field-1",
        recordedAt: "2026-07-01",
        kind: "tank_total",
        volumeLiters: 1_000,
      },
      {
        fieldId: "field-1",
        recordedAt: "2026-07-02",
        kind: "delivery",
        volumeLiters: 900,
      },
      {
        fieldId: "field-1",
        recordedAt: "2026-07-02",
        kind: "milk_meter_rollup",
        volumeLiters: 850,
      },
    ],
    [],
  );
  assert.equal(row.litersProduced, 1_000);
});

test("prefers equipment over CLO and manual records for the same date", () => {
  const [row] = buildMilkReconciliation(
    [
      {
        fieldId: "field-1",
        recordedAt: "2026-07-01",
        kind: "tank_total",
        source: "manual",
        volumeLiters: 1_000,
      },
      {
        fieldId: "field-1",
        recordedAt: "2026-07-01",
        kind: "tank_total",
        source: "cooprinsem_clo",
        volumeLiters: 990,
      },
      {
        fieldId: "field-1",
        recordedAt: "2026-07-01",
        kind: "tank_total",
        source: "equipment",
        volumeLiters: 980,
      },
      {
        fieldId: "field-1",
        recordedAt: "2026-07-02",
        kind: "tank_total",
        source: "manual",
        volumeLiters: 970,
      },
    ],
    [],
  );
  assert.equal(row.litersProduced, 1_950);
});

test("keeps economic ratios null when physical production is absent", () => {
  const [row] = buildMilkReconciliation(
    [],
    [
      {
        fieldId: "field-2",
        period: "2026-06",
        totalLiters: 800,
        netAmountClp: 400_000,
      },
    ],
  );
  assert.equal(row.litersProduced, 0);
  assert.equal(row.deltaPercent, null);
  assert.equal(row.realPricePerLiterClp, null);
});
