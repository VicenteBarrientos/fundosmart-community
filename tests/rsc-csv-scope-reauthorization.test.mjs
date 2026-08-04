import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const accessUrl = new URL("../app/access.ts", import.meta.url);
const costsUrl = new URL("../app/(producto)/costos/page.tsx", import.meta.url);

async function loadAccessModule({ currentAccess, deniedCode = null }) {
  const source = await readFile(accessUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const calls = [];
  class AccessDeniedError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  const stubs = {
    "@/app/account-mode": { resolveAccountUser: async (user) => user },
    "@/app/auth": {
      getAppUser: async () => ({ email: "member@example.com" }),
      getAppUserWithLegalStatus: async () => ({
        user: { email: "member@example.com" },
        legalStatus: { complete: true },
      }),
    },
    "@/app/legal-access": {
      authorizeApiLegalAcceptance: async () => null,
      requirePageLegalAcceptance: async () => {},
    },
    "@/src/modules/access/server/access-repository": {
      AccessDeniedError,
      authorizeUser: async (_user, capability, fieldId) => {
        calls.push({ capability, fieldId });
        if (deniedCode) throw new AccessDeniedError(deniedCode);
        return currentAccess;
      },
    },
    "@/src/modules/access/server/resource-scope": {
      resolveResourceFieldId: async () => null,
    },
    "next/headers": { cookies: async () => ({ get: () => undefined }) },
    "next/navigation": {
      redirect: (location) => {
        const error = new Error(`redirect:${location}`);
        error.location = location;
        throw error;
      },
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
  return { access: loadedModule.exports, calls };
}

async function loadCostsModule({ role, denyFinal = false }) {
  const source = await readFile(costsUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const access = { ...expected, role };
  const calls = {
    final: [],
    initial: [],
    queries: [],
    renders: 0,
  };
  const CostosPage = () => null;
  const stubs = {
    "@/app/access": {
      requirePageAccess: async (returnTo, capability) => {
        calls.initial.push({ capability, returnTo });
        if (["operator", "viewer"].includes(role)) throw new Error("CAPABILITY_DENIED");
        return access;
      },
      reauthorizePageSnapshotAccess: async (_expected, returnTo, requirement) => {
        calls.final.push({ requirement, returnTo });
        if (denyFinal) throw new Error("CAPABILITY_DENIED");
        return access;
      },
    },
    "@/src/modules/access/domain/access-rules.mjs": {
      roleHasGlobalFieldAccess: (currentRole) => ["admin", "owner"].includes(currentRole),
    },
    "@/src/modules/costos/CostosPage": { CostosPage },
    "@/src/modules/demo/data/demo-data.mjs": { DEMO_EMAIL: "demo@example.com" },
    "@/src/modules/ganado/server/livestock-finance-repository": {
      listLivestockFinance: async () => {
        calls.queries.push("finance");
        return { contributions: [], expenses: [], partners: [] };
      },
    },
    "@/src/modules/potreros/server/activity-repository": {
      listActivities: async () => {
        calls.queries.push("activities");
        return [{ id: "activity-a", potreroId: "paddock-a", costClp: 12_000 }];
      },
    },
    "@/src/modules/potreros/server/fundo-repository": {
      listFundos: async () => {
        calls.queries.push("fundos");
        return [{ id: "field-a", name: "Fundo A" }];
      },
    },
    "@/src/modules/potreros/server/potrero-repository": {
      listPotreros: async () => {
        calls.queries.push("potreros");
        return [{ fieldId: "field-a", id: "paddock-a" }];
      },
    },
    "react/jsx-runtime": {
      jsx: (type, props) => {
        if (type === CostosPage) calls.renders += 1;
        return { props, type };
      },
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

const expected = {
  membershipId: "membership-a",
  organizationId: "org-a",
  email: "member@example.com",
  displayName: "Member",
  role: "admin",
  fieldIds: ["field-a", "field-b"],
};

function assertRedirectsTo(code) {
  return (error) => {
    assert.equal(error.location, `/app/sin-acceso?code=${code}`);
    return true;
  };
}

test("the final RSC barrier fails closed for suspension", async () => {
  const { access } = await loadAccessModule({
    currentAccess: null,
    deniedCode: "MEMBERSHIP_SUSPENDED",
  });

  await assert.rejects(
    access.reauthorizePageSnapshotAccess(expected, "/app/reportes", {
      capability: "view",
      fieldIds: expected.fieldIds,
    }),
    assertRedirectsTo("MEMBERSHIP_SUSPENDED"),
  );
});

test("the final RSC barrier rejects only-field-B removal but allows scope expansion", async () => {
  const removed = await loadAccessModule({
    currentAccess: { ...expected, fieldIds: ["field-a"] },
  });
  await assert.rejects(
    removed.access.reauthorizePageSnapshotAccess(expected, "/app/leche", {
      capability: "view",
      fieldIds: expected.fieldIds,
    }),
    assertRedirectsTo("ACCESS_SCOPE_CHANGED"),
  );

  const expandedAccess = { ...expected, fieldIds: ["field-a", "field-b", "field-c"] };
  const expanded = await loadAccessModule({ currentAccess: expandedAccess });
  assert.equal(
    await expanded.access.reauthorizePageSnapshotAccess(expected, "/app/leche", {
      capability: "view",
      fieldIds: expected.fieldIds,
    }),
    expandedAccess,
  );
});

test("the final RSC barrier rejects a same-email membership replacement", async () => {
  const { access } = await loadAccessModule({
    currentAccess: { ...expected, membershipId: "membership-replacement" },
  });

  await assert.rejects(
    access.reauthorizePageSnapshotAccess(expected, "/app/costos", {
      capability: "manage_finance",
      fieldIds: expected.fieldIds,
    }),
    assertRedirectsTo("ACCESS_CONTEXT_CHANGED"),
  );
});

test("the final RSC barrier rejects manager-to-operator or viewer finance downgrades", async () => {
  for (const role of ["operator", "viewer"]) {
    const { access, calls } = await loadAccessModule({
      currentAccess: { ...expected, role },
      deniedCode: "CAPABILITY_DENIED",
    });

    await assert.rejects(
      access.reauthorizePageSnapshotAccess(
        { ...expected, role: "manager" },
        "/app/reportes",
        {
          capability: "manage_finance",
          fieldIds: expected.fieldIds,
        },
      ),
      assertRedirectsTo("CAPABILITY_DENIED"),
    );
    assert.deepEqual(calls, [{ capability: "manage_finance", fieldId: undefined }]);
  }
});

test("Costos denies operator and viewer before any cost query can build props", async () => {
  for (const role of ["operator", "viewer"]) {
    const { calls, route } = await loadCostsModule({ role });
    await assert.rejects(route(), /CAPABILITY_DENIED/);
    assert.deepEqual(calls.initial, [{
      capability: "manage_finance",
      returnTo: "/app/costos",
    }]);
    assert.deepEqual(calls.queries, []);
    assert.deepEqual(calls.final, []);
    assert.equal(calls.renders, 0);
  }
});

test("Costos fails closed when finance is downgraded after its cost queries", async () => {
  const { calls, route } = await loadCostsModule({
    denyFinal: true,
    role: "manager",
  });
  await assert.rejects(route(), /CAPABILITY_DENIED/);
  assert.deepEqual(new Set(calls.queries), new Set([
    "activities",
    "finance",
    "fundos",
    "potreros",
  ]));
  assert.equal(calls.final.length, 1);
  assert.equal(calls.final[0].requirement.capability, "manage_finance");
  assert.equal(calls.final[0].returnTo, "/app/costos");
  assert.equal(calls.renders, 0);
});

test("reportes, costos and leche place one RSC barrier after loading and before returning props", async () => {
  const paths = ["reportes", "costos", "leche"];
  const pages = await Promise.all(paths.map((name) =>
    readFile(new URL(`../app/(producto)/${name}/page.tsx`, import.meta.url), "utf8")));

  for (const [index, page] of pages.entries()) {
    assert.equal((page.match(/reauthorizePageSnapshotAccess\(/g) ?? []).length, 1, paths[index]);
    assert.ok(page.indexOf("Promise.all") < page.indexOf("await reauthorizePageSnapshotAccess"), paths[index]);
    assert.ok(page.indexOf("await reauthorizePageSnapshotAccess") < page.lastIndexOf("return"), paths[index]);
    assert.match(page, /fieldIds: access\.fieldIds/);
  }
  assert.match(pages[0], /capability: canViewFinance \? "manage_finance" : "view"/);
  assert.match(pages[1], /requirePageAccess\("\/app\/costos", "manage_finance"\)/);
  assert.match(pages[1], /capability: "manage_finance"/);
  assert.doesNotMatch(pages[1], /canViewFinance|Promise\.resolve\(\{ partners: \[\], contributions: \[\], expenses: \[\] \}\)/);
  assert.match(pages[2], /canViewFinance \? listMilkSettlements\(access\) : Promise\.resolve\(\[\]\)/);
  assert.match(pages[2], /canViewFinance[\s\S]+\? snapshot[\s\S]+reconciliation: \[\]/);
  assert.match(pages[2], /capability: canViewFinance \? "manage_finance" : "view"/);
});
