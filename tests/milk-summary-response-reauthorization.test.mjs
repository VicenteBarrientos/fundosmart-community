import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const accessUrl = new URL("../app/access.ts", import.meta.url);
const routeUrl = new URL("../app/api/leche/resumen/route.ts", import.meta.url);
const stateKey = "__FUNDOSMART_MILK_SUMMARY_RESPONSE_TEST__";
const moneySecret = 29_178_947;

const expected = {
  displayName: "Member",
  email: "member@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-a",
  organizationId: "org-a",
  role: "manager",
};

async function loadAccessModule({ currentAccess, deniedCode = null, legalRequired = false }) {
  const source = await readFile(accessUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  class AccessDeniedError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  const calls = [];
  const stubs = {
    "@/app/account-mode": { resolveAccountUser: async (user) => user },
    "@/app/auth": {
      getAppUser: async () => ({ email: expected.email }),
      getAppUserWithLegalStatus: async () => ({
        user: { email: expected.email },
        legalStatus: { complete: true },
      }),
    },
    "@/app/legal-access": {
      authorizeApiLegalAcceptance: async () => legalRequired
        ? Response.json({ code: "LEGAL_ACCEPTANCE_REQUIRED" }, { status: 428 })
        : null,
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
    "@/src/modules/access/server/resource-scope": { resolveResourceFieldId: async () => null },
    "next/headers": { cookies: async () => ({ get: () => undefined }) },
    "next/navigation": { redirect: () => { throw new Error("unused redirect"); } },
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

test("the shared API guard returns 428 before membership lookup when legal acceptance is stale", async () => {
  const loaded = await loadAccessModule({ currentAccess: expected, legalRequired: true });
  const result = await loaded.access.authorizeApiAccess("view");
  assert.equal(result.status, 428);
  assert.equal((await result.json()).code, "LEGAL_ACCEPTANCE_REQUIRED");
  assert.deepEqual(loaded.calls, []);
});

test("the API snapshot barrier requires exact identity and every original field", async () => {
  const removed = await loadAccessModule({ currentAccess: { ...expected, fieldIds: ["field-a"] } });
  const removedResult = await removed.access.reauthorizeApiSnapshotAccess(expected, {
    capability: "view",
    fieldIds: expected.fieldIds,
  });
  assert.equal(removedResult.status, 409);
  assert.equal((await removedResult.json()).code, "ACCESS_SCOPE_CHANGED");

  const replacement = await loadAccessModule({
    currentAccess: { ...expected, membershipId: "membership-replacement" },
  });
  const replacementResult = await replacement.access.reauthorizeApiSnapshotAccess(expected, {
    capability: "view",
    fieldIds: expected.fieldIds,
  });
  assert.equal(replacementResult.status, 409);
  assert.equal((await replacementResult.json()).code, "ACCESS_CONTEXT_CHANGED");

  const expandedAccess = { ...expected, fieldIds: [...expected.fieldIds, "field-c"] };
  const expanded = await loadAccessModule({ currentAccess: expandedAccess });
  assert.equal(
    await expanded.access.reauthorizeApiSnapshotAccess(expected, {
      capability: "view",
      fieldIds: expected.fieldIds,
    }),
    expandedAccess,
  );
});

test("the API snapshot barrier rechecks finance capability", async () => {
  const denied = await loadAccessModule({ currentAccess: null, deniedCode: "CAPABILITY_REQUIRED" });
  const result = await denied.access.reauthorizeApiSnapshotAccess(expected, {
    capability: "manage_finance",
    fieldIds: expected.fieldIds,
  });
  assert.equal(result.status, 403);
  assert.deepEqual(denied.calls, [{ capability: "manage_finance", fieldId: undefined }]);
});

test("milk summary hides money from view-only actors and returns no snapshot after revocation", async () => {
  const { route, close } = await loadRoute();
  try {
    const viewer = resetRouteState("viewer", "allowed");
    const viewerResponse = await route.GET(new Request("https://example.com/api/leche/resumen"));
    const viewerBody = await viewerResponse.json();
    assert.equal(viewerResponse.status, 200);
    assert.deepEqual(viewerBody.snapshot.reconciliation, []);
    assert.doesNotMatch(JSON.stringify(viewerBody), new RegExp(String(moneySecret)));
    assert.deepEqual(viewer.requirement, { capability: "view", fieldIds: expected.fieldIds });

    const manager = resetRouteState("manager", "allowed");
    const managerResponse = await route.GET(new Request("https://example.com/api/leche/resumen"));
    const managerBody = await managerResponse.json();
    assert.equal(managerBody.snapshot.reconciliation[0].netAmountClp, moneySecret);
    assert.deepEqual(manager.requirement, { capability: "manage_finance", fieldIds: expected.fieldIds });

    const revoked = resetRouteState("manager", "revoked");
    const revokedResponse = await route.GET(new Request("https://example.com/api/leche/resumen"));
    const revokedText = await revokedResponse.text();
    assert.equal(revokedResponse.status, 409);
    assert.doesNotMatch(revokedText, new RegExp(String(moneySecret)));
    assert.deepEqual(revoked.calls, ["authorize", "snapshot", "reauthorize"]);
  } finally {
    await close();
  }
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
  const stubs = {
    "@/app/access": {
      authorizeApiAccess: async () => {
        globalThis[stateKey].calls.push("authorize");
        return globalThis[stateKey].access;
      },
      isAccessResponse: (value) => value instanceof Response,
      reauthorizeApiSnapshotAccess: async (_access, requirement) => {
        const state = globalThis[stateKey];
        state.calls.push("reauthorize");
        state.requirement = requirement;
        return state.mode === "revoked"
          ? Response.json({ error: "access changed", code: "ACCESS_SCOPE_CHANGED" }, { status: 409 })
          : state.access;
      },
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure: (_operation, message) => Response.json({ error: message }, { status: 500 }),
    },
    "@/src/modules/access/domain/access-rules.mjs": {
      roleHasCapability: (role, capability) =>
        capability === "manage_finance" && ["manager", "admin", "owner"].includes(role),
    },
    "@/src/modules/leche/server/milk-snapshot-repository": {
      getMilkModuleSnapshot: async () => {
        const state = globalThis[stateKey];
        state.calls.push("snapshot");
        return {
          generatedAt: "2026-07-22T00:00:00.000Z",
          reconciliation: [{ fieldId: "field-a", netAmountClp: moneySecret }],
          withdrawals: [],
        };
      },
    },
  };
  const loadedModule = { exports: {} };
  Function("require", "module", "exports", "moneySecret", output)(
    (specifier) => {
      assert.ok(specifier in stubs, `Unexpected import: ${specifier}`);
      return stubs[specifier];
    },
    loadedModule,
    loadedModule.exports,
    moneySecret,
  );
  return { route: loadedModule.exports, close: async () => {} };
}

function resetRouteState(role, mode) {
  const state = {
    access: { ...expected, role },
    calls: [],
    mode,
    requirement: null,
  };
  globalThis[stateKey] = state;
  return state;
}
