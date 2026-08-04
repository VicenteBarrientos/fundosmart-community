import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const stateKey = "__FUNDOSMART_OPERATIONAL_API_RESPONSE_TEST__";
const secret = "OPERATIONAL-SNAPSHOT-SECRET-47291";

const initialAccess = accessContext("membership-original", ["field-a", "field-b"]);

const routeExpectations = [
  route("app/api/fundos/route.ts", {
    GET: methods([snapshot("view")]),
    POST: methods([field("operate")]),
  }),
  route("app/api/actividades/route.ts", {
    GET: methods([field("view"), snapshot("view")]),
    POST: methods([field("operate")]),
    DELETE: methods([field("operate")]),
  }),
  route("app/api/ganado/route.ts", standardCrud()),
  route("app/api/ganado/animales/route.ts", standardCrud("snapshot")),
  route("app/api/ganado/pesajes/route.ts", standardCrud("snapshot")),
  route("app/api/ganado/racion/route.ts", standardCrud()),
  route("app/api/ganado/alimentacion/route.ts", {
    GET: methods([snapshot("view")]),
    POST: methods([field("operate"), field("operate")], 2),
  }),
  route("app/api/potreros/route.ts", {
    GET: methods([field("view"), snapshot("view")]),
    POST: methods([field("operate")]),
    DELETE: methods([field("operate")]),
  }),
  route("app/api/potreros/archivados/route.ts", { GET: methods([field("view")]) }),
  route("app/api/potreros/carga/route.ts", { GET: methods([field("view")]) }),
  route("app/api/potreros/celdas/route.ts", {
    GET: methods([field("view")]),
    POST: methods([field("operate")]),
    PUT: methods([field("operate")]),
    DELETE: methods([field("operate")]),
  }),
  route("app/api/potreros/hitos/route.ts", {
    GET: methods([field("view")]),
    PUT: methods([field("operate")]),
    DELETE: methods([field("operate")]),
  }),
  route("app/api/potreros/lote/route.ts", {
    GET: methods([field("view")]),
    POST: methods([field("operate")]),
  }),
  route("app/api/potreros/ndvi/route.ts", {
    GET: methods([field("view")]),
    POST: methods([field("operate")]),
  }),
  route("app/api/potreros/operaciones/route.ts", {
    GET: methods([field("view")]),
    POST: methods([field("operate")]),
    PUT: methods([field("operate")]),
  }),
  route("app/api/potreros/rotacion/route.ts", {
    GET: methods([field("view")]),
    PUT: methods([field("operate")]),
  }),
  route("app/api/subdivisiones/route.ts", {
    GET: methods([field("view"), field("view")], 2),
    PUT: methods([field("operate")]),
    DELETE: methods([field("operate")]),
  }),
  route("app/api/leche/operaciones/route.ts", {
    GET: methods([snapshot("view")]),
    POST: methods([
      snapshot("operate"),
      field("operate"),
      field("operate"),
      field("operate"),
    ], 4),
    DELETE: methods([field("operate")]),
  }),
];

let vite;
let fundosRoute;
let archivedRoute;

