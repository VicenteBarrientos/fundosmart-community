import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import type {
  PaddockNdviListing,
  PaddockNdviListingItem,
  PaddockNdviRefresh,
  PaddockNdviRefreshItem,
} from "../domain/paddock-ndvi";
import {
  PADDOCK_NDVI_CACHE_MAX_AGE_MS,
  PADDOCK_NDVI_FETCH_CONCURRENCY,
  PADDOCK_NDVI_REFRESH_MAX_PADDOCKS,
} from "../domain/paddock-ndvi";
import {
  commitPaddockNdviValue,
  listPaddockNdviCandidates,
  type PaddockNdviCandidate,
} from "../server/paddock-ndvi-repository";
import { CdseServiceError, createCdseNdviClient } from "./cdse-client";

type NdviScope = OrganizationFieldScope & Partial<Pick<AccessContext, "email">>;
type CdseClient = ReturnType<typeof createCdseNdviClient>;

export type PaddockNdviServiceDependencies = Readonly<{
  now?: () => number;
  createId?: () => string;
  createClient?: typeof createCdseNdviClient;
  listCandidates?: typeof listPaddockNdviCandidates;
  commitValue?: typeof commitPaddockNdviValue;
}>;

export async function listPaddockNdvi(
  fieldId: string,
  scope: NdviScope,
  dependencies: PaddockNdviServiceDependencies = {},
): Promise<PaddockNdviListing> {
  const nowMs = (dependencies.now ?? Date.now)();
  const candidates = await (dependencies.listCandidates ?? listPaddockNdviCandidates)(fieldId, scope);
  return {
    fieldId: fieldId.trim(),
    values: candidates.map((candidate) => listingItem(candidate, nowMs)),
  };
}

export async function refreshPaddockNdvi(
  fieldId: string,
  scope: NdviScope,
  credentials: Readonly<{ clientId?: string; clientSecret?: string }>,
  dependencies: PaddockNdviServiceDependencies = {},
): Promise<PaddockNdviRefresh> {
  const now = dependencies.now ?? Date.now;
  const nowMs = now();
  const interval = previousCompleteMonth(nowMs);
  const month = interval.from.slice(0, 10);
  const listCandidates = dependencies.listCandidates ?? listPaddockNdviCandidates;
  const candidates = await listCandidates(fieldId, scope, month);
  // Fresh entries never consume the quota. Repeating POST therefore advances
  // deterministically through every missing/stale/geometry-changed paddock.
  const fresh = candidates.filter((candidate) => !needsRefresh(candidate, nowMs));
  const pending = candidates.filter((candidate) => needsRefresh(candidate, nowMs));
  const scheduled = pending.slice(0, PADDOCK_NDVI_REFRESH_MAX_PADDOCKS);
  const overflow = pending.slice(PADDOCK_NDVI_REFRESH_MAX_PADDOCKS).map((candidate): PaddockNdviRefreshItem => ({
    paddockId: candidate.paddockId,
    paddockName: candidate.paddockName,
    state: "skipped",
    stale: needsRefresh(candidate, nowMs),
    value: candidate.cache,
    error: { code: "PADDOCK_LIMIT_REACHED", message: "El lote supera el máximo de potreros por actualización." },
    retryAfterMs: null,
  }));
  const cached = fresh.map((candidate): PaddockNdviRefreshItem => ({
    paddockId: candidate.paddockId,
    paddockName: candidate.paddockName,
    state: "cached",
    stale: false,
    value: candidate.cache,
    error: null,
    retryAfterMs: null,
  }));

  let refreshed: PaddockNdviRefreshItem[];
  const clientId = credentials.clientId?.trim() ?? "";
  const clientSecret = credentials.clientSecret?.trim() ?? "";
  if (scheduled.length === 0) {
    refreshed = [];
  } else if (!clientId || !clientSecret) {
    refreshed = scheduled.map((candidate) => unavailableItem(
      candidate,
      "CDSE_NOT_CONFIGURED",
      "La actualización satelital no está configurada.",
    ));
  } else {
    const client = (dependencies.createClient ?? createCdseNdviClient)({ clientId, clientSecret, now });
    refreshed = await mapWithConcurrency(scheduled, PADDOCK_NDVI_FETCH_CONCURRENCY, (candidate) =>
      refreshCandidate(candidate, interval, scope, client, now, dependencies));
  }
  const byId = new Map([...cached, ...refreshed, ...overflow].map((item) => [item.paddockId, item]));
  const values = candidates.map((candidate) => byId.get(candidate.paddockId) as PaddockNdviRefreshItem);
  return {
    fieldId: fieldId.trim(),
    interval,
    values,
    summary: summarize(values),
    hasMore: overflow.length > 0,
    retryAfterMs: maximumRetryAfter(values),
  };
}

