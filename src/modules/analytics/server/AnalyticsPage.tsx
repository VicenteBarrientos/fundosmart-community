"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import { HelpTip } from "@/src/ui/Hint";
import { HELP, type HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { OwnHistorySection } from "../components/OwnHistorySection";
import type { OwnHistoryComparisonResult } from "../domain/own-history-comparison.d.mts";
import {
  buildAnalyticsCsv,
  formatAnalyticsDate,
  formatAnalyticsDateTime,
  shiftAnalyticsPeriod,
} from "../domain/analytics-presentation.mjs";
import type {
  AnalyticsAlert,
  AnalyticsMetric,
  AnalyticsProjection,
  AnalyticsThresholdConfiguration,
  AnalyticsThresholds,
} from "../domain/analytics-projection.mjs";
import type { AnalyticsDashboard } from "./analytics-repository";
import {
  Activity,
  AlertTriangle,
  Beef,
  CalendarDays,
  Calculator,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock3,
  Download,
  Droplets,
  FlaskConical,
  Gauge,
  HeartPulse,
  Link2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Weight,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type AnalyticsPageProps = {
  canConfigureThresholds: boolean;
  canRecompute: boolean;
  fields: Array<{ id: string; name: string }>;
  initialAnalytics: AnalyticsDashboard | null;
  initialFieldId: string;
  initialPeriod: string;
  ownHistory: {
    comparison: OwnHistoryComparisonResult | null;
    reason: string | null;
    periodsRead: number;
  } | null;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
};

const THRESHOLD_FIELDS: Array<{
  key: keyof AnalyticsThresholds;
  label: string;
  detail: string;
  step: string;
  min: number;
  max: number;
}> = [
  { key: "milkDropPct", label: "Caída de leche", detail: "% máximo, entre -100 y 0", step: "0.1", min: -100, max: 0 },
  { key: "somaticCellHigh", label: "RCS alto", detail: "células/mL", step: "1000", min: 0, max: 10_000_000 },
  { key: "somaticCellCritical", label: "RCS crítico", detail: "células/mL", step: "1000", min: 0, max: 10_000_000 },
  { key: "mastitisRatePct", label: "Mastitis alta", detail: "% del rebaño", step: "0.1", min: 0, max: 100 },
  { key: "pregnancyRatePctMinimum", label: "Preñez mínima", detail: "%", step: "0.1", min: 0, max: 100 },
  { key: "daysOpenMaximum", label: "Días abiertos", detail: "máximo", step: "1", min: 0, max: 3650 },
  { key: "calvingIntervalDaysMaximum", label: "Intervalo entre partos", detail: "días máximos", step: "1", min: 0, max: 3650 },
  { key: "averageDailyGainKgMinimum", label: "Ganancia diaria", detail: "kg/día mínimos", step: "0.01", min: -100, max: 100 },
  { key: "mortalityRatePctMaximum", label: "Mortalidad", detail: "% máximo", step: "0.1", min: 0, max: 100 },
  { key: "discardRatePctMaximum", label: "Descarte", detail: "% máximo", step: "0.1", min: 0, max: 100 },
  { key: "iofcMinimumClp", label: "IOFC", detail: "CLP mínimo", step: "1000", min: -1_000_000_000_000, max: 1_000_000_000_000 },
  { key: "expectedHeatCycleDays", label: "Celo esperado", detail: "días desde celo o servicio", step: "1", min: 1, max: 60 },
];

const KPI_KEYS = [
  "milk.volume_liters",
  "milk.production_per_cow_day_liters",
  "milk.somatic_cell_count",
  "reproduction.pregnancy_rate_pct",
  "lactation.days_in_milk_average",
  "weight.average_daily_gain_kg",
  "finance.iofc_clp",
] as const;

const KPI_COPY: Record<(typeof KPI_KEYS)[number], { icon: LucideIcon; label: string; tone: CardTone; help: HelpKey }> = {
  "milk.volume_liters": { icon: Droplets, label: "Leche del período", tone: "green", help: "analiticaLecheDelPeriodo" },
  "milk.production_per_cow_day_liters": { icon: Beef, label: "Litros por vaca-día", tone: "lime", help: "dashLitrosVacaDia" },
  "milk.somatic_cell_count": { icon: FlaskConical, label: "Recuento celular", tone: "default", help: "rcs" },
  "reproduction.pregnancy_rate_pct": { icon: HeartPulse, label: "Tasa de preñez", tone: "default", help: "analiticaTasaPrenez" },
  "lactation.days_in_milk_average": { icon: CalendarDays, label: "Días en leche", tone: "default", help: "del" },
  "weight.average_daily_gain_kg": { icon: Weight, label: "Ganancia diaria", tone: "default", help: "analiticaGananciaDiaria" },
  "finance.iofc_clp": { icon: TrendingUp, label: "Ingreso sobre alimento", tone: "dark", help: "analiticaIofc" },
};

type CardTone = "default" | "dark" | "green" | "lime" | "warning";
type PageMessage = {
  kind: "error" | "info" | "success";
  text: string;
  title: string;
};

const COMPARISON_KEYS = [
  "milk.volume_trend_pct",
  "milk.fat_pct_change_pp",
  "milk.protein_pct_change_pp",
  "milk.somatic_cell_trend_pct",
] as const;

const COMPARISON_COPY: Record<(typeof COMPARISON_KEYS)[number], { label: string; current: string; previous: string }> = {
  "milk.volume_trend_pct": { label: "Volumen diario", current: "Actual por día", previous: "Anterior por día" },
  "milk.fat_pct_change_pp": { label: "Grasa", current: "Actual", previous: "Anterior" },
  "milk.protein_pct_change_pp": { label: "Proteína", current: "Actual", previous: "Anterior" },
  "milk.somatic_cell_trend_pct": { label: "Recuento celular", current: "Actual", previous: "Anterior" },
};

const SECTION_LINKS = [
  ["resumen", "Resumen"],
  ["comparacion", "Comparación"],
  ["historia", "Su historia"],
  ["lactancia", "Lactancia"],
  ["sujetos", "Vacas y lotes"],
  ["alertas", "Alertas"],
  ["calidad", "Calidad"],
  ["evidencia", "Evidencia"],
] as const;

export function AnalyticsPage(props: AnalyticsPageProps) {
  const [fieldId, setFieldId] = useState(props.initialFieldId);
  const [period, setPeriod] = useState(props.initialPeriod);
  const [analytics, setAnalytics] = useState(props.initialAnalytics);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState<AnalyticsThresholds | null>(
    props.initialAnalytics ? { ...props.initialAnalytics.thresholdConfiguration.thresholds } : null,
  );
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const committedSelection = useRef({ fieldId: props.initialFieldId, period: props.initialPeriod });
  const fieldName = props.fields.find((field) => field.id === fieldId)?.name ?? "Analítica";

  useEffect(() => () => requestController.current?.abort(), []);

  async function loadSelection(nextFieldId: string, nextPeriod: string, propagateError = false) {
    if (!nextFieldId) return;
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setFieldId(nextFieldId);
    setPeriod(nextPeriod);
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/analitica?fieldId=${encodeURIComponent(nextFieldId)}&period=${encodeURIComponent(nextPeriod)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = await response.json() as { analytics?: AnalyticsDashboard; error?: string };
      if (!response.ok || !body.analytics) throw new Error(body.error || "No fue posible cargar el período.");
      if (requestSequence.current === requestId) {
        committedSelection.current = { fieldId: nextFieldId, period: nextPeriod };
        setAnalytics(body.analytics);
        setThresholdDraft({ ...body.analytics.thresholdConfiguration.thresholds });
        replaceSelectionUrl(nextFieldId, nextPeriod);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (requestSequence.current === requestId) {
        setFieldId(committedSelection.current.fieldId);
        setPeriod(committedSelection.current.period);
        setMessage({
          kind: "error",
          title: "No se cambió la revisión",
          text: cause instanceof Error ? cause.message : "No fue posible cargar el período.",
        });
      }
      if (propagateError) throw cause;
    } finally {
      if (requestSequence.current === requestId) {
        setLoading(false);
        requestController.current = null;
      }
    }
  }

  function changeField(nextFieldId: string) {
    void loadSelection(nextFieldId, period);
  }

  function changePeriod(nextPeriod: string) {
    void loadSelection(fieldId, nextPeriod);
  }

  const projection = analytics?.projection ?? null;
  const metricByKey = useMemo(
    () => new Map(projection?.metrics.map((metric) => [metric.key, metric]) ?? []),
    [projection],
  );
  const triggered = useMemo(
    () => [...(projection?.alerts ?? [])].sort((left, right) => (
      Number(right.severity === "critical") - Number(left.severity === "critical")
      || left.code.localeCompare(right.code)
    )),
    [projection],
  );
  const lactationCurve = projection?.metrics.filter((metric) => metric.key.startsWith("lactation.curve.dim_")) ?? [];
  const animalProduction = projection?.metrics.filter((metric) => metric.key.startsWith("milk.production.animal:")) ?? [];
  const animalCurves = projection?.metrics.filter((metric) => metric.key.startsWith("lactation.curve.animal:")) ?? [];
  const lotProduction = projection?.metrics.filter((metric) => metric.key.startsWith("milk.production.lot:")) ?? [];
  const lotCurves = projection?.metrics.filter((metric) => metric.key.startsWith("lactation.curve.lot:")) ?? [];
  const lotHistoryCoverage = metricByKey.get("lactation.historical_lot_membership_coverage_pct");
  const unavailableAlerts = projection?.alertEvaluations.filter((alert) => alert.status === "unavailable").length ?? 0;
  const criticalAlerts = triggered.filter((alert) => alert.severity === "critical").length;
  const availableDomains = projection
    ? Object.values(projection.quality.domains).filter((state) => state === "available").length
    : 0;
  const domainCount = projection ? Object.keys(projection.quality.domains).length : 0;
  const thresholdDirty = Boolean(
    analytics
    && thresholdDraft
    && THRESHOLD_FIELDS.some((field) => thresholdDraft[field.key] !== analytics.thresholdConfiguration.thresholds[field.key]),
  );

  function movePeriod(delta: number) {
    void loadSelection(fieldId, shiftAnalyticsPeriod(period, delta));
  }

  async function copySelectionLink() {
    if (!fieldId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("fieldId", fieldId);
    url.searchParams.set("period", period);
    try {
      await navigator.clipboard.writeText(url.toString());
      setMessage({
        kind: "success",
        title: "Enlace copiado",
        text: "La URL abre este mismo fundo y período con el alcance de quien la reciba.",
      });
    } catch {
      setMessage({
        kind: "error",
        title: "No fue posible copiar",
        text: "Copia la dirección del navegador; ya contiene el fundo y período seleccionados.",
      });
    }
  }

  function downloadEvidence() {
    if (!analytics?.projection) return;
    const csv = buildAnalyticsCsv(analytics);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `fundosmart-analitica-${safeFilename(analytics.field.name)}-${period}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setMessage({
      kind: "success",
      title: "Evidencia exportada",
      text: "El CSV incluye indicadores, reglas, numeradores, denominadores, fuentes y revisión de cálculo.",
    });
  }

  async function requestRecompute() {
    if (!fieldId || !props.canRecompute) return;
    setQueueing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/analitica/recalcular", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          fieldId,
          period,
          expectedSourceRevision: projection?.reference.datasetRevision ?? null,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "No fue posible solicitar el recálculo.");
      setMessage({
        kind: "success",
        title: "Recálculo en cola",
        text: "La revisión publicada permanece visible y no cambia hasta que el trabajo termine.",
      });
    } catch (cause) {
      setMessage({
        kind: "error",
        title: "No se pudo encolar",
        text: cause instanceof Error ? cause.message : "No fue posible solicitar el recálculo.",
      });
    } finally {
      setQueueing(false);
    }
  }

  async function saveThresholds() {
    if (!fieldId || !analytics || !thresholdDraft || !props.canConfigureThresholds || analytics.field.isDemo) return;
    setSavingThresholds(true);
    setMessage(null);
    try {
      const response = await fetch("/api/analitica/umbrales", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          fieldId,
          expectedRevision: analytics.thresholdConfiguration.revision,
          thresholds: thresholdDraft,
        }),
      });
      const body = await response.json() as { thresholdConfiguration?: AnalyticsThresholdConfiguration; error?: string };
      if (!response.ok || !body.thresholdConfiguration) throw new Error(body.error || "No fue posible guardar los umbrales.");
      setAnalytics((current) => current ? { ...current, thresholdConfiguration: body.thresholdConfiguration! } : current);
      setThresholdDraft({ ...body.thresholdConfiguration.thresholds });
      setMessage({
        kind: "success",
        title: "Umbrales versionados",
        text: "Se creó una revisión inmutable. Solicita el recálculo para publicar alertas con este snapshot.",
      });
    } catch (cause) {
      setMessage({
        kind: "error",
        title: "No se guardaron los umbrales",
        text: cause instanceof Error ? cause.message : "No fue posible guardar los umbrales.",
      });
    } finally {
      setSavingThresholds(false);
    }
  }

  return (
    <AppShell activeSection="analitica" fieldName={fieldName} isDemo={props.isDemo} onRefresh={() => loadSelection(fieldId, period, true)} organizationId={props.organizationId} organizationName={props.organizationName} userName={props.userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-5 2xl:flex-row 2xl:items-end 2xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent"><span className="size-1.5 rounded-full bg-accent" /> Analítica explicable</div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Una lectura honesta del fundo</h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">Indicadores productivos, reproductivos y económicos con fórmula, muestra y calidad visibles. La ausencia de registros nunca se presenta como cero.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(190px,1fr)_minmax(220px,1fr)] xl:grid-cols-[minmax(190px,1fr)_minmax(220px,1fr)_auto]">
              <FieldSelect label="Fundo" onChange={changeField} value={fieldId}>
                {props.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
              </FieldSelect>
              <label className="grid gap-1 text-[12px] font-black uppercase tracking-wide text-ink-subtle">
                <span>Período</span>
                <span className="grid grid-cols-[44px_minmax(0,1fr)_44px] overflow-hidden rounded-xl border border-line-steel bg-white">
                  <button aria-label="Período anterior" className="grid min-h-11 place-items-center border-r border-line-steel text-ink-muted transition hover:bg-surface-alt disabled:opacity-45" disabled={loading || !fieldId} onClick={() => movePeriod(-1)} type="button"><ChevronLeft size={16} /></button>
                  <input className="min-w-0 bg-white px-3 text-xs font-black text-ink outline-none" disabled={loading || !fieldId} onChange={(event) => changePeriod(event.target.value)} type="month" value={period} />
                  <button aria-label="Período siguiente" className="grid min-h-11 place-items-center border-l border-line-steel text-ink-muted transition hover:bg-surface-alt disabled:opacity-45" disabled={loading || !fieldId} onClick={() => movePeriod(1)} type="button"><ChevronRight size={16} /></button>
                </span>
              </label>
              <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-1">
                <button aria-label="Copiar enlace a esta selección" className="grid size-11 place-items-center rounded-xl border border-line-steel bg-white text-ink-muted transition hover:bg-surface-alt disabled:opacity-45" disabled={!fieldId} onClick={() => void copySelectionLink()} title="Copiar enlace" type="button"><Link2 size={15} /></button>
                <button className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition hover:bg-surface-alt disabled:opacity-45" disabled={!projection} onClick={downloadEvidence} type="button"><Download size={15} /> CSV</button>
                {props.canRecompute && (
                  <button className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white shadow-lg shadow-ink/10 disabled:opacity-50" data-hint={HELP.analiticaRecalcular} disabled={queueing || loading || !fieldId} onClick={() => void requestRecompute()} type="button">
                    <RefreshCw className={queueing ? "animate-spin" : ""} size={15} /> {queueing ? "Encolando" : "Recalcular"}
                  </button>
                )}
              </div>
            </div>
          </header>

          {props.isDemo && <Notice icon={ShieldCheck} kind="info" text="Todos los registros y resultados de esta vista son sintéticos y pertenecen solo a Fundo El Ejemplo." title="Analítica de demostración" />}
          {message && <Notice icon={message.kind === "error" ? AlertTriangle : message.kind === "success" ? CheckCircle2 : Clock3} kind={message.kind} text={message.text} title={message.title} />}
          {loading && <LoadingPanel />}

          {projection && (
            <nav aria-label="Secciones de Analítica" className="mt-5 flex gap-2 overflow-x-auto rounded-2xl border border-line-steel bg-white p-2 shadow-[0_6px_24px_rgba(35,50,42,0.04)]">
              {SECTION_LINKS.map(([id, label]) => <a className="shrink-0 rounded-xl px-3 py-2 text-[12px] font-black text-ink-muted transition hover:bg-surface-alt hover:text-ink" href={`#${id}`} key={id}>{label}</a>)}
            </nav>
          )}

          {analytics && thresholdDraft && (
            <ThresholdConfigurationPanel
              configuration={analytics.thresholdConfiguration}
              dirty={thresholdDirty}
              draft={thresholdDraft}
              editable={props.canConfigureThresholds && !analytics.field.isDemo}
              onChange={(key, value) => setThresholdDraft((current) => current ? { ...current, [key]: value } : current)}
              onReset={() => setThresholdDraft({ ...analytics.thresholdConfiguration.thresholds })}
              onSave={() => void saveThresholds()}
              projectionConfiguration={analytics.projectionThresholdConfiguration}
              saving={savingThresholds}
            />
          )}

          {props.fields.length === 0 && (
            <EmptyPanel text="No hay fundos con Analítica habilitada para esta membresía." title="Función aún no habilitada" />
          )}
          {props.fields.length > 0 && !projection && (
            <EmptyPanel
              text={props.canRecompute ? "Solicita el primer recálculo. El servidor publicará la proyección completa solo cuando termine." : "Todavía no existe una proyección publicada para este período."}
              title="Sin proyección publicada"
            />
          )}

          {projection && (
            <div aria-busy={loading}>
              <section className="scroll-mt-24" id="resumen">
                <ExecutiveSummary
                  availableDomains={availableDomains}
                  criticalAlerts={criticalAlerts}
                  domainCount={domainCount}
                  projection={projection}
                  triggeredAlerts={triggered.length}
                  unavailableAlerts={unavailableAlerts}
                />
                <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4 2xl:grid-cols-7">
                  {KPI_KEYS.map((key) => <KpiCard copy={KPI_COPY[key]} key={key} metric={metricByKey.get(key)} />)}
                </div>
              </section>

              <section className="mt-5 scroll-mt-24" id="comparacion">
                <Panel eyebrow={`${projection.window.comparison.dayCount} días contra ${projection.window.dayCount} días`} helpText="Cada comparación usa ventanas de igual longitud cuando el mes sigue abierto." icon={TrendingUp} title="Qué cambió frente al período anterior">
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {COMPARISON_KEYS.map((key) => <ComparisonCard copy={COMPARISON_COPY[key]} key={key} metric={metricByKey.get(key)} />)}
                  </div>
                </Panel>
              </section>

              <section className="mt-5 scroll-mt-24" id="historia">
                <OwnHistorySection
                  comparison={props.ownHistory?.comparison ?? null}
                  fieldName={analytics?.field.name ?? ""}
                  periodsRead={props.ownHistory?.periodsRead ?? 0}
                  reason={props.ownHistory?.reason ?? null}
                />
              </section>

              <section className="mt-5 scroll-mt-24" id="lactancia">
                <Panel eyebrow="Controles individuales vinculados · DEL 1–305" help="analiticaCurvaReconstruible" icon={Activity} title="Curva de lactancia reconstruible">
                  <p className="mt-4 max-w-3xl text-[12px] leading-4 text-ink-subtle">Cada tramo muestra el promedio de litros de los controles lecheros enlazados a una lactancia. Los tramos sin muestra permanecen vacíos y cada valor conserva sus controles fuente.</p>
                  <LactationCurve metrics={lactationCurve} />
                </Panel>
              </section>

              <section className="mt-5 grid scroll-mt-24 gap-5 xl:grid-cols-2" id="sujetos">
                <Panel eyebrow={`${animalProduction.length} vacas con lactancia`} help="analiticaProduccionPorVaca" icon={Beef} title="Producción y curva por vaca">
                  <SubjectAnalytics curves={animalCurves} empty="No hay lactancias individuales enlazadas." production={animalProduction} searchLabel="Buscar vaca por etiqueta o identificador" />
                </Panel>
                <Panel eyebrow="Pertenencia vigente a la fecha del control" help="analiticaProduccionPorLote" icon={Activity} title="Producción y curva por lote">
                  {lotHistoryCoverage?.status === "unavailable" && (
                    <p className="mt-4 rounded-xl border border-warn-bar bg-warn-bg p-3 text-[12px] leading-4 text-warn-ink">No existe historial temporal suficiente para atribuir estos controles a un lote. FundoSmart los deja explícitamente sin atribución y nunca usa el lote actual como sustituto.</p>
                  )}
                  {lotHistoryCoverage?.status === "partial" && (
                    <p className="mt-4 rounded-xl border border-warn-bar bg-warn-bg p-3 text-[12px] leading-4 text-warn-ink">Solo {formatMetricNumber(lotHistoryCoverage.value, "percent")} de los controles enlazados tiene una pertenencia histórica resoluble. Los restantes no se atribuyen.</p>
                  )}
                  <SubjectAnalytics curves={lotCurves} empty="Sin controles atribuibles a lotes históricos." production={lotProduction} searchLabel="Buscar lote por nombre o identificador" />
                </Panel>
              </section>

              <section className="mt-5 grid scroll-mt-24 gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(330px,0.75fr)]" id="alertas">
                <Panel eyebrow={`${triggered.length} activas · ${unavailableAlerts} no evaluables`} help="analiticaAlertas" icon={AlertTriangle} title="Alertas con evidencia">
                  {triggered.length > 0
                    ? <div className="mt-5 grid gap-3">{triggered.map((alert) => <AlertCard alert={alert} key={alert.code} />)}</div>
                    : <div className="mt-5 flex items-start gap-3 rounded-2xl bg-surface-alt p-4"><CheckCircle2 className="mt-0.5 shrink-0 text-accent" size={19} /><div><p className="text-xs font-black text-ink">Sin alertas activas</p><p className="mt-1 text-[12px] leading-4 text-ink-subtle">Esto solo significa que ninguna regla evaluable cruzó su umbral; revisa también las reglas sin datos.</p></div></div>}
                  <details className="mt-4 rounded-2xl border border-line-steel">
                    <summary className="cursor-pointer list-none px-4 py-3 text-[12px] font-black text-ink-muted">Ver {projection.alertEvaluations.length - triggered.length} reglas sin alerta activa</summary>
                    <div className="grid gap-2 border-t border-line-steel p-3 sm:grid-cols-2">
                      {projection.alertEvaluations.filter((alert) => alert.status !== "triggered").map((alert) => (
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-line-steel px-3 py-2.5" key={alert.code}>
                          <span className="truncate text-[12px] font-black text-ink-muted">{alertLabel(alert.code)}</span>
                          <StatusPill status={alert.status} />
                        </div>
                      ))}
                    </div>
                  </details>
                </Panel>

                <div className="grid scroll-mt-24 gap-5" id="calidad">
                  <Panel eyebrow="Cobertura de fuentes" help="analiticaCobertura" icon={Gauge} title="Calidad de la revisión">
                    <div className="mt-5 flex items-center justify-between rounded-2xl bg-surface-alt p-4"><div><p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Estado</p><p className="mt-1 text-lg font-black text-ink">{qualityLabel(projection.quality.state)}</p></div><QualityIcon state={projection.quality.state} /></div>
                    <div className="mt-4 grid grid-cols-2 gap-2">{Object.entries(projection.quality.domains).map(([domain, state]) => <DomainStatus domain={domain} key={domain} state={state} />)}</div>
                    {projection.quality.issues.length > 0 && <p className="mt-4 text-[12px] leading-4 text-warn-ink">{projection.quality.issues.reduce((sum, issue) => sum + issue.count, 0)} observaciones de calidad permanecen visibles; los outliers no fueron eliminados.</p>}
                  </Panel>
                  <Panel eyebrow="Revisión inmutable" help="analiticaTrazabilidadCalculo" icon={Activity} title="Trazabilidad del cálculo">
                    <Detail label="Ventana" value={`${formatAnalyticsDate(projection.window.start)} — ${formatAnalyticsDate(projection.window.end)}`} />
                    <Detail label="Comparación" value={`${formatAnalyticsDate(projection.window.comparison.start)} — ${formatAnalyticsDate(projection.window.comparison.end)}`} />
                    <Detail label="Estado del período" value={projection.window.complete ? "Mes completo" : `Corte parcial · ${projection.window.dayCount} días`} />
                    <Detail label="Resultados completos" value={projection.reference.sourceCoverage.outcomesComplete ? "Confirmados" : "No confirmados"} />
                    <Detail label="Revisión fuente" value={projection.reference.datasetRevision?.slice(0, 12) ?? "Sin revisión"} mono />
                    <Detail label="Motor" value={`${projection.recommendationEngine.adapterId} · ${projection.recommendationEngine.strategy}`} mono />
                    <Detail label="Calculado" value={formatAnalyticsDateTime(projection.computedAt)} />
                  </Panel>
                </div>
              </section>

              <section className="mt-5 scroll-mt-24" id="evidencia"><Panel eyebrow="Numerador, denominador y método" help="analiticaDetalleIndicadores" icon={Calculator} title="Detalle de indicadores"><MetricTable metrics={projection.metrics} /></Panel></section>
              <p className="pb-8 pt-5 text-right text-[12px] font-bold text-ink-subtle">Las alertas apoyan decisiones operativas; no sustituyen diagnóstico veterinario ni asesoría profesional.</p>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function ThresholdConfigurationPanel({
  configuration,
  dirty,
  draft,
  editable,
  onChange,
  onReset,
  onSave,
  projectionConfiguration,
  saving,
}: {
  configuration: AnalyticsThresholdConfiguration;
  dirty: boolean;
  draft: AnalyticsThresholds;
  editable: boolean;
  onChange: (key: keyof AnalyticsThresholds, value: number) => void;
  onReset: () => void;
  onSave: () => void;
  projectionConfiguration: AnalyticsThresholdConfiguration | null;
  saving: boolean;
}) {
  const pendingRecompute = projectionConfiguration !== null && projectionConfiguration.revision !== configuration.revision;
  return (
    <details className="group mt-5 rounded-[20px] border border-line-steel bg-white shadow-[0_8px_28px_rgba(35,50,42,0.04)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-4 sm:p-5">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent"><Settings2 size={18} /></span>
          <span className="min-w-0">
            <span className="block text-[12px] font-black uppercase tracking-[0.13em] text-ink-subtle">Configuración avanzada</span>
            <span className="mt-0.5 block truncate text-sm font-black text-ink">Umbrales versionados · {configuration.revision.slice(0, 12)}</span>
          </span>
        </span>
        <span className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-black ${pendingRecompute ? "bg-warn-bg text-warn-ink" : dirty ? "bg-ink text-white" : "bg-surface-alt text-ink-muted"}`}>
          {pendingRecompute ? "Recálculo pendiente" : dirty ? "Cambios sin guardar" : editable ? "Editar" : "Solo lectura"}
        </span>
      </summary>
      <div className="border-t border-line-steel p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.13em] text-ink-subtle">Motor de recomendación por reglas</p>
            <h2 className="mt-0.5 text-base font-black text-ink">Snapshot completo por recálculo</h2>
            <p className="mt-1 max-w-3xl text-[12px] leading-4 text-ink-subtle">Cambiar esta configuración crea una revisión nueva y nunca reescribe alertas publicadas.</p>
          </div>
          <div className="rounded-xl bg-surface-alt px-3 py-2 text-right">
            <p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Revisión vigente</p>
            <p className="mt-1 font-mono text-[12px] font-black text-ink-muted">{configuration.revision.slice(0, 12)}</p>
            <p className="mt-1 text-[12px] font-bold text-ink-subtle">{configuration.source === "default" ? "Valores por defecto" : "Configuración del fundo"}</p>
          </div>
        </div>
        {pendingRecompute && <p className="mt-4 rounded-xl border border-warn-bar bg-warn-bg px-3 py-2 text-[12px] font-bold text-warn-ink">La proyección visible usa {projectionConfiguration.revision.slice(0, 12)}. Recalcula para aplicar la revisión vigente.</p>}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {THRESHOLD_FIELDS.map((field) => (
            <label className="grid gap-1 rounded-xl border border-line-steel p-3" key={field.key}>
              <span className="text-[12px] font-black text-ink-muted">{field.label}</span>
              <input
                className="h-9 rounded-lg border border-line-steel bg-surface-alt px-2 text-xs font-black text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-65"
                disabled={!editable || saving}
                max={field.max}
                min={field.min}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) onChange(field.key, value);
                }}
                step={field.step}
                type="number"
                value={draft[field.key]}
              />
              <span className="text-[12px] text-ink-subtle">{field.detail}</span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line-steel pt-4">
          <p className="text-[12px] font-bold text-ink-subtle">{editable ? "Guardar requiere un recálculo posterior para publicar las reglas nuevas." : "Configuración de solo lectura para esta cuenta o fundo."}</p>
          {editable && <div className="flex flex-wrap gap-2"><button className="flex min-h-10 items-center gap-2 rounded-xl border border-line-steel bg-white px-4 text-[12px] font-black text-ink-muted disabled:opacity-45" disabled={!dirty || saving} onClick={onReset} type="button"><RotateCcw size={14} /> Descartar cambios</button><button className="flex min-h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[12px] font-black text-white disabled:opacity-50" disabled={!dirty || saving} onClick={onSave} type="button"><Save size={14} /> {saving ? "Guardando" : "Guardar umbrales"}</button></div>}
        </div>
      </div>
    </details>
  );
}

function FieldSelect({ children, label, onChange, value }: { children?: React.ReactNode; label: string; onChange: (value: string) => void; value: string }) {
  return <label className="grid gap-1 text-[12px] font-black uppercase tracking-wide text-ink-subtle"><span>{label}</span><select className="h-11 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink outline-none focus:border-accent" disabled={!children} onChange={(event) => onChange(event.target.value)} value={value}>{children}</select></label>;
}

function Notice({ icon: Icon, kind, text, title }: { icon: LucideIcon; kind: PageMessage["kind"]; text: string; title: string }) {
  const styles = {
    error: "border-alert-bar/30 bg-alert-bg text-alert-ink",
    info: "border-accent bg-ink text-white",
    success: "border-accent bg-ok-bg text-ok-ink",
  }[kind];
  const iconTone = kind === "info" ? "bg-accent text-ink" : "bg-white/70";
  return <section aria-live={kind === "error" ? "assertive" : "polite"} className={`mt-5 flex items-start gap-3 rounded-[18px] border p-4 ${styles}`} role={kind === "error" ? "alert" : "status"}><span className={`grid size-9 shrink-0 place-items-center rounded-xl ${iconTone}`}><Icon size={17} /></span><div><p className="text-xs font-black">{title}</p><p className={`mt-1 text-[12px] leading-4 ${kind === "info" ? "text-white/70" : "opacity-80"}`}>{text}</p></div></section>;
}

function LoadingPanel() {
  return <div aria-live="polite" className="mt-5 flex items-center gap-3 rounded-[16px] border border-line-steel bg-white px-4 py-3 text-xs font-black text-ink-muted" role="status"><RefreshCw className="animate-spin text-accent" size={16} /> Cargando revisión publicada; la anterior permanece visible…</div>;
}

function EmptyPanel({ text, title }: { text: string; title: string }) {
  return <section className="mt-6 rounded-[20px] border border-dashed border-line-steel bg-surface-alt p-10 text-center"><CircleDashed className="mx-auto text-accent" size={28} /><h2 className="mt-3 text-lg font-black text-ink">{title}</h2><p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-ink-subtle">{text}</p></section>;
}

function LactationCurve({ metrics }: { metrics: AnalyticsMetric[] }) {
  if (metrics.length === 0) return <p className="mt-4 rounded-xl bg-surface-alt p-4 text-[12px] text-ink-subtle">Sin controles vinculados.</p>;
  const maximum = Math.max(0, ...metrics.flatMap((metric) => metric.value === null ? [] : [metric.value]));
  const rows = <div className="grid gap-2">{metrics.map((metric) => {
    const bucket = /dim_(\d{3})_(\d{3})_liters$/u.exec(metric.key);
    const label = bucket ? `DEL ${Number(bucket[1])}–${Number(bucket[2])}` : metric.key;
    const width = metric.value !== null && maximum > 0 ? Math.max(3, (metric.value / maximum) * 100) : 0;
    return <div className="grid grid-cols-[74px_minmax(0,1fr)_88px] items-center gap-3" key={metric.key}>
      <span className="text-[12px] font-black text-ink-muted">{label}</span>
      <div className="h-8 overflow-hidden rounded-lg bg-surface-alt">{metric.value === null
        ? <span className="flex h-full items-center px-3 text-[12px] font-bold text-ink-subtle">Sin controles vinculados</span>
        : <div className="flex h-full min-w-fit items-center rounded-lg bg-gradient-to-r from-ink to-accent px-3 text-[12px] font-black text-white" style={{ width: `${width}%` }}>{formatMetricNumber(metric.value, metric.unit)}</div>}</div>
      <span className="text-right text-[12px] font-bold text-ink-subtle">{metric.sampleCount} control{metric.sampleCount === 1 ? "" : "es"}</span>
    </div>;
  })}</div>;
  if (metrics.every((metric) => metric.value === null)) {
    return <details className="mt-5 rounded-xl border border-line-steel"><summary className="cursor-pointer list-none px-4 py-3 text-[12px] font-black text-ink-muted">Sin controles vinculados · ver {metrics.length} tramos vacíos</summary><div className="border-t border-line-steel p-3">{rows}</div></details>;
  }
  return <div className="mt-5">{rows}</div>;
}

function SubjectAnalytics({
  curves,
  empty,
  production,
  searchLabel,
}: {
  curves: AnalyticsMetric[];
  empty: string;
  production: AnalyticsMetric[];
  searchLabel: string;
}) {
  const [query, setQuery] = useState("");
  if (production.length === 0) return <p className="mt-4 rounded-xl bg-surface-alt p-4 text-[12px] text-ink-subtle">{empty}</p>;
  const normalizedQuery = query.trim().toLocaleLowerCase("es");
  const filtered = production.filter((metric) => {
    const subject = metric.references.find((reference) => reference.subject)?.subject;
    return !normalizedQuery || `${subject?.label ?? ""} ${subject?.id ?? ""}`.toLocaleLowerCase("es").includes(normalizedQuery);
  });
  return <div className="mt-4"><label className="relative block"><span className="sr-only">{searchLabel}</span><Search className="pointer-events-none absolute left-3.5 top-3 text-ink-subtle" size={14} /><input className="h-10 w-full rounded-xl border border-line-steel bg-surface-alt pl-10 pr-3 text-[12px] font-bold text-ink outline-none focus:border-accent" onChange={(event) => setQuery(event.target.value)} placeholder={searchLabel} type="search" value={query} /></label><div className="mt-3 grid max-h-[680px] gap-3 overflow-y-auto pr-1">{filtered.map((metric) => {
    const subject = metric.references.find((reference) => reference.subject)?.subject;
    const kind = subject?.type;
    const id = subject?.id;
    const subjectCurves = kind && id
      ? curves.filter((entry) => entry.references.some((reference) => reference.subject?.type === kind && reference.subject.id === id))
      : [];
    return <details className="rounded-2xl border border-line-steel" key={metric.key}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-4">
        <span><span className="block text-xs font-black text-ink">{subject?.label ?? "Sin etiqueta"}</span><span className="mt-1 block text-[12px] font-mono text-ink-subtle">{subject?.id ?? "sin-identidad"}</span></span>
        <span className="text-right"><span className="block text-[12px] font-black uppercase text-ink-subtle">Producción</span><span className="mt-1 block text-sm font-black text-accent">{metricValue(metric)}</span></span>
      </summary>
      <div className="border-t border-line-steel px-4 pb-4"><LactationCurve metrics={subjectCurves} /></div>
    </details>;
  })}{filtered.length === 0 && <p className="rounded-xl bg-surface-alt p-4 text-[12px] text-ink-subtle">No hay coincidencias para esta búsqueda.</p>}</div></div>;
}

function ExecutiveSummary({
  availableDomains,
  criticalAlerts,
  domainCount,
  projection,
  triggeredAlerts,
  unavailableAlerts,
}: {
  availableDomains: number;
  criticalAlerts: number;
  domainCount: number;
  projection: AnalyticsProjection & { computedAt: string };
  triggeredAlerts: number;
  unavailableAlerts: number;
}) {
  const headline = criticalAlerts > 0
    ? `${criticalAlerts} alerta${criticalAlerts === 1 ? "" : "s"} crítica${criticalAlerts === 1 ? "" : "s"} requiere${criticalAlerts === 1 ? "" : "n"} revisión`
    : triggeredAlerts > 0
      ? `${triggeredAlerts} señal${triggeredAlerts === 1 ? "" : "es"} operativa${triggeredAlerts === 1 ? "" : "s"} activa${triggeredAlerts === 1 ? "" : "s"}`
      : "Ninguna regla evaluable cruzó su umbral";
  const detail = projection.window.complete
    ? `Mes completo: ${formatAnalyticsDate(projection.window.start)} a ${formatAnalyticsDate(projection.window.end)}.`
    : `Corte parcial al ${formatAnalyticsDate(projection.window.end)}: ${projection.window.dayCount} días comparados contra otros ${projection.window.comparison.dayCount}.`;
  return <section className="mt-6 grid gap-3 lg:grid-cols-[minmax(0,1.65fr)_repeat(3,minmax(0,0.65fr))]">
    <article className="rounded-[20px] border border-ink bg-ink p-5 text-white shadow-[0_10px_34px_rgba(35,50,42,0.12)]"><p className="text-[12px] font-black uppercase tracking-[0.14em] text-white/55">Lectura ejecutiva</p><h2 className="mt-2 text-xl font-black tracking-[-0.035em]">{headline}</h2><p className="mt-2 max-w-2xl text-[12px] leading-5 text-white/65">{detail} La cobertura determina qué conclusiones pueden sostenerse.</p></article>
    <SummaryMetric label="Alertas activas" tone={criticalAlerts > 0 ? "critical" : triggeredAlerts > 0 ? "warning" : "ok"} value={String(triggeredAlerts)} />
    <SummaryMetric label="Dominios completos" tone={availableDomains === domainCount ? "ok" : "warning"} value={`${availableDomains}/${domainCount}`} />
    <SummaryMetric label="Reglas sin datos" tone={unavailableAlerts > 0 ? "warning" : "ok"} value={String(unavailableAlerts)} />
  </section>;
}

function SummaryMetric({ label, tone, value }: { label: string; tone: "critical" | "ok" | "warning"; value: string }) {
  const style = tone === "critical" ? "border-alert-bar bg-alert-bg text-alert-ink" : tone === "warning" ? "border-warn-bar bg-warn-bg text-warn-ink" : "border-accent bg-ok-bg text-ok-ink";
  return <article className={`rounded-[20px] border p-4 ${style}`}><p className="text-[12px] font-black uppercase tracking-[0.11em] opacity-70">{label}</p><p className="mt-3 text-2xl font-black tracking-[-0.04em]">{value}</p></article>;
}

function ComparisonCard({ copy, metric }: { copy: { label: string; current: string; previous: string }; metric?: AnalyticsMetric }) {
  return <article className="rounded-2xl border border-line-steel bg-surface-alt p-4">
    <div className="flex items-center justify-between gap-3"><p className="text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle">{copy.label}</p>{metric && <MetricStatus status={metric.status} />}</div>
    <p className="mt-3 text-xl font-black tracking-[-0.04em] text-ink">{metricValue(metric)}</p>
    {metric?.value === null || !metric
      ? <p className="mt-2 min-h-9 text-[12px] leading-4 text-ink-subtle">{statusReason(metric?.statusReason)}</p>
      : <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]"><div><dt className="font-bold text-ink-subtle">{copy.current}</dt><dd className="mt-1 font-black text-ink">{comparisonOperand(metric, metric.numerator)}</dd></div><div><dt className="font-bold text-ink-subtle">{copy.previous}</dt><dd className="mt-1 font-black text-ink">{comparisonOperand(metric, metric.denominator)}</dd></div></dl>}
  </article>;
}

function KpiCard({ copy, metric }: { copy: { icon: LucideIcon; label: string; tone: CardTone; help: HelpKey }; metric?: AnalyticsMetric }) {
  const Icon = copy.icon;
  const tones = {
    default: "border-line-steel bg-white text-ink",
    dark: "border-ink bg-ink text-white",
    green: "border-line-steel bg-surface-alt text-ink",
    lime: "border-accent bg-surface-alt text-ink",
    warning: "border-warn-bar bg-surface-alt text-warn-ink",
  }[copy.tone];
  const dim = copy.tone === "dark" ? "text-white/55" : "text-ink-subtle";
  return <article className={`min-w-0 rounded-[18px] border p-4 shadow-[0_6px_24px_rgba(35,50,42,0.04)] ${tones}`}><div className="flex items-center justify-between gap-3"><p className={`flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.11em] ${dim}`}>{copy.label}<HelpTip help={copy.help} label={copy.label} tone={copy.tone === "dark" ? "inverse" : "muted"} /></p><Icon className={copy.tone === "dark" ? "text-white" : "text-accent"} size={16} /></div><p className="mt-3 truncate text-xl font-black tracking-[-0.045em]">{metricValue(metric)}</p><p className={`mt-1 min-h-8 text-[12px] leading-4 ${dim}`}>{metric?.value === null || !metric ? statusReason(metric?.statusReason) : `${metric.sampleCount} registros · ${methodLabel(metric.method)}`}</p></article>;
}

function Panel({ children, eyebrow, help, helpText, icon: Icon, title }: { children: React.ReactNode; eyebrow: string; help?: HelpKey; helpText?: string; icon: LucideIcon; title: string }) {
  return <section className="min-w-0 rounded-[20px] border border-line-steel bg-white p-5 shadow-[0_8px_28px_rgba(35,50,42,0.04)]"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-surface-alt text-accent"><Icon size={18} /></span><div><p className="text-[12px] font-black uppercase tracking-[0.13em] text-ink-subtle">{eyebrow}</p><h2 className="mt-0.5 flex items-center gap-1.5 text-base font-black text-ink">{title}<HelpTip help={help} label={title} text={helpText} /></h2></div></div>{children}</section>;
}

function AlertCard({ alert }: { alert: AnalyticsAlert }) {
  const critical = alert.severity === "critical";
  return <article className={`rounded-2xl border p-4 ${critical ? "border-alert-bar bg-alert-bg" : "border-warn-bar bg-warn-bg"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className={`text-[12px] font-black uppercase tracking-wide ${critical ? "text-alert-ink" : "text-warn-ink"}`}>{critical ? "Crítica" : "Advertencia"}</p><h3 className="mt-1 text-sm font-black text-ink">{alertLabel(alert.code, alert.evidence.subject?.label)}</h3></div><span className="rounded-full bg-white px-3 py-1.5 text-[12px] font-black text-ink-muted shadow-sm">{operatorLabel(alert.evidence.operator)} {formatEvidence(alert.evidence.threshold, alert.evidence.unit)}</span></div><p className="mt-3 text-[12px] leading-4 text-ink-muted">{alert.explanation}</p><div className="mt-3 grid grid-cols-3 gap-2"><Evidence label="Observado" value={formatEvidence(alert.evidence.observed, alert.evidence.unit)} /><Evidence label="Muestra" value={String(alert.evidence.sampleCount)} /><Evidence label="Ventana" value={alert.window ? `${formatAnalyticsDate(alert.window.start)}–${formatAnalyticsDate(alert.window.end)}` : "Sin ventana"} /></div></article>;
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-white/80 p-2.5"><p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">{label}</p><p className="mt-1 truncate text-[12px] font-black text-ink-muted">{value}</p></div>;
}

function StatusPill({ status }: { status: AnalyticsAlert["status"] }) {
  const copy = status === "clear" ? "Sin alerta" : status === "unavailable" ? "Sin datos" : "Activa";
  const tone = status === "clear" ? "bg-surface-alt text-accent" : status === "unavailable" ? "bg-surface-alt text-ink-muted" : "bg-surface-alt text-alert-ink";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-black ${tone}`}>{copy}</span>;
}

function QualityIcon({ state }: { state: AnalyticsProjection["quality"]["state"] }) {
  if (state === "available") return <CheckCircle2 className="text-accent" size={25} />;
  if (state === "partial") return <AlertTriangle className="text-warn-ink" size={25} />;
  return <CircleDashed className="text-ink-subtle" size={25} />;
}

function DomainStatus({ domain, state }: { domain: string; state: string }) {
  const label = { milk: "Leche", reproduction: "Reproducción", lactation: "Lactancia", weight: "Pesajes", outcomes: "Salud y bajas", finance: "Finanzas" }[domain] ?? domain;
  return <div className="rounded-xl border border-line-steel p-3"><p className="text-[12px] font-black text-ink-muted">{label}</p><p className={`mt-1 text-[12px] font-black uppercase ${state === "available" ? "text-accent" : state === "partial" ? "text-warn-ink" : "text-ink-subtle"}`}>{qualityLabel(state)}</p></div>;
}

function Detail({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return <div className="mt-3 flex items-start justify-between gap-4 border-t border-line-steel pt-3 text-[12px]"><span className="font-bold text-ink-subtle">{label}</span><span className={`text-right font-black text-ink ${mono ? "font-mono" : ""}`}>{value}</span></div>;
}

function MetricTable({ metrics }: { metrics: AnalyticsMetric[] }) {
  return (
    <TableExplorer
      className="mt-5"
      description="Compara disponibilidad, valor, muestra y método de cálculo. Busca por indicador o filtra por estado para entender qué evidencia sostiene cada resultado."
      filter={{ label: "Filtrar métricas por estado", allLabel: "Todos los estados", columnIndex: 1 }}
      id="analitica.metricas"
      maxHeight="34rem"
      searchPlaceholder="Buscar indicador, estado, valor o método…"
      title="Detalle verificable de indicadores"
    >
      <table className="w-full min-w-[900px] border-separate border-spacing-0 text-left"><thead><tr>{["Indicador", "Estado", "Valor", "Numerador", "Denominador", "Muestra", "Método"].map((label) => <th className="border-b border-line-steel bg-surface-alt px-3 py-3 text-[12px] font-black uppercase tracking-wide text-ink-subtle" key={label}>{label}</th>)}</tr></thead><tbody>{metrics.map((metric) => <tr key={metric.key}><td className="border-b border-line-steel px-3 py-3"><p className="text-[12px] font-black text-ink-muted">{metricLabel(metric.key)}</p><p className="mt-0.5 text-[12px] text-ink-subtle">{metric.statusReason ? statusReason(metric.statusReason) : unitLabel(metric.unit)}</p></td><td className="border-b border-line-steel px-3 py-3"><MetricStatus status={metric.status} /></td><TableValue value={formatMetricNumber(metric.value, metric.unit)} /><TableValue value={plainNumber(metric.numerator)} /><TableValue value={plainNumber(metric.denominator)} /><TableValue value={String(metric.sampleCount)} /><TableValue value={methodLabel(metric.method)} /></tr>)}</tbody></table>
    </TableExplorer>
  );
}

function MetricStatus({ status }: { status: AnalyticsMetric["status"] }) {
  const copy = status === "available" ? "Disponible" : status === "partial" ? "Parcial" : status === "insufficient_data" ? "Insuficiente" : "Sin datos";
  const tone = status === "available" ? "bg-surface-alt text-accent" : status === "partial" || status === "insufficient_data" ? "bg-warn-bg text-warn-ink" : "bg-surface-alt text-ink-muted";
  return <span className={`rounded-full px-2.5 py-1 text-[12px] font-black ${tone}`}>{copy}</span>;
}

function TableValue({ value }: { value: string }) {
  return <td className="border-b border-line-steel px-3 py-3 text-[12px] font-bold text-ink-muted">{value}</td>;
}

function metricValue(metric?: AnalyticsMetric): string {
  if (!metric || metric.value === null) return "Sin datos";
  return formatMetricNumber(metric.value, metric.unit);
}

function formatMetricNumber(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "clp") return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
  if (unit === "cells_per_ml") return `${formatNumber(value, 0)} cél/mL`;
  if (unit === "percent") return `${formatNumber(value, 2)}%`;
  if (unit === "percentage_points") return `${signedNumber(value, 2)} pp`;
  if (unit === "liters") return `${formatNumber(value, 0)} L`;
  if (unit === "liters_per_cow_day") return `${formatNumber(value, 2)} L/vaca-día`;
  if (unit === "liters_per_control_day") return `${formatNumber(value, 2)} L/control`;
  if (unit === "kg") return `${formatNumber(value, 2)} kg`;
  if (unit === "kg_per_day") return `${formatNumber(value, 3)} kg/día`;
  if (unit === "days") return `${formatNumber(value, 1)} días`;
  if (unit === "animals") return `${formatNumber(value, 0)} animales`;
  if (unit === "clp_per_liter") return `$${formatNumber(value, 2)}/L`;
  return formatNumber(value, 3);
}

function formatEvidence(value: number | null, unit: string | null): string {
  return value === null ? "Sin dato" : formatMetricNumber(value, unit ?? "");
}

function plainNumber(value: number | null): string {
  return value === null ? "—" : formatNumber(value, 3);
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  return value.toLocaleString("es-CL", { maximumFractionDigits });
}

function signedNumber(value: number, maximumFractionDigits: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value, maximumFractionDigits)}`;
}

function comparisonOperand(metric: AnalyticsMetric, value: number | null): string {
  if (value === null) return "—";
  if (metric.key === "milk.volume_trend_pct") return `${formatNumber(value, 2)} L/día`;
  if (metric.key === "milk.somatic_cell_trend_pct") return `${formatNumber(value, 0)} cél/mL`;
  return `${formatNumber(value, 3)}%`;
}

function qualityLabel(value: string): string {
  return value === "available" ? "Completa" : value === "partial" ? "Parcial" : "Sin cobertura";
}

function statusReason(value: string | null | undefined): string {
  if (!value) return "Sin observaciones";
  return {
    no_current_production: "Sin producción actual",
    no_comparison_production: "Sin período comparable",
    zero_comparison_denominator: "El valor comparable es cero",
    zero_or_missing_cow_days: "Faltan vacas-día",
    conflicting_cow_count: "Denominador de vacas inconsistente",
    no_current_samples: "Sin muestras del período",
    no_comparison_samples: "Sin muestras comparables",
    no_current_somatic_cell_samples: "Sin muestras RCS",
    no_comparison_somatic_cell_samples: "Sin muestras RCS comparables",
    zero_eligible_cycles: "Sin ciclos elegibles",
    no_calving_history: "Sin historial de parto",
    no_active_lactations_at_cutoff: "Sin lactancias activas al corte",
    no_linked_milk_controls_in_dim_bucket: "Sin controles enlazados en este tramo",
    no_linked_milk_controls: "Sin controles individuales enlazados",
    no_individual_milk_controls_in_window: "Sin controles individuales en el período",
    historical_lot_membership_unavailable: "Sin historial temporal de lote",
    historical_lot_membership_partial: "Historial temporal de lote incompleto",
    fewer_than_two_calvings_per_animal: "Faltan dos partos por animal",
    fewer_than_two_distinct_weight_dates: "Faltan dos pesajes por animal",
    no_weight_samples: "Sin pesajes",
    outcome_source_not_confirmed_complete: "Cobertura de resultados no confirmada",
    no_herd_exposure: "Sin exposición de rebaño",
    zero_herd_exposure: "La exposición de rebaño es cero",
    no_feed_cost: "Sin costo de alimento",
    no_milk_revenue: "Sin ingreso de leche",
    no_cost_data: "Sin costos",
    zero_liter_denominator: "El volumen de leche es cero",
  }[value] ?? "Motivo no traducido; consulta la clave técnica en el CSV";
}

function methodLabel(value: string): string {
  return {
    sum: "Suma",
    arithmetic_mean: "Promedio",
    volume_weighted_mean: "Promedio ponderado",
    arithmetic_mean_without_complete_volume: "Promedio simple; falta volumen completo",
    difference_of_arithmetic_means: "Diferencia entre promedios",
    relative_change_of_period_averages: "Variación relativa entre promedios",
    daily_average_relative_change: "Variación del promedio diario",
    liters_divided_by_observed_cow_days: "Litros / vacas-día",
    conceptions_per_eligible_cycle: "Concepciones / ciclos",
    mean_days_from_latest_calving_to_conception_or_cutoff: "Promedio desde último parto a concepción o corte",
    mean_latest_calving_interval: "Promedio del último intervalo entre partos",
    mean_inclusive_days_from_lactation_start: "Promedio de DEL inclusivos",
    arithmetic_mean_of_linked_test_days_by_dim_bucket: "Promedio de controles por tramo DEL",
    arithmetic_mean_of_individual_test_days_in_window: "Promedio de controles del período",
    arithmetic_mean_of_animal_test_days_by_dim_bucket: "Promedio por vaca y tramo DEL",
    arithmetic_mean_of_lot_test_days_by_dim_bucket: "Promedio por lote histórico y tramo DEL",
    historically_resolved_controls_divided_by_linked_controls: "Controles con lote histórico / enlazados",
    sum_of_first_to_last_animal_gain: "Suma de ganancia entre primer y último pesaje",
    aggregate_gain_divided_by_observation_days: "Ganancia / días observados",
    distinct_animals_with_mastitis: "Animales distintos con mastitis",
    unique_animals_divided_by_mean_observed_herd: "Animales / rebaño medio",
    milk_revenue_minus_feed_cost: "Ingreso leche − alimento",
    feed_and_other_cost_divided_by_liters: "Costos / litros",
    unavailable: "No evaluable",
  }[value] ?? "Método técnico disponible en el CSV";
}

function unitLabel(value: string): string {
  return {
    animals: "animales",
    cells_per_ml: "células por mililitro",
    clp: "pesos chilenos",
    clp_per_liter: "pesos por litro",
    days: "días",
    kg: "kilogramos",
    kg_per_day: "kilogramos por día",
    liters: "litros",
    liters_per_control_day: "litros por control",
    liters_per_cow_day: "litros por vaca-día",
    percent: "porcentaje",
    percentage_points: "puntos porcentuales",
  }[value] ?? "unidad no especificada";
}

function metricLabel(key: string): string {
  const label = ({
    "milk.volume_liters": "Volumen de leche",
    "milk.volume_trend_pct": "Tendencia de leche",
    "milk.production_per_cow_day_liters": "Litros por vaca-día",
    "milk.fat_pct": "Grasa",
    "milk.fat_pct_change_pp": "Cambio de grasa",
    "milk.protein_pct": "Proteína",
    "milk.protein_pct_change_pp": "Cambio de proteína",
    "milk.somatic_cell_count": "Recuento de células somáticas",
    "milk.somatic_cell_trend_pct": "Tendencia de células somáticas",
    "reproduction.pregnancy_rate_pct": "Tasa de preñez",
    "reproduction.days_open_average": "Días abiertos",
    "reproduction.calving_interval_days_average": "Intervalo entre partos",
    "lactation.days_in_milk_average": "Días en leche promedio",
    "lactation.historical_lot_membership_coverage_pct": "Cobertura histórica de lote",
    "weight.total_gain_kg": "Ganancia total de peso",
    "weight.average_daily_gain_kg": "Ganancia diaria promedio",
    "health.mastitis_case_count": "Animales con mastitis",
    "health.mastitis_rate_pct": "Tasa de mastitis",
    "outcomes.mortality_rate_pct": "Mortalidad",
    "outcomes.discard_rate_pct": "Descarte",
    "finance.feed_cost_clp": "Costo de alimento",
    "finance.iofc_clp": "Ingreso sobre costo de alimento",
    "finance.cost_per_liter_clp": "Costo por litro",
  } as Record<string, string>)[key];
  if (label) return label;
  const subjectProduction = /^milk\.production\.(animal|lot):([^:]+):liters_per_control_day$/u.exec(key);
  if (subjectProduction) return `Producción por ${subjectProduction[1] === "animal" ? "vaca" : "lote"} · ${decodeURIComponent(subjectProduction[2])}`;
  const subjectCurve = /^lactation\.curve\.(animal|lot):([^:]+):dim_(\d{3})_(\d{3})_liters$/u.exec(key);
  if (subjectCurve) return `Curva por ${subjectCurve[1] === "animal" ? "vaca" : "lote"} · ${decodeURIComponent(subjectCurve[2])} · DEL ${Number(subjectCurve[3])}–${Number(subjectCurve[4])}`;
  const curve = /^lactation\.curve\.dim_(\d{3})_(\d{3})_liters$/u.exec(key);
  return curve ? `Curva de lactancia DEL ${Number(curve[1])}–${Number(curve[2])}` : key;
}

function alertLabel(code: string, subjectLabel?: string): string {
  const label = code.startsWith("PROBLEM_COW_PRODUCTION_DROP:")
    ? "Caída sostenida de producción"
    : code.startsWith("PROBLEM_COW_SOMATIC_CELL_HIGH:")
      ? "Recuento celular individual elevado"
      : code.startsWith("EXPECTED_HEAT:")
        ? "Celo esperado"
      : ({
    MILK_PRODUCTION_DROP: "Caída de producción de leche",
    SOMATIC_CELL_COUNT_HIGH: "Recuento celular elevado",
    MASTITIS_RATE_HIGH: "Tasa de mastitis elevada",
    PREGNANCY_RATE_LOW: "Tasa de preñez baja",
    DAYS_OPEN_HIGH: "Días abiertos elevados",
    CALVING_INTERVAL_HIGH: "Intervalo entre partos elevado",
    WEIGHT_GAIN_LOW: "Ganancia de peso baja",
    MORTALITY_RATE_HIGH: "Mortalidad elevada",
    DISCARD_RATE_HIGH: "Descarte elevado",
    IOFC_LOW: "Ingreso sobre alimento bajo",
      } as Record<string, string>)[code] ?? code;
  return subjectLabel ? `${label} · ${subjectLabel}` : label;
}

function operatorLabel(operator: AnalyticsAlert["evidence"]["operator"]): string {
  return operator === "lt" ? "Menor que" : operator === "lte" ? "Hasta" : "Desde";
}

function replaceSelectionUrl(fieldId: string, period: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("fieldId", fieldId);
  url.searchParams.set("period", period);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function safeFilename(value: string): string {
  const normalized = value.normalize("NFKD").replace(/\p{Mark}/gu, "").toLocaleLowerCase("es");
  return normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 64) || "fundo";
}
