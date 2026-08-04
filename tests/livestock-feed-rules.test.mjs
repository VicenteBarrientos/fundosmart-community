import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateFeedConsumptionCost,
  calculateWeightedUnitCost,
  LivestockFeedRuleError,
  normalizeFeedConsumptionInput,
  normalizeFeedStockReceiptInput,
} from "../src/modules/ganado/server/livestock-feed-repository.ts";

const repositorySource = await readFile(
  new URL("../src/modules/ganado/server/livestock-feed-repository.ts", import.meta.url),
  "utf8",
);
const routeSource = await readFile(
  new URL("../app/api/ganado/alimentacion/route.ts", import.meta.url),
  "utf8",
);

function receipt(overrides = {}) {
  return {
    action: "receive_stock",
    requestId: "receipt-001",
    inventoryId: "feed-001",
    fieldId: "field-001",
    productName: "  Ensilaje de pradera  ",
    quantityKg: "1250,5",
    unitCostClp: "82,5",
    reorderLevelKg: "300",
    ...overrides,
  };
}

function consumption(overrides = {}) {
  return {
    action: "consume",
    id: "consumption-001",
    fieldId: "field-001",
    inventoryId: "feed-001",
    lotId: "lot-001",
    planId: "plan-001",
    occurredAt: "2026-07-20",
    quantityKg: "18,75",
    source: "  Plan diario  ",
    ...overrides,
  };
}

test("normalizes a stock receipt without creating an implicit expense", () => {
  assert.deepEqual(normalizeFeedStockReceiptInput(receipt()), {
    requestId: "receipt-001",
    inventoryId: "feed-001",
    fieldId: "field-001",
    productName: "Ensilaje de pradera",
    quantityKg: 1250.5,
    unitCostClp: 82.5,
    reorderLevelKg: 300,
    expense: null,
  });
});

test("keeps an expense only when the receipt explicitly includes one", () => {
  const normalized = normalizeFeedStockReceiptInput(receipt({
    expense: {
      id: "expense-feed-001",
      date: "2026-07-20",
      description: "  Compra de ensilaje  ",
      amountClp: 103_166,
      paymentSource: "partner",
      paidById: "partner-001",
    },
  }));

  assert.deepEqual(normalized.expense, {
    id: "expense-feed-001",
    date: "2026-07-20",
    description: "Compra de ensilaje",
    amountClp: 103_166,
    paymentSource: "partner",
    paidById: "partner-001",
  });
  assert.throws(
    () => normalizeFeedStockReceiptInput(receipt({
      expense: {
        id: "expense-feed-002",
        description: "Compra",
        amountClp: 1000,
        paymentSource: "partner",
      },
    })),
    (cause) => cause instanceof LivestockFeedRuleError && cause.code === "EXPENSE_PARTNER_REQUIRED",
  );
});

test("calculates weighted stock cost and consumption value", () => {
  const unitCostClp = calculateWeightedUnitCost(100, 200, 50, 260);
  assert.equal(unitCostClp, 220);
  assert.equal(calculateFeedConsumptionCost(12.5, unitCostClp), 2750);
});

test("normalizes consumption data that identifies inventory, lot, and plan", () => {
  assert.deepEqual(normalizeFeedConsumptionInput(consumption()), {
    id: "consumption-001",
    fieldId: "field-001",
    inventoryId: "feed-001",
    lotId: "lot-001",
    planId: "plan-001",
    occurredAt: "2026-07-20",
    quantityKg: 18.75,
    source: "Plan diario",
  });
});

test("rejects invalid feed quantities, costs, and calendar dates", () => {
  const cases = [
    [() => normalizeFeedStockReceiptInput(receipt({ quantityKg: 0 })), "RECEIPT_QUANTITY_INVALID"],
    [() => normalizeFeedStockReceiptInput(receipt({ unitCostClp: -1 })), "UNIT_COST_INVALID"],
    [() => normalizeFeedConsumptionInput(consumption({ quantityKg: -5 })), "CONSUMPTION_QUANTITY_INVALID"],
    [() => normalizeFeedConsumptionInput(consumption({ occurredAt: "2026-02-30" })), "CONSUMPTION_DATE_INVALID"],
  ];
  for (const [operation, expectedCode] of cases) {
    assert.throws(
      operation,
      (cause) => cause instanceof LivestockFeedRuleError && cause.code === expectedCode,
    );
  }
});

test("the API scopes all mutations and elevates only explicit expenses", () => {
  assert.match(routeSource, /authorizeApiAccess\("operate"\)/);
  assert.match(routeSource, /requireContextField\(access, input\.fieldId\)/);
  assert.match(routeSource, /requireResourceField\(access, "lot", input\.lotId\)/);
  assert.match(routeSource, /if \(input\.expense\) \{[\s\S]*authorizeApiAccess\("manage_finance"\)/);
});

test("stock receipts are batched, audited, and expense creation is idempotent", () => {
  const start = repositorySource.indexOf("export async function receiveLivestockFeedStock");
  const end = repositorySource.indexOf("export async function consumeLivestockFeed");
  const receiptSource = repositorySource.slice(start, end);

  assert.match(receiptSource, /await client\.batch\(statements\)/);
  assert.match(receiptSource, /quantity_kg = quantity_kg \+ \?/);
  assert.match(receiptSource, /\(quantity_kg \* unit_cost_clp\)/);
  assert.match(receiptSource, /if \(input\.expense\) \{[\s\S]*INSERT INTO livestock_expenses/);
  assert.match(receiptSource, /WHERE NOT EXISTS \(SELECT 1 FROM audit_log WHERE id = \?\)/);
  assert.match(receiptSource, /'feed\.stock_received'/);
  const expenseInsert = receiptSource.slice(
    receiptSource.indexOf("if (input.expense) {"),
    receiptSource.indexOf("statements.push(client.prepare(`\n    INSERT INTO audit_log"),
  );
  assert.doesNotMatch(expenseInsert, /ON CONFLICT/);
});

test("consumption atomically decrements its inventory item without writing expenses", () => {
  const start = repositorySource.indexOf("export async function consumeLivestockFeed");
  const end = repositorySource.indexOf("function normalizeExpense");
  const consumptionSource = repositorySource.slice(start, end);

  assert.match(consumptionSource, /await client\.batch\(\[/);
  assert.match(consumptionSource, /inventory_item_id/);
  assert.match(consumptionSource, /inventory\.quantity_kg >= \?/);
  assert.match(consumptionSource, /quantity_kg = quantity_kg - \?/);
  assert.match(consumptionSource, /inventory_item_id = livestock_feed_inventory\.id/);
  assert.match(consumptionSource, /'feed\.consumed'/);
  assert.doesNotMatch(consumptionSource, /INSERT INTO livestock_expenses/);
});
