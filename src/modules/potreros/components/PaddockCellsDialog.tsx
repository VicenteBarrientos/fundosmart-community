"use client";

import { AlertTriangle, CloudOff, LoaderCircle, MapPinned, RotateCcw, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PaddockCellGenerationPlanRequest, PaddockCellGenerationPreview, PaddockCellListing } from "../domain/cells-rotation";
import type { Potrero } from "../types";
import { paddockGeometry } from "../utils/paddock-metrics";

type PaddockCellsDialogProps = {
  bearingDegrees: number | null;
  busy: boolean;
  canMutate: boolean;
  error: string | null;
  listing: PaddockCellListing | null;
  networkOnline: boolean;
  onBearingChange: (bearing: number | null) => void;
  onClose: () => void;
  onCloseActive: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onPreview: (request: PaddockCellGenerationPlanRequest) => Promise<void>;
  potrero: Potrero;
  preview: PaddockCellGenerationPreview | null;
};

export function PaddockCellsDialog({
  bearingDegrees,
  busy,
  canMutate,
  error,
  listing,
  networkOnline,
  onBearingChange,
  onClose,
  onCloseActive,
  onConfirm,
  onPreview,
  potrero,
  preview,
}: PaddockCellsDialogProps) {
  const [count, setCount] = useState("4");
  const stripCount = Number(count);
  const blockedByHoles = paddockGeometry(potrero).holes.length > 0;
  const validCount = Number.isInteger(stripCount) && stripCount >= 2 && stripCount <= 200;
  const canOperate = canMutate && networkOnline && !blockedByHoles;

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate || !validCount || bearingDegrees === null) return;
    await onPreview({ fieldId: potrero.fieldId, paddockId: potrero.id, count: stripCount, bearingDegrees });
  }

  async function closeActive() {
    if (!listing?.active.length || !canOperate) return;
    if (!window.confirm(`¿Cerrar las ${listing.active.length} franjas activas de ${potrero.name}? Quedarán visibles en el historial.`)) return;
    await onCloseActive();
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[1000] flex items-start justify-end p-3 sm:p-4" role="presentation">
      <section aria-labelledby="paddock-cells-title" className="pointer-events-auto max-h-[calc(100vh-1.5rem)] w-full max-w-xl overflow-y-auto rounded-[22px] border border-line-steel bg-white p-5 shadow-2xl sm:max-h-[calc(100vh-2rem)]" role="dialog">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Pastoreo temporal</p>
            <h2 className="mt-1 text-xl font-black" id="paddock-cells-title">Crear franjas · {potrero.name}</h2>
          </div>
          <button aria-label="Cerrar franjas" className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-surface-alt" onClick={onClose} type="button"><X size={18} /></button>
        </div>

        {!networkOnline && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-900" role="status">
            <CloudOff className="shrink-0" size={17} /> Sin conexión: puedes revisar la última copia guardada, pero crear o cerrar franjas requiere conexión.
          </div>
        )}
        {!canMutate && <p className="mt-4 rounded-xl bg-surface-alt p-3 text-xs font-bold text-ink-muted">Vista de solo lectura: las franjas y su historial no se pueden modificar.</p>}
        {blockedByHoles && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-800" role="alert">
            <AlertTriangle className="shrink-0" size={17} /> El backend bloquea explícitamente las franjas V1 en potreros con exclusiones interiores. Elimina o rediseña esas exclusiones antes de continuar.
          </div>
        )}

        <form className="mt-5 grid gap-4 rounded-2xl border border-line-steel bg-surface-alt p-4 sm:grid-cols-2" onSubmit={prepare}>
          <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
            Cantidad (2–200)
            <input className="input-base min-h-11" inputMode="numeric" max="200" min="2" onChange={(event) => setCount(event.target.value)} required type="number" value={count} />
          </label>
          <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
            Orientación {bearingDegrees === null ? "sin definir" : `${Math.round(bearingDegrees)}°`}
            <input aria-label="Orientación de las franjas" className="min-h-11 accent-accent" disabled={!canOperate} max="359" min="0" onChange={(event) => onBearingChange(Number(event.target.value))} step="1" type="range" value={bearingDegrees ?? 0} />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button className="flex min-h-11 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink-muted disabled:opacity-40" disabled={!canOperate} onClick={() => onBearingChange(null)} type="button"><RotateCcw size={15} /> Limpiar flecha</button>
            {bearingDegrees === null && <button className="min-h-11 rounded-xl border border-line-steel bg-white px-3 text-xs font-black" disabled={!canOperate} onClick={() => onBearingChange(90)} type="button">Restablecer a 90°</button>}
            <button className="flex min-h-11 items-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white disabled:opacity-40" disabled={!canOperate || !validCount || bearingDegrees === null || busy} type="submit">
              {busy ? <LoaderCircle className="animate-spin" size={15} /> : <MapPinned size={15} />} Previsualizar en mapa
            </button>
          </div>
          {!validCount && <p className="text-xs font-bold text-red-700 sm:col-span-2">Ingresa un entero entre 2 y 200.</p>}
          <p className="text-[12px] font-semibold text-ink-subtle sm:col-span-2">También puedes arrastrar la punta naranja de la flecha directamente sobre el mapa.</p>
        </form>

        {preview && (
          <div className="mt-4 rounded-2xl border border-orange-200 bg-orange-50 p-4">
            <p className="text-xs font-black text-orange-950">Previsualización lista: {preview.count} franjas</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] font-bold text-orange-900 sm:grid-cols-4">
              <span>Ancho: {preview.stripWidthMeters.toLocaleString("es-CL", { maximumFractionDigits: 1 })} m</span>
              <span>Suma: {preview.cellsAreaSquareMeters.toLocaleString("es-CL", { maximumFractionDigits: 1 })} m²</span>
              <span>Delta: {preview.areaDeltaSquareMeters.toLocaleString("es-CL", { maximumFractionDigits: 3 })} m²</span>
              <span>Tolerancia: {preview.areaToleranceSquareMeters.toLocaleString("es-CL", { maximumFractionDigits: 3 })} m²</span>
            </div>
            <button className="mt-3 min-h-11 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-40" disabled={!canOperate || busy} onClick={() => { void onConfirm(); }} type="button">Confirmar y activar franjas</button>
          </div>
        )}

        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-xs font-bold text-red-700" role="alert">{error}</p>}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <section className="rounded-2xl border border-line-steel p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-black">Activas</h3>
              <span className="rounded-full bg-orange-100 px-2 py-1 text-[12px] font-black text-orange-800">{listing?.active.length ?? 0}</span>
            </div>
            <CellList cells={listing?.active ?? []} empty="No hay franjas activas." />
            {(listing?.active.length ?? 0) > 0 && canMutate && (
              <button className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-200 text-xs font-black text-red-700 disabled:opacity-40" disabled={!canOperate || busy} onClick={() => { void closeActive(); }} type="button"><Trash2 size={15} /> Cerrar franjas activas</button>
            )}
          </section>
          <section className="rounded-2xl border border-line-steel p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-black">Historial cerrado</h3>
              <span className="rounded-full bg-surface-alt px-2 py-1 text-[12px] font-black text-ink-muted">{listing?.history.length ?? 0}</span>
            </div>
            <CellList cells={listing?.history ?? []} empty="Aún no hay cierres registrados." />
          </section>
        </div>
      </section>
    </div>
  );
}

function CellList({ cells, empty }: { cells: PaddockCellListing["active"]; empty: string }) {
  if (cells.length === 0) return <p className="mt-3 text-xs font-semibold text-ink-subtle">{empty}</p>;
  return (
    <ul className="mt-3 max-h-44 space-y-2 overflow-y-auto">
      {cells.map((cell) => (
        <li className="rounded-xl bg-surface-alt px-3 py-2 text-[12px]" key={cell.id}>
          <p className="font-black text-ink">{cell.name}</p>
          <p className="mt-0.5 font-semibold text-ink-subtle">{(cell.areaSquareMeters / 10_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha · {cell.activeTo ? `cerrada ${formatDate(cell.activeTo)}` : `activa desde ${formatDate(cell.activeFrom)}`}</p>
        </li>
      ))}
    </ul>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("es-CL") : value;
}
