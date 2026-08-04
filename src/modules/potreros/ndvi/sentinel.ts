import type { Coordinate, PolygonRings } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { decodeStoredPolygon, MAX_POLYGON_RING_VERTICES } from "../utils/polygon-rings.ts";

export const CDSE_TOKEN_ENDPOINT = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
export const CDSE_STATISTICAL_ENDPOINT = "https://sh.dataspace.copernicus.eu/statistics/v1";
export const DEFAULT_MAX_CLOUD_COVERAGE = 20;
export const CDSE_TOKEN_EXPIRY_MARGIN_MS = 60_000;
export const MAX_CDSE_TOKEN_RESPONSE_BYTES = 64 * 1_024;
export const MAX_NDVI_REQUEST_BYTES = 1_024 * 1_024;
export const MAX_NDVI_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_NDVI_TOTAL_VERTICES = 20_000;
export const MAX_NDVI_HOLES = 100;
export const MAX_NDVI_INTERVALS = 60;
export const MAX_NDVI_RANGE_DAYS = 730;
export const MAX_CDSE_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

const MAX_CREDENTIAL_BYTES = 4 * 1_024;
const MAX_ACCESS_TOKEN_BYTES = 32 * 1_024;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1_000;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export const NDVI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "default", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ],
    mosaicking: "ORBIT"
  };
}

function isUsableScl(scl) {
  return scl !== 0 && scl !== 1 && scl !== 3 && scl !== 8 &&
    scl !== 9 && scl !== 10 && scl !== 11;
}

