"use client";

import type { LivestockFeedingPlan, LivestockLot } from "@/src/core/domain/types";
import { Beef, LoaderCircle, Save, Trash2, Wheat } from "lucide-react";
import { useState } from "react";
import { formatInteger, formatKg, formatNumber } from "../lib/format";
import { ErrorMessage, Field, Panel, SmallEmpty, StatCard } from "./ui";

type RacionSectionProps = {
  plans: LivestockFeedingPlan[];
  lots: LivestockLot[];
  onSave: (plan: LivestockFeedingPlan) => Promise<void>;
  onDelete: (id: string, updatedAt: string) => Promise<void>;
};

export function RacionSection({ plans, lots, onSave, onDelete }: RacionSectionProps) {
  const activeLots = lots.filter((lot) => lot.status === "active");
  const planByLot = new Map(plans.map((plan) => [plan.lotId, plan]));
  const feedPlan = activeLots.map((lot) => {
    const plan = planByLot.get(lot.id) ?? null;
    const dailyKg = plan ? plan.kgPerAnimalDay * lot.animalCount : 0;
    return {
      lot,
      plan,
      dailyKg,
      dailySacks: plan && plan.sackWeightKg > 0 ? dailyKg / plan.sackWeightKg : 0,
    };
  });
  const totalDailyKg = feedPlan.reduce((sum, item) => sum + item.dailyKg, 0);
  const totalWeeklySacks = feedPlan.reduce((sum, item) => sum + item.dailySacks * 7, 0);
  const fedAnimals = feedPlan
    .filter((item) => (item.plan?.kgPerAnimalDay ?? 0) > 0)
    .reduce((sum, item) => sum + item.lot.animalCount, 0);
  const withoutConcentrate = feedPlan
    .filter((item) => item.plan?.kgPerAnimalDay === 0)
    .reduce((sum, item) => sum + item.lot.animalCount, 0);

  return (
    <div>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard helpText="Kilos de alimento comprado que se reparten cada día entre todos los lotes. El concentrado suele ser el gasto más grande después de la mano de obra." icon={Wheat} label="Concentrado diario" tone="dark" value={formatKg(totalDailyKg)} detail="Suma de todos los lotes" />
        <StatCard helpText="Cuántos sacos necesitas comprar por semana con la ración actual. Sirve para pedir con anticipación." icon={Wheat} label="Sacos por semana" value={formatNumber(totalWeeklySacks, 1)} detail="Según el peso de saco de cada plan" />
        <StatCard helpText="Animales que reciben alimento comprado además del pasto." icon={Beef} label="Animales con concentrado" value={formatInteger(fedAnimals)} detail="Cabezas con dosis mayor que cero" />
        <StatCard helpText="Animales que solo comen pasto. Si el potrero está pobre, son los primeros que dejan de subir de peso." icon={Beef} label="Sin concentrado" tone="amber" value={formatInteger(withoutConcentrate)} detail="Cabezas con dosis cero" />
      </section>

      <section className="mt-5">
        <Panel title="Plan real por lote" eyebrow="Producto, dosis diaria y sacos de 25 kg" help="ganadoRacion" icon={Wheat}>
          <p className="mt-3 max-w-3xl text-[12px] font-semibold leading-relaxed text-ink-subtle">
            La alimentación se define por lote, no por rango de peso. Ternerera usa concentrado crecimiento,
            Destetados usa concentrado Cosetan y las vaquillas de SM no comen concentrado.
          </p>
          {feedPlan.length > 0 ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              {feedPlan.map(({ lot, plan, dailyKg, dailySacks }) => (
                <FeedingPlanCard
                  dailyKg={dailyKg}
                  dailySacks={dailySacks}
                  key={`${lot.id}-${plan?.updatedAt ?? "new"}`}
                  lot={lot}
                  onDelete={onDelete}
                  onSave={onSave}
                  plan={plan}
                />
              ))}
            </div>
          ) : (
            <SmallEmpty text="Crea lotes activos para configurar su alimentación." />
          )}
        </Panel>
      </section>
    </div>
  );
}

