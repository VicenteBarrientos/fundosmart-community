import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_MILK_SETTLEMENTS } from "../src/modules/demo/data/demo-data.mjs";
import {
  deriveMilkSettlementPrices,
  MILK_SETTLEMENT_LIMITS,
  milkSettlementIntegrityIssues,
  portableMilkSettlementIntegrityIssues,
} from "../src/modules/leche/server/milk-settlement-integrity.mjs";

const NOW = "2026-07-22T12:00:00.000Z";

function settlement(overrides = {}) {
  return {
    id: "settlement-contract",
    fieldId: "field-contract",
    period: "2026-07",
    generatedAt: NOW,
    plant: "Osorno",
    purchaseOrder: "PO-CONTRACT",
    producerCode: "P-1",
    producerName: "Productor",
    buyerName: "Comprador",
    litersFirstHalf: 40,
    litersSecondHalf: 60,
    totalLiters: 100,
    netAmountClp: 1_000,
    taxAmountClp: 190,
    grossAmountClp: 1_190,
    netPricePerLiterClp: 10,
    grossPricePerLiterClp: 11.9,
    sourceDocumentName: "liquidacion.pdf",
    notes: "",
    lineItems: [{
      description: "Leche",
      measurement: null,
      unitPriceClp: null,
      amountClp: 1_000,
    }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test("the canonical derivation replaces printed prices without mutating its input", () => {
  const input = settlement({
    totalLiters: 3,
    litersFirstHalf: 1,
    litersSecondHalf: 2,
    netAmountClp: 100,
    taxAmountClp: 19,
    grossAmountClp: 119,
    netPricePerLiterClp: 1,
    grossPricePerLiterClp: null,
    lineItems: [{
      description: "Leche",
      measurement: null,
      unitPriceClp: null,
      amountClp: 100,
    }],
  });

  const derived = deriveMilkSettlementPrices(input);

  assert.notEqual(derived, input);
  assert.equal(input.netPricePerLiterClp, 1);
  assert.equal(input.grossPricePerLiterClp, null);
  assert.equal(derived.netPricePerLiterClp, 33.3333);
  assert.equal(derived.grossPricePerLiterClp, 39.6667);
  assert.deepEqual(milkSettlementIntegrityIssues(derived), []);
});

test("the canonical contract accepts synthetic demo and portable fixtures", () => {
  for (const current of DEMO_MILK_SETTLEMENTS) {
    assert.deepEqual(milkSettlementIntegrityIssues({ ...current, createdAt: NOW, updatedAt: NOW }), []);
  }

  const current = settlement();
  const portable = Object.fromEntries([
    ["id", current.id],
    ["field_id", current.fieldId],
    ["period", current.period],
    ["generated_at", current.generatedAt],
    ["plant", current.plant],
    ["purchase_order", current.purchaseOrder],
    ["producer_code", current.producerCode],
    ["producer_name", current.producerName],
    ["buyer_name", current.buyerName],
    ["liters_first_half", current.litersFirstHalf],
    ["liters_second_half", current.litersSecondHalf],
    ["total_liters", current.totalLiters],
    ["net_amount_clp", current.netAmountClp],
    ["tax_amount_clp", current.taxAmountClp],
    ["gross_amount_clp", current.grossAmountClp],
    ["net_price_per_liter_clp", current.netPricePerLiterClp],
    ["gross_price_per_liter_clp", current.grossPricePerLiterClp],
    ["source_document_name", current.sourceDocumentName],
    ["notes", current.notes],
    ["line_items", current.lineItems],
    ["created_at", current.createdAt],
    ["updated_at", current.updatedAt],
  ]);
  assert.deepEqual(portableMilkSettlementIntegrityIssues(portable), []);
});

test("text boundaries are explicit and one character beyond each limit is rejected", () => {
  const boundary = settlement({
    plant: "p".repeat(MILK_SETTLEMENT_LIMITS.plant),
    purchaseOrder: "o".repeat(MILK_SETTLEMENT_LIMITS.purchaseOrder),
    producerCode: "c".repeat(MILK_SETTLEMENT_LIMITS.producerCode),
    producerName: "n".repeat(MILK_SETTLEMENT_LIMITS.partyName),
    buyerName: "b".repeat(MILK_SETTLEMENT_LIMITS.partyName),
    sourceDocumentName: "d".repeat(MILK_SETTLEMENT_LIMITS.sourceDocumentName),
    notes: "x".repeat(MILK_SETTLEMENT_LIMITS.notes),
    lineItems: [{
      description: "l".repeat(MILK_SETTLEMENT_LIMITS.lineItemDescription),
      measurement: "m".repeat(MILK_SETTLEMENT_LIMITS.lineItemMeasurement),
      unitPriceClp: null,
      amountClp: 1_000,
    }],
  });
  assert.deepEqual(milkSettlementIntegrityIssues(boundary), []);

  const invalid = [
    { plant: `${boundary.plant}p` },
    { purchaseOrder: `${boundary.purchaseOrder}o` },
    { producerCode: `${boundary.producerCode}c` },
    { producerName: `${boundary.producerName}n` },
    { buyerName: `${boundary.buyerName}b` },
    { sourceDocumentName: `${boundary.sourceDocumentName}d` },
    { notes: `${boundary.notes}x` },
    { lineItems: [{ ...boundary.lineItems[0], description: `${boundary.lineItems[0].description}l` }] },
    { lineItems: [{ ...boundary.lineItems[0], measurement: `${boundary.lineItems[0].measurement}m` }] },
  ];
  for (const overrides of invalid) {
    assert.notEqual(milkSettlementIntegrityIssues({ ...boundary, ...overrides }).length, 0);
  }
});

test("line item shape and temporal order fail closed", () => {
  const invalid = [
    { lineItems: undefined },
    { lineItems: [{ description: "Leche", amountClp: 1_000 }] },
    {
      lineItems: [{
        description: "Leche",
        measurement: null,
        unitPriceClp: null,
        amountClp: 1_000,
        label: "legacy",
      }],
    },
    { createdAt: "2026-07-22T12:00:00.001Z", updatedAt: "2026-07-22T12:00:00.000Z" },
  ];
  for (const overrides of invalid) {
    assert.notEqual(milkSettlementIntegrityIssues(settlement(overrides)).length, 0);
  }
});
