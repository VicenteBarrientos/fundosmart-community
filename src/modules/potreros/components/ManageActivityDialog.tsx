"use client";

import { AlertTriangle, Check, CircleDollarSign, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Field } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import { ACTIVITY_TYPE_LABELS, type Activity, type ActivityType } from "../types";

type ManageActivityDialogProps = {
  activity: Activity;
  onClose: () => void;
  onSave: (activity: Activity) => Promise<void>;
  onDelete: (activityId: string) => Promise<void>;
};

type FormState = {
  type: ActivityType;
  occurredAt: string;
  description: string;
  quantity: string;
  unit: string;
  costClp: string;
};

export function ManageActivityDialog({ activity, onClose, onSave, onDelete }: ManageActivityDialogProps) {
  const [mode, setMode] = useState<"edit" | "delete">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);
  const [form, setForm] = useState<FormState>({
    type: activity.type,
    occurredAt: activity.occurredAt,
    description: activity.description,
    quantity: fromNumber(activity.quantity),
    unit: activity.unit ?? "",
    costClp: fromNumber(activity.costClp),
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.occurredAt || !form.description.trim()) {
      setError("Completa la fecha y la descripción.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...activity,
        type: form.type,
        occurredAt: form.occurredAt,
        description: form.description.trim(),
        quantity: toNumber(form.quantity),
        unit: form.unit.trim() || null,
        costClp: toNumber(form.costClp),
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
      await onDelete(activity.id);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el manejo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2200] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="manage-activity-title" aria-modal="true" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className={`grid size-10 place-items-center rounded-xl ${mode === "delete" ? "bg-red-50 text-red-700" : "bg-band text-accent"}`}>
              {mode === "delete" ? <Trash2 size={18} /> : <Pencil size={18} />}
            </span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Historial del potrero</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="manage-activity-title">
                {mode === "delete" ? "Eliminar manejo" : "Editar manejo"}
              </h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-9 place-items-center rounded-xl bg-surface-alt text-ink-muted" disabled={saving} onClick={onClose} type="button"><X size={17} /></button>
        </div>

        {mode === "delete" ? (
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 shrink-0 text-red-700" size={19} />
              <div>
                <p className="text-sm font-black text-red-900">¿Eliminar este manejo?</p>
                <p className="mt-1 text-xs leading-5 text-red-800/80">Se quitarán su registro y costo del historial. El resumen del potrero se recalculará automáticamente.</p>
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
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Tipo de manejo">
                  <select className="input-base" onChange={(event) => update("type", event.target.value as ActivityType)} value={form.type}>
                    {Object.entries(ACTIVITY_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <Field label="Fecha">
                  <input className="input-base" onChange={(event) => update("occurredAt", event.target.value)} required type="date" value={form.occurredAt} />
                </Field>
              </div>

              <Field label="Descripción">
                <textarea autoFocus className="min-h-24 w-full resize-none rounded-xl border border-line-steel bg-white p-3 text-xs font-medium text-ink outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/10" onChange={(event) => update("description", event.target.value)} required value={form.description} />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Cantidad">
                  <input className="input-base" inputMode="decimal" onChange={(event) => update("quantity", event.target.value)} placeholder="—" value={form.quantity} />
                </Field>
                <Field label="Unidad">
                  <input className="input-base" onChange={(event) => update("unit", event.target.value)} placeholder="kg, ton, animales" value={form.unit} />
                </Field>
              </div>

              <Field label="Costo total">
                <span className="relative block">
                  <CircleDollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={14} />
                  <input className="input-base pl-9" inputMode="numeric" onChange={(event) => update("costClp", event.target.value)} placeholder="0" value={form.costClp} />
                </span>
              </Field>

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

function fromNumber(value: number | null) {
  return value === null ? "" : String(value).replace(".", ",");
}

function toNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
