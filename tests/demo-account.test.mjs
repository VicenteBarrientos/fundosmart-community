import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_ANIMALS,
  DEMO_EMAIL,
  DEMO_FIELD,
  DEMO_LOTS,
  DEMO_MILK_SETTLEMENTS,
  DEMO_PADDOCKS,
} from "../src/modules/demo/data/demo-data.mjs";

test("the demo account uses a synthetic local identity and one isolated demo field", () => {
  assert.equal(DEMO_EMAIL, "demo@fundosmart.local");
  assert.equal(DEMO_FIELD.name, "Fundo El Ejemplo");
  assert.equal(Number(DEMO_FIELD.areaHectares.toFixed(2)), 130.14);
});

test("Fundo El Ejemplo uses the confirmed fourteen-paddock layout", () => {
  assert.equal(DEMO_PADDOCKS.length, 14);
  assert.equal(new Set(DEMO_PADDOCKS.map((paddock) => paddock.id)).size, 14);
  assert.equal(Number(DEMO_PADDOCKS.reduce((sum, paddock) => sum + paddock.areaHectares, 0).toFixed(2)), 130.14);
});

test("the demo herd is internally consistent and every animal has a unique DIIO", () => {
  assert.equal(DEMO_ANIMALS.length, 92);
  assert.equal(new Set(DEMO_ANIMALS.map((animal) => animal.tag)).size, DEMO_ANIMALS.length);
  for (const lot of DEMO_LOTS) {
    assert.equal(DEMO_ANIMALS.filter((animal) => animal.lotId === lot.id).length, lot.animalCount);
  }
});

test("demo milk settlements reconcile liters, line items, tax, and gross totals", () => {
  for (const settlement of DEMO_MILK_SETTLEMENTS) {
    assert.equal(settlement.litersFirstHalf + settlement.litersSecondHalf, settlement.totalLiters);
    assert.equal(settlement.lineItems.reduce((sum, item) => sum + item.amountClp, 0), settlement.netAmountClp);
    assert.equal(settlement.netAmountClp + settlement.taxAmountClp, settlement.grossAmountClp);
  }
});
