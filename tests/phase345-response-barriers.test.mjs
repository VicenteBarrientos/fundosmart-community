import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const fieldId = "field-a";
const secret = "PHASE345-PRIVATE-SNAPSHOT-91827";
const initialAccess = accessContext("membership-original");

const readRoutes = {
  analytics: {
    capability: "analitica:read",
    request: "https://example.com/api/analitica?fieldId=field-a&period=2026-07",
    url: new URL("app/api/analitica/route.ts", root),
  },
  benchmarking: {
    capability: "benchmarking:read",
    request: "https://example.com/api/benchmarking?fieldId=field-a&period=2026-07",
    url: new URL("app/api/benchmarking/route.ts", root),
  },
  pasture: {
    capability: "pastoreo:read",
    request: "https://example.com/api/praderas?fundoId=field-a",
    url: new URL("app/api/praderas/route.ts", root),
  },
};

test("final read barriers allow a current identity only after each private result is complete", async (t) => {
  for (const [domain, definition] of Object.entries(readRoutes)) {
    await t.test(domain, async () => {
      const state = routeState("allowed");
      const route = await loadReadRoute(domain, state);
      const response = await route.GET(new Request(definition.request));
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(body, new RegExp(secret));
      assert.deepEqual(state.reauthorization, {
        capability: definition.capability,
        fieldId,
        membershipId: initialAccess.membershipId,
      });
      assert.ok(state.calls.indexOf("repository") < state.calls.indexOf("reauthorize"));
      if (domain === "pasture") {
        assert.ok(state.calls.indexOf("planningBasis") < state.calls.indexOf("reauthorize"));
      }
    });
  }
});

test("revocation, feature-off, and same-email replacement serialize no loaded response", async (t) => {
  for (const [domain, definition] of Object.entries(readRoutes)) {
    for (const scenario of [
      { mode: "suspended", status: 403 },
      { mode: "feature-off", status: 403 },
      { mode: "same-email-replacement", status: 409 },
    ]) {
      await t.test(`${domain}: ${scenario.mode}`, async () => {
        const state = routeState(scenario.mode);
        const route = await loadReadRoute(domain, state);
        const response = await route.GET(new Request(definition.request));
        const body = await response.text();

        assert.equal(response.status, scenario.status);
        assert.doesNotMatch(body, new RegExp(secret));
        assert.equal(state.calls.includes("repository"), true);
        assert.equal(state.calls.at(-1), "reauthorize");
        assert.deepEqual(state.reauthorization, {
          capability: definition.capability,
          fieldId,
          membershipId: initialAccess.membershipId,
        });
        if (scenario.mode === "same-email-replacement") {
          assert.equal(state.currentAccess.email, initialAccess.email);
          assert.notEqual(state.currentAccess.membershipId, initialAccess.membershipId);
        }
      });
    }
  }
});

test("mutations keep their write authority through the post-result response barrier", async (t) => {
  for (const scenario of [
    { mode: "allowed", expectedStatus: { analytics: 202, benchmarking: 202, pasture: 201 } },
    { mode: "same-email-replacement", expectedStatus: { analytics: 409, benchmarking: 409, pasture: 409 } },
  ]) {
    for (const domain of ["analytics", "benchmarking", "pasture"]) {
      await t.test(`${domain}: ${scenario.mode}`, async () => {
        const state = routeState(scenario.mode);
        const { route, request, writeCapability } = await loadMutationRoute(domain, state);
        const response = await route.POST(request);
        const body = await response.text();

        assert.equal(response.status, scenario.expectedStatus[domain]);
        assert.ok(state.calls.indexOf("mutation") < state.calls.indexOf("reauthorize"));
        assert.equal(state.calls.at(-1), "reauthorize");
        assert.equal(state.reauthorization.capability, writeCapability);
        assert.equal(state.reauthorization.fieldId, fieldId);
        if (scenario.mode === "allowed") assert.match(body, new RegExp(secret));
        else assert.doesNotMatch(body, new RegExp(secret));
      });
    }
  }
});

