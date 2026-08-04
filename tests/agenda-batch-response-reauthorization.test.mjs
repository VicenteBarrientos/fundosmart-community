import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL("../app/api/agenda/route.ts", import.meta.url);
const stateKey = "__FUNDOSMART_AGENDA_BATCH_RESPONSE_TEST__";
const revokedResult = "revoked-field-result-must-not-leak";
const access = {
  displayName: "Operator",
  email: "operator@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-a",
  organizationId: "organization-a",
  role: "operator",
};
const batch = [
  { fieldId: "field-a", operationId: "operation-a" },
  { fieldId: "field-b", operationId: "operation-b" },
  { fieldId: "field-a", operationId: "operation-c" },
];

test("agenda batch hides every result when any final authority changes", async () => {
  const route = await loadRoute();
  const deniedCases = [
    ["field-removed", 409, "ACCESS_SCOPE_CHANGED"],
    ["membership-replaced", 409, "ACCESS_CONTEXT_CHANGED"],
    ["capability-downgraded", 403, "CAPABILITY_REQUIRED"],
  ];

  for (const [mode, status, code] of deniedCases) {
    const state = resetState(mode);
    const response = await route.POST(batchRequest());
    const text = await response.text();
    assert.equal(response.status, status, mode);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store", mode);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", mode);
    assert.doesNotMatch(text, new RegExp(revokedResult), mode);
    assert.equal(JSON.parse(text).code, code, mode);
    assert.deepEqual(state.requirement, {
      capability: "operate",
      fieldIds: ["field-a", "field-b"],
    }, mode);
    assert.deepEqual(state.calls, [
      "authorize:operate:field-a",
      "batch",
      "reauthorize-snapshot",
    ], mode);
  }
});

test("agenda batch preserves the response when every requested field remains authorized", async () => {
  const route = await loadRoute();
  const state = resetState("allowed");
  const response = await route.POST(batchRequest());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(body.results.length, batch.length);
  assert.ok(body.results.every(({ state: result }) => result.privateMarker === revokedResult));
  assert.deepEqual(state.requirement, {
    capability: "operate",
    fieldIds: ["field-a", "field-b"],
  });
  assert.deepEqual(state.calls, [
    "authorize:operate:field-a",
    "batch",
    "reauthorize-snapshot",
  ]);
});

test("the production batch barrier runs after mutation and covers every deduplicated field", async () => {
  const source = await readFile(routeUrl, "utf8");
  const mutationIndex = source.indexOf("const results = await batchMutateAgendaTasks");
  const barrierIndex = source.indexOf("const currentAccess = await reauthorizeApiSnapshotAccess", mutationIndex);
  const responseIndex = source.indexOf("return privateAgendaJson({", barrierIndex);
  assert.ok(mutationIndex >= 0);
  assert.ok(barrierIndex > mutationIndex);
  assert.ok(responseIndex > barrierIndex);
  assert.match(
    source,
    /reauthorizeApiSnapshotAccess\(access,\s*\{\s*capability: "operate",\s*fieldIds,\s*\}\)/u,
  );
  assert.doesNotMatch(
    source,
    /reauthorizeApiAccess\(access,\s*"operate",\s*fieldIds\[0\]\)/u,
  );
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
  class AgendaRequestError extends Error {
    constructor(message, status = 400, code = "AGENDA_INVALID") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const agendaRepository = {
    batchMutateAgendaTasks: async () => {
      const state = globalThis[stateKey];
      state.calls.push("batch");
      return batch.map((mutation) => ({
        replay: false,
        state: { fieldId: mutation.fieldId, privateMarker: revokedResult },
      }));
    },
    listAgendaManagement: async () => assert.fail("GET is outside this test"),
    mutateAgendaTask: async () => assert.fail("single mutation is outside this test"),
  };
  const stubs = {
    "@/app/access": {
      authorizeApiAccess: async (capability, fieldId) => {
        const state = globalThis[stateKey];
        state.calls.push(`authorize:${capability}:${fieldId}`);
        return state.access;
      },
      isAccessResponse: (value) => value instanceof Response,
      reauthorizeApiAccess: async () => assert.fail("the batch must use the snapshot barrier"),
      reauthorizeApiSnapshotAccess: async (_expected, requirement) => {
        const state = globalThis[stateKey];
        state.calls.push("reauthorize-snapshot");
        state.requirement = requirement;
        if (state.mode === "field-removed") {
          return Response.json({ error: "scope changed", code: "ACCESS_SCOPE_CHANGED" }, { status: 409 });
        }
        if (state.mode === "membership-replaced") {
          return Response.json({ error: "identity changed", code: "ACCESS_CONTEXT_CHANGED" }, { status: 409 });
        }
        if (state.mode === "capability-downgraded") {
          return Response.json({ error: "capability changed", code: "CAPABILITY_REQUIRED" }, { status: 403 });
        }
        return state.access;
      },
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure: (_operation, message) => privateJson({ error: message }, 500),
    },
    "@/src/modules/dashboard/agenda-management.mjs": {
      AgendaRequestError,
      validateAgendaTaskMutation: (value) => value,
    },
    "@/src/modules/dashboard/agenda-http": {
      isSameOriginAgendaMutation: () => true,
      privateAgendaJson: privateJson,
      privateAgendaResponse: privateResponse,
      readAgendaJsonObject: (request) => request.json(),
    },
    "@/src/modules/dashboard/agenda-repository": agendaRepository,
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

function privateJson(body, status = 200, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: responseHeaders });
}

function privateResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function batchRequest() {
  return new Request("https://fundosmart.test/api/agenda", {
    body: JSON.stringify({ batch }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://fundosmart.test",
    },
    method: "POST",
  });
}

function resetState(mode) {
  const state = {
    access,
    calls: [],
    mode,
    requirement: null,
  };
  globalThis[stateKey] = state;
  return state;
}
