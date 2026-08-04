"use client";

import { CloudOff, Leaf, LoaderCircle, RefreshCw, Satellite } from "lucide-react";
import { HelpTip } from "@/src/ui/Hint";
import { HELP } from "@/src/ui/help-copy";
import type { PaddockNdviListing } from "../domain/paddock-ndvi";

export type PaddockNdviLoadState = "idle" | "loading" | "loaded" | "stale" | "offline" | "error";

type PaddockNdviPanelProps = {
  listing: PaddockNdviListing | null;
  loadState: PaddockNdviLoadState;
  canRefresh: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
};

export function PaddockNdviPanel({ listing, loadState, canRefresh, refreshing, error, onRefresh }: PaddockNdviPanelProps) {
  const items = listing?.values ?? [];
  const withValue = items.filter(({ value }) => value?.status === "ok" && value.meanNdvi !== null);
  const noData = items.filter(({ value }) => value?.status === "no_data").length;
  // Mismo criterio que needsRefresh del servicio: un potrero sin caché también está pendiente.
  const pendingRefresh = items.filter(({ cacheState }) => cacheState !== "current").length;

  return (
    <section aria-labelledby="ndvi-overview-title" className="mt-5 rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_38px_rgba(35,50,42,0.05)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-band text-accent"><Satellite size={19} /></span>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Observación satelital mensual</p>
            <h2 className="mt-1 flex items-center gap-1.5 text-lg font-black tracking-[-0.035em]" id="ndvi-overview-title">
              NDVI de potreros
              <HelpTip help="ndvi" label="el NDVI" />
            </h2>
            <p className="mt-1 text-[12px] font-semibold text-ink-subtle">
              {withValue.length} con valor · <span data-hint={HELP.ndviSinDatos}>{noData} sin datos</span> ·{" "}
              <span data-hint={HELP.ndviPendientes}>{pendingRefresh} por actualizar</span>
            </p>
          </div>
        </div>
        <button
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[12px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
          data-hint={canRefresh ? HELP.ndviActualizar : "Requiere conexión y rol de operador."}
          disabled={!canRefresh || refreshing}
          onClick={() => { void onRefresh(); }}
          type="button"
        >
          {refreshing ? <LoaderCircle className="animate-spin" size={15} /> : <RefreshCw size={15} />} {refreshing ? "Actualizando…" : "Actualizar NDVI"}
        </button>
      </div>

      {(loadState === "offline" || loadState === "stale") && listing && <p className="mt-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-900" role="status"><CloudOff size={14} /> Se conserva el último NDVI local y su historial; no se interpreta un mes ausente como cero.</p>}
      {error && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-bold text-amber-900" role="status">{error}</p>}

      <div aria-label="Valores NDVI por potrero" className="mt-4 grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-4" tabIndex={items.length > 8 ? 0 : undefined}>
        {items.map((item) => (
          <article className="rounded-2xl border border-line-steel bg-surface-alt p-3" key={item.paddockId}>
            <div className="flex items-center justify-between gap-2"><p className="truncate text-[12px] font-black text-ink">{item.paddockName}</p><Leaf className="shrink-0 text-accent" size={14} /></div>
            {item.value?.status === "ok" && item.value.meanNdvi !== null ? (
              <>
                <p className="mt-2 text-lg font-black text-accent">{item.value.meanNdvi.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                <p className="mt-1 text-[12px] font-bold text-ink-subtle">{formatMonth(item.value.month)}{item.value.cloudPct === null ? "" : ` · nubosidad${item.value.cloudPctIsApproximate ? " aprox." : ""} ${item.value.cloudPct.toLocaleString("es-CL", { maximumFractionDigits: 0 })}%`}</p>
              </>
            ) : item.value?.status === "no_data" ? (
              <><p className="mt-2 text-sm font-black text-ink-muted">Sin datos</p><p className="mt-1 text-[12px] font-bold text-ink-subtle">{formatMonth(item.value.month)} · no equivale a 0</p></>
            ) : <p className="mt-2 text-[12px] font-bold text-ink-subtle">Sin observación conocida</p>}
          </article>
        ))}
        {loadState === "loading" && <p className="col-span-full flex items-center justify-center gap-2 py-4 text-[12px] font-bold text-ink-subtle"><LoaderCircle className="animate-spin" size={14} /> Cargando NDVI…</p>}
      </div>
    </section>
  );
}

function formatMonth(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("es-CL", { month: "short", year: "numeric", timeZone: "UTC" }) : value;
}