test("pages and every response branch place the final barrier before serialization", async () => {
  const [
    analyticsPage,
    analyticsRead,
    analyticsThresholds,
    analyticsRecompute,
    benchmarkPage,
    benchmarkRoute,
    pasturePage,
    pastureRoute,
    pastureNdvi,
  ] = await Promise.all([
    readFile(new URL("app/(producto)/analitica/page.tsx", root), "utf8"),
    readFile(readRoutes.analytics.url, "utf8"),
    readFile(new URL("app/api/analitica/umbrales/route.ts", root), "utf8"),
    readFile(new URL("app/api/analitica/recalcular/route.ts", root), "utf8"),
    readFile(new URL("app/(producto)/benchmarking/page.tsx", root), "utf8"),
    readFile(readRoutes.benchmarking.url, "utf8"),
    readFile(new URL("app/(producto)/praderas/page.tsx", root), "utf8"),
    readFile(readRoutes.pasture.url, "utf8"),
    readFile(new URL("app/api/praderas/ndvi/route.ts", root), "utf8"),
  ]);

  assertOrdered(analyticsRead, "getAnalyticsDashboard", "reauthorizeApiAccess", "privateJson({ analytics })");
  assertOrdered(analyticsPage, "getAnalyticsDashboard", "reauthorizePageAccess", "<AnalyticsPage");
  assert.match(analyticsPage, /"analitica:read", fieldId/u);
  for (const source of [analyticsThresholds, analyticsRecompute]) {
    assert.match(source, /reauthorizeApiAccess\(access, "analitica:read", fieldId\)/u);
    assert.match(source, /roleHasCapability\(currentAccess\.role, "manage_imports"\)/u);
  }

  assertOrdered(benchmarkRoute, "getBenchmarkDashboard", "reauthorizeApiAccess", "privateJson({ dashboard })");
  assertOrdered(benchmarkPage, "getBenchmarkDashboard", "reauthorizePageAccess", "<BenchmarkingPage");
  assert.match(benchmarkPage, /"benchmarking:read", fieldId/u);
  assert.equal((benchmarkRoute.match(/await reauthorizeBenchmarkWrite\(access, fieldId\)/gu) ?? []).length, 3);
  assert.match(benchmarkRoute, /reauthorizeApiAccess\(access, "benchmarking:write", fieldId\)/u);
  assert.match(benchmarkRoute, /roleHasCapability\(currentAccess\.role, "manage_members"\)/u);

  assert.match(pasturePage, /requirePageAccess\("\/app\/praderas"\)/u);
  assert.match(pasturePage, /"pastoreo:read",[\s\S]+fieldId/u);
  assertOrdered(pasturePage, "isFeatureEnabled", "reauthorizePageAccess", "<PraderasPage");
  assert.equal((pastureRoute.match(/reauthorizeApiAccess\(access, "pastoreo:write", fieldId\)/gu) ?? []).length, 2);
  assert.equal((pastureNdvi.match(/reauthorizeApiAccess\(access, "pastoreo:write", fieldId\)/gu) ?? []).length, 1);
  assertOrdered(pastureRoute, "getPastureDashboard", "reauthorizeApiAccess", "privateJson({ pasture })");
  assertOrdered(pastureNdvi, "getPastureProviderDecision", "reauthorizeApiAccess", "privateJson({ provider })");
});

async function loadReadRoute(domain, state) {
  const definition = readRoutes[domain];
  const common = {
    "@/app/access": accessStubs(state),
    "@/app/api-failure.mjs": failureStubs(),
  };
  if (domain === "analytics") {
    class AnalyticsRequestError extends Error {}
    class AnalyticsScopeError extends Error {}
    return loadModule(definition.url, {
      ...common,
      "@/src/modules/analytics/server/analytics-repository": {
        AnalyticsRequestError,
        AnalyticsScopeError,
        getAnalyticsDashboard: async () => {
          state.calls.push("repository");
          return { field: { id: fieldId }, marker: secret };
        },
      },
    });
  }
  if (domain === "benchmarking") {
    class BenchmarkPrivacyError extends Error {}
    class BenchmarkRepositoryError extends Error {}
    return loadModule(definition.url, {
      ...common,
      "@/app/json-body.mjs": { readJsonObject: async (request) => request.json() },
      "@/src/modules/access/domain/access-rules.mjs": { roleHasCapability: () => true },
      "@/src/modules/benchmarking/domain/benchmarking-rules.mjs": { BenchmarkPrivacyError },
      "@/src/modules/benchmarking/server/benchmarking-repository": {
        BenchmarkRepositoryError,
        enqueueBenchmarkAggregation: unused,
        getBenchmarkDashboard: async () => {
          state.calls.push("repository");
          return { marker: secret };
        },
        saveBenchmarkProfile: unused,
        setBenchmarkConsent: unused,
      },
    });
  }
  class PastureDomainError extends Error {}
  class PastureScopeError extends Error {}
  return loadModule(definition.url, {
    ...common,
    "@/app/json-body.mjs": { readJsonObject: async (request) => request.json() },
    "@/src/modules/praderas/domain/pasture-planning.mjs": { PastureDomainError },
    "@/src/modules/praderas/server/pasture-repository": {
      PastureScopeError,
      createPastureRotationPlan: unused,
      getPastureDashboard: async () => {
        state.calls.push("repository");
        const dashboard = { marker: secret };
        dashboard.planningBasis = { marker: `${secret}-BASIS` };
        state.calls.push("planningBasis");
        return dashboard;
      },
      recordManualPastureObservation: unused,
    },
  });
}

