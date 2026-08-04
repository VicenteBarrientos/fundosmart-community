import type { PolygonRings } from "../types";
import {
  buildCdseTokenRequest,
  buildNdviStatisticalRequest,
  isCdseTokenReusable,
  MAX_CDSE_TOKEN_RESPONSE_BYTES,
  MAX_NDVI_RESPONSE_BYTES,
  parseCdseRetryAfterMs,
  parseCdseTokenResponse,
  parseNdviStatisticalResponse,
  type CdseAccessToken,
  type CdseHttpRequest,
  type NdviStatisticalResult,
} from "./sentinel";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CdseNdviClientOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}>;

export type CdseNdviRequest = Readonly<{
  rings: PolygonRings;
  from: string;
  to: string;
  maxCloudCoverage?: number;
}>;

export class CdseServiceError extends Error {
  constructor(
    message: string,
    public readonly code: "CDSE_UNAVAILABLE" | "CDSE_RATE_LIMITED" | "CDSE_TIMEOUT" | "CDSE_RESPONSE_INVALID",
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "CdseServiceError";
  }
}

let cachedToken: CdseAccessToken | null = null;
let cachedCredentials: Readonly<{ clientId: string; clientSecret: string }> | null = null;
let tokenInFlight: Promise<CdseAccessToken> | null = null;

export function createCdseNdviClient(options: CdseNdviClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const credentials = normalizeCredentials(options.clientId, options.clientSecret);

  return Object.freeze({
    async fetchNdvi(request: CdseNdviRequest): Promise<NdviStatisticalResult> {
      const token = await accessToken(credentials, { fetchImpl, now, timeoutMs });
      const statisticalRequest = buildNdviStatisticalRequest(request);
      const response = await fetchWithTimeout(fetchImpl, statisticalRequest, timeoutMs, {
        Authorization: `${token.tokenType} ${token.accessToken}`,
      });
      if (response.status === 429) throw rateLimited(response);
      if (!response.ok) throw unavailable();
      assertJsonResponse(response);
      const body = await readBoundedBody(response, MAX_NDVI_RESPONSE_BYTES);
      try {
        return parseNdviStatisticalResponse(body);
      } catch {
        throw invalidResponse();
      }
    },
  });
}

export function clearCdseTokenCacheForTests(): void {
  cachedToken = null;
  cachedCredentials = null;
  tokenInFlight = null;
}

async function accessToken(
  credentials: Readonly<{ clientId: string; clientSecret: string }>,
  dependencies: Readonly<{ fetchImpl: FetchLike; now: () => number; timeoutMs: number }>,
): Promise<CdseAccessToken> {
  if (!sameCredentials(cachedCredentials, credentials)) {
    cachedToken = null;
    cachedCredentials = credentials;
    tokenInFlight = null;
  }
  const currentTime = dependencies.now();
  if (cachedToken && isCdseTokenReusable(cachedToken, currentTime)) return cachedToken;
  if (!tokenInFlight) {
    const inFlight = requestToken(credentials, dependencies).then((token) => {
      if (sameCredentials(cachedCredentials, credentials)) cachedToken = token;
      return token;
    }).finally(() => {
      if (tokenInFlight === inFlight) tokenInFlight = null;
    });
    tokenInFlight = inFlight;
  }
  return tokenInFlight;
}

async function requestToken(
  credentials: Readonly<{ clientId: string; clientSecret: string }>,
  dependencies: Readonly<{ fetchImpl: FetchLike; now: () => number; timeoutMs: number }>,
): Promise<CdseAccessToken> {
  const tokenRequest = buildCdseTokenRequest(credentials.clientId, credentials.clientSecret);
  const response = await fetchWithTimeout(dependencies.fetchImpl, tokenRequest, dependencies.timeoutMs);
  if (response.status === 429) throw rateLimited(response);
  if (!response.ok) throw unavailable();
  assertJsonResponse(response);
  const body = await readBoundedBody(response, MAX_CDSE_TOKEN_RESPONSE_BYTES);
  try {
    return parseCdseTokenResponse(body, dependencies.now());
  } catch {
    throw invalidResponse();
  }
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  request: CdseHttpRequest,
  timeoutMs: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  try {
    return await fetchImpl(request.url, {
      method: request.method,
      headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      throw new CdseServiceError("El servicio satelital no respondió a tiempo.", "CDSE_TIMEOUT");
    }
    throw unavailable();
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > limit) throw invalidResponse();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw invalidResponse();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (cause) {
    if (cause instanceof CdseServiceError) throw cause;
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      throw new CdseServiceError("El servicio satelital no respondió a tiempo.", "CDSE_TIMEOUT");
    }
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
}

function assertJsonResponse(response: Response): void {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) throw invalidResponse();
}

function normalizeCredentials(clientId: string, clientSecret: string) {
  const normalized = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  if (!normalized.clientId || !normalized.clientSecret) throw unavailable();
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  const candidate = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(candidate) || candidate <= 0 || candidate > MAX_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return Math.trunc(candidate);
}

function sameCredentials(
  first: Readonly<{ clientId: string; clientSecret: string }> | null,
  second: Readonly<{ clientId: string; clientSecret: string }>,
): boolean {
  return first?.clientId === second.clientId && first.clientSecret === second.clientSecret;
}

function rateLimited(response: Response): CdseServiceError {
  return new CdseServiceError(
    "El servicio satelital limitó temporalmente las solicitudes.",
    "CDSE_RATE_LIMITED",
    parseCdseRetryAfterMs(response.headers.get("Retry-After")),
  );
}

function unavailable(): CdseServiceError {
  return new CdseServiceError("El servicio satelital no está disponible temporalmente.", "CDSE_UNAVAILABLE");
}

function invalidResponse(): CdseServiceError {
  return new CdseServiceError("El servicio satelital devolvió una respuesta inválida.", "CDSE_RESPONSE_INVALID");
}
