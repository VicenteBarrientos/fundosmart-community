import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { NDVI_SUCCESS_RESPONSE, OSORNO_NDVI_RINGS } from "./fixtures/paddock-ndvi-sentinel.mjs";

const root = process.cwd();
const fixedNow = Date.parse("2026-07-20T12:00:00.000Z");
const scope = { organizationId: "org-a", fieldIds: ["field-a"], email: "operator@example.com" };
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");
let vite;
let service;
let cdse;

before(async () => {
  const virtualWorkers = "\0fundosmart-phase44-service-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-phase44-service-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = {}";
      },
    }],
  });
  [service, cdse] = await Promise.all([
    vite.ssrLoadModule("/src/modules/potreros/ndvi/paddock-ndvi-service.ts"),
    vite.ssrLoadModule("/src/modules/potreros/ndvi/cdse-client.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

test("uses the deterministic latest complete month and a weekly cache without any fetch", async () => {
  const candidate = makeCandidate({ cache: makeCache({ computedAt: "2026-07-16T12:00:00.000Z" }) });
  let clients = 0;
  const result = await service.refreshPaddockNdvi("field-a", scope, { clientId: "id", clientSecret: "secret" }, {
    now: () => fixedNow,
    listCandidates: async (_fieldId, _scope, month) => {
      assert.equal(month, "2026-06-01");
      return [candidate];
    },
    createClient: () => {
      clients += 1;
      throw new Error("network must not be initialized for a cache hit");
    },
  });
  assert.deepEqual(result.interval, {
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(result.values[0].state, "cached");
  assert.equal(clients, 0);
});

test("listing keeps latest value objective and exposes the bounded history without turning no_data into zero", async () => {
  const latest = makeCache();
  const noData = { ...makeCache(), id: "cache-no-data", month: "2026-05-01", status: "no_data", meanNdvi: null, noDataReason: "no_intervals" };
  const candidate = makeCandidate({ cache: latest });
  candidate.history = [latest, noData];
  const listing = await service.listPaddockNdvi("field-a", scope, {
    now: () => fixedNow,
    listCandidates: async (_fieldId, _scope, month) => {
      assert.equal(month, undefined);
      return [candidate];
    },
  });
  assert.equal(listing.values[0].value, latest);
  assert.deepEqual(listing.values[0].history, [latest, noData]);
  assert.equal(listing.values[0].history[1].meanNdvi, null);
});

test("geometry changes invalidate cache and success/no_data/unavailable remain explicit in a partial batch", async () => {
  const success = makeCandidate({ id: "success", token: "snapshot-success", cache: makeCache({ paddockId: "success", token: "old" }) });
  const noData = makeCandidate({ id: "no-data", token: "snapshot-no-data" });
  const unavailable = makeCandidate({ id: "unavailable", token: "snapshot-unavailable", cache: makeCache({ paddockId: "unavailable", token: "old" }) });
  const committed = [];
  const result = await service.refreshPaddockNdvi("field-a", scope, { clientId: "id", clientSecret: "secret" }, {
    now: () => fixedNow,
    createId: () => `operation-${committed.length}`,
    listCandidates: async () => [success, noData, unavailable],
    createClient: () => ({
      async fetchNdvi({ rings }) {
        const marker = rings.outer[0][0];
        if (marker === 3) throw new cdse.CdseServiceError("No disponible.", "CDSE_RATE_LIMITED", 2_500);
        if (marker === 2) return noDataResult();
        return okResult();
      },
    }),
    commitValue: async (input) => {
      committed.push(input);
      return storedValue(input);
    },
  });
  assert.deepEqual(result.values.map(({ state }) => state), ["refreshed", "no_data", "unavailable"]);
  assert.equal(result.values[2].value, unavailable.cache);
  assert.equal(result.values[2].retryAfterMs, 2_500);
  assert.equal(result.retryAfterMs, 2_500);
  assert.equal(result.summary.noData, 1);
  assert.equal(committed.length, 2);
  assert.equal(committed[0].candidate.paddockId, "success");
  assert.equal(committed[1].candidate.paddockId, "no-data");
});

test("missing secrets returns existing cache as unavailable and bounded batches skip overflow", async () => {
  const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate({
    id: `paddock-${index}`,
    token: `snapshot-${index}`,
    cache: index === 0 ? makeCache({ paddockId: `paddock-${index}`, token: "old" }) : null,
  }));
  let clientCreated = false;
  const result = await service.refreshPaddockNdvi("field-a", scope, {}, {
    now: () => fixedNow,
    listCandidates: async () => candidates,
    createClient: () => {
      clientCreated = true;
      throw new Error("must not create a CDSE client without secrets");
    },
  });
  assert.equal(clientCreated, false);
  assert.equal(result.values[0].state, "unavailable");
  assert.equal(result.values[0].value, candidates[0].cache);
  assert.equal(result.values[0].error.code, "CDSE_NOT_CONFIGURED");
  assert.equal(result.summary.unavailable, 8);
  assert.equal(result.summary.skipped, 2);
  assert.equal(result.hasMore, true);
  assert.doesNotMatch(JSON.stringify(result), /client_secret|secret/u);
});

test("repeated bounded POST batches prioritize pending paddocks and eventually cover the whole field", async () => {
  const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate({
    id: `progress-${String(index).padStart(2, "0")}`,
    token: `progress-snapshot-${index}`,
  }));
  let fetches = 0;
  const dependencies = {
    now: () => fixedNow,
    listCandidates: async () => candidates,
    createClient: () => ({ fetchNdvi: async () => { fetches += 1; return okResult(); } }),
    commitValue: async (input) => {
      const value = storedValue(input);
      input.candidate.cache = value;
      return value;
    },
  };
  const first = await service.refreshPaddockNdvi("field-a", scope, { clientId: "id", clientSecret: "secret" }, dependencies);
  assert.equal(first.summary.refreshed, 8);
  assert.equal(first.summary.skipped, 2);
  assert.equal(first.hasMore, true);
  const second = await service.refreshPaddockNdvi("field-a", scope, { clientId: "id", clientSecret: "secret" }, dependencies);
  assert.equal(second.summary.cached, 8);
  assert.equal(second.summary.refreshed, 2);
  assert.equal(second.summary.skipped, 0);
  assert.equal(second.hasMore, false);
  assert.equal(fetches, 10);
});

test("post-fetch scope races are returned as stale and never attributed as a confirmed value", async () => {
  const candidate = makeCandidate({ cache: makeCache({ token: "old" }) });
  const raced = await service.refreshPaddockNdvi("field-a", scope, { clientId: "id", clientSecret: "secret" }, {
    now: () => fixedNow,
    listCandidates: async () => [candidate],
    createClient: () => ({ fetchNdvi: async () => okResult() }),
    commitValue: async () => { throw Object.assign(new Error("race"), { code: "FIELD_SCOPE_CONFLICT" }); },
  });
  assert.equal(raced.values[0].state, "stale");
  assert.equal(raced.values[0].value, candidate.cache);
  assert.equal(raced.values[0].error.code, "PADDOCK_CHANGED");
});

test("OAuth token is single-flight/reused and Authorization is sent only to statistics", async () => {
  cdse.clearCdseTokenCacheForTests();
  let tokenCalls = 0;
  let statsCalls = 0;
  const requests = [];
  const client = cdse.createCdseNdviClient({
    clientId: "client-id",
    clientSecret: "never-echo-this-secret",
    now: () => fixedNow,
    fetch: async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
      if (String(url).includes("identity")) {
        tokenCalls += 1;
        await Promise.resolve();
        return jsonResponse({ access_token: "token-value", expires_in: 3_600, token_type: "Bearer" });
      }
      statsCalls += 1;
      return new Response(NDVI_SUCCESS_RESPONSE, { headers: { "Content-Type": "application/json" } });
    },
  });
  const request = { rings: OSORNO_NDVI_RINGS, from: "2026-06-01", to: "2026-07-01" };
  await Promise.all([client.fetchNdvi(request), client.fetchNdvi(request)]);
  await client.fetchNdvi(request);
  assert.equal(tokenCalls, 1);
  assert.equal(statsCalls, 3);
  assert.equal(requests[0].headers.has("Authorization"), false);
  assert.equal(requests.slice(1).every(({ headers }) => headers.get("Authorization") === "Bearer token-value"), true);
});

test("429, timeout, malformed and oversized responses are public, bounded and never leak secrets", async () => {
  const secret = "unique-secret-never-public";
  for (const scenario of ["rate", "malformed", "oversize", "timeout"]) {
    cdse.clearCdseTokenCacheForTests();
    let calls = 0;
    const client = cdse.createCdseNdviClient({
      clientId: "client-id",
      clientSecret: secret,
      timeoutMs: 1,
      now: () => fixedNow,
      fetch: async (_url, init) => {
        calls += 1;
        if (scenario === "timeout" && calls === 1) {
          return await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
        }
        if (calls === 1) return jsonResponse({ access_token: "token", expires_in: 3_600 });
        if (scenario === "rate") return new Response(null, { status: 429, headers: { "Retry-After": "1750" } });
        if (scenario === "malformed") return new Response("{", { headers: { "Content-Type": "application/json" } });
        return new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "1048577" } });
      },
    });
    let failure;
    try {
      await client.fetchNdvi({ rings: OSORNO_NDVI_RINGS, from: "2026-06-01", to: "2026-07-01" });
      assert.fail(`expected ${scenario} failure`);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure instanceof cdse.CdseServiceError, true);
    if (scenario === "rate") assert.equal(failure.retryAfterMs, 1_750);
    if (scenario === "timeout") assert.equal(failure.code, "CDSE_TIMEOUT");
    assert.doesNotMatch(`${failure.message}\n${failure.stack}`, new RegExp(secret, "u"));
  }
});