async function loadMutationRoute(domain, state) {
  if (domain === "analytics") {
    class AnalyticsConflictError extends Error {}
    class AnalyticsRequestError extends Error {}
    class AnalyticsScopeError extends Error {}
    const route = await loadModule(new URL("app/api/analitica/recalcular/route.ts", root), {
      "@/app/access": accessStubs(state),
      "@/app/api-failure.mjs": failureStubs(),
      "@/app/json-body.mjs": { readJsonObject: async (request) => request.json() },
      "@/src/modules/access/domain/access-rules.mjs": { roleHasCapability: () => true },
      "@/src/modules/analytics/server/analytics-repository": {
        AnalyticsConflictError,
        AnalyticsRequestError,
        AnalyticsScopeError,
        enqueueAnalyticsRecompute: async () => {
          state.calls.push("mutation");
          return { id: secret };
        },
      },
    });
    return {
      route,
      request: jsonRequest("https://example.com/api/analitica/recalcular", {
        expectedSourceRevision: null,
        fieldId,
        period: "2026-07",
      }),
      writeCapability: "analitica:read",
    };
  }
  if (domain === "benchmarking") {
    class BenchmarkPrivacyError extends Error {}
    class BenchmarkRepositoryError extends Error {}
    const route = await loadModule(readRoutes.benchmarking.url, {
      "@/app/access": accessStubs(state),
      "@/app/api-failure.mjs": failureStubs(),
      "@/app/json-body.mjs": { readJsonObject: async (request) => request.json() },
      "@/src/modules/access/domain/access-rules.mjs": { roleHasCapability: () => true },
      "@/src/modules/benchmarking/domain/benchmarking-rules.mjs": { BenchmarkPrivacyError },
      "@/src/modules/benchmarking/server/benchmarking-repository": {
        BenchmarkRepositoryError,
        enqueueBenchmarkAggregation: async () => {
          state.calls.push("mutation");
          return { id: secret };
        },
        getBenchmarkDashboard: unused,
        saveBenchmarkProfile: unused,
        setBenchmarkConsent: unused,
      },
    });
    const request = jsonRequest("https://example.com/api/benchmarking", {
      action: "enqueue_recompute",
      fieldId,
      period: "2026-07",
    }, { "Idempotency-Key": "phase345-runtime" });
    return { route, request, writeCapability: "benchmarking:write" };
  }
  class PastureDomainError extends Error {}
  class PastureScopeError extends Error {}
  const route = await loadModule(readRoutes.pasture.url, {
    "@/app/access": accessStubs(state),
    "@/app/api-failure.mjs": failureStubs(),
    "@/app/json-body.mjs": { readJsonObject: async (request) => request.json() },
    "@/src/modules/praderas/domain/pasture-planning.mjs": { PastureDomainError },
    "@/src/modules/praderas/server/pasture-repository": {
      PastureScopeError,
      createPastureRotationPlan: async () => {
        state.calls.push("mutation");
        return { id: secret };
      },
      getPastureDashboard: unused,
      recordManualPastureObservation: unused,
    },
  });
  return {
    route,
    request: jsonRequest("https://example.com/api/praderas", { action: "create_rotation_plan", fieldId }),
    writeCapability: "pastoreo:write",
  };
}

function accessStubs(state) {
  return {
    authorizeApiAccess: async (capability, requestedFieldId) => {
      state.calls.push(`authorize:${capability}:${requestedFieldId ?? ""}`);
      return initialAccess;
    },
    isAccessResponse: (value) => value instanceof Response,
    reauthorizeApiAccess: async (expected, capability, requestedFieldId) => {
      state.calls.push("reauthorize");
      state.reauthorization = {
        capability,
        fieldId: requestedFieldId,
        membershipId: expected.membershipId,
      };
      if (state.mode === "suspended") return denied(403, "MEMBERSHIP_SUSPENDED");
      if (state.mode === "feature-off") return denied(403, "FEATURE_REQUIRED");
      if (state.mode === "same-email-replacement") return denied(409, "ACCESS_CONTEXT_CHANGED");
      return state.currentAccess;
    },
    requireContextField: () => null,
  };
}

function routeState(mode) {
  return {
    calls: [],
    currentAccess: accessContext(mode === "same-email-replacement" ? "membership-replacement" : "membership-original"),
    mode,
    reauthorization: null,
  };
}

function accessContext(membershipId) {
  return {
    displayName: "Current administrator",
    email: "member@example.com",
    fieldIds: [fieldId],
    membershipId,
    organizationId: "org-a",
    role: "admin",
  };
}

function denied(status, code) {
  return Response.json({ error: "access changed", code }, { status });
}

function failureStubs() {
  return {
    unexpectedApiFailure: (_operation, message) => Response.json({ error: message }, { status: 500 }),
  };
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(url).origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function loadModule(url, stubs) {
  const source = await readFile(url, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
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

function assertOrdered(source, first, barrier, serialized) {
  const firstIndex = source.indexOf(first);
  const barrierIndex = source.indexOf(barrier, firstIndex + first.length);
  const serializedIndex = source.indexOf(serialized, barrierIndex + barrier.length);
  assert.ok(firstIndex >= 0, first);
  assert.ok(firstIndex < barrierIndex, `${barrier} must follow ${first}`);
  assert.ok(barrierIndex < serializedIndex, `${barrier} must precede ${serialized}`);
}

async function unused() {
  throw new Error("unused test stub");
}
