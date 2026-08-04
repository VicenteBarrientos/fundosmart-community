"use client";

import {
  LIVESTOCK_CATEGORY_LABELS,
  LIVESTOCK_STATUS_LABELS,
  type Fundo,
  type LivestockCategory,
  type LivestockLot,
  type LivestockStatus,
  type LivestockTrackingMode,
  type Potrero,
} from "@/src/core/domain/types";
import { AlertTriangle, Beef, Check, LoaderCircle, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { ErrorMessage, Field, parseOptionalNumber } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";

type ManageLivestockLotDialogProps = {
  fundos: Fundo[];
  lot: LivestockLot | null;
  onClose: () => void;
  onDelete: (id: string, updatedAt: string) => Promise<void>;
  onSave: (lot: LivestockLot) => Promise<void>;
  potreros: Potrero[];
};

type FormState = {
  fieldId: string;
  paddockId: string;
  name: string;
  category: LivestockCategory;
  animalCount: string;
  averageWeightKg: string;
  entryDate: string;
  status: LivestockStatus;
  ownerName: string;
  trackingMode: LivestockTrackingMode;
  notes: string;
};

export function ManageLivestockLotDialog({ fundos, lot, onClose, onDelete, onSave, potreros }: ManageLivestockLotDialogProps) {
  const [mode, setMode] = useState<"edit" | "delete">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    fieldId: lot?.fieldId ?? fundos[0]?.id ?? "",
    paddockId: lot?.paddockId ?? "",
    name: lot?.name ?? "",
    category: lot?.category ?? "dairy_cow",
    animalCount: lot ? String(lot.animalCount) : "",
    averageWeightKg: lot?.averageWeightKg ? String(lot.averageWeightKg) : "",
    entryDate: lot?.entryDate ?? new Date().toISOString().slice(0, 10),
    status: lot?.status ?? "active",
    ownerName: lot?.ownerName ?? "",
    trackingMode: lot?.trackingMode ?? "summary",
    notes: lot?.notes ?? "",
  });

  const availablePotreros = useMemo(
    () => potreros.filter((potrero) => potrero.fieldId === form.fieldId),
    [form.fieldId, potreros],
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const animalCount = form.trackingMode === "individual" ? (lot?.animalCount ?? 0) : Number(form.animalCount);
    const averageWeightKg = form.trackingMode === "individual"
      ? (lot?.averageWeightKg ?? null)
      : parseOptionalNumber(form.averageWeightKg);

    if (!form.fieldId || !form.name.trim() || !form.entryDate) {
      setError("Completa el fundo, nombre y fecha de ingreso.");
      return;
    }
    if (!Number.isInteger(animalCount) || animalCount < 0 || (form.trackingMode === "summary" && animalCount === 0)) {
      setError("La cantidad debe ser un número entero mayor que cero.");
      return;
    }
    if (averageWeightKg !== null && averageWeightKg <= 0) {
      setError("El peso promedio debe ser mayor que cero.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: lot?.id ?? crypto.randomUUID(),
        fieldId: form.fieldId,
        paddockId: form.paddockId || null,
        name: form.name.trim(),
        category: form.category,
        animalCount,
        averageWeightKg,
        entryDate: form.entryDate,
        status: form.status,
        ownerName: form.ownerName.trim() || null,
        trackingMode: form.trackingMode,
        notes: form.notes.trim(),
        createdAt: lot?.createdAt ?? new Date().toISOString(),
        updatedAt: lot?.updatedAt,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el lote.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!lot?.updatedAt) {
      setError("Actualiza el inventario antes de eliminar el lote ganadero.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onDelete(lot.id, lot.updatedAt);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el lote.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2200] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="manage-livestock-title" aria-modal="true" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className={`grid size-10 place-items-center rounded-xl ${mode === "delete" ? "bg-red-50 text-red-700" : "bg-band text-accent"}`}>
              {mode === "delete" ? <Trash2 size={18} /> : <Beef size={19} />}
            </span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Inventario ganadero</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="manage-livestock-title">
                {mode === "delete" ? "Eliminar lote" : lot ? "Editar lote" : "Nuevo lote"}
              </h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-9 place-items-center rounded-xl bg-surface-alt text-ink-muted" disabled={saving} onClick={onClose} type="button"><X size={17} /></button>
        </div>

        {mode === "delete" ? (
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 shrink-0 text-red-700" size={19} />
              <div><p className="text-sm font-black text-red-900">¿Eliminar {lot?.name}?</p><p className="mt-1 text-xs leading-5 text-red-800/80">El lote saldrá definitivamente del inventario. Si necesitas conservar su historia, cambia el estado a Vendido o Retirado.</p></div>
            </div>
            {error && <ErrorMessage text={error} />}
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
                <Field label="Nombre del lote">
                  <input autoFocus className="input-base" onChange={(event) => update("name", event.target.value)} placeholder="Ej. Vacas ordeña 1" required value={form.name} />
                </Field>
                <Field label="Categoría">
                  <select className="input-base" onChange={(event) => update("category", event.target.value as LivestockCategory)} value={form.category}>
                    {Object.entries(LIVESTOCK_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Fundo">
                  <select className="input-base" onChange={(event) => setForm((current) => ({ ...current, fieldId: event.target.value, paddockId: "" }))} required value={form.fieldId}>
                    <option disabled value="">Selecciona un fundo</option>
                    {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
                  </select>
                </Field>
                <Field label="Potrero actual">
                  <select className="input-base" onChange={(event) => update("paddockId", event.target.value)} value={form.paddockId}>
                    <option value="">Sin potrero asignado</option>
                    {availablePotreros.map((potrero) => <option key={potrero.id} value={potrero.id}>{potrero.name}</option>)}
                  </select>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Cantidad de animales">
                  <input className="input-base disabled:bg-surface-alt disabled:text-ink-subtle" disabled={form.trackingMode === "individual"} inputMode="numeric" min="1" onChange={(event) => update("animalCount", event.target.value)} placeholder="0" required={form.trackingMode === "summary"} type="number" value={form.trackingMode === "individual" ? String(lot?.animalCount ?? 0) : form.animalCount} />
                </Field>
                <Field label="Peso promedio (kg)">
                  <input className="input-base disabled:bg-surface-alt disabled:text-ink-subtle" disabled={form.trackingMode === "individual"} inputMode="decimal" min="0" onChange={(event) => update("averageWeightKg", event.target.value)} placeholder={form.trackingMode === "individual" ? "Se calcula con los pesajes" : "Opcional"} step="0.1" type="number" value={form.trackingMode === "individual" ? (lot?.averageWeightKg ?? "") : form.averageWeightKg} />
                </Field>
                <Field label="Fecha de ingreso">
                  <input className="input-base" onChange={(event) => update("entryDate", event.target.value)} required type="date" value={form.entryDate} />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Estado">
                  <select className="input-base" onChange={(event) => update("status", event.target.value as LivestockStatus)} value={form.status}>
                    {Object.entries(LIVESTOCK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <Field label="Trazabilidad">
                  <select
                    className="input-base"
                    onChange={(event) => {
                      const trackingMode = event.target.value as LivestockTrackingMode;
                      setForm((current) => ({
                        ...current,
                        trackingMode,
                        animalCount: trackingMode === "individual" ? String(lot?.animalCount ?? 0) : current.animalCount,
                        averageWeightKg: trackingMode === "individual" ? String(lot?.averageWeightKg ?? "") : current.averageWeightKg,
                      }));
                    }}
                    value={form.trackingMode}
                  >
                    <option value="summary">Solo resumen del lote</option>
                    <option value="individual">Animal por animal (DIIO)</option>
                  </select>
                </Field>
              </div>

              {form.trackingMode === "individual" && (
                <p className="rounded-xl bg-band px-3 py-2 text-[12px] font-bold leading-4 text-accent">
                  La cantidad activa y el peso promedio se calculan automáticamente desde las fichas y pesajes individuales.
                </p>
              )}

              <Field label="Propietario o responsable">
                <input className="input-base" onChange={(event) => update("ownerName", event.target.value)} placeholder="Opcional" value={form.ownerName} />
              </Field>

              <Field label="Notas">
                <textarea className="min-h-20 w-full resize-none rounded-xl border border-line-steel bg-white p-3 text-xs font-medium text-ink outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/10" onChange={(event) => update("notes", event.target.value)} placeholder="Observaciones sanitarias, alimentación u otra referencia" value={form.notes} />
              </Field>
              {error && <ErrorMessage text={error} />}
            </div>

            <div className="flex flex-wrap gap-3 border-t border-line-steel p-4 sm:px-6">
              {lot && <button className="flex h-11 items-center justify-center gap-2 rounded-xl border border-red-200 px-4 text-xs font-black text-red-700" disabled={saving} onClick={() => setMode("delete")} type="button"><Trash2 size={15} /> Eliminar</button>}
              <div className="ml-auto flex flex-1 justify-end gap-3 sm:flex-none">
                <button className="h-11 flex-1 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted sm:flex-none" disabled={saving} onClick={onClose} type="button">Cancelar</button>
                <button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:opacity-60 sm:flex-none" disabled={saving || fundos.length === 0} type="submit">
                  {saving ? <><LoaderCircle className="animate-spin" size={15} /> Guardando</> : <><Check size={15} /> Guardar lote</>}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
