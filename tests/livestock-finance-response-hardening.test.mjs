import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const pageUrl = new URL("../app/(producto)/ganado/page.tsx", import.meta.url);
const partnersUrl = new URL("../app/api/ganado/plata/socios/route.ts", import.meta.url);
const operationsUrl = new URL("../app/api/ganado/operaciones/route.ts", import.meta.url);
const moneySecret = 8_711_933;

const baseAccess = {
  displayName: "Initial member",
  email: "member@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-a",
  organizationId: "org-a",
  role: "manager",
};

test("Ganado RSC refuses a loaded financial snapshot after revocation", async () => {
  const calls = { events: [], renders: [], requirements: [] };
  const route = await loadGanadoPage(calls);
  await assert.rejects(route(), /MEMBERSHIP_SUSPENDED/);
  assert.equal(calls.events.includes("finance"), true);
  assert.equal(calls.events.includes("financeAudit"), true);
  assert.equal(calls.events.at(-1), "reauthorize");
  assert.deepEqual(calls.requirements, [{
    capability: "manage_finance",
    fieldIds: baseAccess.fieldIds,
  }]);
  assert.equal(calls.renders.length, 0);
});

test("Ganado finance APIs return no loaded secret after revocation", async () => {
  const partnersState = { calls: [], requirement: null };
  const partners = await loadPartnersRoute(partnersState);
  const partnersResponse = await partners.GET();
  const partnersBody = await partnersResponse.text();
  assert.equal(partnersResponse.status, 409);
  assert.doesNotMatch(partnersBody, new RegExp(String(moneySecret)));
  assert.deepEqual(partnersState.calls, ["authorize", "finance", "reauthorize"]);
  assert.deepEqual(partnersState.requirement, {
    capability: "manage_members",
    fieldIds: baseAccess.fieldIds,
  });

  const operationsState = { calls: [], requirement: null };
  const operations = await loadOperationsRoute(operationsState);
  const operationsResponse = await operations.GET();
  const operationsBody = await operationsResponse.text();
  assert.equal(operationsResponse.status, 409);
  assert.doesNotMatch(operationsBody, new RegExp(String(moneySecret)));
  assert.deepEqual(operationsState.calls, [
    "authorize",
    "lots",
    "animals",
    "weighings",
    "finance",
    "operations",
    "reauthorize",
  ]);
  assert.deepEqual(operationsState.requirement, {
    capability: "manage_finance",
    fieldIds: baseAccess.fieldIds,
  });
});