test("route/client are private, typed, role-separated and never log bodies, forms or tokens", async () => {
  const [route, client, external, accessRules, envTypes] = await Promise.all([
    source("app/api/potreros/ndvi/route.ts"),
    source("src/modules/potreros/api/paddock-ndvi-client.ts"),
    source("src/modules/potreros/ndvi/cdse-client.ts"),
    import("../src/modules/access/domain/access-rules.mjs"),
    source("cloudflare-env.d.ts"),
  ]);
  assert.match(route, /authorizeApiAccess\("view"\)/u);
  assert.match(route, /authorizeApiAccess\("operate"\)/u);
  assert.match(route, /requireContextField\(access, fieldId\)/u);
  assert.match(route, /private, no-store/u);
  assert.match(client, /cache:\s*"no-store"/u);
  assert.match(client, /method:\s*"POST"/u);
  assert.doesNotMatch(external, /console\./u);
  assert.equal(accessRules.roleHasCapability("viewer", "view"), true);
  assert.equal(accessRules.roleHasCapability("viewer", "operate"), false);
  assert.match(envTypes, /CDSE_CLIENT_ID\?: string/u);
  assert.match(envTypes, /CDSE_CLIENT_SECRET\?: string/u);
});

function makeCandidate({ id = "paddock-a", token = "snapshot-current", cache = null } = {}) {
  const marker = id === "no-data" ? 2 : id === "unavailable" ? 3 : 1;
  return {
    paddockId: id,
    paddockName: id,
    rings: { outer: [[marker, -73], [marker + 0.01, -73], [marker, -72.99]], holes: [] },
    snapshot: { id, fieldId: "field-a", coordinates: OSORNO_NDVI_RINGS },
    geometrySnapshotToken: token,
    cache,
    history: cache ? [cache] : [],
  };
}

