"use client";

import type {
  Fundo,
  LivestockAnimal,
  LivestockFeedingPlan,
  LivestockLot,
  Potrero,
} from "@/src/core/domain/types";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { Calculator, Database, FileUp, Leaf, Trash2, Wheat } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  buildForageBudget,
  DEFAULT_FORAGE_ASSUMPTIONS,
  forageStorageKey,
  parseForageObservations,
  type ForageAssumptions,
  type ForageObservation,
} from "../lib/forage-rules";

type ForageSectionProps = {
  fundos: Fundo[];
  potreros: Potrero[];
  lots: LivestockLot[];
  animals: LivestockAnimal[];
  feedingPlans: LivestockFeedingPlan[];
  offlineScope: string;
};

type ManualObservationForm = {
  paddockId: string;
  observedAt: string;
  ndvi: string;
  biomassKgDmHa: string;
  utilizationPct: string;
  notes: string;
};

export function ForageSection({ fundos, potreros, lots, animals, feedingPlans, offlineScope }: ForageSectionProps) {
  const [observations, setObservations] = useState<ForageObservation[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [assumptions, setAssumptions] = useState<ForageAssumptions>({ ...DEFAULT_FORAGE_ASSUMPTIONS });
  const [form, setForm] = useState<ManualObservationForm>(() => ({
    paddockId: potreros[0]?.id ?? "",
    observedAt: today(),
    ndvi: "",
    biomassKgDmHa: "",
    utilizationPct: String(DEFAULT_FORAGE_ASSUMPTIONS.defaultUtilizationPct),
    notes: "",
  }));

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = localStorage.getItem(forageStorageKey(offlineScope));
        const parsed: unknown = stored ? JSON.parse(stored) : [];
        setObservations(Array.isArray(parsed) ? parsed.filter(isForageObservation) : []);
        setMessage(null);
      } catch {
        setObservations([]);
        setMessage("No fue posible leer las observaciones guardadas en este dispositivo.");
      } finally { setLoadedScope(offlineScope); }
    });
    return () => { cancelled = true; };
  }, [offlineScope]);

  useEffect(() => {
    if (loadedScope !== offlineScope) return;
    try {
      localStorage.setItem(forageStorageKey(offlineScope), JSON.stringify(observations));
    } catch {
      console.warn("[fundosmart] forage observations could not be saved locally");
    }
  }, [loadedScope, observations, offlineScope]);

  const budget = useMemo(() => buildForageBudget({
    fundos,
    potreros,
    lots,
    animals,
    feedingPlans,
    observations,
    assumptions,
  }), [animals, assumptions, feedingPlans, fundos, lots, observations, potreros]);
  const resolvePaddock = useMemo(() => createPaddockResolver(potreros), [potreros]);

  function saveManualObservation() {
    const ndvi = optionalNumber(form.ndvi);
    const biomassKgDmHa = optionalNumber(form.biomassKgDmHa);
    const utilizationPct = optionalNumber(form.utilizationPct);
    if (!form.paddockId || !/^\d{4}-\d{2}-\d{2}$/.test(form.observedAt)) return setMessage("Selecciona potrero y fecha.");
    if (ndvi === null && biomassKgDmHa === null) return setMessage("Ingresa NDVI observado o biomasa medida.");
    if (ndvi !== null && (ndvi < 0 || ndvi > 1)) return setMessage("NDVI debe estar entre 0 y 1.");
    if (biomassKgDmHa !== null && biomassKgDmHa <= 0) return setMessage("La biomasa debe ser mayor que cero kg MS/ha.");
    if (utilizationPct === null || utilizationPct <= 0 || utilizationPct > 100) return setMessage("El aprovechamiento debe estar entre 0 y 100%.");

    const now = new Date().toISOString();
    setObservations((current) => [...current, {
      id: crypto.randomUUID(),
      paddockId: form.paddockId,
      observedAt: form.observedAt,
      ndvi,
      biomassKgDmHa,
      utilizationPct,
      source: "manual",
      notes: form.notes.trim(),
      createdAt: now,
    }]);
    setForm((current) => ({ ...current, ndvi: "", biomassKgDmHa: "", notes: "" }));
    setMessage("Observación guardada localmente para este usuario y sus fundos.");
  }

  function importObservations(content: string) {
    const parsed = parseForageObservations(content, {
      defaultObservedAt: today(),
      defaultUtilizationPct: assumptions.defaultUtilizationPct,
    });
    const now = new Date().toISOString();
    const imported: ForageObservation[] = [];
    const unresolved: number[] = [];
    for (const row of parsed.observations) {
      const paddock = resolvePaddock(row.paddockRef);
      if (!paddock) {
        unresolved.push(row.line);
        continue;
      }
      imported.push({
        id: crypto.randomUUID(),
        paddockId: paddock.id,
        observedAt: row.observedAt,
        ndvi: row.ndvi,
        biomassKgDmHa: row.biomassKgDmHa,
        utilizationPct: row.utilizationPct,
        source: "imported",
        notes: row.notes,
        createdAt: now,
      });
    }
    if (imported.length > 0) setObservations((current) => [...current, ...imported]);
    const rejected = parsed.rejected.length + unresolved.length;
    setMessage(`${imported.length} observación${imported.length === 1 ? "" : "es"} importada${imported.length === 1 ? "" : "s"}${rejected ? ` · ${rejected} fila${rejected === 1 ? "" : "s"} omitida${rejected === 1 ? "" : "s"}` : ""}.`);
  }

  async function loadFile(file: File | null) {
    if (!file) return;
    const content = await file.text();
    setImportText(content);
    importObservations(content);
  }

  function removeObservation(id: string) {
    setObservations((current) => current.filter((observation) => observation.id !== id));
    setMessage("Observación eliminada del almacenamiento local.");
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
        <div className="flex gap-3">
          <Database className="mt-0.5 shrink-0" size={18} />
          <div>
            <h2 className="text-sm font-black">NDVI observado o importado</h2>
            <p className="mt-1 text-xs leading-relaxed">Esta pantalla no consulta satélites automáticamente. El NDVI proviene de una medición o archivo que tú incorporas; si no agregas biomasa medida, la oferta usa la calibración manual indicada abajo.</p>
          </div>
        </div>
      </section>

      {message && <p aria-live="polite" className="rounded-xl bg-ink px-4 py-3 text-xs font-bold text-white">{message}</p>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Oferta utilizable" value={formatKg(budget.totalOfferKgDm)} detail={`${budget.observedPaddocks} de ${potreros.length} potreros observados`} />
        <MetricCard label="Demanda de pradera" value={`${formatNumber(budget.totalDemandKgDmDay)} kg MS/día`} detail={`${budget.lots.length} lotes activos`} />
        <MetricCard label="Cobertura total" value={budget.coverageDays === null ? "Sin base" : `${formatNumber(budget.coverageDays)} días`} detail="Incluye lotes sin potrero como demanda" />
        <MetricCard label="Demanda sin asignar" value={`${formatNumber(budget.unassignedDemandKgDmDay)} kg MS/día`} detail="Conviene ubicar esos lotes en un potrero" tone={budget.unassignedDemandKgDmDay > 0 ? "amber" : "green"} />
      </section>

      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3"><Leaf className="text-accent" size={18} /><div><p className="eyebrow">Observación puntual</p><h2 className="text-lg font-black">Registrar pradera</h2></div></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="field-label sm:col-span-2">Potrero<select className="input-base mt-1" onChange={(event) => setForm({ ...form, paddockId: event.target.value })} value={form.paddockId}><option value="">Selecciona potrero</option>{potreros.map((potrero) => <option key={potrero.id} value={potrero.id}>{potrero.name} · {fundos.find((fundo) => fundo.id === potrero.fieldId)?.name ?? "Fundo"}</option>)}</select></label>
            <label className="field-label">Fecha<input className="input-base mt-1" max={today()} onChange={(event) => setForm({ ...form, observedAt: event.target.value })} type="date" value={form.observedAt} /></label>
            <label className="field-label">Aprovechamiento %<input className="input-base mt-1" max="100" min="1" onChange={(event) => setForm({ ...form, utilizationPct: event.target.value })} step="1" type="number" value={form.utilizationPct} /></label>
            <label className="field-label">NDVI observado<input className="input-base mt-1" max="1" min="0" onChange={(event) => setForm({ ...form, ndvi: event.target.value })} placeholder="Ej. 0,68" step="0.01" type="text" value={form.ndvi} /></label>
            <label className="field-label">Biomasa kg MS/ha<input className="input-base mt-1" min="1" onChange={(event) => setForm({ ...form, biomassKgDmHa: event.target.value })} placeholder="Prioritaria si se mide" step="1" type="text" value={form.biomassKgDmHa} /></label>
            <label className="field-label sm:col-span-2">Notas<textarea className="mt-1 min-h-20 w-full rounded-xl border border-line-steel bg-surface-alt p-3 text-xs" onChange={(event) => setForm({ ...form, notes: event.target.value })} value={form.notes} /></label>
          </div>
          <button className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white" onClick={saveManualObservation} type="button"><Leaf size={15} /> Guardar observación local</button>
        </section>

        <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3"><FileUp className="text-accent" size={18} /><div><p className="eyebrow">CSV o texto</p><h2 className="text-lg font-black">Pegar o cargar observaciones</h2></div></div>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">Columnas admitidas: Potrero, Fecha, NDVI, Biomasa kg MS/ha, Aprovechamiento y Notas. Acepta punto y coma, coma o tabulación.</p>
          <textarea className="mt-4 min-h-40 w-full rounded-xl border border-line-steel bg-surface-alt p-3 font-mono text-[12px]" onChange={(event) => setImportText(event.target.value)} placeholder={"Potrero;Fecha;NDVI;Biomasa kg MS/ha;Aprovechamiento\nP1;2026-07-20;0,66;1850;70"} value={importText} />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="action-secondary flex cursor-pointer items-center justify-center"><FileUp size={14} /> Cargar CSV/TXT<input accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(event) => loadFile(event.target.files?.[0] ?? null)} type="file" /></label>
            <button className="flex h-10 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white" disabled={!importText.trim()} onClick={() => importObservations(importText)} type="button"><FileUp size={14} /> Importar texto</button>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3"><Calculator className="text-accent" size={18} /><div><p className="eyebrow">Supuestos editables</p><h2 className="text-lg font-black">Calibración del presupuesto</h2></div></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AssumptionInput label="Consumo % peso vivo" max={10} min={0.1} onChange={(value) => setAssumptions({ ...assumptions, intakePctLiveWeight: value })} step={0.1} value={assumptions.intakePctLiveWeight} />
          <AssumptionInput label="MS del suplemento %" max={100} min={0} onChange={(value) => setAssumptions({ ...assumptions, supplementDryMatterPct: value })} step={1} value={assumptions.supplementDryMatterPct} />
          <AssumptionInput label="NDVI suelo desnudo" max={1} min={0} onChange={(value) => setAssumptions({ ...assumptions, bareSoilNdvi: value })} step={0.01} value={assumptions.bareSoilNdvi} />
          <AssumptionInput label="kg MS/ha por unidad NDVI" min={1} onChange={(value) => setAssumptions({ ...assumptions, kgDmHaPerNdviUnit: value })} step={100} value={assumptions.kgDmHaPerNdviUnit} />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-subtle">Estimación NDVI: máximo entre cero y (NDVI − suelo desnudo) × calibración. Ajusta la pendiente con aforos locales; biomasa medida siempre reemplaza esta estimación.</p>
      </section>

      <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3"><Wheat className="text-accent" size={18} /><div><p className="eyebrow">Presupuesto forrajero</p><h2 className="text-lg font-black">Oferta y cobertura por potrero</h2></div></div>
        <TableExplorer
          className="mt-4"
          description="Oferta utilizable, demanda diaria, cobertura y lotes asignados."
          filter={{ label: "Última base", allLabel: "Todas las bases", columnIndex: 1 }}
          id="ganado.forraje.oferta"
          searchPlaceholder="Buscar potrero, fundo o lote..."
          title="Oferta y cobertura por potrero"
        >
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="text-[12px] uppercase tracking-wider text-ink-subtle"><tr><th className="pb-2">Potrero</th><th className="pb-2">Última base</th><th className="pb-2">Oferta utilizable</th><th className="pb-2">Demanda</th><th className="pb-2">Cobertura</th><th className="pb-2">Lotes</th></tr></thead>
            <tbody className="divide-y divide-line-steel">{budget.potreros.map((potrero) => <tr key={potrero.paddockId}><td className="py-3 pr-4 font-black">{potrero.paddockName}<span className="block text-[12px] font-medium text-ink-subtle">{potrero.fieldName} · {formatNumber(potrero.areaHectares)} ha</span></td><td className="pr-4">{potrero.observation ? <>{potrero.biomassBasis === "observed_biomass" ? "Biomasa medida" : "NDVI estimado"}<span className="block text-[12px] text-ink-subtle">{potrero.observation.observedAt}{potrero.observation.ndvi !== null ? ` · NDVI ${formatNumber(potrero.observation.ndvi)}` : ""}</span></> : "Sin observación"}</td><td className="pr-4 font-black">{potrero.usableOfferKgDm === null ? "—" : formatKg(potrero.usableOfferKgDm)}</td><td className="pr-4">{formatNumber(potrero.dailyDemandKgDm)} kg MS/día</td><td className="pr-4 font-black">{potrero.coverageDays === null ? "—" : `${formatNumber(potrero.coverageDays)} días`}</td><td>{potrero.lots.map((lot) => lot.lotName).join(", ") || "Sin lote"}</td></tr>)}</tbody>
          </table>
        </TableExplorer>
      </section>

      <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm">
        <h2 className="text-sm font-black">Demanda diaria por lote</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{budget.lots.map((lot) => <div className="rounded-xl bg-surface-alt p-4" key={lot.lotId}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black">{lot.lotName}</p><p className="mt-1 text-[12px] text-ink-muted">{lot.headCount} cabezas · {formatNumber(lot.averageWeightKg)} kg promedio</p></div><span className="rounded-full bg-white px-2 py-1 text-[12px] font-black text-accent">{formatNumber(lot.pastureDemandKgDmDay)} kg MS/día</span></div><p className="mt-3 text-[12px] text-ink-muted">Demanda bruta {formatNumber(lot.grossDemandKgDmDay)} · suplemento {formatNumber(lot.supplementKgDmDay)} kg MS/día</p></div>)}</div>
      </section>

      {observations.length > 0 && <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm"><h2 className="text-sm font-black">Historial local ({observations.length})</h2><div className="mt-3 divide-y divide-line-steel">{[...observations].sort((left, right) => right.observedAt.localeCompare(left.observedAt)).map((observation) => <div className="flex items-center justify-between gap-3 py-3" key={observation.id}><div><p className="text-xs font-black">{potreros.find((potrero) => potrero.id === observation.paddockId)?.name ?? "Potrero no disponible"}</p><p className="mt-1 text-[12px] text-ink-subtle">{observation.observedAt} · {observation.source === "manual" ? "Manual" : "Importada"}{observation.ndvi !== null ? ` · NDVI ${formatNumber(observation.ndvi)}` : ""}{observation.biomassKgDmHa !== null ? ` · ${formatNumber(observation.biomassKgDmHa)} kg MS/ha` : ""}</p></div><button aria-label="Eliminar observación" className="grid size-9 shrink-0 place-items-center rounded-lg text-red-700 hover:bg-red-50" onClick={() => removeObservation(observation.id)} type="button"><Trash2 size={14} /></button></div>)}</div></section>}
    </div>
  );
}

function MetricCard({ label, value, detail, tone = "green" }: { label: string; value: string; detail: string; tone?: "green" | "amber" }) {
  return <div className={`rounded-2xl border p-4 ${tone === "amber" ? "border-amber-200 bg-amber-50" : "border-line-steel bg-white"}`}><p className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">{label}</p><p className="mt-2 text-xl font-black text-ink">{value}</p><p className="mt-1 text-[12px] text-ink-subtle">{detail}</p></div>;
}

function AssumptionInput({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (value: number) => void; min: number; max?: number; step: number }) {
  return <label className="field-label">{label}<input className="input-base mt-1" max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="number" value={value} /></label>;
}

function createPaddockResolver(potreros: Potrero[]): (reference: string) => Potrero | null {
  const byId = new Map(potreros.map((potrero) => [normalizeReference(potrero.id), potrero]));
  const byName = new Map<string, Potrero[]>();
  for (const potrero of potreros) {
    const key = normalizeReference(potrero.name);
    byName.set(key, [...(byName.get(key) ?? []), potrero]);
  }
  return (reference) => {
    const normalized = normalizeReference(reference);
    const exact = byId.get(normalized);
    if (exact) return exact;
    const sameName = byName.get(normalized) ?? [];
    return sameName.length === 1 ? sameName[0] : null;
  };
}

function isForageObservation(value: unknown): value is ForageObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Partial<ForageObservation>;
  return typeof observation.id === "string"
    && typeof observation.paddockId === "string"
    && typeof observation.observedAt === "string"
    && (observation.ndvi === null || typeof observation.ndvi === "number")
    && (observation.biomassKgDmHa === null || typeof observation.biomassKgDmHa === "number")
    && typeof observation.utilizationPct === "number"
    && (observation.source === "manual" || observation.source === "imported")
    && typeof observation.notes === "string"
    && typeof observation.createdAt === "string";
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReference(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function formatKg(value: number): string {
  return `${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(value)} kg MS`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(value);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