function FeedingPlanCard({
  lot,
  plan,
  dailyKg,
  dailySacks,
  onSave,
  onDelete,
}: {
  lot: LivestockLot;
  plan: LivestockFeedingPlan | null;
  dailyKg: number;
  dailySacks: number;
  onSave: (plan: LivestockFeedingPlan) => Promise<void>;
  onDelete: (id: string, updatedAt: string) => Promise<void>;
}) {
  const [productName, setProductName] = useState(plan?.productName ?? "Sin concentrado");
  const [kgPerAnimalDay, setKgPerAnimalDay] = useState(String(plan?.kgPerAnimalDay ?? 0));
  const [sackWeightKg, setSackWeightKg] = useState(String(plan?.sackWeightKg ?? 25));
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const perAnimal = Number(kgPerAnimalDay.replace(",", "."));
    const sackWeight = Number(sackWeightKg.replace(",", "."));
    if (!productName.trim()) {
      setError("Indica el alimento o escribe Sin concentrado.");
      return;
    }
    if (!Number.isFinite(perAnimal) || perAnimal < 0) {
      setError("La dosis diaria no puede ser negativa.");
      return;
    }
    if (!Number.isFinite(sackWeight) || sackWeight <= 0) {
      setError("El peso del saco debe ser mayor que cero.");
      return;
    }

    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    try {
      await onSave({
        id: plan?.id ?? crypto.randomUUID(),
        lotId: lot.id,
        productName: productName.trim(),
        kgPerAnimalDay: perAnimal,
        sackWeightKg: sackWeight,
        notes: notes.trim(),
        createdAt: plan?.createdAt ?? now,
        updatedAt: plan?.updatedAt ?? now,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el plan.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!plan) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(plan.id, plan.updatedAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el plan.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="rounded-2xl border border-line-steel bg-surface-alt p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black text-ink">{lot.name}</p>
          <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
            {formatInteger(lot.animalCount)} cabezas · {lot.averageWeightKg !== null ? `promedio ${formatKg(lot.averageWeightKg)}` : "sin peso promedio"}
          </p>
        </div>
        {plan && (
          <button aria-label={`Eliminar plan de ${lot.name}`} className="grid size-8 place-items-center rounded-lg border border-red-100 text-red-700 disabled:opacity-50" disabled={deleting || saving} onClick={remove} type="button">
            {deleting ? <LoaderCircle className="animate-spin" size={13} /> : <Trash2 size={13} />}
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <div className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
          <Field label="Alimento">
            <input className="input-base" onChange={(event) => setProductName(event.target.value)} value={productName} />
          </Field>
        </div>
        <Field label="Kg/cabeza/día">
          <input className="input-base" min="0" onChange={(event) => setKgPerAnimalDay(event.target.value)} step="0.1" type="number" value={kgPerAnimalDay} />
        </Field>
        <Field label="Peso del saco (kg)">
          <input className="input-base" min="1" onChange={(event) => setSackWeightKg(event.target.value)} step="0.1" type="number" value={sackWeightKg} />
        </Field>
        <div className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
          <Field label="Notas">
            <input className="input-base" onChange={(event) => setNotes(event.target.value)} value={notes} />
          </Field>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Consumo del lote</span>
          <span className="text-sm font-black text-ink">{formatKg(dailyKg)}/día</span>
        </div>
        <p className="mt-1 text-right text-[12px] font-bold text-ink-muted">
          {formatNumber(dailySacks, 2)} sacos/día · {formatNumber(dailySacks * 7, 1)} sacos/semana
        </p>
      </div>

      {error && <ErrorMessage text={error} />}
      <button className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-60" disabled={saving || deleting} onClick={save} type="button">
        {saving ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />} Guardar plan
      </button>
    </article>
  );
}
