"use client";

import { AlertCircle, AlertTriangle, Check, GitMerge, LoaderCircle, ScissorsLineDashed, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Field } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import type { Coordinate, Fundo } from "../types";
import { calculateHectares } from "../utils/geometry";

type BulkSubdivisionDialogProps = {
  fundo: Fundo;
  polygons: Coordinate[][];
  operation?: "split" | "merge" | "redesign";
  sourcePaddockNames?: string[];
  warnings?: string[];
  blockers?: string[];
  lotMoves?: LotMovePreview[];
  existingPotreroCount: number;
  existingActivityCount: number;
  assignedLotCount: number;
  onClose: () => void;
  onConfirm: (prefix: string, sector: string) => Promise<void>;
};

export type LotMovePreview = {
  lotId: string;
  lotName?: string | null;
  destinationPaddockId: string | null;
  destinationPaddockName?: string | null;
  overlapRatio: number;
  warning?: string | null;
};

export function BulkSubdivisionDialog({
  fundo,
  polygons,
  operation = "redesign",
  sourcePaddockNames = [],
  warnings = [],
  blockers = [],
  lotMoves = [],
  existingPotreroCount,
  existingActivityCount,
  assignedLotCount,
  onClose,
  onConfirm,
}: BulkSubdivisionDialogProps) {
  const [prefix, setPrefix] = useState(operation === "merge" ? "Potrero fusionado" : "Potrero");
  const [sector, setSector] = useState(fundo.location || fundo.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);
  const areas = polygons.map(calculateHectares);
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  const operationLabel = operation === "split" ? "Subdivisión de potrero" : operation === "merge" ? "Fusión de potreros" : "Rediseño del fundo";
  const actionLabel = operation === "merge" ? "Fusionar potreros" : operation === "split" ? "Crear potreros hijos" : "Confirmar rediseño";
  const archivedDescription = operation === "split"
    ? `Se archivará «${sourcePaddockNames[0] ?? "el potrero original"}» y se crearán ${polygons.length} potreros hijos.`
    : operation === "merge"
      ? `Se archivarán ${sourcePaddockNames.length} potreros y se creará un potrero fusionado.`
      : `Se archivarán ${existingPotreroCount} potreros vigentes y se crearán ${polygons.length} nuevos.`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prefix.trim() || !sector.trim()) {
      setError("Completa el prefijo y el sector.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onConfirm(prefix.trim(), sector.trim());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible crear los potreros.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2300] grid place-items-center bg-chrome/70 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="bulk-subdivision-title" aria-modal="true" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-band text-accent"><ScissorsLineDashed size={18} /></span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">{operationLabel}</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="bulk-subdivision-title">{actionLabel}</h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-9 place-items-center rounded-xl bg-surface-alt text-ink-muted" disabled={saving} onClick={onClose} type="button"><X size={17} /></button>
        </div>

        <form onSubmit={submit}>
          <div className="space-y-5 px-5 py-5 sm:px-6">
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <AlertTriangle className="mt-0.5 shrink-0 text-amber-700" size={19} />
              <div>
                <p className="text-sm font-black text-amber-950">{archivedDescription}</p>
                <p className="mt-1 text-xs leading-5 text-amber-900/75">
                  {existingActivityCount > 0
                    ? `Los ${existingActivityCount} manejos asociados se conservarán y seguirán consultables mediante el historial heredado.`
                    : "No se eliminará ningún manejo. Los potreros anteriores quedarán disponibles en Archivados."}
                </p>
                {lotMoves.length === 0 && assignedLotCount > 0 && (
                  <p className="mt-1 text-xs leading-5 text-amber-900/75">
                    {assignedLotCount === 1
                      ? "Además, 1 lote ganadero quedará sin potrero asignado."
                      : `Además, ${assignedLotCount} lotes ganaderos quedarán sin potrero asignado.`}
                  </p>
                )}
              </div>
            </div>

            {blockers.length > 0 && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4" role="alert">
                <p className="flex items-center gap-2 text-xs font-black text-red-900"><AlertCircle size={16} /> La operación está bloqueada</p>
                <ul className="mt-2 space-y-1 text-[12px] font-semibold leading-5 text-red-800">
                  {blockers.map((blocker) => <li key={blocker}>• {blocker}</li>)}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-xs font-black text-amber-950">Advertencias de la previsualización</p>
                <ul className="mt-2 space-y-1 text-[12px] font-semibold leading-5 text-amber-900/80">
                  {warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                </ul>
              </div>
            )}

            {lotMoves.length > 0 && (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-muted">Destino de lotes ganaderos</p>
                  <GitMerge className="text-accent" size={16} />
                </div>
                <div className="mt-3 divide-y divide-line-steel overflow-hidden rounded-2xl border border-line-steel">
                  {lotMoves.map((move) => (
                    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={move.lotId}>
                      <div>
                        <p className="text-xs font-black text-ink">{move.lotName ?? move.lotId}</p>
                        <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
                          {move.destinationPaddockId ? `Destino: ${move.destinationPaddockName ?? move.destinationPaddockId}` : "Sin destino automático"}
                        </p>
                        {move.warning && <p className="mt-1 text-[12px] font-bold text-amber-800">{move.warning}</p>}
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[12px] font-black ${move.destinationPaddockId ? "bg-band text-accent" : "bg-amber-100 text-amber-900"}`}>
                        {(move.overlapRatio * 100).toLocaleString("es-CL", { maximumFractionDigits: 1 })}% confianza
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Prefijo de los nombres">
                <input className="input-base" onChange={(event) => setPrefix(event.target.value)} value={prefix} />
              </Field>
              <Field label="Sector">
                <input className="input-base" onChange={(event) => setSector(event.target.value)} value={sector} />
              </Field>
            </div>

            {operation === "merge" && (
              <p className="rounded-xl bg-surface-alt px-3 py-2 text-[12px] font-semibold leading-4 text-ink-muted">
                El nuevo potrero conserva el sector propuesto y calcula los valores de suelo como promedio ponderado por superficie de los potreros de origen.
              </p>
            )}

            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-muted">Vista previa</p>
                <p className="text-xs font-black text-ink">{totalArea.toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha</p>
              </div>
              <div className="mt-3 max-h-56 divide-y divide-line-steel overflow-y-auto rounded-2xl border border-line-steel">
                {areas.map((area, index) => (
                  <div className="flex items-center justify-between gap-3 px-4 py-3" key={index}>
                    <span className="text-xs font-black text-ink">{prefix.trim() || "Potrero"}{operation === "merge" ? "" : ` ${index + 1}`}</span>
                    <span className="text-[12px] font-bold text-ink-subtle">{area.toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha</span>
                  </div>
                ))}
              </div>
            </div>

            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}
          </div>

          <div className="flex justify-end gap-3 border-t border-line-steel p-4 sm:px-6">
            <button className="h-11 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted" disabled={saving} onClick={onClose} type="button">Seguir editando</button>
            <button className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:opacity-60" disabled={saving || blockers.length > 0} type="submit">
              {saving ? <><LoaderCircle className="animate-spin" size={15} /> Aplicando operación</> : <><Check size={15} /> {actionLabel}</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
