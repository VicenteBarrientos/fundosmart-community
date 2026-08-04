import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("milk settlement mutations carry the persisted version through every boundary", async () => {
  const [repository, route, client, page, dialog] = await Promise.all([
    readSource("../src/modules/leche/server/milk-settlement-repository.ts"),
    readSource("../app/api/leche/route.ts"),
    readSource("../src/modules/leche/api/milk-client.ts"),
    readSource("../src/modules/leche/LechePage.tsx"),
    readSource("../src/modules/leche/components/ManageMilkSettlementDialog.tsx"),
  ]);

  assert.match(repository, /settlement\.updatedAt !== existing\.updatedAt/);
  assert.match(repository, /const requestedSettlement = deriveMilkSettlementPrices\(settlementInput\)/);
  assert.match(repository, /createdAt: existing\.createdAt/);
  assert.match(repository, /createdAt: writeTimestamp, updatedAt: writeTimestamp/);
  assert.match(repository, /assertMilkSettlementIntegrity\(settlement\)/);
  assert.match(repository, /MILK_SETTLEMENT_INVALID/);
  assert.match(repository, /AND field_id IS \?[\s\S]+?AND created_at IS \? AND updated_at IS \?/);
  assert.match(repository, /client\.batch\(\[auditStatement, mutation, savedStatement, assertion\]\)/);
  assert.match(repository, /milk_settlement\.(?:created|updated|deleted)/);
  assert.match(repository, /settlementAuditExistsSql/);
  assert.match(repository, /fundosmart_milk_settlement_postcondition_failed/);
  assert.match(repository, /expectedUpdatedAt !== existing\.updatedAt/);
  assert.match(repository, /deleteMilkSettlement\([\s\S]+?expectedUpdatedAt: string/);

  assert.match(route, /!payload\.updatedAt\?\.trim\(\)[\s\S]+?status: 409/);
  assert.match(route, /\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$/);
  assert.match(route, /createdAt: now/);
  assert.match(route, /updatedAt: existingFieldId \? payload\.updatedAt!\.trim\(\) : now/);
  assert.match(route, /Number\.isSafeInteger/);
  assert.match(route, /upsertMilkSettlement\(deriveMilkSettlementPrices\(\{/);
  assert.match(route, /netPricePerLiterClp: 0/);
  assert.match(route, /grossPricePerLiterClp: null/);
  assert.doesNotMatch(route, /function pricePerLiter/);
  assert.match(route, /Object\.hasOwn\(candidate, key\)/);
  assert.match(route, /!expectedUpdatedAt[\s\S]+?status: 409/);
  assert.match(route, /deleteMilkSettlement\(id, access, expectedUpdatedAt\)/);
  assert.match(route, /cause\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);

  assert.match(client, /new URLSearchParams\(\{ id, updatedAt \}\)/);
  assert.match(page, /removeMilkSettlement\(confirmDelete\.id, confirmDelete\.updatedAt\)/);
  assert.match(dialog, /updatedAt: settlement\?\.updatedAt \?\? now/);
  assert.match(dialog, /netPricePerLiterClp: roundPrice\(net \/ liters\)/);
  assert.match(dialog, /grossPricePerLiterClp: roundPrice\(\(net \+ tax\) \/ liters\)/);
  assert.match(dialog, /aria-readonly="true"[\s\S]+?readOnly/);
  assert.match(dialog, /Number\.isSafeInteger\(parsed\)/);
  assert.match(dialog, /lineItemsMismatch/);
  assert.match(dialog, /halfLitersMismatch/);
  assert.match(dialog, /role="alert"/);
});
