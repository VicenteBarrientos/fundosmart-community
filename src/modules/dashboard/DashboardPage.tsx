"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import { HelpTip } from "@/src/ui/Hint";
import { HELP, type HelpKey } from "@/src/ui/help-copy";
import { Panel, PanelHeader, StatCard } from "@/src/ui/primitives";
import {
  AgendaClientError,
  fetchAgendaManagement,
  persistAgendaTaskMutation,
} from "./agenda-client";
import {
  applyAgendaTaskStates,
  type AgendaAssignee,
  type AgendaManagementSnapshot,
  type AgendaTaskAction,
  type ManagedTodayAgendaItem,
} from "./agenda-management.mjs";
import type { DashboardMetrics } from "./dashboard-metrics.mjs";
import { buildOperationalAlerts } from "./operational-alerts.mjs";
import {
  buildTodayAgenda,
  type AgronomicAgendaSignal,
  type ImportAgendaSignal,
  type TodayAgendaCategory,
  type TodayAgendaUrgency,
} from "./today-agenda.mjs";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Beef,
  BellRing,
  CalendarDays,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  CircleDollarSign,
  Droplets,
  FileText,
  Gauge,
  Leaf,
  LoaderCircle,
  Map,
  MapPinned,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sprout,
  TrendingUp,
  UserRound,
  WalletCards,
  Weight,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchHerdOperations } from "../ganado/api/livestock-client";
import type { HerdWorkItem } from "../ganado/domain/operations";
import { fetchMilkSnapshot } from "../leche/api/milk-operations-client";
import type { MilkMammaryWorkItem } from "../leche/domain/types";
import { OnboardingChecklist } from "../onboarding/OnboardingChecklist";
import {
  ACTIVITY_TYPE_LABELS,
  type Activity,
  type Fundo,
  type Potrero,
} from "../potreros/types";

type DashboardPageProps = {
  fundos: Fundo[];
  potreros: Potrero[];
  activities: Activity[];
  agronomicAgendaSignals: AgronomicAgendaSignal[];
  importAgendaSignals?: ImportAgendaSignal[];
  agendaManagement: AgendaManagementSnapshot;
  canManageAgenda: boolean;
  canManageImports: boolean;
  canViewFinance: boolean;
  generatedAt: string;
  herdSummary?: { workItems: HerdWorkItem[] };
  isDemo: boolean;
  milkSummary?: { mammaryWorkItems: MilkMammaryWorkItem[] };
  metrics: {
    all: DashboardMetrics;
    byField: Record<string, DashboardMetrics>;
  };
  onboardingFacts: {
    fieldCount: number;
    paddockCount: number;
    hasFirstAction: boolean;
    firstFieldId: string | null;
  };
  onboardingScope: string;
  organizationId: string;
  organizationName: string;
  userName: string;
};

const ALL_FUNDOS = "all";
const ALL_AGENDA = "all";
const UNASSIGNED_AGENDA = "unassigned";
const MY_AGENDA = "mine";
type AgendaStatusFilter = "pending" | "postponed" | "closed";
type AgendaEditorState = {
  action: AgendaTaskAction;
  assigneeMembershipId: string;
  itemId: string;
  operationId: string;
  reason: string;
  revision: string;
  scheduledFor: string;
};
const AGENDA_URGENCY_LABELS: Record<TodayAgendaUrgency, string> = {
  urgent: "Urgente",
  today: "Hoy",
  soon: "Próxima",
  review: "Revisar",
};
const AGENDA_CATEGORY_LABELS: Record<TodayAgendaCategory, string> = {
  reproduction: "Reproducción",
  health: "Sanidad",
  weighing: "Pesajes",
  production: "Producción",
  finance: "Costos",
  paddocks: "Potreros",
  records: "Registros",
  imports: "Importaciones",
};
const AGENDA_STATUS_LABELS: Record<AgendaStatusFilter, string> = {
  pending: "Pendientes",
  postponed: "Pospuestas",
  closed: "Cerradas",
};

