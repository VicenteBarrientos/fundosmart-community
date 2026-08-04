import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { calculateDashboardMetrics } from "../src/modules/dashboard/dashboard-metrics.mjs";

const pageUrl = new URL("../app/(producto)/dashboard/page.tsx", import.meta.url);

const baseAccess = {
  displayName: "Initial member",
  email: "member@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-a",
  organizationId: "org-a",
  role: "viewer",
};

async function loadDashboardModule({ finalError = null, initialRole = "viewer" } = {}) {
  const source = await readFile(pageUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const access = { ...baseAccess, role: initialRole };
  const calls = { events: [], final: [], renders: [] };
  const DashboardPage = () => null;
  const query = (name, value) => async () => {
    calls.events.push(name);
    return value;
  };
  const stubs = {
    "@/app/access": {
      requirePageAccess: async (returnTo) => {
        calls.events.push("initial");
        assert.equal(returnTo, "/app");
        return access;
      },
      reauthorizePageSnapshotAccess: async (expected, returnTo, requirement) => {
        calls.events.push("final");
        calls.final.push({ expected, requirement, returnTo });
        if (finalError) throw new Error(finalError);
        return { ...access, displayName: "Current member" };
      },
    },
    "@/src/modules/access/domain/access-rules.mjs": {
      roleHasCapability: (role, capability) => capability === "manage_finance"
        ? ["manager", "admin", "owner"].includes(role)
        : capability === "operate" && ["operator", "manager", "admin", "owner"].includes(role),
      roleHasGlobalFieldAccess: (role) => ["admin", "owner"].includes(role),
    },
    "@/src/modules/dashboard/agenda-repository": {
      listAgendaManagement: query("agenda", { assignees: [], states: [] }),
    },
    "@/src/modules/dashboard/agronomic-agenda-repository": {
      listAgronomicAgendaSignals: query("agronomic", []),
    },
    "@/src/modules/dashboard/DashboardPage": { DashboardPage },
    "@/src/modules/dashboard/dashboard-metrics.mjs": {
      calculateDashboardMetrics: (input) => {
        calls.events.push("metrics");
        return calculateDashboardMetrics(input);
      },
    },
    "@/src/modules/dashboard/dashboard-operational-snapshot-repository": {
      getDashboardOperationalSnapshot: query("operational-snapshot", {
        activities: [],
        activityCostsByPeriod: [],
        animals: [],
        lots: [],
        herdWorkItems: [],
        mammaryWorkItems: [],
      }),
    },
    "@/src/modules/demo/data/demo-data.mjs": { DEMO_EMAIL: "demo@example.com" },
    "@/src/modules/ganado/server/livestock-finance-repository": {
      listLivestockFinance: query("finance", {
        contributions: [],
        expenses: [{ amountClp: 800_000, date: "2026-07-15", fieldId: "field-a" }],
        partners: [],
      }),
    },
    "@/src/modules/leche/server/milk-settlement-repository": {
      listMilkSettlements: query("settlements", [{
        fieldId: "field-a",
        grossAmountClp: 1_200_000,
        netAmountClp: 1_000_000,
        period: "2026-07",
        totalLiters: 10_000,
      }]),
    },
    "@/src/modules/potreros/server/fundo-repository": {
      listFundos: query("fundos", [{ id: "field-a", name: "Fundo A" }]),
    },
    "@/src/modules/potreros/server/potrero-repository": {
      listPotreros: query("potreros", []),
    },
    "react/jsx-runtime": {
      jsx: (type, props) => {
        if (type === DashboardPage) {
          calls.events.push("render");
          calls.renders.push(props);
        }
        return { props, type };
      },
      jsxs: (type, props) => ({ props, type }),
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
  return { calls, route: loadedModule.exports.default };
}

test("viewer dashboard does not query or serialize financial settlement data", async () => {
  const { calls, route } = await loadDashboardModule();
  await route();

  assert.equal(calls.events.includes("finance"), false);
  assert.equal(calls.events.includes("settlements"), false);
  assert.equal(calls.events.includes("agenda"), true);
  assert.equal(calls.events.includes("agronomic"), true);
  assert.equal(calls.events.includes("operational-snapshot"), true);
  assert.equal(calls.events.includes("activities"), false);
  assert.deepEqual(calls.final.map(({ requirement, returnTo }) => ({ requirement, returnTo })), [{
    requirement: { capability: "view", fieldIds: ["field-a", "field-b"] },
    returnTo: "/app",
  }]);
  assert.equal(calls.renders.length, 1);
  assert.equal(calls.renders[0].canViewFinance, false);
  assert.equal(calls.renders[0].canManageAgenda, false);
  assert.equal(calls.renders[0].userName, "Current member");
  assert.doesNotMatch(
    JSON.stringify(calls.renders[0]),
    /grossAmountClp|netAmountClp|netPricePerLiterClp|800000|1000000|1200000/,
  );
  assert.ok(calls.events.lastIndexOf("metrics") < calls.events.indexOf("final"));
  assert.ok(calls.events.indexOf("final") < calls.events.indexOf("render"));
});

test("dashboard refuses a financial snapshot when access is revoked or downgraded after loading", async () => {
  for (const finalError of ["MEMBERSHIP_SUSPENDED", "CAPABILITY_DENIED"]) {
    const { calls, route } = await loadDashboardModule({ finalError, initialRole: "manager" });
    await assert.rejects(route(), new RegExp(finalError));

    assert.equal(calls.events.includes("finance"), true, finalError);
    assert.equal(calls.events.includes("settlements"), true, finalError);
    assert.equal(calls.final[0].requirement.capability, "manage_finance", finalError);
    assert.deepEqual(calls.final[0].requirement.fieldIds, ["field-a", "field-b"], finalError);
    assert.equal(calls.renders.length, 0, finalError);
    assert.equal(calls.events.at(-1), "final", finalError);
  }
});

test("dashboard places its final multi-scope barrier after snapshot construction and before props", async () => {
  const source = await readFile(pageUrl, "utf8");

  assert.equal((source.match(/reauthorizePageSnapshotAccess\(/g) ?? []).length, 1);
  assert.match(source, /canViewFinance \? listMilkSettlements\(access\) : Promise\.resolve\(\[\]\)/);
  assert.match(source, /capability: canViewFinance \? "manage_finance" : canManageAgenda \? "operate" : "view"/);
  assert.match(source, /fieldIds: access\.fieldIds/);
  assert.ok(source.indexOf("const metrics =") < source.indexOf("await reauthorizePageSnapshotAccess"));
  assert.ok(source.indexOf("await reauthorizePageSnapshotAccess") < source.lastIndexOf("return"));
  assert.doesNotMatch(source, /isDemo=\{access\.email|userName=\{access\.displayName/);
});
