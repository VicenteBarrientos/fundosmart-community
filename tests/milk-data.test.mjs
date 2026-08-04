import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_MILK_SETTLEMENTS } from "../src/modules/demo/data/demo-data.mjs";

test("the synthetic milk settlements preserve deterministic totals", () => {
  assert.equal(DEMO_MILK_SETTLEMENTS.length, 3);
  assert.equal(DEMO_MILK_SETTLEMENTS.reduce((sum, entry) => sum + entry.totalLiters, 0), 83_440);
  assert.equal(DEMO_MILK_SETTLEMENTS.reduce((sum, entry) => sum + entry.netAmountClp, 0), 38_469_568);
  assert.equal(DEMO_MILK_SETTLEMENTS.reduce((sum, entry) => sum + entry.taxAmountClp, 0), 7_309_218);
  assert.equal(DEMO_MILK_SETTLEMENTS.reduce((sum, entry) => sum + entry.grossAmountClp, 0), 45_778_786);
});

test("every synthetic settlement reconciles volume, taxes and payment lines", () => {
  const orders = new Set();
  for (const settlement of DEMO_MILK_SETTLEMENTS) {
    assert.equal(settlement.grossAmountClp, settlement.netAmountClp + settlement.taxAmountClp);
    assert.equal(
      settlement.lineItems.reduce((sum, item) => sum + item.amountClp, 0),
      settlement.netAmountClp,
    );
    assert.equal(
      (settlement.litersFirstHalf ?? 0) + (settlement.litersSecondHalf ?? 0),
      settlement.totalLiters,
    );
    assert.ok(settlement.netPricePerLiterClp > 0);
    assert.ok(!orders.has(settlement.purchaseOrder));
    orders.add(settlement.purchaseOrder);
  }
});

test("the seed is visibly fictitious and independent from customer documents", () => {
  assert.ok(DEMO_MILK_SETTLEMENTS.every((entry) => entry.id.startsWith("demo-milk-")));
  assert.deepEqual(DEMO_MILK_SETTLEMENTS.map((entry) => entry.period), ["2026-04", "2026-05", "2026-06"]);
  assert.ok(DEMO_MILK_SETTLEMENTS.every((entry) => entry.producerCode === "DEMO-001"));
  assert.ok(DEMO_MILK_SETTLEMENTS.every((entry) => entry.sourceDocumentName.startsWith("liquidacion-demo-")));
});
