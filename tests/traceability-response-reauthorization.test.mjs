import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const routeUrl = new URL("../app/api/trazabilidad/route.ts", import.meta.url);
const pageUrl = new URL("../app/trazabilidad/page.tsx", import.meta.url);
const stateKey = "__FUNDOSMART_TRACEABILITY_RESPONSE_TEST__";
const secrets = [
  "76.543.210-K",
  "RUP-SECRET-001",
  "GEOREF-SECRET-42",
  "DIIO-SECRET-9001",
  "RFID-SECRET-9001",
  "DESTINATION-RUP-SECRET",
  "DECLARATION-SECRET-2026",
  "IMPORT-SECRET-RAW",
];

let vite;
let route;
let page;

before(async () => {
  const virtualModules = new Map([
    ["@/app/account-mode", `
      export async function resolveAccountUser(user) { return user; }
    `],
    ["@/app/auth", `
      export async function getAppUser() {
        return { email: "operator@example.com", displayName: "Initial operator" };
      }
      export async function getAppUserWithLegalStatus() {
        return { user: await getAppUser(), legalStatus: { complete: true } };
      }
    `],
    ["@/app/legal-access", `
      export async function authorizeApiLegalAcceptance() { return null; }
      export async function requirePageLegalAcceptance() {}
    `],
    ["@/src/modules/access/server/access-repository", `
      export class AccessDeniedError extends Error {
        constructor(message, code) {
          super(message);
          this.name = "AccessDeniedError";
          this.code = code;
        }
      }

      export async function authorizeUser(_user, capability = "view", fieldId) {
        const state = globalThis.${stateKey};
        state.events.push("authorize");
        state.authorizationCalls.push({ capability, fieldId });
        if (!state.snapshotLoaded) return state.initialAccess;
        if (state.mode === "suspended") {
          throw new AccessDeniedError("Tu membresia esta suspendida.", "MEMBERSHIP_SUSPENDED");
        }
        if (state.mode === "feature-off") {
          throw new AccessDeniedError("La funcionalidad ya no esta habilitada.", "FEATURE_REQUIRED");
        }
        if (fieldId && !state.currentAccess.fieldIds.includes(fieldId)) {
          throw new AccessDeniedError("El fundo ya no esta disponible.", "FIELD_REQUIRED");
        }
        return state.currentAccess;
      }
    `],
    ["@/src/modules/access/server/resource-scope", `
      export async function resolveResourceFieldId() { return null; }
    `],
    ["next/navigation", `
      export function redirect(url) {
        const error = new Error("NEXT_REDIRECT");
        error.url = url;
        throw error;
      }
    `],
    ["@/src/modules/access/server/feature-flag-repository", `
      export async function isFeatureEnabled(_access, feature, fieldId) {
        const state = globalThis.${stateKey};
        state.events.push("feature:" + fieldId);
        state.featureChecks.push({ feature, fieldId });
        return true;
      }
    `],
    ["@/src/modules/potreros/server/fundo-repository", `
      export async function listFundos() {
        globalThis.${stateKey}.events.push("fundos");
        return [
          { id: "field-a", name: "Fundo A" },
          { id: "field-b", name: "Fundo B" },
        ];
      }
    `],
    ["@/src/modules/trazabilidad/server/traceability-repository", `
      export class TraceabilityRequestError extends Error {
        constructor(message, status = 400, code = "TRACEABILITY_REQUEST_INVALID", issues) {
          super(message);
          this.status = status;
          this.code = code;
          this.issues = issues;
        }
      }
      export async function getTraceabilityDashboard() {
        const state = globalThis.${stateKey};
        state.events.push("dashboard");
        state.snapshotLoaded = true;
        return state.dashboard;
      }
      export async function addTraceabilityDiio() { throw new Error("unused"); }
      export async function annulFmaDocument() { throw new Error("unused"); }
      export async function commitTraceabilityImport() { throw new Error("unused"); }
      export async function generateDeaDraft() { throw new Error("unused"); }
      export async function generateFmaDrafts() { throw new Error("unused"); }
      export async function issueFmaDocuments() { throw new Error("unused"); }
      export async function saveTraceabilityEstablishment() { throw new Error("unused"); }
      export async function stageTraceabilityImport() { throw new Error("unused"); }
      export async function stageTraceabilityDbfImport() { throw new Error("unused"); }
      export async function transitionTraceabilityDiio() { throw new Error("unused"); }
    `],
    ["@/src/modules/demo/data/demo-data.mjs", `
      export const DEMO_EMAIL = "demo@fundosmart.local";
    `],
    ["@/app/api-failure.mjs", `
      export function unexpectedApiFailure(_operation, message) {
        return Response.json({ error: message }, { status: 500 });
      }
    `],
    ["@/app/json-body.mjs", `
      export async function readJsonObject() { return {}; }
    `],
    ["./TraceabilityClient", `
      export function TraceabilityClient() { return null; }
    `],
    ["react/jsx-runtime", jsxRuntimeSource()],
    ["react/jsx-dev-runtime", jsxRuntimeSource()],
  ]);
  const virtualPrefix = "\0traceability-response:";

  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "traceability-response-mocks",
      enforce: "pre",
      resolveId(source) {
        const virtualSource = resolveVirtualSource(source, virtualModules);
        if (virtualSource) return `${virtualPrefix}${virtualSource}`;
      },
      load(id) {
        if (!id.startsWith(virtualPrefix)) return;
        return virtualModules.get(id.slice(virtualPrefix.length));
      },
    }],
  });

  [route, page] = await Promise.all([
    vite.ssrLoadModule("/app/api/trazabilidad/route.ts"),
    vite.ssrLoadModule("/app/trazabilidad/page.tsx"),
  ]);
});