before(async () => {
  const virtualModules = new Map([
    ["@/app/account-mode", `
      export async function resolveAccountUser(user) { return user; }
    `],
    ["@/app/auth", `
      export async function getAppUser() {
        return { email: "operator@example.com", displayName: "Operator" };
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
        if (state.authorizationCalls.length === 1) return state.initialAccess;
        if (state.mode === "suspended") {
          throw new AccessDeniedError("Tu membresia no esta activa.", "MEMBERSHIP_INACTIVE");
        }
        if (fieldId && !state.currentAccess.fieldIds.includes(fieldId)) {
          throw new AccessDeniedError("El fundo ya no esta disponible.", "FIELD_REQUIRED");
        }
        return state.currentAccess;
      }
    `],
    ["@/src/modules/access/server/resource-scope", `
      export async function resolveResourceFieldId() { return "field-a"; }
    `],
    ["@/src/modules/access/server/organization-plan-repository", `
      export async function getOrganizationPlanUsage() {
        return {
          planCode: "legacy",
          fieldLimit: null,
          paddockLimit: null,
          fieldsUsed: 2,
          paddocksUsed: 0,
        };
      }
    `],
    ["next/navigation", `
      export function redirect() { throw new Error("unused redirect"); }
    `],
    ["@/app/api-failure.mjs", `
      export function unexpectedApiFailure(_operation, message) {
        return Response.json({ error: message }, { status: 500 });
      }
    `],
    ["@/app/json-body.mjs", `
      export async function readJsonObject(request) { return request.json(); }
    `],
    ["@/src/core/server/domain-rule-error.mjs", `
      export class DomainRuleError extends Error {}
    `],
    ["@/src/modules/potreros/server/fundo-repository", `
      export async function listFundos() {
        globalThis.${stateKey}.events.push("loader");
        return [{ id: "field-a", name: "${secret}", location: "Secret location" }];
      }
      export async function upsertFundo(input) {
        globalThis.${stateKey}.events.push("writer");
        return { ...input, id: "field-a", name: "${secret}" };
      }
    `],
    ["@/src/modules/potreros/server/potrero-repository", `
      export async function listArchivedPotreros() {
        globalThis.${stateKey}.events.push("loader");
        return [{ id: "paddock-secret", fieldId: "field-a", name: "${secret}" }];
      }
    `],
  ]);
  const virtualPrefix = "\0operational-api-response:";

  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "operational-api-response-mocks",
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

  [fundosRoute, archivedRoute] = await Promise.all([
    vite.ssrLoadModule("/app/api/fundos/route.ts"),
    vite.ssrLoadModule("/app/api/potreros/archivados/route.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  delete globalThis[stateKey];
});

test("every operational response barrier follows domain data work and uses method-specific authority", async (t) => {
  for (const expectation of routeExpectations) {
    await t.test(expectation.file, async () => {
      const source = await readFile(new URL(`../${expectation.file}`, import.meta.url), "utf8");
      for (const [method, methodExpectation] of Object.entries(expectation.methods)) {
        const block = methodBlock(source, method);
        const barriers = collectBarriers(block);
        assert.deepEqual(barriers.map(({ kind, capability }) => ({ kind, capability })), methodExpectation.barriers);
        assert.equal(
          countMatches(block, /if \(isAccessResponse\(currentAccess\)\) return currentAccess;/g),
          methodExpectation.guards,
          `${method} must fail closed after every response branch`,
        );
        assert.equal(
          countMatches(
            block,
            /if \(isAccessResponse\(currentAccess\)\) return currentAccess;\s*return (?:Response\.json|privateJson)/g,
          ),
          methodExpectation.guards,
          `${method} must serialize immediately after its final guard`,
        );

        const firstBarrier = barriers[0]?.index ?? -1;
        assert.ok(firstBarrier > 0, `${method} must contain a response barrier`);
        const domainAwaits = [...block.slice(0, firstBarrier).matchAll(/await\s+([A-Za-z][A-Za-z0-9]*)/g)]
          .map((match) => match[1])
          .filter((name) => !["authorizeApiAccess", "readJsonObject", "requireResourceField", "resolveResourceFieldId"].includes(name));
        assert.ok(domainAwaits.length > 0, `${method} must load or write domain data before reauthorizing`);
      }
    });
  }
});

test("multi-fundo GET denies suspension, withdrawal, and same-email replacement without leaking its snapshot", async (t) => {
  for (const scenario of responseScenarios("multi")) {
    await t.test(scenario.mode, async () => {
      const state = resetState(scenario.mode, "multi");
      const response = await fundosRoute.GET();
      const text = await response.text();

      assert.equal(response.status, scenario.status);
      assert.equal(text.includes(secret), scenario.allowed);
      assert.deepEqual(state.events, ["authorize", "loader", "authorize"]);
      assert.deepEqual(state.authorizationCalls, [
        { capability: "view", fieldId: undefined },
        { capability: "view", fieldId: undefined },
      ]);
    });
  }
});

test("field-specific GET rechecks the exact field and permits current scope expansion", async (t) => {
  for (const scenario of responseScenarios("field")) {
    await t.test(scenario.mode, async () => {
      const state = resetState(scenario.mode, "field");
      const response = await archivedRoute.GET(new Request("https://example.com/api/potreros/archivados?fundoId=field-a"));
      const text = await response.text();

      assert.equal(response.status, scenario.status);
      assert.equal(text.includes(secret), scenario.allowed);
      assert.deepEqual(state.events, ["authorize", "loader", "authorize"]);
      assert.deepEqual(state.authorizationCalls, [
        { capability: "view", fieldId: undefined },
        { capability: "view", fieldId: "field-a" },
      ]);
    });
  }
});

test("post-write response rechecks operate authority after the writer and leaks no saved record on revocation", async (t) => {
  for (const scenario of responseScenarios("field")) {
    await t.test(scenario.mode, async () => {
      const state = resetState(scenario.mode, "field");
      const response = await fundosRoute.POST(new Request("https://example.com/api/fundos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          areaHectares: 1,
          coordinates: [[0, 0], [1, 0], [0, 1]],
          id: "field-a",
          location: "Osorno",
          name: "Updated field",
          snapshotToken: "current",
        }),
      }));
      const text = await response.text();

      assert.equal(response.status, scenario.allowed ? 201 : scenario.status);
      assert.equal(text.includes(secret), scenario.allowed);
      assert.deepEqual(state.events, ["authorize", "writer", "authorize"]);
      assert.deepEqual(state.authorizationCalls, [
        { capability: "manage_members", fieldId: undefined },
        { capability: "operate", fieldId: "field-a" },
      ]);
    });
  }
});