function evaluatePixel(samples) {
  var bestNdvi = -1;
  var hasUsableSample = false;

  for (var index = 0; index < samples.length; index += 1) {
    var sample = samples[index];
    if (sample.dataMask !== 1 || !isUsableScl(sample.SCL)) continue;

    var denominator = sample.B08 + sample.B04;
    if (denominator === 0) continue;

    var ndvi = (sample.B08 - sample.B04) / denominator;
    if (ndvi >= -1 && ndvi <= 1) {
      bestNdvi = Math.max(bestNdvi, ndvi);
      hasUsableSample = true;
    }
  }

  return hasUsableSample
    ? { default: [bestNdvi], dataMask: [1] }
    : { default: [0], dataMask: [0] };
}`;

export type CdseHttpRequest = Readonly<{
  url: string;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type CdseAccessToken = Readonly<{
  accessToken: string;
  tokenType: "Bearer";
  issuedAtMs: number;
  expiresAtMs: number;
  reuseUntilMs: number;
}>;

export type BuildNdviStatisticalRequestInput = Readonly<{
  rings: PolygonRings;
  from: string;
  to: string;
  maxCloudCoverage?: number;
}>;

export type NdviStatisticalSuccess = Readonly<{
  status: "ok";
  meanNdvi: number;
  cloudPct: number;
  cloudPctMethod: "no_data_fraction";
  cloudPctIsApproximate: true;
  observedAt: string;
  interval: Readonly<{ from: string; to: string }>;
  sampleCount: number;
  noDataCount: number;
  validSampleCount: number;
}>;

export type NdviStatisticalNoData = Readonly<{
  status: "no_data";
  reason: "no_intervals" | "no_valid_samples";
  observedAt: string | null;
  interval: Readonly<{ from: string; to: string }> | null;
  sampleCount: number;
  noDataCount: number;
  validSampleCount: 0;
}>;

export type NdviStatisticalResult = NdviStatisticalSuccess | NdviStatisticalNoData;

export class CdseNdviError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CdseNdviError";
    this.code = code;
  }
}

export function buildCdseTokenRequest(clientId: string, secret: string): CdseHttpRequest {
  assertCredential(clientId, "CDSE_CLIENT_ID_INVALID");
  assertCredential(secret, "CDSE_CLIENT_SECRET_INVALID");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: secret,
  }).toString();

  return {
    url: CDSE_TOKEN_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  };
}

export function parseCdseTokenResponse(rawJson: string, receivedAtMs: number): CdseAccessToken {
  assertEpochMillis(receivedAtMs, "CDSE_TOKEN_TIME_INVALID");
  const payload = parseBoundedJson(rawJson, MAX_CDSE_TOKEN_RESPONSE_BYTES, "CDSE_TOKEN_RESPONSE_INVALID");
  const response = requireRecord(payload, "CDSE_TOKEN_RESPONSE_INVALID");
  const accessToken = response.access_token;
  const expiresIn = response.expires_in;
  const tokenType = response.token_type;

  if (
    typeof accessToken !== "string"
    || accessToken.trim().length === 0
    || utf8ByteLength(accessToken) > MAX_ACCESS_TOKEN_BYTES
    || !Number.isInteger(expiresIn)
    || typeof expiresIn !== "number"
    || expiresIn <= 0
    || expiresIn > MAX_TOKEN_LIFETIME_SECONDS
    || (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"))
  ) {
    throw publicError("La respuesta de autenticacion CDSE no es valida.", "CDSE_TOKEN_RESPONSE_INVALID");
  }

  const expiresAtMs = receivedAtMs + expiresIn * 1_000;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw publicError("La respuesta de autenticacion CDSE no es valida.", "CDSE_TOKEN_RESPONSE_INVALID");
  }
  return {
    accessToken,
    tokenType: "Bearer",
    issuedAtMs: receivedAtMs,
    expiresAtMs,
    reuseUntilMs: Math.max(receivedAtMs, expiresAtMs - CDSE_TOKEN_EXPIRY_MARGIN_MS),
  };
}

export function isCdseTokenReusable(token: CdseAccessToken, nowMs: number): boolean {
  assertEpochMillis(nowMs, "CDSE_TOKEN_TIME_INVALID");
  return typeof token.accessToken === "string"
    && token.accessToken.length > 0
    && Number.isSafeInteger(token.reuseUntilMs)
    && Number.isSafeInteger(token.expiresAtMs)
    && token.reuseUntilMs >= token.issuedAtMs
    && token.reuseUntilMs <= token.expiresAtMs
    && nowMs < token.reuseUntilMs;
}

export function buildNdviStatisticalRequest(input: BuildNdviStatisticalRequestInput): CdseHttpRequest {
  const from = normalizeDateTime(input.from, "NDVI_DATE_RANGE_INVALID");
  const to = normalizeDateTime(input.to, "NDVI_DATE_RANGE_INVALID");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs || toMs - fromMs > MAX_NDVI_RANGE_DAYS * MILLIS_PER_DAY) {
    throw publicError("El rango de fechas NDVI no es valido.", "NDVI_DATE_RANGE_INVALID");
  }
  const maxCloudCoverage = input.maxCloudCoverage ?? DEFAULT_MAX_CLOUD_COVERAGE;
  if (!Number.isFinite(maxCloudCoverage) || maxCloudCoverage < 0 || maxCloudCoverage > 100) {
    throw publicError("La cobertura maxima de nubes debe estar entre 0 y 100.", "NDVI_CLOUD_COVERAGE_INVALID");
  }

  const rings = decodeNdviRings(input.rings);
  const payload = {
    input: {
      bounds: {
        geometry: {
          type: "Polygon",
          coordinates: [toGeoJsonRing(rings.outer), ...rings.holes.map(toGeoJsonRing)],
        },
        properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: { maxCloudCoverage },
      }],
    },
    aggregation: {
      timeRange: { from, to },
      aggregationInterval: { of: "P1M" },
      resx: 10,
      resy: 10,
      evalscript: NDVI_EVALSCRIPT,
    },
    calculations: { default: {} },
  };
  const body = JSON.stringify(payload);
  if (utf8ByteLength(body) > MAX_NDVI_REQUEST_BYTES) {
    throw publicError("La solicitud NDVI supera el tamano permitido.", "NDVI_REQUEST_TOO_LARGE");
  }
  return {
    url: CDSE_STATISTICAL_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
}

export function parseNdviStatisticalResponse(rawJson: string): NdviStatisticalResult {
  const payload = parseBoundedJson(rawJson, MAX_NDVI_RESPONSE_BYTES, "NDVI_RESPONSE_INVALID");
  const response = requireRecord(payload, "NDVI_RESPONSE_INVALID");
  if (!Array.isArray(response.data) || response.data.length > MAX_NDVI_INTERVALS) {
    throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
  }
  if (response.data.length === 0) {
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

  const intervals = response.data.map(parseStatisticalInterval);
  intervals.sort((first, second) => second.toMs - first.toMs || second.fromMs - first.fromMs);
  const latestUseful = intervals.find((interval) => interval.validSampleCount > 0);
  if (latestUseful) {
    if (latestUseful.meanNdvi === null) {
      throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
    }
    return {
      status: "ok",
      meanNdvi: latestUseful.meanNdvi,
      cloudPct: roundPct((latestUseful.noDataCount / latestUseful.sampleCount) * 100),
      cloudPctMethod: "no_data_fraction",
      cloudPctIsApproximate: true,
      observedAt: latestUseful.from,
      interval: { from: latestUseful.from, to: latestUseful.to },
      sampleCount: latestUseful.sampleCount,
      noDataCount: latestUseful.noDataCount,
      validSampleCount: latestUseful.validSampleCount,
    };
  }

  const latest = intervals[0];
  return {
    status: "no_data",
    reason: "no_valid_samples",
    observedAt: latest.from,
    interval: { from: latest.from, to: latest.to },
    sampleCount: latest.sampleCount,
    noDataCount: latest.noDataCount,
    validSampleCount: 0,
  };
}

export function parseCdseRetryAfterMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const milliseconds = Number(trimmed);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_CDSE_RETRY_AFTER_MS
    ? milliseconds
    : null;
}

type ParsedStatisticalInterval = {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  meanNdvi: number | null;
  sampleCount: number;
  noDataCount: number;
  validSampleCount: number;
};

function parseStatisticalInterval(value: unknown): ParsedStatisticalInterval {
  const entry = requireRecord(value, "NDVI_RESPONSE_INVALID");
  const interval = requireRecord(entry.interval, "NDVI_RESPONSE_INVALID");
  if (typeof interval.from !== "string" || typeof interval.to !== "string") {
    throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
  }
  const from = normalizeDateTime(interval.from, "NDVI_RESPONSE_INVALID");
  const to = normalizeDateTime(interval.to, "NDVI_RESPONSE_INVALID");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs) {
    throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
  }

  const outputs = requireRecord(entry.outputs, "NDVI_RESPONSE_INVALID");
  const defaultOutput = requireRecord(outputs.default, "NDVI_RESPONSE_INVALID");
  const bands = requireRecord(defaultOutput.bands, "NDVI_RESPONSE_INVALID");
  const firstBand = requireRecord(bands.B0, "NDVI_RESPONSE_INVALID");
  const stats = requireRecord(firstBand.stats, "NDVI_RESPONSE_INVALID");
  const sampleCount = parseSampleCount(stats.sampleCount);
  const noDataCount = parseSampleCount(stats.noDataCount);
  if (noDataCount > sampleCount) {
    throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
  }
  const validSampleCount = sampleCount - noDataCount;
  const meanNdvi = stats.mean === null || stats.mean === undefined ? null : stats.mean;
  if (
    (meanNdvi !== null && (typeof meanNdvi !== "number" || !Number.isFinite(meanNdvi) || meanNdvi < -1 || meanNdvi > 1))
    || (validSampleCount > 0 && meanNdvi === null)
  ) {
    throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
  }

  return { from, to, fromMs, toMs, meanNdvi, sampleCount, noDataCount, validSampleCount };
}

function parseSampleCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw publicError("La respuesta estadistica CDSE no es valida.", "NDVI_RESPONSE_INVALID");
  }
  return value;
}

function decodeNdviRings(value: PolygonRings): PolygonRings {
  let rings: PolygonRings;
  try {
    rings = decodeStoredPolygon(value);
  } catch {
    throw publicError("La geometria del potrero no es valida.", "NDVI_GEOMETRY_INVALID");
  }
  if (rings.holes.length > MAX_NDVI_HOLES) {
    throw publicError("La geometria del potrero supera el limite permitido.", "NDVI_GEOMETRY_TOO_LARGE");
  }
  const totalVertices = rings.outer.length + rings.holes.reduce((sum, ring) => sum + ring.length, 0);
  if (totalVertices > MAX_NDVI_TOTAL_VERTICES || [rings.outer, ...rings.holes].some((ring) => ring.length > MAX_POLYGON_RING_VERTICES)) {
    throw publicError("La geometria del potrero supera el limite permitido.", "NDVI_GEOMETRY_TOO_LARGE");
  }
  if (![rings.outer, ...rings.holes].every((ring) => ring.every(isWgs84Coordinate))) {
    throw publicError("La geometria del potrero contiene coordenadas fuera de WGS84.", "NDVI_COORDINATE_RANGE_INVALID");
  }
  return rings;
}

function toGeoJsonRing(ring: Coordinate[]): [number, number][] {
  const coordinates = ring.map(([latitude, longitude]): [number, number] => [longitude, latitude]);
  coordinates.push([...coordinates[0]]);
  return coordinates;
}

function isWgs84Coordinate([latitude, longitude]: Coordinate): boolean {
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function assertCredential(value: string, code: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || utf8ByteLength(value) > MAX_CREDENTIAL_BYTES) {
    throw publicError("Las credenciales CDSE no son validas.", code);
  }
}

function assertEpochMillis(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw publicError("La marca de tiempo CDSE no es valida.", code);
  }
}

function normalizeDateTime(value: string, code: string): string {
  if (typeof value !== "string") throw publicError("La fecha CDSE no es valida.", code);
  const dateOnlyMatch = DATE_ONLY_PATTERN.exec(value);
  const dateTimeMatch = RFC3339_PATTERN.exec(value);
  const match = dateOnlyMatch ?? dateTimeMatch;
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw publicError("La fecha CDSE no es valida.", code);
  }
  const normalized = dateOnlyMatch ? `${value}T00:00:00Z` : value;
  if (!Number.isFinite(Date.parse(normalized))) throw publicError("La fecha CDSE no es valida.", code);
  return normalized;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseBoundedJson(rawJson: string, maxBytes: number, code: string): unknown {
  if (typeof rawJson !== "string" || utf8ByteLength(rawJson) > maxBytes) {
    throw publicError("La respuesta CDSE supera el limite permitido.", code);
  }
  try {
    return JSON.parse(rawJson) as unknown;
  } catch {
    throw publicError("La respuesta CDSE no contiene JSON valido.", code);
  }
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw publicError("La respuesta CDSE no tiene el formato esperado.", code);
  }
  return value as Record<string, unknown>;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function roundPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

function publicError(message: string, code: string): CdseNdviError {
  return new CdseNdviError(message, code);
}