export function DashboardPage({
  fundos,
  potreros,
  activities,
  agronomicAgendaSignals,
  importAgendaSignals = [],
  agendaManagement: initialAgendaManagement,
  canManageAgenda,
  canManageImports,
  canViewFinance,
  generatedAt,
  herdSummary,
  isDemo,
  metrics,
  milkSummary,
  onboardingFacts,
  onboardingScope,
  organizationId,
  organizationName,
  userName,
}: DashboardPageProps) {
  const [selectedFundoId, setSelectedFundoId] = useState(ALL_FUNDOS);
  const [fetchedHerdSummary, setFetchedHerdSummary] = useState<DashboardPageProps["herdSummary"]>();
  const [fetchedMammaryItems, setFetchedMammaryItems] = useState<MilkMammaryWorkItem[]>();
  const [agendaLoading, setAgendaLoading] = useState(!herdSummary || !milkSummary);
  const [agendaPartial, setAgendaPartial] = useState(false);
  const [agendaUrgency, setAgendaUrgency] = useState<typeof ALL_AGENDA | TodayAgendaUrgency>(ALL_AGENDA);
  const [agendaCategory, setAgendaCategory] = useState<typeof ALL_AGENDA | TodayAgendaCategory>(ALL_AGENDA);
  const [agendaStatus, setAgendaStatus] = useState<AgendaStatusFilter>("pending");
  const [agendaAssignee, setAgendaAssignee] = useState(ALL_AGENDA);
  const [agendaManagement, setAgendaManagement] = useState(initialAgendaManagement);
  const [agendaEditor, setAgendaEditor] = useState<AgendaEditorState | null>(null);
  const [agendaSavingId, setAgendaSavingId] = useState<string | null>(null);
  const [agendaMutationError, setAgendaMutationError] = useState<string | null>(null);

  useEffect(() => {
    setAgendaManagement(initialAgendaManagement);
  }, [initialAgendaManagement]);

  useEffect(() => {
    let active = true;
    const pending: Promise<void>[] = [];
    if (!herdSummary) {
      pending.push(fetchHerdOperations()
        .then((operations) => {
          if (active) setFetchedHerdSummary({ workItems: operations.workItems });
        })
        .catch(() => {
          if (active) setAgendaPartial(true);
        }));
    }
    if (!milkSummary) {
      pending.push(fetchMilkSnapshot()
        .then((snapshot) => {
          if (active) setFetchedMammaryItems(snapshot.mammaryWorkItems);
        })
        .catch(() => {
          if (active) setAgendaPartial(true);
        }));
    }
    if (pending.length > 0) {
      void Promise.allSettled(pending).then(() => {
        if (active) setAgendaLoading(false);
      });
    }
    return () => {
      active = false;
    };
  }, [herdSummary, milkSummary]);

  const selectedFundo = fundos.find((fundo) => fundo.id === selectedFundoId) ?? null;
  const visiblePotreros = useMemo(
    () => selectedFundoId === ALL_FUNDOS ? potreros : potreros.filter((potrero) => potrero.fieldId === selectedFundoId),
    [potreros, selectedFundoId],
  );
  const visibleIds = useMemo(() => new Set(visiblePotreros.map((potrero) => potrero.id)), [visiblePotreros]);
  const visibleActivities = useMemo(
    () => activities.filter((activity) => visibleIds.has(activity.potreroId)),
    [activities, visibleIds],
  );
  const totalFarmArea = selectedFundo
    ? selectedFundo.areaHectares
    : fundos.reduce((sum, fundo) => sum + fundo.areaHectares, 0);
  const delimitedArea = visiblePotreros.reduce((sum, potrero) => sum + potrero.areaHectares, 0);
  const grazingCount = visiblePotreros.filter((potrero) => potrero.status === "En pastoreo").length;
  const restingCount = visiblePotreros.filter((potrero) => potrero.status === "En descanso").length;
  const availableCount = visiblePotreros.filter((potrero) => potrero.status === "Disponible").length;
  const reportsCount = selectedFundo
    ? Number(Boolean(selectedFundo.soilReport))
    : fundos.filter((fundo) => fundo.soilReport).length;
  const coverage = totalFarmArea > 0 ? Math.min(100, (delimitedArea / totalFarmArea) * 100) : 0;
  const sortedActivities = [...visibleActivities]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  const selectedFieldIds = selectedFundo ? new Set([selectedFundo.id]) : new Set(fundos.map((fundo) => fundo.id));
  const herdTasks = (herdSummary?.workItems ?? fetchedHerdSummary?.workItems ?? [])
    .filter((item) => selectedFieldIds.has(item.fieldId));
  const mammaryTasks = (milkSummary?.mammaryWorkItems ?? fetchedMammaryItems ?? [])
    .filter((item) => selectedFieldIds.has(item.fieldId));
  const selectedMetrics = selectedFundoId === ALL_FUNDOS
    ? metrics.all
    : metrics.byField[selectedFundoId] ?? metrics.all;
  const milkTrend = selectedMetrics.milkChangePercent;
  const latestMilkNetAmount = canViewFinance ? selectedMetrics.latestMilk?.netAmountClp : undefined;
  const latestMilkNetPrice = canViewFinance ? selectedMetrics.latestMilk?.netPricePerLiterClp : undefined;
  const lastActivityDate = visibleActivities.map((activity) => activity.occurredAt).sort().at(-1) ?? null;
  const operationalAlerts = buildOperationalAlerts({
    availablePaddockCount: availableCount,
    canViewFinance,
    lastActivityDate,
    metrics: selectedMetrics,
    paddockCount: visiblePotreros.length,
    referenceDate: generatedAt,
  });
  const agendaItems = buildTodayAgenda({
    agronomicWorkItems: agronomicAgendaSignals,
    importWorkItems: importAgendaSignals,
    contextFieldId: selectedFundo?.id ?? null,
    herdWorkItems: herdTasks,
    mammaryWorkItems: mammaryTasks,
    operationalAlerts,
    referenceDate: generatedAt,
  });
  const managedAgendaItems = applyAgendaTaskStates(
    agendaItems,
    agendaManagement.states,
    generatedAt,
  );
  const visibleAgendaItems = managedAgendaItems.filter((item) =>
    (agendaUrgency === ALL_AGENDA || item.urgency === agendaUrgency)
    && (agendaCategory === ALL_AGENDA || item.category === agendaCategory)
    && matchesAgendaStatus(item, agendaStatus)
    && matchesAgendaAssignee(
      item,
      agendaAssignee,
      agendaManagement.currentMembershipId,
    ));
  const urgentAgendaCount = managedAgendaItems.filter((item) =>
    item.agendaView === "pending"
    && (item.urgency === "urgent" || item.urgency === "today")).length;

  function startAgendaAction(item: ManagedTodayAgendaItem, action: AgendaTaskAction) {
    if (!item.fieldId) {
      setAgendaMutationError("Selecciona un fundo para gestionar esta alerta agregada.");
      return;
    }
    setAgendaMutationError(null);
    setAgendaEditor({
      action,
      assigneeMembershipId: item.taskState?.assigneeMembershipId ?? "",
      itemId: item.id,
      operationId: crypto.randomUUID(),
      reason: "",
      revision: item.revision,
      scheduledFor: addIsoDays(generatedAt, 1),
    });
  }

  async function saveAgendaAction(item: ManagedTodayAgendaItem) {
    if (
      !agendaEditor
      || agendaEditor.itemId !== item.id
      || agendaEditor.revision !== item.revision
      || !item.fieldId
    ) return;
    const identity = agendaIdentity(item);
    setAgendaSavingId(identity);
    setAgendaMutationError(null);
    try {
      const result = await persistAgendaTaskMutation({
        action: agendaEditor.action,
        operationId: agendaEditor.operationId,
        fieldId: item.fieldId,
        itemKey: item.id,
        signalRevision: item.revision,
        source: item.source,
        expectedVersion: item.taskState?.version ?? null,
        reason: ["complete", "postpone", "dismiss"].includes(agendaEditor.action)
          ? agendaEditor.reason
          : null,
        scheduledFor: agendaEditor.action === "postpone"
          ? agendaEditor.scheduledFor
          : null,
        assigneeMembershipId: agendaEditor.action === "assign"
          ? agendaEditor.assigneeMembershipId || null
          : null,
      });
      setAgendaManagement((current) => ({
        ...current,
        states: [
          ...current.states.filter((state) => state.id !== result.state.id),
          result.state,
        ],
      }));
      setAgendaEditor(null);
    } catch (cause) {
      setAgendaMutationError(
        cause instanceof Error
          ? cause.message
          : "No fue posible guardar la acción de agenda.",
      );
      if (cause instanceof AgendaClientError && cause.status === 409) {
        try {
          setAgendaManagement(await fetchAgendaManagement());
          if (cause.code === "AGENDA_IDEMPOTENCY_COLLISION") {
            setAgendaEditor((current) => current
              ? { ...current, operationId: crypto.randomUUID() }
              : current);
          }
        } catch {
          // The actionable mutation error remains visible; a later retry still
          // revalidates the server-side version and access scope.
        }
      }
    } finally {
      setAgendaSavingId(null);
    }
  }

  return (
    <AppShell activeSection="summary" fieldName={selectedFundo?.name ?? "Todos los fundos"} isDemo={isDemo} organizationId={organizationId} organizationName={organizationName} snapshotGeneratedAt={generatedAt} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> Visión general
              </div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Tu campo, en una mirada</h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">Superficie, ganado, leche y resultado operativo conectados para decidir qué atender hoy.</p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="relative">
                <span className="sr-only">Filtrar por fundo</span>
                <select
                  className="h-11 min-w-56 appearance-none rounded-xl border border-line-steel bg-white pl-4 pr-10 text-xs font-black text-ink shadow-sm outline-none focus:border-accent"
                  data-hint={HELP.dashFiltroFundo}
                  data-hint-side="bottom"
                  onChange={(event) => setSelectedFundoId(event.target.value)}
                  value={selectedFundoId}
                >
                  <option value={ALL_FUNDOS}>Todos los fundos</option>
                  {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
                </select>
                <MapPinned className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-accent" size={16} />
              </label>
              <Link className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white shadow-lg shadow-ink/10" href="/app/potreros">
                Ver mapa <ArrowRight size={15} />
              </Link>
            </div>
          </header>

          {isDemo && <DemoNotice />}
          {!isDemo && canManageAgenda && (
            <OnboardingChecklist
              canImport={canManageImports}
              facts={onboardingFacts}
              scope={onboardingScope}
            />
          )}

          <section className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard help="dashSuperficie" icon={Map} label="Superficie" tone="dark" value={`${formatNumber(totalFarmArea, 1)} ha`} detail={`${formatNumber(delimitedArea, 1)} ha en potreros`} />
            <StatCard help="dashAnimalesActivos" icon={Beef} label="Animales activos" value={formatNumber(selectedMetrics.activeAnimals, 0)} detail={`${selectedMetrics.milkingCows} vacas en leche · ${selectedMetrics.activeLots} lotes`} />
            <StatCard
              help="dashLeche"
              icon={Droplets}
              label={selectedMetrics.latestMilk ? `Leche · ${formatPeriod(selectedMetrics.latestMilk.period)}` : "Leche"}
              value={selectedMetrics.latestMilk ? `${formatNumber(selectedMetrics.latestMilk.totalLiters, 0)} L` : "Sin datos"}
              detail={milkTrend === null ? "Sin período anterior" : `${milkTrend >= 0 ? "+" : ""}${formatNumber(milkTrend, 1)}% vs. período anterior`}
            />
            <StatCard
              help={canViewFinance ? "dashResultadoOperativo" : "dashProduccionDiaria"}
              icon={canViewFinance ? WalletCards : Gauge}
              label={canViewFinance ? "Resultado operativo" : "Producción diaria"}
              tone={canViewFinance && (selectedMetrics.operatingResultClp ?? 0) < 0 ? "amber" : "positive"}
              value={canViewFinance
                ? selectedMetrics.operatingResultClp === null ? "Sin datos" : formatClp(selectedMetrics.operatingResultClp)
                : selectedMetrics.litersPerMilkingCowDay === null ? "Sin datos" : `${formatNumber(selectedMetrics.litersPerMilkingCowDay, 1)} L`}
              detail={canViewFinance
                ? selectedMetrics.latestMilk ? `Ingreso neto menos costos de ${formatPeriod(selectedMetrics.latestMilk.period)}` : "Registra leche y costos"
                : "por vaca en leche al día"}
            />
          </section>

          <section className="mt-5">
            <Panel>
              <PanelHeader
                actions={(
                  <span className={`inline-flex min-h-8 items-center rounded-full px-3 text-[12px] font-black ${urgentAgendaCount > 0 ? "bg-alert-bg text-alert-ink" : "bg-ok-bg text-ok-ink"}`}>
                    {agendaLoading
                      ? "Actualizando señales"
                      : urgentAgendaCount > 0
                        ? `${urgentAgendaCount} para atender hoy`
                        : "Sin urgencias para hoy"}
                  </span>
                )}
                eyebrow="Atención hoy"
                helpText="Reúne tareas de ganado, salud mamaria e indicadores operacionales. Cada señal explica por qué aparece y abre el módulo donde se resuelve."
                icon={BellRing}
                title="Hoy en el fundo"
              />

              <div className="mt-5 grid gap-3 rounded-2xl border border-line-steel bg-surface-alt p-3 sm:grid-cols-2 xl:grid-cols-4">
                <label className="text-[12px] font-black text-ink-muted">
                  Urgencia
                  <select
                    className="mt-1.5 h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink outline-none focus:border-accent"
                    onChange={(event) => setAgendaUrgency(event.target.value as typeof agendaUrgency)}
                    value={agendaUrgency}
                  >
                    <option value={ALL_AGENDA}>Todas las urgencias</option>
                    {Object.entries(AGENDA_URGENCY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="text-[12px] font-black text-ink-muted">
                  Tema
                  <select
                    className="mt-1.5 h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink outline-none focus:border-accent"
                    onChange={(event) => setAgendaCategory(event.target.value as typeof agendaCategory)}
                    value={agendaCategory}
                  >
                    <option value={ALL_AGENDA}>Todos los temas</option>
                    {Object.entries(AGENDA_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="text-[12px] font-black text-ink-muted">
                  Estado
                  <select
                    className="mt-1.5 h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink outline-none focus:border-accent"
                    onChange={(event) => setAgendaStatus(event.target.value as AgendaStatusFilter)}
                    value={agendaStatus}
                  >
                    {Object.entries(AGENDA_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="text-[12px] font-black text-ink-muted">
                  Responsable
                  <select
                    className="mt-1.5 h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink outline-none focus:border-accent"
                    onChange={(event) => setAgendaAssignee(event.target.value)}
                    value={agendaAssignee}
                  >
                    <option value={ALL_AGENDA}>Todos</option>
                    <option value={MY_AGENDA}>Mis tareas</option>
                    <option value={UNASSIGNED_AGENDA}>Sin responsable</option>
                    {agendaManagement.assignees
                      .filter((assignee) => assignee.id !== agendaManagement.currentMembershipId)
                      .map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}
                  </select>
                </label>
              </div>

              {agendaPartial && (
                <p className="mt-3 rounded-xl border border-warn-bar bg-warn-bg px-3 py-2 text-[12px] font-bold text-warn-ink" role="status">
                  Algunas fuentes no respondieron. La agenda muestra solo las señales disponibles y puedes seguir entrando a sus módulos.
                </p>
              )}
              {agendaLoading && (
                <p aria-live="polite" className="mt-3 text-[12px] font-bold text-ink-subtle">
                  Actualizando Ganado y Leche…
                </p>
              )}
              {agendaMutationError && (
                <p className="mt-3 flex items-start gap-2 rounded-xl border border-alert-bar/25 bg-alert-bg px-3 py-2 text-[12px] font-bold text-alert-ink" role="alert">
                  <CircleAlert className="mt-0.5 shrink-0" size={15} />
                  {agendaMutationError}
                </p>
              )}

              {visibleAgendaItems.length > 0 ? (
                <div className="mt-4 grid max-h-[42rem] gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
                  {visibleAgendaItems.map((item) => (
                    <TodayAgendaCard
                      assignees={agendaManagement.assignees.filter((assignee) =>
                        Boolean(item.fieldId && assignee.fieldIds.includes(item.fieldId)))}
                      canManage={canManageAgenda && !isDemo}
                      editor={agendaEditor?.itemId === item.id && agendaEditor.revision === item.revision
                        ? agendaEditor
                        : null}
                      fieldName={item.fieldId
                        ? fundos.find((fundo) => fundo.id === item.fieldId)?.name ?? "Fundo"
                        : selectedFundo?.name ?? "Todos los fundos"}
                      isSaving={agendaSavingId === agendaIdentity(item)}
                      item={item}
                      key={agendaIdentity(item)}
                      minimumScheduleDate={addIsoDays(generatedAt, 1)}
                      onCancel={() => {
                        setAgendaEditor(null);
                        setAgendaMutationError(null);
                      }}
                      onChangeEditor={setAgendaEditor}
                      onSave={() => void saveAgendaAction(item)}
                      onStart={(action) => startAgendaAction(item, action)}
                    />
                  ))}
                </div>
              ) : agendaLoading ? (
                <div className="mt-4 min-h-28 animate-pulse rounded-2xl border border-line-steel bg-surface-alt" />
              ) : agendaItems.length > 0 ? (
                <div className="mt-4 flex flex-col items-start gap-3 rounded-2xl border border-line-steel bg-surface-alt p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs font-bold text-ink-muted">No hay señales que coincidan con estos filtros.</p>
                  <button
                    className="min-h-11 rounded-xl border border-line-steel bg-white px-4 text-xs font-black text-accent"
                    onClick={() => {
                      setAgendaUrgency(ALL_AGENDA);
                      setAgendaCategory(ALL_AGENDA);
                      setAgendaStatus("pending");
                      setAgendaAssignee(ALL_AGENDA);
                    }}
                    type="button"
                  >
                    Limpiar filtros
                  </button>
                </div>
              ) : (
                <div className="mt-4 flex items-start gap-3 rounded-2xl border border-line-steel bg-surface-alt p-4">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ok-bg text-ok-ink"><ShieldCheck size={17} /></span>
                  <div>
                    <p className="text-xs font-black text-ink">Todo al día en esta selección</p>
                    <p className="mt-1 text-[12px] leading-4 text-ink-subtle">No hay tareas del rebaño ni indicadores operacionales que requieran revisión.</p>
                  </div>
                </div>
              )}

              <p className="mt-4 text-[12px] leading-5 text-ink-subtle">
                Gestionar una señal guarda responsable, fecha y motivo con auditoría; no diagnostica ni inventa un evento productivo. Abre el módulo de origen para registrar la acción operacional cuando corresponda.
              </p>
            </Panel>
          </section>

          <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
            <Panel>
              <PanelHeader eyebrow="Pulso productivo" help="dashIndicadores" icon={Gauge} title="Indicadores para decidir" />
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <InsightCard
                  detail={latestMilkNetPrice !== undefined
                    ? `${formatClp(latestMilkNetPrice)} netos por litro`
                    : selectedMetrics.latestMilk ? "Volumen sin información financiera" : "Aún no hay liquidaciones"}
                  help="dashTendenciaLeche"
                  icon={milkTrend !== null && milkTrend < 0 ? ArrowDownRight : ArrowUpRight}
                  label="Tendencia de leche"
                  tone={milkTrend !== null && milkTrend < 0 ? "warning" : "good"}
                  value={milkTrend === null ? "—" : `${milkTrend >= 0 ? "+" : ""}${formatNumber(milkTrend, 1)}%`}
                />
                <InsightCard
                  detail={selectedMetrics.latestWeightDate ? `Último control: ${formatDate(selectedMetrics.latestWeightDate)}` : "Sin pesajes registrados"}
                  help="dashCoberturaPesaje"
                  icon={Weight}
                  label="Cobertura de pesaje"
                  value={selectedMetrics.weightCoveragePercent === null ? "—" : `${formatNumber(selectedMetrics.weightCoveragePercent, 0)}%`}
                />
                <InsightCard
                  detail={selectedMetrics.litersPerMilkingCowDay === null ? "Vincula el rebaño lechero" : `${selectedMetrics.milkingCows} vacas en leche`}
                  help="dashLitrosVacaDia"
                  icon={Droplets}
                  label="Litros por vaca/día"
                  value={selectedMetrics.litersPerMilkingCowDay === null ? "—" : formatNumber(selectedMetrics.litersPerMilkingCowDay, 1)}
                />
              </div>
              {canViewFinance && selectedMetrics.latestMilk && latestMilkNetAmount !== undefined && (
                <div className="mt-4 grid gap-3 rounded-2xl border border-line-steel bg-surface-alt p-4 sm:grid-cols-3">
                  <FinancialLine label="Ingreso neto" value={formatClp(latestMilkNetAmount)} />
                  <FinancialLine label="Costos registrados" value={selectedMetrics.periodCostsClp === null ? "—" : formatClp(selectedMetrics.periodCostsClp)} />
                  <FinancialLine emphasis label="Resultado" value={selectedMetrics.operatingResultClp === null ? "—" : formatClp(selectedMetrics.operatingResultClp)} />
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHeader eyebrow="Atajos" icon={Sparkles} title="Explora el producto" />
              <div className="mt-5 grid grid-cols-2 gap-3">
                <QuickLink detail="Lotes, DIIO y pesajes" help="navGanado" href="/app/ganado" icon={Beef} label="Ganado" />
                <QuickLink detail="Litros, precio y bonos" help="navLeche" href="/app/leche" icon={Droplets} label="Leche" />
                <QuickLink detail="Mapa y manejos" help="navPotreros" href="/app/potreros" icon={MapPinned} label="Potreros" />
                <QuickLink detail="Egresos por origen" help="navCostos" href="/app/costos" icon={CircleDollarSign} label="Costos" />
              </div>
            </Panel>
          </section>

          <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <Panel>
              <PanelHeader eyebrow="Territorio" help="dashSuperficiePorPotrero" icon={TrendingUp} title="Superficie por potrero" />
              {visiblePotreros.length > 0 ? (
                <div className="mt-5 space-y-4">
                  {visiblePotreros.map((potrero) => {
                    const share = delimitedArea > 0 ? (potrero.areaHectares / delimitedArea) * 100 : 0;
                    return (
                      <div key={potrero.id}>
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <div className="min-w-0">
                            <p className="truncate font-black text-ink">{potrero.name}</p>
                            <p className="mt-0.5 truncate text-[12px] font-bold uppercase tracking-wide text-ink-subtle">{fundos.find((fundo) => fundo.id === potrero.fieldId)?.name} · {potrero.sector}</p>
                          </div>
                          <span className="shrink-0 font-black text-ink">{formatNumber(potrero.areaHectares, 2)} ha</span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-alt">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : <EmptyState text="Aún no hay potreros delimitados en este fundo." />}
            </Panel>

            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
              <Panel>
                <PanelHeader eyebrow="Cobertura" help="dashDelimitacion" icon={MapPinned} title="Delimitación del fundo" />
                <div className="mt-5 flex items-center gap-5">
                  <div className="grid size-24 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#19784b ${coverage}%, #e8ede5 0)` }}>
                    <div className="grid size-[72px] place-items-center rounded-full bg-white text-center">
                      <span className="text-xl font-black tracking-[-0.04em] text-ink">{formatNumber(coverage, 0)}%</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-black text-ink">{formatNumber(delimitedArea, 1)} ha delimitadas</p>
                    <p className="mt-1 text-[12px] leading-4 text-ink-subtle">Calculado con los polígonos actuales de los potreros.</p>
                  </div>
                </div>
              </Panel>

              <Panel>
                <PanelHeader eyebrow="Documentos" help="dashEstudiosSuelo" icon={FileText} title="Estudios de suelo" />
                <div className="mt-5 flex items-center justify-between rounded-2xl bg-surface-alt p-4">
                  <div>
                    <p className="text-2xl font-black tracking-[-0.04em] text-ink">{reportsCount}</p>
                    <p className="mt-1 text-[12px] font-bold text-ink-subtle">{reportsCount === 1 ? "fundo con estudio adjunto" : "fundos con estudio adjunto"}</p>
                  </div>
                  <span className="grid size-11 place-items-center rounded-2xl bg-white text-accent shadow-sm"><CheckCircle2 size={20} /></span>
                </div>
              </Panel>
            </div>
          </section>

          <section className="mt-5 grid gap-5 pb-8 xl:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="Trazabilidad" help="dashActividadReciente" icon={CalendarDays} title="Actividad reciente" />
              {sortedActivities.length > 0 ? (
                <div className="mt-4 divide-y divide-line-steel">
                  {sortedActivities.map((activity) => {
                    const potrero = potreros.find((item) => item.id === activity.potreroId);
                    return (
                      <div className="flex items-start gap-3 py-3" key={activity.id}>
                        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-band text-accent"><Leaf size={16} /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs font-black text-ink">{ACTIVITY_TYPE_LABELS[activity.type]}</p>
                            <span className="text-[12px] font-bold text-ink-subtle">{formatDate(activity.occurredAt)}</span>
                          </div>
                          <p className="mt-1 truncate text-[12px] text-ink-muted">{activity.description}</p>
                          <p className="mt-1 text-[12px] font-bold uppercase tracking-wide text-ink-subtle">{potrero?.name ?? "Potrero"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState action="Registrar el primer manejo" href="/app/potreros" text="Todavía no hay actividades registradas para esta selección." />
              )}
            </Panel>

            <Panel>
              <PanelHeader eyebrow="Estado operativo" help="dashDisponibilidadPotreros" icon={Sprout} title="Disponibilidad de potreros" />
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <StatusCard color="bg-accent" label="Disponibles" value={availableCount} />
                <StatusCard color="bg-accent" label="En pastoreo" value={grazingCount} />
                <StatusCard color="bg-warn-ink" label="En descanso" value={restingCount} />
              </div>
              <div className="mt-5 rounded-2xl border border-line-steel bg-surface-alt p-4">
                <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">Próximo paso recomendado</p>
                <p className="mt-2 text-sm font-black text-ink">Registra los manejos a medida que ocurren</p>
                <p className="mt-1 text-[12px] leading-5 text-ink-subtle">El resumen de costos y la trazabilidad se actualizarán automáticamente con cada registro.</p>
              </div>
            </Panel>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function DemoNotice() {
  return (
    <section className="mt-6 flex flex-col gap-4 overflow-hidden rounded-[20px] border border-accent bg-[linear-gradient(105deg,#173b2d_0%,#1f513b_68%,#527a2a_100%)] p-5 text-white shadow-[0_16px_38px_rgba(23,59,45,0.12)] sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-ink"><Sparkles size={18} /></span>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-black">Estás explorando Fundo El Ejemplo</p>
            <span className="rounded-full bg-white/10 px-2 py-1 text-[12px] font-black uppercase tracking-[0.12em] text-white">Modo demo</span>
          </div>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-white/68">Los registros son ficticios y están aislados. Puedes recorrer mapas, animales, liquidaciones y costos sin afectar información real.</p>
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-white/10 bg-white/[0.07] px-3 py-2 text-[12px] font-bold text-white/78 sm:self-center"><ShieldCheck size={14} className="text-white" /> Entorno seguro de demostración</span>
    </section>
  );
}


function InsightCard({ detail, help, icon: Icon, label, tone = "default", value }: { detail: string; help?: HelpKey; icon: LucideIcon; label: string; tone?: "default" | "good" | "warning"; value: string }) {
  const toneClass = tone === "warning"
    ? "bg-surface-alt text-warn-ink"
    : tone === "good"
      ? "bg-band text-accent"
      : "bg-surface-alt text-accent";
  return (
    <div className="rounded-2xl border border-line-steel bg-surface-alt p-4">
      <span className={`grid size-9 place-items-center rounded-xl ${toneClass}`}><Icon size={16} /></span>
      <p className="mt-4 flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">
        {label}
        <HelpTip help={help} label={label} />
      </p>
      <p className="mt-1 text-2xl font-black tracking-[-0.045em] text-ink">{value}</p>
      <p className="mt-1 text-[12px] leading-4 text-ink-subtle">{detail}</p>
    </div>
  );
}

function FinancialLine({ emphasis = false, label, value }: { emphasis?: boolean; label: string; value: string }) {
  return (
    <div className={emphasis ? "rounded-xl bg-ink px-3 py-2.5 text-white" : "px-1 py-2.5"}>
      <p className={`text-[12px] font-black uppercase tracking-[0.1em] ${emphasis ? "text-white/50" : "text-ink-subtle"}`}>{label}</p>
      <p className={`mt-1 text-sm font-black ${emphasis ? "text-white" : "text-ink"}`}>{value}</p>
    </div>
  );
}

function QuickLink({ detail, help, href, icon: Icon, label }: { detail: string; help?: HelpKey; href: string; icon: LucideIcon; label: string }) {
  return (
    <Link className="group rounded-2xl border border-line-steel bg-surface-alt p-4 transition hover:-translate-y-0.5 hover:border-accent hover:bg-white hover:shadow-md" data-hint={help ? HELP[help] : undefined} href={href}>
      <div className="flex items-center justify-between gap-2">
        <span className="grid size-9 place-items-center rounded-xl bg-surface-alt text-accent"><Icon size={16} /></span>
        <ArrowRight className="text-ink-subtle transition group-hover:translate-x-0.5 group-hover:text-accent" size={14} />
      </div>
      <p className="mt-3 text-xs font-black text-ink">{label}</p>
      <p className="mt-1 text-[12px] leading-4 text-ink-subtle">{detail}</p>
    </Link>
  );
}

type TodayAgendaCardProps = {
  assignees: AgendaAssignee[];
  canManage: boolean;
  editor: AgendaEditorState | null;
  fieldName: string;
  isSaving: boolean;
  item: ManagedTodayAgendaItem;
  minimumScheduleDate: string;
  onCancel: () => void;
  onChangeEditor: (editor: AgendaEditorState) => void;
  onSave: () => void;
  onStart: (action: AgendaTaskAction) => void;
};

function TodayAgendaCard({
  assignees,
  canManage,
  editor,
  fieldName,
  isSaving,
  item,
  minimumScheduleDate,
  onCancel,
  onChangeEditor,
  onSave,
  onStart,
}: TodayAgendaCardProps) {
  const urgencyTone = {
    urgent: "bg-alert-bg text-alert-ink",
    today: "bg-warn-bg text-warn-ink",
    soon: "bg-band text-accent",
    review: "bg-surface-alt text-ink-muted",
  }[item.urgency];
  const subject = [
    fieldName,
    item.animalTag,
    item.lotName,
  ].filter(Boolean).join(" · ");
  const closed = item.taskState?.status === "completed"
    || item.taskState?.status === "dismissed";
  const managed = canManage && Boolean(item.fieldId);
  const stateLabel = item.taskState?.status === "completed"
    ? "Completada"
    : item.taskState?.status === "dismissed"
      ? "Descartada"
      : item.taskState?.status === "postponed"
        ? `Pospuesta hasta ${formatDate(item.taskState.scheduledFor!)}`
        : null;

  return (
    <article className="flex min-h-44 flex-col rounded-2xl border border-line-steel bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-black uppercase tracking-wide ${urgencyTone}`}>
          {AGENDA_URGENCY_LABELS[item.urgency]}
        </span>
        <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[12px] font-black text-ink-muted">
          {AGENDA_CATEGORY_LABELS[item.category]}
        </span>
        <span className="ml-auto text-[12px] font-black text-accent">{item.sourceLabel}</span>
      </div>
      {(stateLabel || item.taskState?.assigneeName) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {stateLabel && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-black ${
              closed ? "bg-surface-alt text-ink-muted" : "bg-band text-accent"
            }`}>
              {item.taskState?.status === "postponed"
                ? <CalendarClock size={12} />
                : closed ? <CheckCircle2 size={12} /> : null}
              {stateLabel}
            </span>
          )}
          {item.taskState?.assigneeName && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-black text-ink-muted">
              <UserRound size={12} />
              {item.taskState.assigneeName}
            </span>
          )}
        </div>
      )}
      <h3 className="mt-3 text-sm font-black leading-5 text-ink">{item.title}</h3>
      <p className="mt-1 text-[12px] leading-5 text-ink-muted">{item.reason}</p>
      {item.taskState?.resolutionReason && (
        <p className="mt-2 rounded-xl bg-surface-alt px-3 py-2 text-[11px] font-semibold leading-4 text-ink-muted">
          Motivo registrado: {item.taskState.resolutionReason}
        </p>
      )}
      <div className="mt-auto pt-4">
        <p className="text-[12px] font-bold text-ink-subtle">{subject}</p>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-bold text-ink-subtle">{item.dateLabel}: {formatDate(item.evidenceDate)}</span>
          <Link className="group inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-[12px] font-black text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={item.href}>
            {item.actionLabel}
            <ArrowRight className="transition group-hover:translate-x-0.5" size={13} />
          </Link>
        </div>
      </div>

      {canManage && !item.fieldId && (
        <p className="mt-3 rounded-xl bg-surface-alt px-3 py-2 text-[11px] font-bold text-ink-subtle">
          Selecciona un fundo arriba para gestionar esta alerta agregada sin mezclar alcances.
        </p>
      )}

      {managed && !editor && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line-steel pt-3">
          {!closed && (
            <>
              <button className={agendaActionButtonClass("primary")} onClick={() => onStart("complete")} type="button">
                Completar
              </button>
              <button className={agendaActionButtonClass()} onClick={() => onStart("postpone")} type="button">
                Posponer
              </button>
              <button className={agendaActionButtonClass()} onClick={() => onStart("dismiss")} type="button">
                Descartar
              </button>
            </>
          )}
          {item.taskState && item.taskState.status !== "open" && (
            <button className={agendaActionButtonClass()} onClick={() => onStart("reopen")} type="button">
              <RotateCcw size={13} /> Reabrir
            </button>
          )}
          <button className={agendaActionButtonClass()} onClick={() => onStart("assign")} type="button">
            <UserRound size={13} /> Responsable
          </button>
        </div>
      )}

      {managed && editor && (
        <AgendaActionEditor
          assignees={assignees}
          editor={editor}
          isSaving={isSaving}
          minimumScheduleDate={minimumScheduleDate}
          onCancel={onCancel}
          onChange={onChangeEditor}
          onSave={onSave}
        />
      )}
    </article>
  );
}

function AgendaActionEditor({
  assignees,
  editor,
  isSaving,
  minimumScheduleDate,
  onCancel,
  onChange,
  onSave,
}: {
  assignees: AgendaAssignee[];
  editor: AgendaEditorState;
  isSaving: boolean;
  minimumScheduleDate: string;
  onCancel: () => void;
  onChange: (editor: AgendaEditorState) => void;
  onSave: () => void;
}) {
  const needsReason = ["complete", "postpone", "dismiss"].includes(editor.action);
  const canSave = !isSaving
    && (!needsReason || editor.reason.trim().length >= 3)
    && (editor.action !== "postpone" || Boolean(editor.scheduledFor));
  const title = {
    complete: "Confirmar trabajo realizado",
    postpone: "Programar para otra fecha",
    dismiss: "Descartar esta señal",
    reopen: "Reabrir esta señal",
    assign: "Asignar responsable",
  }[editor.action];

  return (
    <div className="mt-3 rounded-2xl border border-accent/30 bg-band p-3" role="group" aria-label={title}>
      <p className="text-xs font-black text-ink">{title}</p>
      {editor.action === "assign" && (
        <label className="mt-3 block text-[11px] font-black text-ink-muted">
          Responsable
          <select
            className="mt-1.5 h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none focus:border-accent"
            disabled={isSaving}
            onChange={(event) => onChange({ ...editor, assigneeMembershipId: event.target.value })}
            value={editor.assigneeMembershipId}
          >
            <option value="">Sin responsable</option>
            {assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}
          </select>
        </label>
      )}
      {editor.action === "postpone" && (
        <label className="mt-3 block text-[11px] font-black text-ink-muted">
          Nueva fecha
          <input
            className="mt-1.5 h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none focus:border-accent"
            disabled={isSaving}
            min={minimumScheduleDate}
            onChange={(event) => onChange({ ...editor, scheduledFor: event.target.value })}
            type="date"
            value={editor.scheduledFor}
          />
        </label>
      )}
      {needsReason && (
        <label className="mt-3 block text-[11px] font-black text-ink-muted">
          {editor.action === "complete" ? "Qué se hizo" : "Motivo"}
          <textarea
            className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-line-steel bg-white px-3 py-2 text-xs font-medium leading-5 text-ink outline-none focus:border-accent"
            disabled={isSaving}
            maxLength={500}
            onChange={(event) => onChange({ ...editor, reason: event.target.value })}
            placeholder={editor.action === "complete"
              ? "Ej.: Revisé la ficha y registré el control correspondiente."
              : "Deja una explicación breve para el equipo."}
            value={editor.reason}
          />
        </label>
      )}
      {editor.action === "reopen" && (
        <p className="mt-2 text-[11px] font-semibold leading-4 text-ink-muted">
          La señal volverá a la lista pendiente conservando su responsable.
        </p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button className={agendaActionButtonClass()} disabled={isSaving} onClick={onCancel} type="button">
          Cancelar
        </button>
        <button
          className={agendaActionButtonClass("primary")}
          disabled={!canSave}
          onClick={onSave}
          type="button"
        >
          {isSaving && <LoaderCircle className="animate-spin" size={13} />}
          {isSaving ? "Guardando…" : "Confirmar"}
        </button>
      </div>
    </div>
  );
}

function agendaActionButtonClass(tone: "default" | "primary" = "default") {
  return `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border px-3 text-[11px] font-black transition disabled:cursor-not-allowed disabled:opacity-45 ${
    tone === "primary"
      ? "border-accent bg-accent text-white hover:bg-emerald"
      : "border-line-steel bg-white text-ink-muted hover:border-accent hover:text-accent"
  }`;
}



function StatusCard({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-surface-alt p-4">
      <span className={`block h-1.5 w-8 rounded-full ${color}`} />
      <p className="mt-3 text-2xl font-black tracking-[-0.04em] text-ink">{value}</p>
      <p className="mt-1 text-[12px] font-black uppercase tracking-wide text-ink-subtle">{label}</p>
    </div>
  );
}

function EmptyState({ text, action, href }: { text: string; action?: string; href?: string }) {
  return (
    <div className="mt-5 grid min-h-40 place-items-center rounded-2xl border border-dashed border-line-steel bg-surface-alt p-5 text-center">
      <div>
        <Sprout className="mx-auto text-accent" size={24} />
        <p className="mt-2 text-xs font-black text-ink">{text}</p>
        {action && href && <Link className="mt-3 inline-flex items-center gap-1 text-[12px] font-black text-accent" href={href}>{action} <ArrowRight size={12} /></Link>}
      </div>
    </div>
  );
}

function matchesAgendaStatus(
  item: ManagedTodayAgendaItem,
  status: AgendaStatusFilter,
) {
  if (status === "pending") return item.agendaView === "pending";
  if (status === "postponed") return item.agendaView === "postponed";
  return item.agendaView === "closed";
}

function matchesAgendaAssignee(
  item: ManagedTodayAgendaItem,
  filter: string,
  currentMembershipId: string,
) {
  const assignee = item.taskState?.assigneeMembershipId ?? null;
  if (filter === ALL_AGENDA) return true;
  if (filter === UNASSIGNED_AGENDA) return assignee === null;
  if (filter === MY_AGENDA) return assignee === currentMembershipId;
  return assignee === filter;
}

function agendaIdentity(item: Pick<ManagedTodayAgendaItem, "id" | "revision">) {
  return `${item.id}::${item.revision}`;
}

function addIsoDays(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: number, maximumFractionDigits: number) {
  return value.toLocaleString("es-CL", { maximumFractionDigits });
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

function formatPeriod(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("es-CL", { month: "short", year: "numeric", timeZone: "UTC" });
}