test("Ganado places its role-aware barriers after loading and before serialization", async () => {
  const [page, partners, operations] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(partnersUrl, "utf8"),
    readFile(operationsUrl, "utf8"),
  ]);
  assert.equal((page.match(/reauthorizePageSnapshotAccess\(/g) ?? []).length, 1);
  assert.ok(page.indexOf("listHerdOperations") < page.indexOf("await reauthorizePageSnapshotAccess"));
  assert.ok(page.indexOf("await reauthorizePageSnapshotAccess") < page.lastIndexOf("return"));
  assert.match(page, /canViewOrganizationFinance[\s\S]+\? "manage_members"[\s\S]+canViewFinance[\s\S]+\? "manage_finance"[\s\S]+: "view"/);
  assert.match(page, /fieldIds: access\.fieldIds/);
  assert.doesNotMatch(page, /isDemo=\{access\.email|userName=\{access\.displayName/);

  assert.equal((partners.match(/reauthorizeApiSnapshotAccess\(/g) ?? []).length, 3);
  assert.match(partners, /capability: "manage_members"/);
  assert.ok(partners.indexOf("const finance = await listLivestockFinance") < partners.indexOf("await reauthorizeApiSnapshotAccess"));

  assert.equal((operations.match(/reauthorizeApiSnapshotAccess\(/g) ?? []).length, 2);
  assert.match(operations, /capability: canViewFinance \? "manage_finance" : "view"/);
  assert.match(operations, /capability: canViewFinance \? "manage_finance" : "operate"/);
  assert.match(operations, /fieldIds: access\.fieldIds/);
});

async function loadGanadoPage(calls) {
  const source = await readFile(pageUrl, "utf8");
  const output = transpile(source, true);
  const GanadoPage = () => null;
  const query = (name, value) => async () => {
    calls.events.push(name);
    return value;
  };
  const stubs = {
    "@/app/access": {
      requirePageAccess: async () => {
        calls.events.push("authorize");
        return baseAccess;
      },
      reauthorizePageSnapshotAccess: async (_access, _returnTo, requirement) => {
        calls.events.push("reauthorize");
        calls.requirements.push(requirement);
        throw new Error("MEMBERSHIP_SUSPENDED");
      },
    },
    "@/src/modules/access/domain/access-rules.mjs": {
      roleHasCapability: (role, capability) => capability === "manage_finance" && role === "manager",
      roleHasGlobalFieldAccess: (role) => role === "owner" || role === "admin",
    },
    "@/src/modules/demo/data/demo-data.mjs": { DEMO_EMAIL: "demo@example.com" },
    "@/src/modules/ganado/GanadoPage": { GanadoPage },
    "@/src/modules/ganado/server/herd-operations-repository": {
      listHerdOperations: query("operations", { animalMargins: [{ marginClp: moneySecret }], lotMargins: [] }),
    },
    "@/src/modules/ganado/server/livestock-animal-repository": { listLivestockAnimals: query("animals", []) },
    "@/src/modules/ganado/server/livestock-feed-repository": {
      listLivestockFeedData: query("feed", { consumptions: [], inventory: [] }),
    },
    "@/src/modules/ganado/server/livestock-finance-repository": {
      listLivestockFinance: query("finance", {
        contributions: [], expenses: [{ amountClp: moneySecret, fieldId: "field-a" }], partners: [],
      }),
      listLivestockFinanceAudit: query("financeAudit", [{ amountClp: moneySecret }]),
    },
    "@/src/modules/ganado/server/livestock-ration-repository": { listLivestockFeedingPlans: query("plans", []) },
    "@/src/modules/ganado/server/livestock-repository": { listLivestockLots: query("lots", []) },
    "@/src/modules/ganado/server/livestock-weighing-repository": { listLivestockWeighings: query("weighings", []) },
    "@/src/modules/potreros/server/fundo-repository": { listFundos: query("fundos", []) },
    "@/src/modules/potreros/server/potrero-repository": { listPotreros: query("potreros", []) },
    "react/jsx-runtime": {
      jsx: (type, props) => {
        if (type === GanadoPage) calls.renders.push(props);
        return { props, type };
      },
      jsxs: (type, props) => ({ props, type }),
    },
  };
  return evaluate(output, stubs).default;
}

async function loadPartnersRoute(state) {
  const source = await readFile(partnersUrl, "utf8");
  class DomainRuleError extends Error {}
  return evaluate(transpile(source), {
    "@/app/access": accessStubs(state, { ...baseAccess, role: "admin" }),
    "@/app/api-failure.mjs": { unexpectedApiFailure: (_operation, message) => Response.json({ error: message }, { status: 500 }) },
    "@/app/json-body.mjs": { readJsonObject: async (request) => request.json() },
    "@/src/core/server/domain-rule-error.mjs": { DomainRuleError },
    "@/src/modules/access/domain/access-rules.mjs": { roleHasGlobalFieldAccess: (role) => role === "owner" || role === "admin" },
    "@/src/modules/ganado/server/livestock-finance-repository": {
      deleteLivestockPartner: async () => ({ deleted: true }),
      listLivestockFinance: async () => {
        state.calls.push("finance");
        return { contributions: [{ amountClp: moneySecret }], expenses: [], partners: [] };
      },
      upsertLivestockPartner: async (value) => ({ auditEntry: {}, value }),
    },
  });
}

async function loadOperationsRoute(state) {
  const source = await readFile(operationsUrl, "utf8");
  class AnimalRecordRuleError extends Error {}
  const query = (name, value) => async () => {
    state.calls.push(name);
    return value;
  };
  return evaluate(transpile(source), {
    "@/app/access": { ...accessStubs(state, baseAccess), requireResourceField: async () => null },
    "@/src/modules/ganado/ficha/server/animal-record-rules.mjs": {
      AnimalRecordRuleError,
      normalizeHealthEventInput: (value) => value,
    },
    "@/src/modules/ganado/ficha/server/animal-record-repository": { saveHealthEventsBatch: async () => [] },
    "@/src/modules/ganado/server/livestock-animal-repository": { listLivestockAnimals: query("animals", []) },
    "@/src/modules/ganado/server/livestock-finance-repository": {
      listLivestockFinance: query("finance", { contributions: [], expenses: [{ amountClp: moneySecret }], partners: [] }),
    },
    "@/src/modules/ganado/server/herd-operations-repository": {
      listHerdOperations: query("operations", { animalMargins: [{ marginClp: moneySecret }], lotMargins: [] }),
    },
    "@/src/modules/ganado/server/livestock-repository": { listLivestockLots: query("lots", []) },
    "@/src/modules/ganado/server/livestock-weighing-repository": { listLivestockWeighings: query("weighings", []) },
    "@/src/modules/access/domain/access-rules.mjs": {
      roleHasCapability: (role, capability) => role === "manager" && capability === "manage_finance",
    },
  });
}

function accessStubs(state, access) {
  return {
    authorizeApiAccess: async () => {
      state.calls.push("authorize");
      return access;
    },
    isAccessResponse: (value) => value instanceof Response,
    reauthorizeApiSnapshotAccess: async (_access, requirement) => {
      state.calls.push("reauthorize");
      state.requirement = requirement;
      return Response.json({ error: "access changed", code: "ACCESS_CONTEXT_CHANGED" }, { status: 409 });
    },
  };
}

function transpile(source, jsx = false) {
  return ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function evaluate(output, stubs) {
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
