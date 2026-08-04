import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCdseTokenRequest,
  buildNdviStatisticalRequest,
  CDSE_STATISTICAL_ENDPOINT,
  CDSE_TOKEN_ENDPOINT,
  CDSE_TOKEN_EXPIRY_MARGIN_MS,
  isCdseTokenReusable,
  MAX_CDSE_RETRY_AFTER_MS,
  MAX_NDVI_RESPONSE_BYTES,
  NDVI_EVALSCRIPT,
  parseCdseRetryAfterMs,
  parseCdseTokenResponse,
  parseNdviStatisticalResponse,
} from "../src/modules/potreros/ndvi/sentinel.ts";
import {
  NDVI_NO_DATA_RESPONSE,
  NDVI_SUCCESS_RESPONSE,
  OSORNO_NDVI_RINGS,
  statisticalInterval,
} from "./fixtures/paddock-ndvi-sentinel.mjs";

test("construye el payload Statistical API exacto en WGS84, conserva huecos y no muta los anillos", () => {
  const rings = structuredClone(OSORNO_NDVI_RINGS);
  const before = structuredClone(rings);
  const request = buildNdviStatisticalRequest({
    rings,
    from: "2026-05-01",
    to: "2026-08-01T00:00:00Z",
  });
  const payload = JSON.parse(request.body);

  assert.equal(request.url, CDSE_STATISTICAL_ENDPOINT);
  assert.equal(request.method, "POST");
  assert.deepEqual(request.headers, { "Content-Type": "application/json" });
  assert.deepEqual(rings, before);
  assert.deepEqual(payload.input.bounds, {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-73.148, -40.579],
          [-73.132, -40.579],
          [-73.132, -40.565],
          [-73.148, -40.565],
          [-73.148, -40.579],
        ],
        [
          [-73.143, -40.574],
          [-73.139, -40.574],
          [-73.139, -40.57],
          [-73.143, -40.57],
          [-73.143, -40.574],
        ],
      ],
    },
    properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
  });
  assert.deepEqual(payload.input.data, [{
    type: "sentinel-2-l2a",
    dataFilter: { maxCloudCoverage: 20 },
  }]);
  assert.deepEqual(payload.aggregation, {
    timeRange: { from: "2026-05-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
    aggregationInterval: { of: "P1M" },
    resx: 10,
    resy: 10,
    evalscript: NDVI_EVALSCRIPT,
  });
  assert.deepEqual(payload.calculations, { default: {} });
});

test("el evalscript v3 usa B04/B08, ORBIT y enmascara no-data, sombra, nube, cirrus y nieve", () => {
  assert.match(NDVI_EVALSCRIPT, /^\/\/VERSION=3/u);
  for (const band of ["B04", "B08", "SCL", "dataMask"]) assert.match(NDVI_EVALSCRIPT, new RegExp(`"${band}"`, "u"));
  assert.match(NDVI_EVALSCRIPT, /mosaicking:\s*"ORBIT"/u);
  for (const scl of [0, 1, 3, 8, 9, 10, 11]) assert.match(NDVI_EVALSCRIPT, new RegExp(`scl !== ${scl}\\b`, "u"));
  assert.match(NDVI_EVALSCRIPT, /sample\.dataMask !== 1/u);
  assert.match(NDVI_EVALSCRIPT, /dataMask:\s*\[0\]/u);
  assert.match(NDVI_EVALSCRIPT, /\(sample\.B08 - sample\.B04\) \/ denominator/u);
});

test("arma OAuth client_credentials, valida el token y aplica margen antes del vencimiento", () => {
  const secret = "secreto +& con Unicode Nandu";
  const request = buildCdseTokenRequest("cliente-cdse", secret);
  const parameters = new URLSearchParams(request.body);
  assert.equal(request.url, CDSE_TOKEN_ENDPOINT);
  assert.equal(request.method, "POST");
  assert.deepEqual(request.headers, { "Content-Type": "application/x-www-form-urlencoded" });
  assert.equal(parameters.get("grant_type"), "client_credentials");
  assert.equal(parameters.get("client_id"), "cliente-cdse");
  assert.equal(parameters.get("client_secret"), secret);

  const issuedAtMs = Date.parse("2026-07-20T12:00:00Z");
  const token = parseCdseTokenResponse(JSON.stringify({
    access_token: "access-token-value",
    expires_in: 3_600,
    token_type: "bearer",
  }), issuedAtMs);
  assert.equal(token.expiresAtMs, issuedAtMs + 3_600_000);
  assert.equal(token.reuseUntilMs, token.expiresAtMs - CDSE_TOKEN_EXPIRY_MARGIN_MS);
  assert.equal(isCdseTokenReusable(token, token.reuseUntilMs - 1), true);
  assert.equal(isCdseTokenReusable(token, token.reuseUntilMs), false);
});

test("los errores de autenticacion son publicos y nunca incorporan el secreto o token rechazado", () => {
  const secret = "no-filtrar-este-secreto-unico";
  assert.throws(
    () => buildCdseTokenRequest("cliente", " "),
    (error) => error.code === "CDSE_CLIENT_SECRET_INVALID" && !error.message.includes(secret),
  );
  try {
    parseCdseTokenResponse(JSON.stringify({ access_token: secret, expires_in: 0 }), 1_000);
    assert.fail("se esperaba rechazo del token");
  } catch (error) {
    assert.equal(error.code, "CDSE_TOKEN_RESPONSE_INVALID");
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    assert.doesNotMatch(error.stack ?? "", new RegExp(secret, "u"));
  }
});

