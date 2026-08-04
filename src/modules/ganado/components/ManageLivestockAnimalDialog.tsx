"use client";

import {
  LIVESTOCK_ANIMAL_STATUS_LABELS,
  LIVESTOCK_SEX_LABELS,
  type LivestockAnimal,
  type LivestockAnimalStatus,
  type LivestockSex,
  type LivestockLot,
  type LivestockWeighing,
} from "@/src/core/domain/types";
import { AlertTriangle, Check, LoaderCircle, Tag, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { ErrorMessage, Field, parseOptionalNumber } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import { formatDate, formatKg, todayISO } from "../lib/format";
import { accumulatedWeightGain } from "../lib/livestock-metrics";
import { WeightCurve } from "./WeightCurve";

type ManageLivestockAnimalDialogProps = {
  animal: LivestockAnimal | null;
  lots: LivestockLot[];
  weighings: LivestockWeighing[];
  onClose: () => void;
  onDelete: (id: string, snapshotToken: string) => Promise<void>;
  onSave: (animal: LivestockAnimal) => Promise<void>;
};

type FormState = {
  tag: string;
  lotId: string;
  sex: LivestockSex;
  status: LivestockAnimalStatus;
  statusDate: string;
  statusReason: string;
  birthDate: string;
  purchasePriceClp: string;
  purchaseDate: string;
  salePriceClp: string;
  saleBuyer: string;
  saleWeightKg: string;
  origin: string;
  latestWeightKg: string;
  latestWeightDate: string;
  notes: string;
};

export function ManageLivestockAnimalDialog({ animal, lots, weighings, onClose, onDelete, onSave }: ManageLivestockAnimalDialogProps) {
  const individualLots = lots.filter((lot) => lot.trackingMode === "individual");
  const weightHistory = animal
    ? weighings.filter((weighing) => weighing.animalId === animal.id).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    : [];
  const accumulatedGain = accumulatedWeightGain(weightHistory);
  const [mode, setMode] = useState<"edit" | "delete">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);
  const [form, setForm] = useState<FormState>({
    tag: animal?.tag ?? "",
    lotId: animal?.lotId ?? individualLots[0]?.id ?? "",
    sex: animal?.sex ?? "unknown",
    status: animal?.status ?? "active",
    statusDate: animal?.statusDate ?? "",
    statusReason: animal?.statusReason ?? "",
    birthDate: animal?.birthDate ?? "",
    purchasePriceClp: animal?.purchasePriceClp !== null && animal?.purchasePriceClp !== undefined ? String(animal.purchasePriceClp) : "",
    purchaseDate: animal?.purchaseDate ?? "",
    salePriceClp: animal?.salePriceClp !== null && animal?.salePriceClp !== undefined ? String(animal.salePriceClp) : "",
    saleBuyer: animal?.saleBuyer ?? "",
    saleWeightKg: animal?.saleWeightKg !== null && animal?.saleWeightKg !== undefined ? String(animal.saleWeightKg) : "",
    origin: animal?.origin ?? "",
    latestWeightKg: animal?.latestWeightKg !== null && animal?.latestWeightKg !== undefined ? String(animal.latestWeightKg) : "",
    latestWeightDate: animal?.latestWeightDate ?? "",
    notes: animal?.notes ?? "",
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tag = form.tag.trim();
    const latestWeightKg = parseOptionalNumber(form.latestWeightKg);
    const purchasePriceClp = parseOptionalNumber(form.purchasePriceClp);
    const salePriceClp = parseOptionalNumber(form.salePriceClp);
    const saleWeightKg = parseOptionalNumber(form.saleWeightKg);

    if (!tag) {
      setError("Ingresa el DIIO o identificador del animal.");
      return;
    }
    if (!/^[A-Za-z0-9.-]+$/.test(tag)) {
      setError("El DIIO solo puede llevar letras, números, puntos y guiones.");
      return;
    }
    if (!form.lotId) {
      setError("Selecciona el lote al que pertenece.");
      return;
    }
    if (purchasePriceClp !== null && (!Number.isInteger(purchasePriceClp) || purchasePriceClp < 0)) {
      setError("El precio de compra debe ser un monto CLP entero.");
      return;
    }
    if (latestWeightKg !== null && latestWeightKg <= 0) {
      setError("El peso debe ser mayor que cero.");
      return;
    }
    if (latestWeightKg !== null && !form.latestWeightDate) {
      setError("Indica la fecha del pesaje.");
      return;
    }
    if (form.status === "sold" && (salePriceClp === null || salePriceClp <= 0 || saleWeightKg === null || saleWeightKg <= 0 || !form.saleBuyer.trim())) {
      setError("Para cerrar la venta registra precio, comprador y peso final.");
      return;
    }
    if (form.status !== "active" && !form.statusDate) {
      setError("Indica la fecha del cambio de estado.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: animal?.id ?? crypto.randomUUID(),
        lotId: form.lotId,
        tag,
        sex: form.sex,
        status: form.status,
        statusDate: form.status !== "active" && form.statusDate ? form.statusDate : null,
        statusReason: form.status !== "active" && form.statusReason.trim() ? form.statusReason.trim() : null,
        birthDate: form.birthDate || null,
        purchasePriceClp,
        purchaseDate: form.purchaseDate || null,
        salePriceClp: form.status === "sold" ? salePriceClp : null,
        saleBuyer: form.status === "sold" ? form.saleBuyer.trim() : null,
        saleWeightKg: form.status === "sold" ? saleWeightKg : null,
        origin: form.origin.trim() || null,
        notes: form.notes.trim(),
        source: animal?.source ?? "Registro manual",
        latestWeightKg,
        latestWeightDate: latestWeightKg !== null ? form.latestWeightDate : null,
        createdAt: animal?.createdAt ?? new Date().toISOString(),
        snapshotToken: animal?.snapshotToken,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el animal.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!animal?.snapshotToken) {
      setError("Actualiza los animales antes de eliminar.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onDelete(animal.id, animal.snapshotToken);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el animal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2200] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="manage-animal-title" aria-modal="true" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className={`grid size-10 place-items-center rounded-xl ${mode === "delete" ? "bg-red-50 text-red-700" : "bg-band text-accent"}`}>
              {mode === "delete" ? <Trash2 size={18} /> : <Tag size={19} />}
            </span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Ficha del animal</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="manage-animal-title">
                {mode === "delete" ? "Eliminar animal" : animal ? `Editar ${animal.tag}` : "Nuevo animal"}
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
                <p className="text-sm font-black text-red-900">¿Eliminar el animal {animal?.tag}?</p>
                <p className="mt-1 text-xs leading-5 text-red-800/80">Se borrarán también sus pesajes. Si murió o se vendió, prefiere cambiar el estado para conservar la historia.</p>
              </div>
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
                <Field label="DIIO o identificador">
                  <input autoFocus className="input-base" onChange={(event) => update("tag", event.target.value)} placeholder="Ej. 954.123" required value={form.tag} />
                </Field>
                <Field label="Lote">
                  <select className="input-base" onChange={(event) => update("lotId", event.target.value)} required value={form.lotId}>
                    <option disabled value="">Selecciona un lote</option>
                    {individualLots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}
                  </select>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Sexo">
                  <select className="input-base" onChange={(event) => update("sex", event.target.value as LivestockSex)} value={form.sex}>
                    {Object.entries(LIVESTOCK_SEX_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <Field label="Fecha de nacimiento">
                  <input className="input-base" onChange={(event) => update("birthDate", event.target.value)} type="date" value={form.birthDate} />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Origen">
                  <input className="input-base" onChange={(event) => update("origin", event.target.value)} placeholder="Ej. Feria Osorno" value={form.origin} />
                </Field>
                <Field label="Precio compra (CLP)">
                  <input className="input-base" inputMode="numeric" min="0" onChange={(event) => update("purchasePriceClp", event.target.value)} placeholder="Opcional" step="1" type="number" value={form.purchasePriceClp} />
                </Field>
                <Field label="Fecha de compra">
                  <input className="input-base" onChange={(event) => update("purchaseDate", event.target.value)} type="date" value={form.purchaseDate} />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Último peso (kg)">
                  <input className="input-base" inputMode="decimal" min="0" onChange={(event) => update("latestWeightKg", event.target.value)} placeholder="Opcional" step="0.1" type="number" value={form.latestWeightKg} />
                </Field>
                <Field label="Fecha del pesaje">
                  <input className="input-base" onChange={(event) => update("latestWeightDate", event.target.value)} type="date" value={form.latestWeightDate} />
                </Field>
              </div>

              <Field label="Estado">
                <select
                  className="input-base"
                  onChange={(event) => {
                    const status = event.target.value as LivestockAnimalStatus;
                    setForm((current) => ({
                      ...current,
                      status,
                      statusDate: status !== "active" && !current.statusDate ? todayISO() : current.statusDate,
                    }));
                  }}
                  value={form.status}
                >
                  {Object.entries(LIVESTOCK_ANIMAL_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>

              {form.status !== "active" && (
                <div className="grid gap-4 rounded-2xl border border-line-steel bg-surface-alt p-4 sm:grid-cols-2">
                  <Field label="Fecha del cambio de estado">
                    <input className="input-base" onChange={(event) => update("statusDate", event.target.value)} type="date" value={form.statusDate} />
                  </Field>
                  <Field label="Motivo o detalle">
                    <input className="input-base" onChange={(event) => update("statusReason", event.target.value)} placeholder="Ej. venta feria, causa de muerte" value={form.statusReason} />
                  </Field>
                </div>
              )}

              {form.status === "sold" && (
                <div className="grid gap-4 rounded-2xl border border-line-steel bg-surface-alt p-4 sm:grid-cols-3">
                  <Field label="Precio de venta (CLP)">
                    <input className="input-base" min="1" onChange={(event) => update("salePriceClp", event.target.value)} required step="1" type="number" value={form.salePriceClp} />
                  </Field>
                  <Field label="Comprador">
                    <input className="input-base" maxLength={160} onChange={(event) => update("saleBuyer", event.target.value)} placeholder="Nombre o feria" required value={form.saleBuyer} />
                  </Field>
                  <Field label="Peso final (kg)">
                    <input className="input-base" min="0.1" onChange={(event) => update("saleWeightKg", event.target.value)} required step="0.1" type="number" value={form.saleWeightKg} />
                  </Field>
                  {saleMargin(form.salePriceClp, form.purchasePriceClp) !== null && (
                    <p className="sm:col-span-3 text-xs font-black text-accent">Margen bruto animal: {saleMargin(form.salePriceClp, form.purchasePriceClp)!.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 })}</p>
                  )}
                </div>
              )}

              {animal && weightHistory.length > 0 && (
                <div className="rounded-2xl border border-line-steel bg-surface-alt p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-[12px] font-black uppercase tracking-[0.12em] text-accent">Evolución</p>
                      <p className="mt-1 text-sm font-black text-ink">Curva de peso</p>
                    </div>
                    <div className="text-right text-[12px] font-semibold text-ink-muted">
                      <p>{weightHistory.length} {weightHistory.length === 1 ? "pesaje" : "pesajes"}</p>
                      {accumulatedGain && (
                        <p className="mt-0.5 font-black text-ink">
                          GDV {accumulatedGain.dailyGainKg >= 0 ? "+" : ""}{accumulatedGain.dailyGainKg.toLocaleString("es-CL", { maximumFractionDigits: 2 })} kg/día
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 overflow-x-auto"><div className="min-w-[520px]"><WeightCurve weighings={weightHistory} /></div></div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {weightHistory.map((weighing) => (
                      <span className="rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-bold text-ink-muted" key={weighing.id}>
                        {formatDate(weighing.recordedAt)} · {formatKg(weighing.weightKg)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <Field label="Notas">
                <textarea className="min-h-20 w-full resize-none rounded-xl border border-line-steel bg-white p-3 text-xs font-medium text-ink outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/10" onChange={(event) => update("notes", event.target.value)} placeholder="Observaciones sanitarias u otra referencia" value={form.notes} />
              </Field>
              {error && <ErrorMessage text={error} />}
            </div>

            <div className="flex flex-wrap gap-3 border-t border-line-steel p-4 sm:px-6">
              {animal && <button className="flex h-11 items-center justify-center gap-2 rounded-xl border border-red-200 px-4 text-xs font-black text-red-700" disabled={saving} onClick={() => setMode("delete")} type="button"><Trash2 size={15} /> Eliminar</button>}
              <div className="ml-auto flex flex-1 justify-end gap-3 sm:flex-none">
                <button className="h-11 flex-1 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted sm:flex-none" disabled={saving} onClick={onClose} type="button">Cancelar</button>
                <button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:opacity-60 sm:flex-none" disabled={saving || individualLots.length === 0} type="submit">
                  {saving ? <><LoaderCircle className="animate-spin" size={15} /> Guardando</> : <><Check size={15} /> Guardar animal</>}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function saleMargin(saleValue: string, purchaseValue: string): number | null {
  const sale = parseOptionalNumber(saleValue);
  const purchase = parseOptionalNumber(purchaseValue);
  return sale === null ? null : sale - (purchase ?? 0);
}
