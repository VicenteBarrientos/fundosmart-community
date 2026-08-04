import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const stateKey = "__FUNDOSMART_ANIMAL_RECORD_RESPONSE_TEST__";
const secrets = [
  "DIIO-SECRET-901",
  "DIIO-SECRET-NONINITIAL-902",
  "MILK-SECRET-32.4",
  "REPRO-SECRET-INSEMINATION",
  "BIRTH-SECRET-TWIN",
  "HEALTH-SECRET-TREATMENT",
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
        state.authorizationCalls.push({ capability, fieldId });
        if (state.authorizationCalls.length === 1) return state.initialAccess;
        if (state.mode === "suspended") {
          throw new AccessDeniedError("Tu membresia no esta activa.", "MEMBERSHIP_INACTIVE");
        }
        if (fieldId && !state.currentAccess.fieldIds.includes(fieldId)) {
          throw new AccessDeniedError("El fundo ya no esta disponible.", "FIELD_ACCESS_DENIED");
        }
        return state.currentAccess;
      }
    `],
    ["@/src/modules/access/server/resource-scope", `
      export async function resolveResourceFieldId() {
        return globalThis.${stateKey}.record.fieldId;
      }
    `],
    ["next/navigation", `
      export function redirect(url) {
        const error = new Error("NEXT_REDIRECT");
        error.url = url;
        throw error;
      }
    `],
    ["@/src/modules/ganado/ficha/server/animal-record-repository", `
      export async function listAnimalDirectory() {
        return globalThis.${stateKey}.directory;
      }
      export async function getAnimalRecord() {
        return globalThis.${stateKey}.record;
      }
      export async function saveBirth() { throw new Error("unused"); }
      export async function saveHealthEvent() { throw new Error("unused"); }
      export async function saveMilkControl() { throw new Error("unused"); }
      export async function saveReproductiveEvent() { throw new Error("unused"); }
    `],
    ["@/src/modules/ganado/ficha/AnimalRecordPage", `
      export function AnimalRecordPage() { return null; }
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
    ["@/src/core/server/domain-rule-error.mjs", `
      export class DomainRuleError extends Error {}
    `],
    ["@/src/modules/ganado/ficha/server/animal-record-rules.mjs", `
      export class AnimalRecordRuleError extends Error {}
      export function normalizeBirthInput(value) { return value; }
      export function normalizeHealthEventInput(value) { return value; }
      export function normalizeMilkControlInput(value) { return value; }
      export function normalizeReproductiveEventInput(value) { return value; }
    `],
    ["react/jsx-runtime", jsxRuntimeSource()],
    ["react/jsx-dev-runtime", jsxRuntimeSource()],
  ]);
  const virtualPrefix = "\0animal-record-response:";

  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "animal-record-response-mocks",
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
    vite.ssrLoadModule("/app/api/ganado/ficha/route.ts"),
    vite.ssrLoadModule("/app/(producto)/ganado/ficha/page.tsx"),
  ]);
});

after(async () => {
  await vite?.close();
  delete globalThis[stateKey];
});

test("the API releases a loaded animal record only after exact current field authorization", async () => {
  const state = resetState("allowed");
  const response = await route.GET(new Request("https://example.com/api/ganado/ficha?animalId=animal-secret"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.record.animal.tag, secrets[0]);
  assert.deepEqual(state.authorizationCalls, [
    { capability: "view", fieldId: undefined },
    { capability: "view", fieldId: "field-a" },
  ]);
});

test("suspension, field withdrawal, and same-email replacement return no animal history", async (t) => {
  for (const scenario of [
    { mode: "suspended", status: 403 },
    { mode: "field-withdrawn", status: 403 },
    { mode: "same-email-replacement", status: 409 },
  ]) {
    await t.test(scenario.mode, async () => {
      const state = resetState(scenario.mode);
      const response = await route.GET(new Request("https://example.com/api/ganado/ficha?animalId=animal-secret"));
      const text = await response.text();

      assert.equal(response.status, scenario.status);
      assert.equal(state.authorizationCalls.at(-1).fieldId, "field-a");
      assertNoAnimalSecrets(text);
    });
  }
});

test("the page creates sensitive props only after the equivalent exact field barrier", async () => {
  const state = resetState("allowed");
  const tree = await page.default();

  assert.equal(tree.props.initialRecord.animal.tag, secrets[0]);
  assert.equal(tree.props.animals[0].tag, secrets[0]);
  assert.equal(tree.props.animals[1].tag, secrets[1]);
  assert.equal(tree.props.userName, "Current operator");
  assert.deepEqual(state.authorizationCalls, [
    { capability: "view", fieldId: undefined },
    { capability: "view", fieldId: "field-a" },
  ]);
});

test("page revocation, including a non-initial field withdrawal, redirects before directory or history props", async (t) => {
  for (const mode of ["suspended", "field-withdrawn", "noninitial-field-withdrawn", "same-email-replacement"]) {
    await t.test(mode, async () => {
      const state = resetState(mode);
      const error = await captureRejection(() => page.default());
      const redirectSignal = `${error.message} ${error.digest ?? ""} ${error.url ?? ""}`;

      assert.equal(error.message, "NEXT_REDIRECT");
      assert.match(redirectSignal, /\/app\/sin-acceso\?code=/);
      if (mode === "noninitial-field-withdrawn") assert.match(redirectSignal, /ACCESS_SCOPE_CHANGED/);
      assert.equal(state.authorizationCalls.at(-1).fieldId, "field-a");
      assert.equal(state.authorizationCalls.length, 2);
      assertNoAnimalSecrets(redirectSignal);
    });
  }
});

function resetState(mode) {
  const initialAccess = accessContext("membership-original", ["field-a", "field-b"], "Initial operator");
  const currentAccess = mode === "same-email-replacement"
    ? accessContext("membership-replacement", ["field-a", "field-b"], "Replacement operator")
    : accessContext("membership-original", currentFieldIdsForMode(mode), "Current operator");
  const state = {
    authorizationCalls: [],
    currentAccess,
    directory: [
      { id: "animal-secret", tag: secrets[0], sex: "female", fieldId: "field-a" },
      { id: "animal-noninitial", tag: secrets[1], sex: "male", fieldId: "field-b" },
    ],
    initialAccess,
    mode,
    record: sensitiveRecord(),
  };
  globalThis[stateKey] = state;
  return state;
}

function currentFieldIdsForMode(mode) {
  if (mode === "field-withdrawn") return ["field-b"];
  if (mode === "noninitial-field-withdrawn") return ["field-a"];
  return ["field-a", "field-b"];
}

function accessContext(membershipId, fieldIds, displayName) {
  return {
    capabilities: ["view"],
    displayName,
    email: "operator@example.com",
    fieldIds,
    membershipId,
    organizationId: "org-a",
    role: "viewer",
  };
}

function sensitiveRecord() {
  return {
    animal: { id: "animal-secret", tag: secrets[0], sex: "female" },
    births: [{ notes: secrets[4] }],
    fieldId: "field-a",
    healthEvents: [{ condition: secrets[5] }],
    identifiers: [{ kind: "DIIO", value: secrets[0] }],
    lactations: [{ notes: secrets[2] }],
    milkControls: [{ notes: secrets[2] }],
    reproductiveEvents: [{ notes: secrets[3] }],
  };
}

function assertNoAnimalSecrets(value) {
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
      globalThis.${stateKey}.renderedProps = props;
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