export function previousCompleteMonth(nowMs: number): Readonly<{ from: string; to: string }> {
  if (!Number.isFinite(nowMs)) throw new RangeError("La fecha de referencia NDVI no es válida.");
  const reference = new Date(nowMs);
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    to: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

async function refreshCandidate(
  candidate: PaddockNdviCandidate,
  interval: Readonly<{ from: string; to: string }>,
  scope: NdviScope,
  client: CdseClient,
  now: () => number,
  dependencies: PaddockNdviServiceDependencies,
): Promise<PaddockNdviRefreshItem> {
  try {
    const result = await client.fetchNdvi({ rings: candidate.rings, ...interval });
    const computedAt = new Date(now()).toISOString();
    const value = await (dependencies.commitValue ?? commitPaddockNdviValue)({
      scope,
      candidate,
      interval,
      result,
      computedAt,
      auditId: `audit-paddock-ndvi-${(dependencies.createId ?? (() => crypto.randomUUID()))()}`,
    });
    return {
      paddockId: candidate.paddockId,
      paddockName: candidate.paddockName,
      state: value.status === "no_data" ? "no_data" : "refreshed",
      stale: false,
      value,
      error: null,
      retryAfterMs: null,
    };
  } catch (cause) {
    if (cause instanceof CdseServiceError) {
      return unavailableItem(candidate, cause.code, cause.message, cause.retryAfterMs);
    }
    if (isPaddockRace(cause)) {
      return {
        paddockId: candidate.paddockId,
        paddockName: candidate.paddockName,
        state: "stale",
        stale: true,
        value: candidate.cache,
        error: { code: "PADDOCK_CHANGED", message: "El potrero cambió durante la consulta satelital." },
        retryAfterMs: null,
      };
    }
    return {
      paddockId: candidate.paddockId,
      paddockName: candidate.paddockName,
      state: "error",
      stale: true,
      value: candidate.cache,
      error: { code: "NDVI_REFRESH_FAILED", message: "No fue posible actualizar este potrero." },
      retryAfterMs: null,
    };
  }
}

function listingItem(candidate: PaddockNdviCandidate, nowMs: number): PaddockNdviListingItem {
  const state = !candidate.cache
    ? "missing"
    : candidate.cache.geometrySnapshotToken !== candidate.geometrySnapshotToken
      ? "geometry_changed"
      : isCacheStale(candidate.cache.computedAt, nowMs)
        ? "stale"
        : "current";
  return {
    paddockId: candidate.paddockId,
    paddockName: candidate.paddockName,
    cacheState: state,
    value: candidate.cache,
    history: candidate.history ?? (candidate.cache ? [candidate.cache] : []),
  };
}

function needsRefresh(candidate: PaddockNdviCandidate, nowMs: number): boolean {
  return !candidate.cache
    || candidate.cache.geometrySnapshotToken !== candidate.geometrySnapshotToken
    || isCacheStale(candidate.cache.computedAt, nowMs);
}

function isCacheStale(computedAt: string, nowMs: number): boolean {
  const computedAtMs = Date.parse(computedAt);
  return !Number.isFinite(computedAtMs) || nowMs - computedAtMs > PADDOCK_NDVI_CACHE_MAX_AGE_MS;
}

function unavailableItem(
  candidate: PaddockNdviCandidate,
  code: string,
  message: string,
  retryAfterMs: number | null = null,
): PaddockNdviRefreshItem {
  return {
    paddockId: candidate.paddockId,
    paddockName: candidate.paddockName,
    state: "unavailable",
    stale: true,
    value: candidate.cache,
    error: { code, message },
    retryAfterMs,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(values: readonly PaddockNdviRefreshItem[]) {
  return {
    total: values.length,
    cached: values.filter(({ state }) => state === "cached").length,
    refreshed: values.filter(({ state }) => state === "refreshed").length,
    noData: values.filter(({ value }) => value?.status === "no_data").length,
    stale: values.filter(({ stale }) => stale).length,
    unavailable: values.filter(({ state }) => state === "unavailable").length,
    errors: values.filter(({ state }) => state === "error").length,
    skipped: values.filter(({ state }) => state === "skipped").length,
  };
}

function maximumRetryAfter(values: readonly PaddockNdviRefreshItem[]): number | null {
  const delays = values.flatMap(({ retryAfterMs }) => retryAfterMs === null ? [] : [retryAfterMs]);
  return delays.length > 0 ? Math.max(...delays) : null;
}

function isPaddockRace(cause: unknown): boolean {
  return Boolean(cause && typeof cause === "object" && "code" in cause
    && (cause as { code?: unknown }).code === "FIELD_SCOPE_CONFLICT");
}
