"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import type { Fundo } from "@/src/core/domain/types";
import { HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import type { PastureDashboard, StoredPastureRotationPlan } from "./domain/types";
import { BarChart3, CalendarRange, CloudOff, FlaskConical, LoaderCircle, RefreshCw, Sprout, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Props = { allowedFieldIds: string[]; canWrite: boolean; isDemo: boolean; organizationId: string; organizationName: string; userName: string };
type LoadState = "loading" | "loaded" | "error";

export function PraderasPage({ allowedFieldIds, canWrite, isDemo, organizationId, organizationName, userName }: Props) {
  const [fields, setFields] = useState<Fundo[]>([]);
  const [fieldId, setFieldId] = useState<string | null>(allowedFieldIds[0] ?? null);
  const [dashboard, setDashboard] = useState<PastureDashboard | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const selectedField = fields.find((field) => field.id === fieldId) ?? null;

  const load = useCallback(async (propagateError = false) => {
    setLoadState("loading");
    setMessage("");
    try {
      const fieldResponse = await fetch("/api/fundos", { cache: "no-store" });
      if (!fieldResponse.ok) throw new Error("No fue posible cargar los fundos.");
      const fieldPayload = await fieldResponse.json() as { fundos: Fundo[] };
      const scoped = fieldPayload.fundos.filter((field) => allowedFieldIds.includes(field.id));
      setFields(scoped);
      const nextFieldId = fieldId && scoped.some((field) => field.id === fieldId) ? fieldId : scoped[0]?.id ?? null;
      setFieldId(nextFieldId);
      if (!nextFieldId) {
        setDashboard(null);
        setLoadState("loaded");
        return;
      }
      const response = await fetch(`/api/praderas?fundoId=${encodeURIComponent(nextFieldId)}`, { cache: "no-store" });
      const payload = await response.json() as { pasture?: PastureDashboard; error?: string };
      if (!response.ok || !payload.pasture) throw new Error(payload.error ?? "No fue posible cargar las praderas.");
      setDashboard(payload.pasture);
      setLoadState("loaded");
    } catch (error) {
      setLoadState("error");
      setMessage(error instanceof Error ? error.message : "No fue posible cargar las praderas.");
      if (propagateError) throw error;
    }
  }, [allowedFieldIds, fieldId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);

  return (
    <AppShell activeSection="praderas" fieldName={selectedField?.name ?? "Praderas"} isDemo={isDemo} onRefresh={() => load(true)} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <main className="mx-auto w-full max-w-[1500px] px-4 pb-24 pt-5 sm:px-6 lg:px-8">
        <header className="overflow-hidden rounded-[24px] bg-ink p-6 text-white shadow-[0_22px_70px_rgba(23,59,45,0.14)] sm:p-8">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div className="max-w-3xl">
              <p className="text-[12px] font-black uppercase tracking-[0.18em] text-white">Fase 4 · manejo basado en evidencia</p>
              <h1 className="mt-2 text-3xl font-black tracking-[-0.045em] sm:text-4xl">Praderas, biomasa y rotación</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">Contrasta muestras manuales y observaciones NDVI calibradas; convierte kg MS/ha en días de oferta y deja visible cualquier déficit del plan.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Fundo" className="h-11 rounded-xl border border-white/15 bg-white/10 px-3 text-xs font-bold text-white" onChange={(event) => setFieldId(event.target.value)} value={fieldId ?? ""}>
                {fields.map((field) => <option className="text-ink" key={field.id} value={field.id}>{field.name}</option>)}
              </select>
              <button className="grid size-11 place-items-center rounded-xl border border-white/15 bg-white/10" onClick={() => void load()} title="Actualizar" type="button"><RefreshCw size={17} /></button>
            </div>
          </div>
        </header>

        {message && <div className="mt-4 flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900"><TriangleAlert size={16} /> {message}</div>}
        {loadState === "loading" && <div className="mt-6 grid min-h-60 place-items-center rounded-[22px] border border-line-steel bg-white"><LoaderCircle className="animate-spin text-accent" /></div>}
        {loadState === "loaded" && !dashboard && <EmptyState />}
        {loadState === "loaded" && dashboard && (
          <PastureWorkspace dashboard={dashboard} canWrite={canWrite} onChanged={load} onMessage={setMessage} />
        )}
      </main>
    </AppShell>
  );
}

function PastureWorkspace({ dashboard, canWrite, onChanged, onMessage }: { dashboard: PastureDashboard; canWrite: boolean; onChanged: () => Promise<void>; onMessage: (message: string) => void }) {
  const latestPlan = dashboard.rotationPlans[0] ?? null;
  const measured = dashboard.paddocks.filter((paddock) => paddock.latestEstimate);
  const mean = measured.length ? Math.round(measured.reduce((sum, paddock) => sum + (paddock.latestEstimate?.kgDmPerHectare ?? 0), 0) / measured.length) : null;
  return (
    <>
      <section className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Metric helpText="Cuántos potreros tienen una medición de pasto vigente. Sin medición no se puede planificar la rotación." icon={Sprout} label="Potreros medidos" value={`${measured.length}/${dashboard.paddocks.length}`} detail="con estimación vigente" />
        <Metric help="kgMsHa" icon={BarChart3} label="Biomasa media" value={mean === null ? "Sin datos" : `${mean.toLocaleString("es-CL")} kg MS/ha`} detail="última evidencia por potrero" />
        <Metric help="praderaDemanda" icon={BarChart3} label="Demanda derivada" value={dashboard.planningBasis.dailyDemandKgDm === null ? "No disponible" : `${dashboard.planningBasis.dailyDemandKgDm.toLocaleString("es-CL")} kg MS/día`} detail="lotes, pesos y supuesto 3% PV" />
        <Metric helpText="Servicio satelital que entrega las imágenes del NDVI. Mientras no se elija uno, no hay observación calibrada." icon={dashboard.provider.mode === "configured" ? FlaskConical : CloudOff} label="Proveedor NDVI" value={dashboard.provider.mode === "configured" ? dashboard.provider.providerKey : "Por decidir"} detail="no se usa un proveedor por defecto" />
        <Metric help="praderaRotacion" icon={CalendarRange} label="Último plan" value={latestPlan ? (latestPlan.feasible ? "Factible" : "Con déficit") : "Sin plan"} detail={latestPlan ? formatDate(latestPlan.createdAt) : "crea una simulación"} />
      </section>

      <PlanningEvidence dashboard={dashboard} />
      {dashboard.syntheticNdviSamples.length > 0 && <SyntheticNdviPanel dashboard={dashboard} />}
      <section className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <BiomassTable dashboard={dashboard} />
        <ManualSampleForm canWrite={canWrite} dashboard={dashboard} onChanged={onChanged} onMessage={onMessage} />
      </section>
      <section className="mt-5 grid gap-5 xl:grid-cols-[0.75fr_1.25fr]">
        <RotationForm canWrite={canWrite} dashboard={dashboard} onChanged={onChanged} onMessage={onMessage} />
        <RotationResult plan={latestPlan} />
      </section>
    </>
  );
}

function Metric({ help, helpText, icon: Icon, label, value, detail }: { help?: HelpKey; helpText?: string; icon: typeof Sprout; label: string; value: string; detail: string }) {
  return <article className="rounded-[20px] border border-line-steel bg-white p-5"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-surface-alt text-accent"><Icon size={18} /></span><div><p className="flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.14em] text-ink-subtle">{label}<HelpTip help={help} label={label} text={helpText} /></p><p className="mt-1 text-lg font-black text-ink">{value}</p></div></div><p className="mt-3 border-t border-line-steel pt-3 text-[12px] font-semibold text-ink-subtle">{detail}</p></article>;
}

function PlanningEvidence({ dashboard }: { dashboard: PastureDashboard }) {
  const basis = dashboard.planningBasis;
  const settings = basis.rotationContext.settings;
  return <section className="mt-5 rounded-[22px] border border-line-steel bg-white p-5">
    <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
      <div><p className="eyebrow">Base autoritativa D1</p><h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-ink">Demanda, suplementación y economía</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-ink-subtle">La demanda no llega desde el navegador: se reconstruye desde lotes activos, animales/pesajes y raciones. La suplementación conserva kg ofrecidos y no se mezcla con kg MS sin una materia seca persistida.</p></div>
      <span className={`rounded-full px-3 py-1.5 text-[12px] font-black ${basis.status === "available" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{basis.status === "available" ? "Demanda disponible" : "Datos incompletos"}</span>
    </div>
    {basis.statusReason && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">{basis.statusReason}</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <EvidenceValue label="Animales activos" value={basis.animalCount.toLocaleString("es-CL")} detail="conteo individual o resumen de lote" />
      <EvidenceValue label="Peso ponderado" value={basis.weightedAverageLiveWeightKg === null ? "No disponible" : `${basis.weightedAverageLiveWeightKg.toLocaleString("es-CL")} kg`} detail="pesaje individual más reciente o peso del lote" />
      <EvidenceValue help="praderaResiduo" label="Oferta medida" value={`${basis.totalSupplyKgDm.toLocaleString("es-CL")} kg MS`} detail="residuo 1.500 y utilización 80%" />
      <EvidenceValue help="ganadoRacion" label="Ración diaria" value={`${basis.supplement.dailyQuantityKgAsFed.toLocaleString("es-CL")} kg ofrecidos`} detail={basis.supplement.projectedDailyCostClp === null ? (basis.supplement.statusReason ?? "Costo no disponible") : `${formatClp(basis.supplement.projectedDailyCostClp)} proyectados/día`} />
      <EvidenceValue help="analiticaIofc" label="IOFC F3" value={basis.economics.iofcClp === null ? "No disponible" : formatClp(basis.economics.iofcClp)} detail={basis.economics.period ? `proyección ${basis.economics.period}` : (basis.economics.statusReason ?? "Sin proyección")} />
    </div>
    <TableExplorer
      className="mt-4"
      description="Compara animales, peso vivo, demanda y suplementación para entender cómo se construye el plan de cada lote."
      filter={{ label: "Filtrar lotes por ración", allLabel: "Todos los lotes", columnIndex: 4 }}
      id="praderas.planificacion-lotes"
      maxHeight="28rem"
      searchPlaceholder="Buscar lote, demanda, ración o costo…"
      title="Demanda y suplementación por lote"
    >
      <table className="w-full min-w-[760px] text-left text-xs"><thead className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle"><tr><th className="py-2">Lote</th><th className="py-2">Animales</th><th className="py-2">Peso vivo</th><th className="py-2">Demanda</th><th className="py-2">Ración</th><th className="py-2">Costo diario</th></tr></thead><tbody>{basis.lots.map((lot) => <tr className="border-t border-line-steel" key={lot.id}><td className="py-3 font-black text-ink">{lot.name}</td><td className="py-3 text-ink-muted">{lot.animalCount}</td><td className="py-3 text-ink-muted">{lot.averageLiveWeightKg === null ? "No disponible" : `${lot.averageLiveWeightKg.toLocaleString("es-CL")} kg`}</td><td className="py-3 text-ink-muted">{lot.dailyGrossDemandKgDm === null ? "No disponible" : `${lot.dailyGrossDemandKgDm.toLocaleString("es-CL")} kg MS/día`}</td><td className="py-3 text-ink-muted" data-table-filter-label={lot.ration ? "Con ración" : "Sin ración"}>{lot.ration ? `${lot.ration.dailyQuantityKgAsFed.toLocaleString("es-CL")} kg ofrecidos` : "Sin ración"}</td><td className="py-3 text-ink-muted">{lot.ration?.projectedDailyCostClp === null || lot.ration?.projectedDailyCostClp === undefined ? "No disponible" : formatClp(lot.ration.projectedDailyCostClp)}</td></tr>)}</tbody></table>
    </TableExplorer>
    <p className="mt-3 text-[12px] font-semibold text-ink-subtle">Rotación GIS: {settings ? `umbrales ${settings.recentDays}/${settings.longRestDays} días (v${settings.version})` : "sin umbrales persistidos"}; {Object.values(basis.rotationContext.activeCellsByPaddock).reduce((sum, count) => sum + count, 0)} franjas activas. El plan asigna cada lote a potrero, franja disponible y descanso persistido.</p>
  </section>;
}

function EvidenceValue({ help, helpText, label, value, detail }: { help?: HelpKey; helpText?: string; label: string; value: string; detail: string }) {
  return <div className="rounded-2xl bg-surface-alt p-4"><p className="flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">{label}<HelpTip help={help} label={label} text={helpText} /></p><p className="mt-1 text-sm font-black text-ink">{value}</p><p className="mt-1 text-[12px] leading-4 text-ink-subtle">{detail}</p></div>;
}

function SyntheticNdviPanel({ dashboard }: { dashboard: PastureDashboard }) {
  return <section className="mt-5 rounded-[22px] border border-sky-200 bg-sky-50/70 p-5"><div className="flex items-start gap-3"><FlaskConical className="mt-0.5 text-sky-700" size={18} /><div><p className="text-[12px] font-black uppercase tracking-[0.13em] text-sky-800">Muestra demo sintética</p><h2 className="mt-1 text-lg font-black text-sky-950">NDVI ilustrativo, sin proveedor ni secreto</h2><p className="mt-1 text-xs leading-5 text-sky-900/75">Sirve para leer la señal y su cobertura. No es una observación calibrada, no entra a biomasa, presupuesto ni planes operativos.</p></div></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{dashboard.syntheticNdviSamples.map((sample) => <div className="rounded-2xl border border-sky-200 bg-white p-4" key={sample.paddockId}><p className="text-xs font-black text-sky-950">{sample.paddockName}</p><p className="mt-2 text-2xl font-black text-sky-700">{sample.meanNdvi.toFixed(2)}</p><p className="mt-1 text-[12px] text-sky-900/70">{sample.usablePixelPercent}% píxeles útiles · {sample.indicativeKgDmPerHectare.toLocaleString("es-CL")} kg MS/ha indicativos</p></div>)}</div></section>;
}

function BiomassTable({ dashboard }: { dashboard: PastureDashboard }) {
  const growthByPaddock = new Map(dashboard.growthRates.map((rate) => [rate.paddockId, rate]));
  const budgetByPaddock = new Map(dashboard.planningBasis.paddockBudgets.map((budget) => [budget.paddockId, budget]));
  return <TableExplorer
    description="Feed wedge operativo para contrastar oferta, demanda, días disponibles y la evidencia que respalda cada estimación."
    filter={{ label: "Filtrar potreros por fuente", allLabel: "Todas las fuentes", columnIndex: 7 }}
    id="praderas.feed-wedge"
    maxHeight="34rem"
    searchPlaceholder="Buscar potrero, oferta, demanda o evidencia…"
    title="Oferta y demanda por potrero"
  >
    <table className="w-full min-w-[980px] text-left"><thead className="bg-surface-alt text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle"><tr><th className="px-5 py-3">Potrero</th><th className="px-5 py-3">Superficie</th><th className="px-5 py-3">kg MS/ha</th><th className="px-5 py-3">Oferta</th><th className="px-5 py-3">Demanda rebaño</th><th className="px-5 py-3">Días disponibles</th><th className="px-5 py-3">Crecimiento</th><th className="px-5 py-3">Fuente</th><th className="px-5 py-3">Observación</th></tr></thead><tbody>{dashboard.paddocks.map((paddock) => { const growth = growthByPaddock.get(paddock.id); const budget = budgetByPaddock.get(paddock.id); return <tr className="border-t border-line-steel text-xs" key={paddock.id}><td className="px-5 py-4 font-black text-ink">{paddock.name}</td><td className="px-5 py-4 text-ink-muted">{paddock.areaHectares.toLocaleString("es-CL")} ha</td><td className="px-5 py-4 font-black text-accent">{paddock.latestEstimate ? paddock.latestEstimate.kgDmPerHectare.toLocaleString("es-CL") : "—"}</td><td className="px-5 py-4 text-ink-muted">{budget?.availableKgDm === null || budget?.availableKgDm === undefined ? "No disponible" : `${budget.availableKgDm.toLocaleString("es-CL")} kg MS`}</td><td className="px-5 py-4 text-ink-muted">{budget?.herdDailyDemandKgDm === null || budget?.herdDailyDemandKgDm === undefined ? "No disponible" : `${budget.herdDailyDemandKgDm.toLocaleString("es-CL")} kg MS/día`}</td><td className="px-5 py-4 font-black text-accent">{budget?.availableDays === null || budget?.availableDays === undefined ? "—" : budget.availableDays.toLocaleString("es-CL")}</td><td className="px-5 py-4 text-ink-muted">{growth?.status === "available" && growth.kgDmPerHaPerDay !== null ? `${growth.kgDmPerHaPerDay > 0 ? "+" : ""}${growth.kgDmPerHaPerDay.toLocaleString("es-CL")} kg MS/ha/día` : "Datos insuficientes"}</td><td className="px-5 py-4 text-ink-muted">{paddock.latestEstimate?.sourceKind === "ndvi" ? "NDVI calibrado" : paddock.latestEstimate ? "Muestra manual" : "Sin evidencia"}</td><td className="px-5 py-4 text-ink-muted">{paddock.latestEstimate ? formatDate(paddock.latestEstimate.capturedAt) : "—"}</td></tr>; })}</tbody></table>
  </TableExplorer>;
}

function ManualSampleForm({ dashboard, canWrite, onChanged, onMessage }: { dashboard: PastureDashboard; canWrite: boolean; onChanged: () => Promise<void>; onMessage: (message: string) => void }) {
  const [paddockId, setPaddockId] = useState(dashboard.paddocks[0]?.id ?? "");
  const [kind, setKind] = useState<"direct" | "quadrat">("direct");
  const [value, setValue] = useState("2200");
  const [dryMatter, setDryMatter] = useState("20");
  const [area, setArea] = useState("0.25");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true); onMessage("");
    const measurement = kind === "direct"
      ? { sampleKind: "direct", kgDmPerHectare: Number(value) }
      : { sampleKind: "quadrat", freshWeightGrams: Number(value), dryMatterPercent: Number(dryMatter), quadratAreaSquareMeters: Number(area) };
    try {
      await mutate({ action: "record_manual_sample", operationId: `manual-${crypto.randomUUID()}`, fieldId: dashboard.fieldId, paddockId, capturedAt: new Date().toISOString(), measurement });
      await onChanged();
    } catch (error) { onMessage(error instanceof Error ? error.message : "No fue posible guardar la muestra."); }
    finally { setSaving(false); }
  };
  return <section className="rounded-[22px] border border-line-steel bg-white p-5"><p className="eyebrow">Evidencia en terreno</p><h2 className="mt-1 flex items-center gap-1.5 text-xl font-black tracking-[-0.03em] text-ink">Registrar muestra manual<HelpTip label="la muestra manual" text="Mide el pasto en terreno y guárdalo como evidencia. Es lo que calibra el satélite y sostiene el plan de rotación." /></h2><div className="mt-4 space-y-3"><Field label="Potrero"><select className="input-base" onChange={(event) => setPaddockId(event.target.value)} value={paddockId}>{dashboard.paddocks.map((paddock) => <option key={paddock.id} value={paddock.id}>{paddock.name}</option>)}</select></Field><Field help="praderaCuadrante" label="Método"><select className="input-base" onChange={(event) => setKind(event.target.value as "direct" | "quadrat")} value={kind}><option value="direct">Lectura directa kg MS/ha</option><option value="quadrat">Cuadrante con peso fresco</option></select></Field><Field label={kind === "direct" ? "kg MS/ha" : "Peso fresco (g)"}><input className="input-base" inputMode="decimal" min="0" onChange={(event) => setValue(event.target.value)} type="number" value={value} /></Field>{kind === "quadrat" && <div className="grid grid-cols-2 gap-3"><Field label="Materia seca (%)"><input className="input-base" onChange={(event) => setDryMatter(event.target.value)} type="number" value={dryMatter} /></Field><Field label="Área cuadrante (m²)"><input className="input-base" onChange={(event) => setArea(event.target.value)} step="0.01" type="number" value={area} /></Field></div>}<button className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={!canWrite || saving || !paddockId} onClick={() => void save()} type="button">{saving && <LoaderCircle className="animate-spin" size={15} />} {canWrite ? "Guardar evidencia" : "Solo lectura"}</button></div></section>;
}

function RotationForm({ dashboard, canWrite, onChanged, onMessage }: { dashboard: PastureDashboard; canWrite: boolean; onChanged: () => Promise<void>; onMessage: (message: string) => void }) {
  const measured = dashboard.paddocks.filter((paddock) => paddock.latestEstimate);
  const [horizon, setHorizon] = useState("14"); const [saving, setSaving] = useState(false);
  const disabled = !canWrite || measured.length === 0 || dashboard.planningBasis.status !== "available" || saving;
  const create = async () => {
    setSaving(true); onMessage("");
    try {
      await mutate({ action: "create_rotation_plan", operationId: `rotation-${crypto.randomUUID()}`, fieldId: dashboard.fieldId, startDate: new Date().toISOString().slice(0, 10), horizonDays: Number(horizon) });
      await onChanged();
    } catch (error) { onMessage(error instanceof Error ? error.message : "No fue posible crear el plan."); }
    finally { setSaving(false); }
  };
  return <section className="rounded-[22px] border border-line-steel bg-white p-5"><p className="eyebrow">Oferta · demanda</p><h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-ink">Simular rotación</h2><p className="mt-2 text-xs leading-5 text-ink-subtle">El servidor deriva animales, peso, raciones y biomasa desde D1. El cliente solo define fecha y horizonte; 3% PV, 80% de utilización y residuo 1.500 kg MS/ha quedan versionados como supuestos.</p><div className="mt-4 grid grid-cols-2 gap-3"><Field label="Horizonte (días)"><input className="input-base" max="90" min="1" onChange={(event) => setHorizon(event.target.value)} type="number" value={horizon} /></Field><Field label="Potreros medidos"><div className="grid h-11 place-items-center rounded-xl bg-surface-alt text-xs font-black text-ink-muted">{measured.length}</div></Field><Field label="Animales derivados"><div className="grid h-11 place-items-center rounded-xl bg-surface-alt text-xs font-black text-ink-muted">{dashboard.planningBasis.animalCount}</div></Field><Field label="Demanda derivada"><div className="grid h-11 place-items-center rounded-xl bg-surface-alt px-2 text-center text-xs font-black text-ink-muted">{dashboard.planningBasis.dailyDemandKgDm === null ? "No disponible" : `${dashboard.planningBasis.dailyDemandKgDm.toLocaleString("es-CL")} kg MS/día`}</div></Field></div><button className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={disabled} onClick={() => void create()} type="button">{saving && <LoaderCircle className="animate-spin" size={15} />} Crear plan verificable</button></section>;
}

function RotationResult({ plan }: { plan: StoredPastureRotationPlan | null }) {
  const visits = useMemo(() => readArray(plan?.plan.visits), [plan]);
  const wedge = useMemo(() => readArray(plan?.plan.feedWedge), [plan]);
  if (!plan) return <section className="grid min-h-80 place-items-center rounded-[22px] border border-dashed border-line-steel bg-surface-alt p-6 text-center"><div><CalendarRange className="mx-auto text-ink-subtle" /><p className="mt-3 text-sm font-black text-ink-muted">Aún no hay un plan de rotación</p><p className="mt-1 text-xs text-ink-subtle">Registra biomasa y crea una simulación.</p></div></section>;
  return <section className="rounded-[22px] border border-line-steel bg-white p-5"><div className="flex items-start justify-between gap-3"><div><p className="eyebrow">Plan más reciente</p><h2 className="mt-1 text-xl font-black text-ink">{plan.feasible ? "Horizonte cubierto" : "Oferta insuficiente"}</h2></div><span className={`rounded-full px-3 py-1.5 text-[12px] font-black ${plan.feasible ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{plan.feasible ? "Factible" : "Revisar"}</span></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{visits.map((visit, index) => <div className="rounded-2xl border border-line-steel bg-surface-alt p-4" key={`${readString(visit.paddockId)}-${index}`}><p className="text-xs font-black text-ink">{index + 1}. {readString(visit.lotName)} → {readString(visit.paddockName)}</p><p className="mt-1 text-[12px] font-semibold text-ink-subtle">{readString(visit.startsOn)} → {readString(visit.endsOn)} · {readNumber(visit.durationDays)} días{visit.cellId ? ` · ${readString(visit.cellName)}` : ""}</p><p className="mt-1 text-[12px] text-ink-subtle">Descanso hasta {readString(visit.restUntil)}</p></div>)}</div>{wedge.length > 0 && <div className="mt-5"><p className="flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.13em] text-ink-subtle">Feed wedge<HelpTip help="feedWedge" label="el feed wedge" /></p><div className="mt-2 flex h-24 items-end gap-2">{wedge.map((item, index) => { const kg = readNumber(item.kgDmPerHectare); return <div className="flex min-w-0 flex-1 flex-col items-center gap-1" key={`${readString(item.paddockId)}-${index}`}><span className="text-[12px] font-black text-ink-muted">{kg}</span><div className="w-full rounded-t-md bg-accent" style={{ height: `${Math.max(8, Math.min(70, kg / 40))}px` }} /><span className="max-w-full truncate text-[12px] text-ink-subtle">{readString(item.paddockName)}</span></div>; })}</div></div>}</section>;
}

function Field({ help, helpText, label, children }: { help?: HelpKey; helpText?: string; label: string; children: React.ReactNode }) { return <label><span className="field-label mb-1.5 flex items-center gap-1">{label}<HelpTip help={help} label={label} text={helpText} /></span>{children}</label>; }
function EmptyState() { return <div className="mt-6 grid min-h-64 place-items-center rounded-[22px] border border-dashed border-line-steel bg-white p-6 text-center"><div><Sprout className="mx-auto text-accent" /><p className="mt-3 text-sm font-black text-ink-muted">No hay fundos disponibles</p><p className="mt-1 text-xs text-ink-subtle">Solicita acceso a un fundo antes de gestionar praderas.</p></div></div>; }
async function mutate(body: Record<string, unknown>) { const response = await fetch("/api/praderas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const payload = await response.json() as { error?: string }; if (!response.ok) throw new Error(payload.error ?? "La operación no pudo completarse."); return payload; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(date); }
function readArray(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function readString(value: unknown): string { return typeof value === "string" ? value : "—"; }
function readNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function formatClp(value: number): string { return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value); }