function route(file, methodsByName) {
  return { file, methods: methodsByName };
}

function methods(barriers, guards = 1) {
  return { barriers, guards };
}

function field(capability) {
  return { kind: "field", capability };
}

function snapshot(capability) {
  return { kind: "snapshot", capability };
}

function standardCrud(writeKind = "field") {
  const writeBarrier = writeKind === "snapshot" ? snapshot : field;
  return {
    GET: methods([snapshot("view")]),
    POST: methods([writeBarrier("operate")]),
    DELETE: methods([writeBarrier("operate")]),
  };
}

function methodBlock(source, method) {
  const start = source.indexOf(`export async function ${method}`);
  assert.notEqual(start, -1, `missing ${method}`);
  const next = source.indexOf("export async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function collectBarriers(block) {
  const matches = [];
  const pattern = /reauthorizeApi(Snapshot)?Access\(access,\s*(?:\{\s*capability:\s*"(view|operate)"|"(view|operate)")/g;
  for (const match of block.matchAll(pattern)) {
    matches.push({
      capability: match[2] ?? match[3],
      index: match.index,
      kind: match[1] ? "snapshot" : "field",
    });
  }
  return matches;
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function responseScenarios(kind) {
  return [
    { allowed: true, mode: "active", status: 200 },
    { allowed: true, mode: "expanded", status: 200 },
    { allowed: false, mode: "suspended", status: 403 },
    { allowed: false, mode: "withdrawn", status: kind === "field" ? 403 : 409 },
    { allowed: false, mode: "same-email-replacement", status: 409 },
  ];
}

function resetState(mode, kind) {
  const currentAccess = mode === "same-email-replacement"
    ? accessContext("membership-replacement", ["field-a", "field-b"])
    : accessContext("membership-original", fieldIdsForMode(mode, kind));
  const state = {
    authorizationCalls: [],
    currentAccess,
    events: [],
    initialAccess,
    mode,
  };
  globalThis[stateKey] = state;
  return state;
}

function fieldIdsForMode(mode, kind) {
  if (mode === "expanded") return ["field-a", "field-b", "field-c"];
  if (mode === "withdrawn") return kind === "field" ? ["field-b"] : ["field-a"];
  return ["field-a", "field-b"];
}

function accessContext(membershipId, fieldIds) {
  return {
    displayName: "Operator",
    email: "operator@example.com",
    fieldIds,
    membershipId,
    organizationId: "org-a",
    role: "admin",
  };
}

function resolveVirtualSource(source, virtualModules) {
  if (virtualModules.has(source)) return source;
  const normalized = source.replaceAll("\\", "/").replace(/\?.*$/, "");
  for (const virtualSource of virtualModules.keys()) {
    if (!virtualSource.startsWith("@/")) continue;
    const suffix = virtualSource.slice(1);
    if (normalized.endsWith(suffix) || normalized.endsWith(`${suffix}.ts`) || normalized.endsWith(`${suffix}.mjs`)) {
      return virtualSource;
    }
  }
  return null;
}