after(async () => {
  await vite?.close();
  delete globalThis[stateKey];
});

test("valid API and page snapshots pass the final exact traceability barrier", async () => {
  const apiState = resetState("allowed", "api");
  const response = await route.GET(new Request("https://example.com/api/trazabilidad?fieldId=field-a"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.establishment.rup, secrets[1]);
  assert.deepEqual(apiState.authorizationCalls, [
    { capability: "trazabilidad:read", fieldId: "field-a" },
    { capability: "trazabilidad:read", fieldId: "field-a" },
  ]);
  assert.deepEqual(apiState.events, ["authorize", "dashboard", "authorize"]);

  const pageState = resetState("allowed", "page");
  const tree = await page.default({ searchParams: Promise.resolve({ fieldId: "field-a" }) });

  assert.equal(tree.props.initialDashboard.establishment.holderRut, secrets[0]);
  assert.deepEqual(tree.props.fields.map(({ id }) => id), ["field-a", "field-b"]);
  assert.equal(tree.props.userName, "Current operator");
  assert.deepEqual(pageState.authorizationCalls, [
    { capability: "view", fieldId: undefined },
    { capability: "trazabilidad:read", fieldId: "field-a" },
    { capability: "trazabilidad:read", fieldId: "field-a" },
  ]);
  assert.ok(pageState.events.indexOf("dashboard") < pageState.events.lastIndexOf("authorize"));
  assert.equal(pageState.events.at(-1), "authorize");
});

test("API suspension, field withdrawal, feature shutdown, and same-email replacement return no traceability snapshot", async (t) => {
  for (const scenario of [
    { mode: "suspended", status: 403 },
    { mode: "scope-withdrawn", status: 403 },
    { mode: "feature-off", status: 403 },
    { mode: "same-email-replacement", status: 409 },
  ]) {
    await t.test(scenario.mode, async () => {
      const state = resetState(scenario.mode, "api");
      const response = await route.GET(new Request("https://example.com/api/trazabilidad?fieldId=field-a"));
      const text = await response.text();

      assert.equal(response.status, scenario.status);
      assert.deepEqual(state.events, ["authorize", "dashboard", "authorize"]);
      assertNoTraceabilitySecrets(text);
    });
  }
});

test("page revocation redirects before RSC props, including withdrawal of a non-selected snapshot field", async (t) => {
  for (const mode of ["suspended", "scope-withdrawn", "feature-off", "same-email-replacement"]) {
    await t.test(mode, async () => {
      const state = resetState(mode, "page");
      const error = await captureRejection(() => page.default({
        searchParams: Promise.resolve({ fieldId: "field-a" }),
      }));
      const redirectSignal = `${error.message} ${error.digest ?? ""} ${error.url ?? ""}`;

      assert.equal(error.message, "NEXT_REDIRECT");
      assert.match(redirectSignal, /\/app\/sin-acceso\?code=/);
      if (mode === "scope-withdrawn") assert.match(redirectSignal, /ACCESS_SCOPE_CHANGED/);
      assert.equal(state.events.at(-1), "authorize");
      assertNoTraceabilitySecrets(redirectSignal);
    });
  }
});

test("both callers place one field-specific read barrier after loading and immediately before serialization", async () => {
  const [routeSource, pageSource] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(pageUrl, "utf8"),
  ]);

  assert.equal((routeSource.match(/reauthorizeApiAccess\(/g) ?? []).length, 1);
  assert.match(
    routeSource,
    /getTraceabilityDashboard\(access, fieldId\)[\s\S]+reauthorizeApiAccess\(access, "trazabilidad:read", dashboard\.field\.id\)[\s\S]+privateJson\(dashboard\)/,
  );
  assert.equal((pageSource.match(/reauthorizePageAccess\(/g) ?? []).length, 1);
  assert.ok(pageSource.indexOf("getTraceabilityDashboard(access, selected.id)") < pageSource.indexOf("await reauthorizePageAccess"));
  assert.ok(pageSource.indexOf("await reauthorizePageAccess") < pageSource.lastIndexOf("return"));
  assert.match(pageSource, /"trazabilidad:read",[\s\S]+dashboard\.field\.id/);
  assert.match(pageSource, /enabledFundos\.some\(\(fundo\) => !currentFieldIds\.has\(fundo\.id\)\)/);
  assert.doesNotMatch(pageSource, /isDemo=\{access\.email|userName=\{access\.displayName/);
});

function resetState(mode, surface) {
  const initialAccess = accessContext("membership-original", ["field-a", "field-b"], "Initial operator");
  const currentAccess = mode === "same-email-replacement"
    ? accessContext("membership-replacement", currentFieldIds(mode, surface), "Replacement operator")
    : accessContext("membership-original", currentFieldIds(mode, surface), "Current operator");
  const state = {
    authorizationCalls: [],
    currentAccess,
    dashboard: sensitiveDashboard(),
    events: [],
    featureChecks: [],
    initialAccess,
    mode,
    snapshotLoaded: false,
    surface,
  };
  globalThis[stateKey] = state;
  return state;
}

function currentFieldIds(mode, surface) {
  if (mode !== "scope-withdrawn") return ["field-a", "field-b"];
  return surface === "api" ? [] : ["field-a"];
}

function accessContext(membershipId, fieldIds, displayName) {
  return {
    displayName,
    email: "operator@example.com",
    fieldIds,
    membershipId,
    organizationId: "org-a",
    role: "manager",
  };
}

function sensitiveDashboard() {
  return {
    dataMode: "real",
    declarations: [{ id: secrets[6] }],
    devices: [{ officialNumber: secrets[3], rfidId: secrets[4] }],
    establishment: {
      address: "Secret address",
      georef: { source: secrets[2] },
      holderName: "Secret holder",
      holderRut: secrets[0],
      rup: secrets[1],
    },
    field: { id: "field-a", isDemo: false, location: "Secret location", name: "Fundo A" },
    imports: [{ result: secrets[7] }],
    inventory: [{ deviceId: secrets[3] }],
    movements: [{ destinationRup: secrets[5] }],
    officialFormatDecision: "pending_confirmation",
    readOnly: false,
    reconciliation: {
      currentYearDeaStored: false,
      findings: [],
      healthy: true,
      lastScheduledState: null,
      staleDrafts: 0,
    },
    sipecAdapter: {},
  };
}

function assertNoTraceabilitySecrets(value) {
  for (const secret of secrets) assert.doesNotMatch(value, new RegExp(secret));
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected the page access barrier to redirect");
}

function jsxRuntimeSource() {
  return `
    export const Fragment = Symbol.for("test.fragment");
    export function jsx(type, props) {
      globalThis.${stateKey}.events.push("render");
      return { type, props };
    }
    export const jsxs = jsx;
    export const jsxDEV = jsx;
  `;
}

function resolveVirtualSource(source, virtualModules) {
  if (virtualModules.has(source)) return source;
  const normalized = source.replaceAll("\\", "/").replace(/\?.*$/, "");
  for (const virtualSource of virtualModules.keys()) {
    if (!virtualSource.startsWith("@/")) continue;
    const suffix = virtualSource.slice(1);
    if (normalized.endsWith(suffix) || normalized.endsWith(`${suffix}.ts`) || normalized.endsWith(`${suffix}.tsx`)) {
      return virtualSource;
    }
  }
  return null;
}
