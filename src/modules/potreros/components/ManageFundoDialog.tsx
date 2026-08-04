"use client";

import { Check, Download, FileCode2, FileJson2, LoaderCircle, MapPinned, PencilRuler, Printer, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import type { Fundo } from "../types";
import { calculatePerimeterMeters } from "../utils/geometry";

type ManageFundoDialogProps = {
  fundo: Fundo;
  onClose: () => void;
  onEditBoundary: () => void;
  onSave: (fundo: Fundo) => Promise<void>;
};

export function ManageFundoDialog({ fundo, onClose, onEditBoundary, onSave }: ManageFundoDialogProps) {
  const [name, setName] = useState(fundo.name);
  const [location, setLocation] = useState(fundo.location);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !location.trim()) {
      setError("Completa el nombre y la ubicación.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...fundo, name: name.trim(), location: location.trim() });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el fundo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2100] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="manage-fundo-title" aria-modal="true" className="w-full max-w-lg rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-band text-accent"><MapPinned size={18} /></span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Administración</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="manage-fundo-title">Editar fundo</h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-9 place-items-center rounded-xl bg-surface-alt text-ink-muted" disabled={saving} onClick={onClose} type="button"><X size={17} /></button>
        </div>

        <form onSubmit={submit}>
          <div className="space-y-4 px-5 py-5 sm:px-6">
            <label className="block"><span className="mb-1.5 block text-[12px] font-black uppercase tracking-[0.09em] text-ink-muted">Nombre</span><input autoFocus className="input-base" onChange={(event) => setName(event.target.value)} value={name} /></label>
            <label className="block"><span className="mb-1.5 block text-[12px] font-black uppercase tracking-[0.09em] text-ink-muted">Sector o localidad</span><input className="input-base" onChange={(event) => setLocation(event.target.value)} value={location} /></label>
            <div className="rounded-2xl bg-surface-alt p-4">
              <p className="text-[12px] font-black uppercase tracking-[0.11em] text-ink-subtle">Superficie del límite registrado</p>
              <p className="mt-1 text-xl font-black text-ink">{fundo.areaHectares.toLocaleString("es-CL")} ha</p>
              <p className="mt-1 text-xs font-black text-accent">Perímetro · {formatDistance(calculatePerimeterMeters(fundo.coordinates))}</p>
              <p className="mt-1 text-[12px] leading-4 text-ink-subtle">La geometría del fundo y sus potreros se mantienen intactas.</p>
              <button
                className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-line-steel bg-white text-[12px] font-black text-accent"
                onClick={() => {
                  onClose();
                  onEditBoundary();
                }}
                type="button"
              >
                <PencilRuler size={14} /> Editar límite en el mapa
              </button>
            </div>
            <div className="rounded-2xl border border-line-steel p-4">
              <div className="flex items-start gap-2.5">
                <Download className="mt-0.5 shrink-0 text-accent" size={16} />
                <div>
                  <p className="text-xs font-black text-accent">Exportar e imprimir potreros</p>
                  <p className="mt-1 text-[12px] leading-4 text-ink-subtle">Las descargas y el plano vectorial incluyen sólo los potreros de este fundo y no dependen de teselas externas.</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <a
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-surface-alt text-[12px] font-black text-accent"
                  download
                  href={`/api/potreros/export?fundoId=${encodeURIComponent(fundo.id)}&format=geojson`}
                >
                  <FileJson2 size={13} /> GeoJSON
                </a>
                <a
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-surface-alt text-[12px] font-black text-accent"
                  download
                  href={`/api/potreros/export?fundoId=${encodeURIComponent(fundo.id)}&format=kml`}
                >
                  <FileCode2 size={13} /> KML
                </a>
                <a
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-ink text-[12px] font-black text-white"
                  href={`/app/potreros/imprimir?fundoId=${encodeURIComponent(fundo.id)}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  <Printer size={13} /> Imprimir
                </a>
              </div>
            </div>
            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}
          </div>

          <div className="flex gap-3 border-t border-line-steel p-4 sm:px-6">
            <button className="h-11 flex-1 rounded-xl border border-line-steel text-xs font-black text-ink-muted" disabled={saving} onClick={onClose} type="button">Cancelar</button>
            <button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white disabled:opacity-60" disabled={saving} type="submit">{saving ? <><LoaderCircle className="animate-spin" size={15} /> Guardando</> : <><Check size={15} /> Guardar fundo</>}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatDistance(meters: number) {
  if (meters >= 1_000) return `${(meters / 1_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
  return `${meters.toLocaleString("es-CL", { maximumFractionDigits: 0 })} m`;
}
