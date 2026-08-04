import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL("../app/api/configuracion/accesos/route.ts", import.meta.url);
const pageUrl = new URL("../app/configuracion/accesos/page.tsx", import.meta.url);
const stateKey = "__FUNDOSMART_ACCESS_DIRECTORY_RESPONSE_TEST__";
const secretEmail = "directory-secret@example.com";

const expected = {
  displayName: "Administrator",
  email: "admin@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-admin",
  organizationId: "org-a",
  role: "admin",
};

test("access directory GET and PUT return no directory after authority is revoked", async () => {
  const route = await loadRoute();

  for (const method of ["GET", "PUT"]) {
    const state = resetState("revoked");
    const response = method === "GET"
      ? await route.GET()
      : await route.PUT(new Request("https://example.com/api/configuracion/accesos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Member",
          email: "member@example.com",
          fieldIds: ["field-a"],
          role: "viewer",
          status: "active",
        }),
      }));
    const body = await response.text();
    assert.equal(response.status, 409, method);
    assert.doesNotMatch(body, new RegExp(secretEmail), method);
    assert.deepEqual(state.requirement, {
      capability: "manage_members",
      fieldIds: expected.fieldIds,
    }, method);
    assert.deepEqual(
      state.calls,
      method === "GET"
        ? ["authorize", "dashboard", "reauthorize"]
        : ["authorize", "save", "reauthorize"],
      method,
    );
  }
});

test("access directory responses place one final barrier after each load and before serialization", async () => {
  const [route, page] = await Promise.all([readFile(routeUrl, "utf8"), readFile(pageUrl, "utf8")]);
  assert.equal((route.match(/reauthorizeApiSnapshotAccess\(/g) ?? []).length, 2);
  assert.match(
    route,
    /getAccessDashboard\(access\)[\s\S]+reauthorizeApiSnapshotAccess\([\s\S]+capability: "manage_members"[\s\S]+fieldIds: access\.fieldIds[\s\S]+Response\.json\(\{ dashboard \}/,
  );
  assert.match(
    route,
    /saveAccessMembership\([\s\S]+reauthorizeApiSnapshotAccess\([\s\S]+capability: "manage_members"[\s\S]+fieldIds: access\.fieldIds[\s\S]+Response\.json\(\{ dashboard \}/,
  );
  assert.equal((page.match(/reauthorizePageSnapshotAccess\(/g) ?? []).length, 1);
  assert.ok(page.indexOf("getAccessDashboard(access)") < page.indexOf("await reauthorizePageSnapshotAccess"));
  assert.ok(page.indexOf("await reauthorizePageSnapshotAccess") < page.lastIndexOf("return"));
  assert.match(page, /capability: "manage_members"[\s\S]+fieldIds: access\.fieldIds/);
  assert.match(page, /userName=\{currentAccess\.displayName\}/);
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
      authorizeApiAccess: async () => {
        const state = globalThis[stateKey];
        state.calls.push("authorize");
        return state.access;
      },
      isAccessResponse: (value) => value instanceof Response,
      reauthorizeApiSnapshotAccess: async (_access, requirement) => {
        const state = globalThis[stateKey];
        state.calls.push("reauthorize");
        state.requirement = requirement;
        return state.mode === "revoked"
          ? Response.json({ error: "access changed", code: "ACCESS_CONTEXT_CHANGED" }, { status: 409 })
          : state.access;
      },
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure: (_operation, message) => Response.json({ error: message }, { status: 500 }),
    },
    "@/app/json-body.mjs": {
      readJsonObject: async (request) => request.json(),
    },
    "@/src/core/server/domain-rule-error.mjs": { DomainRuleError },
    "@/src/modules/access/domain/types": {
      ORGANIZATION_MEMBERSHIP_ROLES: ["owner", "admin", "manager", "operator", "viewer"],
      ORGANIZATION_MEMBERSHIP_STATUSES: ["active", "suspended"],
    },
    "@/src/modules/access/server/access-repository": {
      getAccessDashboard: async () => {
        globalThis[stateKey].calls.push("dashboard");
        return directorySnapshot();
      },
      saveAccessMembership: async () => {
        globalThis[stateKey].calls.push("save");
        return directorySnapshot();
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
  return loadedModule.exports;
}

function directorySnapshot() {
  return {
    currentMembershipId: expected.membershipId,
    fields: [{ id: "field-a", name: "Field A" }],
    memberships: [{
      displayName: "Secret member",
      email: secretEmail,
      fieldIds: ["field-a"],
      id: "membership-secret",
      role: "viewer",
      status: "active",
    }],
    organizationId: expected.organizationId,
    organizationName: "Organization A",
  };
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
