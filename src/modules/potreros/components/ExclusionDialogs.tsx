"use client";

import { AlertTriangle, Check, Droplets, LoaderCircle, MapPinned, Trees, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { SortableDataSelect, SortableGridHeader } from "@/src/ui/SortableGridHeader";
import {
  nextSortState,
  stableSortData,
  type SortColumn,
  type SortState,
} from "@/src/ui/sortable-data";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import type { ExclusionKind } from "../types";
import {
  EXCLUSION_KIND_LABELS,
  type ExclusionPreview,
  type ExclusionScope,
} from "../utils/exclusions";
import { formatHectares } from "../utils/paddock-metrics";

type ExclusionSetupDialogProps = {
  networkOnline: boolean;
  scope: ExclusionScope;
  onClose: () => void;
  onStart: (kind: ExclusionKind) => void;
};

export function ExclusionSetupDialog({ networkOnline, scope, onClose, onStart }: ExclusionSetupDialogProps) {
  const [kind, setKind] = useState<ExclusionKind>("laguna");
  const target = scope.kind === "field" ? scope.fieldName : scope.paddockName;

  return (
    <DialogFrame labelledBy="exclusion-setup-title" onClose={onClose}>
      <header className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-sky-50 text-sky-700"><MapPinned size={20} /></span>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Superficie no pastoreable</p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.035em]" id="exclusion-setup-title">Dibujar exclusión</h2>
            <p className="mt-1 text-xs text-ink-muted">Objetivo: {target}</p>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <div className="space-y-5 p-5 sm:p-6">
        <p className="text-xs leading-5 text-ink-muted">
          Elige el tipo y marca al menos tres puntos en el mapa. Antes de guardar verás todos los potreros afectados y el cambio de superficie útil.
        </p>
        <fieldset>
          <legend className="mb-2 text-[12px] font-black uppercase tracking-[0.12em] text-ink-muted">Tipo de exclusión</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.entries(EXCLUSION_KIND_LABELS) as [ExclusionKind, string][]).map(([value, label]) => (
              <label className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-xs font-black transition ${kind === value ? "border-accent bg-band text-ink" : "border-line-steel text-ink-muted hover:bg-surface-alt"}`} key={value}>
                <input
                  checked={kind === value}
                  className="size-4 accent-accent"
                  name="exclusion-kind"
                  onChange={() => setKind(value)}
                  type="radio"
                  value={value}
                />
                {value === "laguna" || value === "humedal" ? <Droplets size={16} /> : <Trees size={16} />}
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {!networkOnline && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-900" role="alert">
            <AlertTriangle className="mt-0.5 shrink-0" size={16} />
            Sin conexión: las exclusiones no se aplican ni se encolan. Recupera internet para comenzar.
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-3 border-t border-line-steel p-4 sm:px-6">
        <button className="min-h-11 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted" onClick={onClose} type="button">Cancelar</button>
        <button className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={!networkOnline} onClick={() => onStart(kind)} type="button">
          <MapPinned size={16} /> Comenzar dibujo
        </button>
      </footer>
    </DialogFrame>
  );
}

type ExclusionPreviewDialogProps = {
  error: string | null;
  preview: ExclusionPreview;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

type ExclusionRow = ExclusionPreview["affected"][number];
type ExclusionSortColumn = "grossArea" | "name" | "nextNetArea" | "previousNetArea";

const EXCLUSION_SORT_COLUMNS: Record<ExclusionSortColumn, SortColumn<ExclusionRow>> = {
  name: { kind: "text", value: (item) => item.paddockName },
  grossArea: { kind: "number", value: (item) => item.grossAreaHectares },
  previousNetArea: { kind: "number", value: (item) => item.previousNetAreaHectares },
  nextNetArea: { kind: "number", value: (item) => item.nextNetAreaHectares },
};

const EXCLUSION_SORT_OPTIONS = [
  { column: "name", label: "Potrero" },
  { column: "grossArea", label: "Total" },
  { column: "previousNetArea", label: "Útil actual" },
  { column: "nextNetArea", label: "Útil nueva" },
] as const satisfies readonly { column: ExclusionSortColumn; label: string }[];

export function ExclusionPreviewDialog({ error, preview, saving, onCancel, onConfirm }: ExclusionPreviewDialogProps) {
  const [sort, setSort] = useState<SortState<ExclusionSortColumn> | null>(null);
  const canConfirm = preview.affected.length > 0 && preview.blockers.length === 0 && !saving;
  const affected = useMemo(
    () => stableSortData(preview.affected, sort, EXCLUSION_SORT_COLUMNS),
    [preview.affected, sort],
  );
  const handleSort = (column: ExclusionSortColumn) => {
    setSort((current) => nextSortState(current, column));
  };

  return (
    <DialogFrame closeEnabled={!saving} labelledBy="exclusion-preview-title" onClose={onCancel} wide>
      <header className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Confirmación obligatoria</p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.035em]" id="exclusion-preview-title">
            {preview.operation === "edit" ? "Cambios de exclusión" : "Potreros afectados"}
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            {EXCLUSION_KIND_LABELS[preview.kind]} · {formatHectares(preview.totalExcludedAreaHectares)} {preview.operation === "edit" ? "de superficie" : "excluidas"}
          </p>
        </div>
        {!saving && <CloseButton onClose={onCancel} />}
      </header>

      <div className="max-h-[62vh] space-y-4 overflow-y-auto p-5 sm:p-6">
        {preview.affected.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-line-steel">
            <SortableDataSelect
              className="block border-b border-line-steel bg-surface-alt p-3 sm:hidden"
              label="Ordenar potreros afectados"
              onChange={setSort}
              options={EXCLUSION_SORT_OPTIONS}
              sort={sort}
            />
            <div className="hidden grid-cols-[1.35fr_.8fr_.8fr_.8fr] gap-3 bg-surface-alt px-4 py-3 text-[12px] font-black uppercase tracking-wide text-ink-subtle sm:grid">
              {EXCLUSION_SORT_OPTIONS.map((option) => (
                <SortableGridHeader
                  column={option.column}
                  key={option.column}
                  label={option.label}
                  onSort={handleSort}
                  sort={sort}
                />
              ))}
            </div>
            <div className="divide-y divide-line-steel">
              {affected.map((item) => (
                <div className="grid gap-1 px-4 py-3 text-xs sm:grid-cols-[1.35fr_.8fr_.8fr_.8fr] sm:items-center sm:gap-3" key={item.paddockId}>
                  <span className="font-black text-ink">{item.paddockName}</span>
                  <Metric label="Total" value={formatHectares(item.grossAreaHectares)} />
                  <Metric label="Útil actual" value={formatHectares(item.previousNetAreaHectares)} />
                  <Metric label="Útil nueva" value={formatHectares(item.nextNetAreaHectares)} highlight />
                </div>
              ))}
            </div>
          </div>
        )}

        {preview.warnings.map((warning) => (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-900" key={warning}>
            <AlertTriangle className="mt-0.5 shrink-0" size={16} /> {warning}
          </div>
        ))}
        {preview.blockers.map((blocker) => (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-800" key={blocker} role="alert">
            <AlertTriangle className="mt-0.5 shrink-0" size={16} /> {blocker}
          </div>
        ))}
        {error && <div className="rounded-xl bg-red-50 p-3 text-xs font-bold text-red-800" role="alert">{error}</div>}
      </div>

      <footer className="flex flex-col-reverse gap-3 border-t border-line-steel p-4 sm:flex-row sm:justify-end sm:px-6">
        <button className="min-h-11 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted disabled:opacity-45" disabled={saving} onClick={onCancel} type="button">{preview.operation === "edit" ? "Volver al mapa" : "Volver al dibujo"}</button>
        <button className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={!canConfirm} onClick={onConfirm} type="button">
          {saving ? <><LoaderCircle className="animate-spin" size={16} /> Guardando</> : <><Check size={16} /> {preview.operation === "edit" ? "Guardar cambios" : "Confirmar exclusión"}</>}
        </button>
      </footer>
    </DialogFrame>
  );
}

function DialogFrame({ closeEnabled = true, labelledBy, onClose, wide = false, children }: { closeEnabled?: boolean; labelledBy: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogA11y(dialogRef, onClose, closeEnabled);
  return (
    <div
      className="fixed inset-0 z-[2300] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget && closeEnabled) onClose(); }}
      role="presentation"
    >
      <section
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={`w-full overflow-hidden rounded-[24px] bg-white shadow-2xl outline-none focus-visible:ring-3 focus-visible:ring-accent ${wide ? "max-w-3xl" : "max-w-xl"}`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return <button aria-label="Cerrar" className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-alt text-ink-muted" onClick={onClose} type="button"><X size={18} /></button>;
}

function Metric({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return <span className={highlight ? "font-black text-accent" : "font-bold text-ink-muted"}><span className="mr-1 text-[12px] uppercase text-ink-subtle sm:hidden">{label}:</span>{value}</span>;
}
