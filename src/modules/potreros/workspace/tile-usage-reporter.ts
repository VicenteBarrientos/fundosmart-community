import {
  MAX_TILE_USAGE_REPORT_TILES,
  isValidTileUsageReport,
} from "../../../core/maps/tile-policy.mjs";
import type { BasemapId, BasemapSurface } from "./map-preferences";

export const TILE_USAGE_REPORT_ENDPOINT = "/api/mapas/teselas/consumo";
export const TILE_USAGE_BATCH_SIZE = 64;
export const TILE_USAGE_FLUSH_INTERVAL_MS = 15_000;

export type TileUsageContext = Readonly<{
  basemapId: BasemapId;
  surface: BasemapSurface;
  degraded: boolean;
}>;

export type TileUsageReport = Readonly<TileUsageContext & {
  tileCount: number;
  sessionSeq: number;
}>;

export type TileUsageReporter = Readonly<{
  setContext: (context: TileUsageContext) => Promise<boolean>;
  recordTile: () => void;
  flush: () => Promise<boolean>;
  dispose: () => Promise<boolean>;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type TileUsageReporterOptions = Readonly<{
  send?: (report: TileUsageReport) => Promise<boolean>;
  batchSize?: number;
  flushIntervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}>;

export function createTileUsageReporter(
  options: TileUsageReporterOptions = {},
): TileUsageReporter {
  const send = options.send ?? sendTileUsageReport;
  const batchSize = positiveInteger(options.batchSize, TILE_USAGE_BATCH_SIZE);
  const flushIntervalMs = positiveInteger(
    options.flushIntervalMs,
    TILE_USAGE_FLUSH_INTERVAL_MS,
  );
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer));

  let context: TileUsageContext | null = null;
  let pendingTileCount = 0;
  let sessionSeq = 0;
  let timer: TimerHandle | null = null;
  let disposed = false;
  let sendQueue = Promise.resolve(false);

  function clearFlushTimer() {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function scheduleFlush() {
    if (timer !== null || disposed) return;
    timer = schedule(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  }

  function flush(): Promise<boolean> {
    clearFlushTimer();
    if (!context || pendingTileCount === 0) return sendQueue;

    const report: TileUsageReport = Object.freeze({
      basemapId: context.basemapId,
      surface: context.surface,
      tileCount: pendingTileCount,
      degraded: context.degraded,
      sessionSeq: ++sessionSeq,
    });
    pendingTileCount = 0;

    if (!isValidTileUsageReport(report)) return sendQueue;
    sendQueue = sendQueue
      .catch(() => false)
      .then(() => send(report))
      .catch(() => false);
    return sendQueue;
  }

  async function setContext(nextContext: TileUsageContext): Promise<boolean> {
    if (
      context?.basemapId === nextContext.basemapId
      && context.surface === nextContext.surface
      && context.degraded === nextContext.degraded
    ) {
      return false;
    }
    const flushed = flush();
    context = Object.freeze({ ...nextContext });
    return flushed;
  }

  function recordTile() {
    if (disposed || !context) return;
    pendingTileCount += 1;
    if (pendingTileCount >= Math.min(batchSize, MAX_TILE_USAGE_REPORT_TILES)) {
      void flush();
      return;
    }
    scheduleFlush();
  }

  async function dispose(): Promise<boolean> {
    if (disposed) return sendQueue;
    const flushed = flush();
    disposed = true;
    clearFlushTimer();
    return flushed;
  }

  return Object.freeze({
    setContext,
    recordTile,
    flush,
    dispose,
  });
}

export async function sendTileUsageReport(
  report: TileUsageReport,
  fetchImplementation: typeof fetch = fetch,
): Promise<boolean> {
  if (!isValidTileUsageReport(report)) return false;
  try {
    const response = await fetchImplementation(TILE_USAGE_REPORT_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