test("elige el intervalo mensual util mas reciente y deriva cobertura aproximada desde noDataCount", () => {
  const result = parseNdviStatisticalResponse(NDVI_SUCCESS_RESPONSE);
  assert.deepEqual(result, {
    status: "ok",
    meanNdvi: 0.64,
    cloudPct: 25,
    cloudPctMethod: "no_data_fraction",
    cloudPctIsApproximate: true,
    observedAt: "2026-06-01T00:00:00Z",
    interval: {
      from: "2026-06-01T00:00:00Z",
      to: "2026-07-01T00:00:00Z",
    },
    sampleCount: 100,
    noDataCount: 25,
    validSampleCount: 75,
  });
});

test("no-data es discriminado y nunca inventa meanNdvi cero", () => {
  const withIntervals = parseNdviStatisticalResponse(NDVI_NO_DATA_RESPONSE);
  const empty = parseNdviStatisticalResponse(JSON.stringify({ data: [] }));

  assert.deepEqual(withIntervals, {
    status: "no_data",
    reason: "no_valid_samples",
    observedAt: "2026-08-01T00:00:00Z",
    interval: {
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
    },
    sampleCount: 120,
    noDataCount: 120,
    validSampleCount: 0,
  });
  assert.equal("meanNdvi" in withIntervals, false);
  assert.deepEqual(empty, {
    status: "no_data",
    reason: "no_intervals",
    observedAt: null,
    interval: null,
    sampleCount: 0,
    noDataCount: 0,
    validSampleCount: 0,
  });
  assert.equal("meanNdvi" in empty, false);
});

test("rechaza fechas, coordenadas, anillos, conteos y NDVI fuera de rango", () => {
  const validRequest = { rings: OSORNO_NDVI_RINGS, from: "2026-05-01", to: "2026-08-01" };
  assert.throws(() => buildNdviStatisticalRequest({ ...validRequest, from: "2026-02-30" }), /fecha|rango/iu);
  assert.throws(() => buildNdviStatisticalRequest({ ...validRequest, from: "2026-09-01" }), /rango/iu);
  assert.throws(() => buildNdviStatisticalRequest({ ...validRequest, maxCloudCoverage: 101 }), /nubes/iu);
  assert.throws(() => buildNdviStatisticalRequest({
    ...validRequest,
    rings: { outer: [[-91, -73], [-90, -72], [-89, -73]], holes: [] },
  }), /WGS84/iu);

  const oversizedRing = Array.from({ length: 2_001 }, (_, index) => {
    const angle = (index / 2_001) * Math.PI * 2;
    return [-40 + Math.sin(angle), -73 + Math.cos(angle)];
  });
  assert.throws(() => buildNdviStatisticalRequest({
    ...validRequest,
    rings: { outer: oversizedRing, holes: [] },
  }), /geometria|limite/iu);

  const invalidResponses = [
    "not-json",
    JSON.stringify({ data: {} }),
    JSON.stringify({ data: [statisticalInterval("2026-06-01", "2026-07-01", {
      mean: 1.01, sampleCount: 10, noDataCount: 0,
    })] }),
    JSON.stringify({ data: [statisticalInterval("2026-06-01", "2026-07-01", {
      mean: 0.5, sampleCount: 10, noDataCount: 11,
    })] }),
    JSON.stringify({ data: [statisticalInterval("2026-06-01", "2026-07-01", {
      mean: null, sampleCount: 10, noDataCount: 0,
    })] }),
  ];
  invalidResponses.forEach((response) => assert.throws(() => parseNdviStatisticalResponse(response)));
  assert.throws(() => parseNdviStatisticalResponse(`{"data":[],"padding":"${"x".repeat(MAX_NDVI_RESPONSE_BYTES)}"}`));
});

test("Retry-After de CDSE se interpreta como milisegundos y rechaza otros formatos", () => {
  assert.equal(parseCdseRetryAfterMs("1500"), 1_500);
  assert.equal(parseCdseRetryAfterMs(" 0 "), 0);
  assert.equal(parseCdseRetryAfterMs(String(MAX_CDSE_RETRY_AFTER_MS)), MAX_CDSE_RETRY_AFTER_MS);
  for (const value of [null, undefined, "1.5", "-1", "Wed, 21 Oct 2015 07:28:00 GMT", "", "999999999999999999"]) {
    assert.equal(parseCdseRetryAfterMs(value), null);
  }
});

test("el nucleo permanece puro, DOM/Node/network-free y no registra credenciales", async () => {
  const source = await readFile(new URL("../src/modules/potreros/ndvi/sentinel.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/u);
  assert.doesNotMatch(source, /\b(?:window|document|navigator|XMLHttpRequest|localStorage)\b/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\bconsole\s*\./u);
  assert.doesNotMatch(source, /\b(?:Request|Response)\s*\(/u);
});
