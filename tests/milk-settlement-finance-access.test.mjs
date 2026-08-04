import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL("../app/api/leche/route.ts", import.meta.url);
const repositoryUrl = new URL("../src/modules/leche/server/milk-settlement-repository.ts", import.meta.url);
const stateKey = "__FUNDOSMART_MILK_SETTLEMENT_FINANCE_TEST__";
const moneySecret = 17_733_901;

const expected = {
  displayName: "Manager",
  email: "manager@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-a",
  organizationId: "org-a",
  role: "manager",
};

test("settlement GET denies non-finance actors and returns no money after revocation", async () => {
  const route = await loadRoute();

  const viewer = resetState("viewer");
  const viewerResponse = await route.GET();
  assert.equal(viewerResponse.status, 403);
  assert.deepEqual(viewer.calls, ["authorize:manage_finance"]);

  const manager = resetState("allowed");
  const managerResponse = await route.GET();
  const managerBody = await managerResponse.json();
  assert.equal(managerResponse.status, 200);
  assert.equal(managerBody.settlements[0].netAmountClp, moneySecret);
  assert.deepEqual(manager.calls, ["authorize:manage_finance", "list", "reauthorize"]);
  assert.deepEqual(manager.requirement, {
    capability: "manage_finance",
    fieldIds: expected.fieldIds,
  });

  const revoked = resetState("revoked");
  const revokedResponse = await route.GET();
  const revokedText = await revokedResponse.text();
  assert.equal(revokedResponse.status, 409);
  assert.doesNotMatch(revokedText, new RegExp(String(moneySecret)));
  assert.deepEqual(revoked.calls, ["authorize:manage_finance", "list", "reauthorize"]);
});

test("every settlement route and the atomic writer require finance authority", async () => {
  const [route, repository] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
  ]);
  assert.equal((route.match(/authorizeApiAccess\("manage_finance"\)/g) ?? []).length, 3);
  assert.doesNotMatch(route, /authorizeApiAccess\("operate"\)/);
  assert.match(
    route,
    /listMilkSettlements\(access\)[\s\S]+reauthorizeApiSnapshotAccess\([\s\S]+capability: "manage_finance"[\s\S]+Response\.json/,
  );
  assert.match(
    route,
    /upsertMilkSettlement[\s\S]+reauthorizeApiAccess\([\s\S]+"manage_finance"[\s\S]+settlement\.fieldId[\s\S]+Response\.json/,
  );
  assert.match(repository, /current_membership\.role IN \('owner', 'admin'\)/);
  assert.match(repository, /current_membership\.role = 'manager'/);
  assert.doesNotMatch(repository, /current_membership\.role IN \('manager', 'operator'\)/);
});

async function loadRoute() {
  const source = await readFile(routeUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  class DomainRuleError extends Error {}
  const stubs = {
    "@/app/access": {
      authorizeApiAccess: async (capability) => {
        const state = globalThis[stateKey];
        state.calls.push(`authorize:${capability}`);
        return state.mode === "viewer"
          ? Response.json({ error: "forbidden" }, { status: 403 })
          : state.access;
      },
      isAccessResponse: (value) => value instanceof Response,
      reauthorizeApiAccess: async () => expected,
      reauthorizeApiSnapshotAccess: async (_access, requirement) => {
        const state = globalThis[stateKey];
        state.calls.push("reauthorize");
        state.requirement = requirement;
        return state.mode === "revoked"
          ? Response.json({ error: "access changed", code: "ACCESS_SCOPE_CHANGED" }, { status: 409 })
          : state.access;
      },
      requireContextField: () => null,
      requireResourceField: async () => null,
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure: (_operation, message) => Response.json({ error: message }, { status: 500 }),
    },
    "@/app/json-body.mjs": { readJsonObject: async () => ({}) },
    "@/src/modules/access/server/resource-scope": { resolveResourceFieldId: async () => null },
    "@/src/core/server/domain-rule-error.mjs": { DomainRuleError },
    "@/src/modules/leche/server/milk-settlement-integrity.mjs": {
      deriveMilkSettlementPrices: (value) => value,
      MILK_SETTLEMENT_LIMITS: { lineItems: 200, lineItemDescription: 500, lineItemMeasurement: 100 },
    },
    "@/src/modules/leche/server/milk-settlement-repository": {
      deleteMilkSettlement: async () => true,
      listMilkSettlements: async () => {
        const state = globalThis[stateKey];
        state.calls.push("list");
        return [{ fieldId: "field-a", netAmountClp: moneySecret }];
      },
      upsertMilkSettlement: async (value) => value,
    },
  };
  const loadedModule = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      assert.ok(specifier in stubs, `Unexpected import: ${specifier}`);
      return stubs[specifier];
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function resetState(mode) {
  const state = {
    access: expected,
    calls: [],
    mode,
    requirement: null,
  };
  globalThis[stateKey] = state;
  return state;
}
