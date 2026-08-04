"use client";

import { FileText, MapPinned, Pencil, Plus, Sprout, Upload } from "lucide-react";
import type { Fundo } from "../types";

type FundoSelectorProps = {
  fundos: Fundo[];
  selectedId: string | null;
  paddockCounts: Record<string, number>;
  onSelect: (fundoId: string) => void;
  onCreate: () => void;
  onEdit: () => void;
  onImport: () => void;
  canEdit?: boolean;
  canCreate?: boolean;
  createDisabledReason?: string | null;
  fieldLimit?: number | null;
  paddockLimit?: number | null;
  totalPaddocks?: number;
};

export function FundoSelector({
  fundos,
  selectedId,
  paddockCounts,
  onCreate,
  onEdit,
  onImport,
  onSelect,
  canEdit = true,
  canCreate = true,
  createDisabledReason = null,
  fieldLimit = null,
  paddockLimit = null,
  totalPaddocks = 0,
}: FundoSelectorProps) {
  const selected = fundos.find((fundo) => fundo.id === selectedId) ?? null;

  return (
    <section className="mt-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Estructura productiva</p>
          <h2 className="mt-1 text-lg font-black tracking-[-0.035em] text-ink">Selecciona un fundo</h2>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-[12px] font-bold text-ink-subtle">
            {fieldLimit === null ? `${fundos.length} fundos registrados` : `${fundos.length}/${fieldLimit} fundos`}
            {paddockLimit !== null ? ` · ${totalPaddocks}/${paddockLimit} potreros` : ""}
          </p>
          <button
            className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-3 text-[12px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canCreate}
            onClick={onCreate}
            title={!canCreate ? createDisabledReason ?? undefined : undefined}
            type="button"
          >
            <Plus size={13} /> Nuevo fundo
          </button>
          <button className="flex min-h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface-alt px-3 text-[12px] font-black text-accent disabled:opacity-40" disabled={!selected} onClick={onImport} type="button"><Upload size={13} /> Importar mapa</button>
          <button className="flex h-9 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-[12px] font-black text-ink-muted disabled:opacity-40" disabled={!selected || !canEdit} onClick={onEdit} type="button"><Pencil size={13} /> Editar fundo</button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {fundos.map((fundo) => {
          const active = fundo.id === selectedId;
          return (
            <button
              className={`rounded-[18px] border p-4 text-left transition ${active ? "border-accent bg-ink text-white shadow-[0_10px_30px_rgba(23,59,45,0.14)]" : "border-line-steel bg-white text-ink hover:border-accent"}`}
              key={fundo.id}
              onClick={() => onSelect(fundo.id)}
              type="button"
            >
              <div className="flex items-start justify-between gap-3">
                <span className={`grid size-10 place-items-center rounded-xl ${active ? "bg-accent text-ink" : "bg-surface-alt text-accent"}`}><MapPinned size={18} /></span>
                <span className={`rounded-full px-2.5 py-1 text-[12px] font-black ${active ? "bg-white/10 text-white/70" : "bg-surface-alt text-ink-muted"}`}>{fundo.areaHectares.toLocaleString("es-CL")} ha</span>
              </div>
              <p className="mt-3 text-sm font-black">{fundo.name}</p>
              <p className={`mt-1 text-[12px] font-semibold ${active ? "text-white/50" : "text-ink-subtle"}`}>{fundo.location}</p>
              <div className={`mt-3 flex items-center gap-2 border-t pt-3 text-[12px] font-bold ${active ? "border-white/10 text-white/65" : "border-line-steel text-ink-muted"}`}>
                <Sprout size={13} /> {paddockCounts[fundo.id] ?? 0} potreros
                {fundo.soilReport && <span className="ml-auto flex items-center gap-1"><FileText size={12} /> Suelo</span>}
              </div>
            </button>
          );
        })}
      </div>

      {fundos.length === 0 && (
        <div className="rounded-[20px] border border-dashed border-line-strong bg-white px-5 py-8 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-band text-accent"><MapPinned size={20} /></span>
          <p className="mt-3 text-sm font-black text-ink">Crea tu primer fundo</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">Agrega su nombre y ubicación; luego podrás dibujar el límite y comenzar a registrar potreros.</p>
          <button className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-40" disabled={!canCreate} onClick={onCreate} type="button">
            <Plus size={14} /> Crear primer fundo
          </button>
          {!canCreate && createDisabledReason && <p className="mt-2 text-[12px] font-bold text-ink-subtle">{createDisabledReason}</p>}
        </div>
      )}

      {selected?.soilReport && (
        <div className="mt-3 flex flex-col gap-3 rounded-[16px] border border-line-steel bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <FileText className="mt-0.5 shrink-0 text-accent" size={16} />
            <div>
              <p className="text-xs font-black text-accent">Estudio de suelo de referencia</p>
              <p className="mt-1 text-[12px] leading-4 text-ink-muted">Cooprinsem, folio {selected.soilReport.folio}, muestra {selected.soilReport.sampleId}. pH 5,6; fósforo 23,4 mg/kg; potasio 213,7 mg/kg.</p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-white px-3 py-1.5 text-[12px] font-black text-ink-muted">Referencia inicial, no análisis por potrero</span>
        </div>
      )}
    </section>
  );
}