function makeCache({ paddockId = "paddock-a", token = "snapshot-current", computedAt = "2026-07-01T00:00:00.000Z" } = {}) {
  return {
    id: `cache-${paddockId}`,
    organizationId: "org-a",
    fieldId: "field-a",
    paddockId,
    month: "2026-06-01",
    status: "ok",
    meanNdvi: 0.5,
    noDataReason: null,
    cloudPct: 10,
    cloudPctIsApproximate: true,
    interval: { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" },
    observedAt: "2026-06-01T00:00:00.000Z",
    sampleCount: 100,
    noDataCount: 10,
    validSampleCount: 90,
    computedAt,
    geometrySnapshotToken: token,
  };
}

function okResult() {
  return {
    status: "ok",
    meanNdvi: 0.61,
    cloudPct: 20,
    cloudPctIsApproximate: true,
    observedAt: "2026-06-01T00:00:00.000Z",
    interval: { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" },
    sampleCount: 100,
    noDataCount: 20,
    validSampleCount: 80,
  };
}

function noDataResult() {
  return {
    status: "no_data",
    reason: "no_intervals",
    observedAt: null,
    interval: null,
    sampleCount: 0,
    noDataCount: 0,
    validSampleCount: 0,
  };
}

function storedValue(input) {
  const value = input.result.status === "ok" ? {
    status: "ok",
    meanNdvi: input.result.meanNdvi,
    noDataReason: null,
    cloudPct: input.result.cloudPct,
    cloudPctIsApproximate: true,
    observedAt: input.result.observedAt,
  } : {
    status: "no_data",
    meanNdvi: null,
    noDataReason: input.result.reason,
    cloudPct: null,
    cloudPctIsApproximate: false,
    observedAt: input.result.observedAt,
  };
  return {
    id: `cache-${input.candidate.paddockId}`,
    organizationId: input.scope.organizationId,
    fieldId: input.candidate.snapshot.fieldId,
    paddockId: input.candidate.paddockId,
    month: input.interval.from.slice(0, 10),
    ...value,
    interval: input.interval,
    sampleCount: input.result.sampleCount,
    noDataCount: input.result.noDataCount,
    validSampleCount: input.result.validSampleCount,
    computedAt: input.computedAt,
    geometrySnapshotToken: input.candidate.geometrySnapshotToken,
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
