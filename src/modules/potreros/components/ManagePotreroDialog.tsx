"use client";

import { AlertTriangle, Check, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Field } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import type { PaddockLandUse, Potrero } from "../types";
import { LAND_USE_LABELS, paddockAreaMetrics } from "../utils/paddock-metrics";

type ManagePotreroDialogProps = {
  potrero: Potrero;
  initialMode: "edit" | "delete";
  onClose: () => void;
  onSave: (potrero: Potrero) => Promise<void>;
  onDelete: (potreroId: string) => Promise<void>;
};

type FormState = {
  name: string;
  sector: string;
  status: Potrero["status"];
  ph: string;
  nitrogen: string;
  phosphorus: string;
  potassium: string;
  landUse: PaddockLandUse;
  grazeableArea: string;
};

export function ManagePotreroDialog({ potrero, initialMode, onClose, onSave, onDelete }: ManagePotreroDialogProps) {
  const [mode, setMode] = useState<"edit" | "delete">(initialMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);
  const metrics = paddockAreaMetrics(potrero);
  const [manualGrazeable, setManualGrazeable] = useState(potrero.grazeableAreaHectares !== null && potrero.grazeableAreaHectares !== undefined);
  const [form, setForm] = useState<FormState>({
    name: potrero.name,
    sector: potrero.sector,
    status: potrero.status,
    ph: fromNumber(potrero.soil.ph),
    nitrogen: fromNumber(potrero.soil.nitrogen),
    phosphorus: fromNumber(potrero.soil.phosphorus),
    potassium: fromNumber(potrero.soil.potassium),
    landUse: potrero.landUse ?? "pradera_permanente",
    grazeableArea: fromNumber(potrero.grazeableAreaHectares ?? null),
  });
  const parsedGrazeable = toNumber(form.grazeableArea);
  const effectiveGrazeable = manualGrazeable ? parsedGrazeable ?? 0 : metrics.netAreaHectares;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim() || !form.sector.trim()) {
      setError("Completa el nombre y el sector.");
      return;
    }
    if (manualGrazeable && (parsedGrazeable === null || parsedGrazeable < 0 || parsedGrazeable > metrics.netAreaHectares)) {
      setError(`La superficie pastoreable debe estar entre 0 y ${metrics.netAreaHectares.toLocaleString("es-CL")} ha útiles.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...potrero,
        name: form.name.trim(),
        sector: form.sector.trim(),
        status: form.status,
        landUse: form.landUse,
        grazeableAreaHectares: manualGrazeable ? parsedGrazeable : null,
        effectiveGrazeableAreaHectares: manualGrazeable ? parsedGrazeable! : metrics.netAreaHectares,
        areaHectares: metrics.grossAreaHectares,
        netAreaHectares: metrics.netAreaHectares,
        geometry: metrics.geometry,
        coordinates: metrics.geometry.outer,
        soil: {
          ph: toNumber(form.ph),
          nitrogen: toNumber(form.nitrogen),
          phosphorus: toNumber(form.phosphorus),
          potassium: toNumber(form.potassium),
        },
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setSaving(true);
    setError(null);
    try {
      await onDelete(potrero.id);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el potrero.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2100] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="manage-potrero-title" aria-modal="true" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className={`grid size-10 place-items-center rounded-xl ${mode === "delete" ? "bg-red-50 text-red-700" : "bg-band text-accent"}`}>
              {mode === "delete" ? <Trash2 size={18} /> : <Pencil size={18} />}
            </span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Ficha del potrero</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="manage-potrero-title">{mode === "delete" ? "Eliminar potrero" : `Editar ${potrero.name}`}</h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-11 place-items-center rounded-xl bg-surface-alt text-ink-muted" disabled={saving} onClick={onClose} type="button"><X size={17} /></button>
        </div>

        {mode === "delete" ? (
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 shrink-0 text-red-700" size={19} />
              <div>
                <p className="text-sm font-black text-red-900">¿Eliminar {potrero.name}?</p>
                <p className="mt-1 text-xs leading-5 text-red-800/80">Se borrará el polígono y todo su historial de manejos y costos. Los demás potreros no cambiarán.</p>
              </div>
            </div>
            {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}
            <div className="mt-5 flex gap-3">
              <button className="h-11 flex-1 rounded-xl border border-line-steel text-xs font-black text-ink-muted" disabled={saving} onClick={() => setMode("edit")} type="button">Volver a editar</button>
              <button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-700 text-xs font-black text-white disabled:opacity-60" disabled={saving} onClick={confirmDelete} type="button">
                {saving ? <><LoaderCircle className="animate-spin" size={15} /> Eliminando</> : <><Trash2 size={15} /> Sí, eliminar</>}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="space-y-5 px-5 py-5 sm:px-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nombre">
                  <input autoFocus className="input-base" onChange={(event) => update("name", event.target.value)} value={form.name} />
                </Field>
                <Field label="Sector">
                  <input className="input-base" onChange={(event) => update("sector", event.target.value)} value={form.sector} />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Estado">
                  <select className="input-base" onChange={(event) => update("status", event.target.value as Potrero["status"])} value={form.status}>
                    <option value="Disponible">Disponible</option>
                    <option value="En pastoreo">En pastoreo</option>
                    <option value="En descanso">En descanso</option>
                  </select>
                </Field>
                <Field label="Superficie">
                  <div className="flex min-h-11 items-center rounded-xl border border-line-steel bg-surface-alt px-3 text-xs font-black text-ink-muted">{metrics.grossAreaHectares.toLocaleString("es-CL")} ha total · {metrics.netAreaHectares.toLocaleString("es-CL")} ha neta</div>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Uso de suelo">
                  <select className="input-base" onChange={(event) => update("landUse", event.target.value as PaddockLandUse)} value={form.landUse}>
                    {(Object.entries(LAND_USE_LABELS) as [PaddockLandUse, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <div className="rounded-xl border border-line-steel bg-surface-alt p-3">
                  <p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Superficie útil pastoreable</p>
                  <p className="mt-1 text-sm font-black text-ink">{effectiveGrazeable.toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha · {metrics.grossAreaHectares > 0 ? (effectiveGrazeable * 100 / metrics.grossAreaHectares).toLocaleString("es-CL", { maximumFractionDigits: 1 }) : "0"}%</p>
                </div>
              </div>

              <div>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line-steel bg-surface-alt px-3 text-xs font-black text-ink-muted">
                  <input checked={manualGrazeable} className="size-4 accent-accent" onChange={(event) => setManualGrazeable(event.target.checked)} type="checkbox" />
                  Sobrescribir hectáreas pastoreables calculadas
                </label>
                {manualGrazeable && (
                  <label className="mt-3 grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                    Hectáreas pastoreables manuales
                    <input className="input-base" inputMode="decimal" onChange={(event) => update("grazeableArea", event.target.value)} placeholder={`Máximo ${metrics.netAreaHectares.toLocaleString("es-CL")} ha`} value={form.grazeableArea} />
                  </label>
                )}
                <p className="mt-2 text-[12px] text-ink-subtle">En modo automático se usa la superficie neta, descontando {metrics.geometry.holes.length} exclusión{metrics.geometry.holes.length === 1 ? "" : "es"}.</p>
              </div>

              <div>
                <p className="mb-3 text-[12px] font-black uppercase tracking-[0.13em] text-ink-muted">Análisis de suelo</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="pH" value={form.ph} onChange={(value) => update("ph", value)} />
                  <Metric label="N" value={form.nitrogen} onChange={(value) => update("nitrogen", value)} />
                  <Metric label="P" value={form.phosphorus} onChange={(value) => update("phosphorus", value)} />
                  <Metric label="K" value={form.potassium} onChange={(value) => update("potassium", value)} />
                </div>
              </div>

              {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}
            </div>

            <div className="flex flex-wrap gap-3 border-t border-line-steel p-4 sm:px-6">
              <button className="flex h-11 items-center justify-center gap-2 rounded-xl border border-red-200 px-4 text-xs font-black text-red-700" disabled={saving} onClick={() => setMode("delete")} type="button"><Trash2 size={15} /> Eliminar</button>
              <div className="ml-auto flex flex-1 justify-end gap-3 sm:flex-none">
                <button className="h-11 flex-1 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted sm:flex-none" disabled={saving} onClick={onClose} type="button">Cancelar</button>
                <button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:opacity-60 sm:flex-none" disabled={saving} type="submit">
                  {saving ? <><LoaderCircle className="animate-spin" size={15} /> Guardando</> : <><Check size={15} /> Guardar cambios</>}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span className="mb-1.5 block text-[12px] font-black text-ink-muted">{label}</span><input className="input-base" inputMode="decimal" onChange={(event) => onChange(event.target.value)} placeholder="—" value={value} /></label>;
}

function fromNumber(value: number | null) {
  return value === null ? "" : String(value).replace(".", ",");
}

function toNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
