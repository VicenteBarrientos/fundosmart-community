"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import { HelpTip } from "@/src/ui/Hint";
import type { BenchmarkDashboard } from "./server/benchmarking-repository";
import { BENCHMARK_TERMS_REVISION } from "./domain/benchmarking-rules.mjs";
import {
  BarChart3,
  CheckCircle2,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type FundoOption = { id: string; name: string };
type Props = {
  fundos: FundoOption[];
  selectedFieldId: string;
  period: string;
  initialDashboard: BenchmarkDashboard | null;
  canManage: boolean;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
};

const metricLabels: Record<string, string> = {
  "milk.volume_liters": "Volumen de leche",
  "milk.production_per_cow_day_liters": "Litros por vaca/día",
  "milk.somatic_cell_count": "Recuento de células somáticas",
  "reproduction.pregnancy_rate_pct": "Tasa de preñez",
  "reproduction.days_open_average": "Días abiertos",
  "reproduction.calving_interval_days_average": "Intervalo entre partos",
  "weight.average_daily_gain_kg": "Ganancia diaria",
  "health.mastitis_rate_pct": "Tasa de mastitis",
  "outcomes.mortality_rate_pct": "Mortalidad",
  "outcomes.discard_rate_pct": "Descarte",
  "finance.iofc_clp": "Ingreso sobre costo de alimento",
  "finance.feed_cost_clp": "Costo de alimento",
  "finance.cost_per_liter_clp": "Costo por litro",
};

const zoneLabels = {
  los_lagos: "Los Lagos",
  los_rios: "Los Ríos",
  araucania: "La Araucanía",
  nuble_biobio: "Ñuble y Biobío",
  other_chile: "Otra zona de Chile",
};
const sizeLabels = {
  lt_50: "Menos de 50 animales",
  "50_99": "50 a 99 animales",
  "100_199": "100 a 199 animales",
  "200_plus": "200 o más animales",
};
const systemLabels = { pasture: "Pastoril", mixed: "Mixto", confined: "Confinado" };

export function BenchmarkingPage(props: Props) {
  const router = useRouter();
  const [dashboard, setDashboard] = useState(props.initialDashboard);
  const [confirmed, setConfirmed] = useState(false);
  const [profile, setProfile] = useState(() => props.initialDashboard?.profile ?? {
    zone: "los_lagos" as const,
    herdSizeBand: "100_199" as const,
    productionSystem: "pasture" as const,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const navigate = (fieldId: string, period: string) => {
    router.push(`/app/benchmarking?fieldId=${encodeURIComponent(fieldId)}&period=${encodeURIComponent(period)}`);
  };

  const refreshDashboard = async () => {
    if (!props.selectedFieldId || !props.period) return;
    setError(null);
    const response = await fetch(`/api/benchmarking?fieldId=${encodeURIComponent(props.selectedFieldId)}&period=${encodeURIComponent(props.period)}`, { cache: "no-store" });
    const result = await response.json() as { dashboard?: BenchmarkDashboard; error?: string };
    if (!response.ok || !result.dashboard) {
      const message = result.error || "No fue posible actualizar el benchmarking.";
      setError(message);
      throw new Error(message);
    }
    setDashboard(result.dashboard);
    if (result.dashboard.profile) setProfile(result.dashboard.profile);
  };

  const mutate = async (action: string, body: Record<string, unknown>) => {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/benchmarking", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          action,
          fieldId: props.selectedFieldId,
          period: props.period,
          idempotencyKey,
          ...body,
        }),
      });
      const result = await response.json() as { dashboard?: BenchmarkDashboard; error?: string };
      if (!response.ok) throw new Error(result.error || "No fue posible completar la operación.");
      if (result.dashboard) setDashboard(result.dashboard);
      setMessage(action === "enqueue_recompute"
        ? "Cálculo encolado. El resultado aparecerá cuando termine el proceso seguro."
        : "Preferencias guardadas.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible completar la operación.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell activeSection="benchmarking" isDemo={props.isDemo} onRefresh={refreshDashboard} organizationId={props.organizationId} organizationName={props.organizationName} userName={props.userName}>
      <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl space-y-6">
          <header className="rounded-3xl bg-ink p-6 text-white shadow-xl shadow-ink/10 sm:p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="mb-3 flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.18em] text-white">
                  <ShieldCheck size={15} /> Benchmarking protegido
                </p>
                <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Tu posición, sin exponer a otros fundos</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
                  Compara métricas derivadas con una cohorte anónima. Nunca mostramos filas, nombres ni valores individuales de otros participantes.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:w-[420px]">
                <label className="text-[12px] font-black uppercase tracking-wider text-white/60">
                  Fundo
                  <select
                    className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-white/10 px-3 text-sm font-bold text-white"
                    disabled={!props.fundos.length}
                    onChange={(event) => navigate(event.target.value, props.period)}
                    value={props.selectedFieldId}
                  >
                    {props.fundos.map((fundo) => <option className="text-slate-900" key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
                  </select>
                </label>
                <label className="text-[12px] font-black uppercase tracking-wider text-white/60">
                  Período
                  <input
                    className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-white/10 px-3 text-sm font-bold text-white"
                    onChange={(event) => navigate(props.selectedFieldId, event.target.value)}
                    type="month"
                    value={props.period}
                  />
                </label>
              </div>
            </div>
          </header>

          <section className="grid gap-4 md:grid-cols-3" aria-label="Garantías de privacidad">
            <PrivacyCard icon={LockKeyhole} title="Opt-in explícito" text="Solo participa una organización cuando su propietario o administrador lo confirma." />
            <PrivacyCard icon={UsersRound} title="k-anonimato" text="Una distribución se publica únicamente cuando alcanza el mínimo configurado." />
            <PrivacyCard icon={EyeOff} title="Sin datos de pares" text="La API devuelve tu posición y percentiles agregados; nunca la lista de participantes." />
          </section>

          {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700" role="alert">{error}</div>}
          {message && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800" role="status">{message}</div>}

          {!dashboard ? (
            <EmptyState title="No hay fundos disponibles" text="Asigna un fundo a tu membresía para configurar benchmarking." />
          ) : dashboard.reason === "demo_excluded" ? (
            <EmptyState title="La demo no participa" text="Los datos ficticios nunca entran en cohortes reales ni reciben resultados de otros fundos." />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="space-y-5">
                <section className="rounded-3xl border border-line-steel bg-white p-5 shadow-sm">
                  <p className="eyebrow">Consentimiento</p>
                  <h2 className="mt-2 flex items-center gap-1.5 text-xl font-black text-ink">
                    {dashboard.consent.status === "opted_in" ? "Participación activa" : "Participación desactivada"}
                    <HelpTip help="benchmarkingOptIn" label="la participación en el benchmarking" />
                  </h2>
                  <p className="mt-2 text-xs leading-5 text-ink-muted">
                    El opt-out bloquea de inmediato tu tablero y retira el fundo de los agregados futuros.
                  </p>
                  {props.canManage ? (
                    <div className="mt-5 space-y-3">
                      {dashboard.consent.status !== "opted_in" && (
                        <label className="flex gap-3 rounded-2xl bg-bg-steel p-3 text-xs leading-5 text-ink-muted">
                          <input checked={confirmed} className="mt-1 size-4 accent-accent" onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
                          Confirmo que autorizo el uso de métricas derivadas en distribuciones anónimas bajo k-anonimato.
                        </label>
                      )}
                      <button
                        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={busy !== null || (dashboard.consent.status !== "opted_in" && !confirmed)}
                        onClick={() => mutate("set_consent", dashboard.consent.status === "opted_in"
                          ? { status: "opted_out", confirmed: false, termsRevision: null }
                          : { status: "opted_in", confirmed: true, termsRevision: BENCHMARK_TERMS_REVISION })}
                        type="button"
                      >
                        {busy === "set_consent" ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                        {dashboard.consent.status === "opted_in" ? "Dejar de participar" : "Confirmar participación"}
                      </button>
                    </div>
                  ) : <p className="mt-4 text-xs font-bold text-ink-muted">Solo propietarios y administradores pueden cambiar esta decisión.</p>}
                </section>

                <section className="rounded-3xl border border-line-steel bg-white p-5 shadow-sm">
                  <p className="flex items-center gap-1 eyebrow">
                    Cohorte
                    <HelpTip help="benchmarkingCohorte" label="la cohorte" />
                  </p>
                  <div className="mt-4 space-y-3">
                    <ProfileSelect label="Zona" labels={zoneLabels} onChange={(zone) => setProfile({ ...profile, zone })} value={profile.zone} />
                    <ProfileSelect label="Tamaño del rebaño" labels={sizeLabels} onChange={(herdSizeBand) => setProfile({ ...profile, herdSizeBand })} value={profile.herdSizeBand} />
                    <ProfileSelect label="Sistema" labels={systemLabels} onChange={(productionSystem) => setProfile({ ...profile, productionSystem })} value={profile.productionSystem} />
                  </div>
                  {props.canManage && (
                    <button
                      className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-4 text-xs font-black text-ink-muted disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() => mutate("save_profile", { profile })}
                      type="button"
                    >
                      {busy === "save_profile" ? <LoaderCircle className="animate-spin" size={16} /> : <SlidersHorizontal size={16} />}
                      Guardar clasificación
                    </button>
                  )}
                </section>
              </aside>

              <section className="rounded-3xl border border-line-steel bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="eyebrow">Resultados anónimos</p>
                    <h2 className="mt-2 flex items-center gap-1.5 text-2xl font-black text-ink">
                      Posición en tu cohorte
                      <HelpTip help="benchmarkingPosicion" label="tu posición en la cohorte" />
                    </h2>
                  </div>
                  {props.canManage && dashboard.consent.status === "opted_in" && dashboard.profile && (
                    <button
                      className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() => mutate("enqueue_recompute", { kThreshold: 5 })}
                      type="button"
                    >
                      {busy === "enqueue_recompute" ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                      Solicitar actualización
                    </button>
                  )}
                </div>

                {dashboard.reason === "consent_required" ? (
                  <EmptyState title="Activa tu participación" text="Confirma el consentimiento antes de aportar o consultar resultados." />
                ) : dashboard.reason === "profile_required" ? (
                  <EmptyState title="Completa la cohorte" text="Guarda zona, tamaño de rebaño y sistema productivo para iniciar la comparación." />
                ) : dashboard.metrics.length === 0 ? (
                  <EmptyState title="Aún no hay resultados" text="El cálculo periódico publicará una distribución cuando exista información derivada suficiente." />
                ) : (
                  <div className="mt-6 grid gap-4 xl:grid-cols-2">
                    {dashboard.metrics.map((metric) => (
                      <article className="rounded-2xl border border-line-steel bg-surface-alt p-5" key={metric.metricKey}>
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-black text-ink">{metricLabels[metric.metricKey] ?? metric.metricKey}</p>
                            <p className="mt-1 text-[12px] font-bold uppercase tracking-wider text-ink-subtle">{metric.unit.replaceAll("_", " ")}</p>
                          </div>
                          <BarChart3 className="text-accent" size={20} />
                        </div>
                        {metric.status === "suppressed" ? (
                          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
                            <p className="text-xs font-black text-amber-800">Cohorte suprimida</p>
                            <p className="mt-1 text-xs leading-5 text-amber-700">No alcanzó el mínimo de {metric.kThreshold} fundos. El conteo exacto permanece oculto.</p>
                          </div>
                        ) : (
                          <>
                            <div className="mt-5 flex items-end justify-between gap-4">
                              <div>
                                <p className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">Tu valor</p>
                                <p className="mt-1 text-3xl font-black text-ink">{formatNumber(metric.own?.value)}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">Tu percentil</p>
                                <p className="mt-1 text-2xl font-black text-accent">P{Math.round(metric.own?.percentileRank ?? 0)}</p>
                              </div>
                            </div>
                            {metric.percentiles && (
                              <div className="mt-5 grid grid-cols-5 gap-1 border-t border-line-steel pt-4">
                                {Object.entries(metric.percentiles).map(([key, value]) => (
                                  <div className="text-center" key={key}>
                                    <p className="text-[12px] font-black uppercase text-ink-subtle">{key}</p>
                                    <p className="mt-1 text-[12px] font-black text-ink-muted">{formatNumber(value)}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                            <p className="mt-4 text-[12px] text-ink-subtle">Cohorte con al menos {metric.kThreshold} fundos · sin conteo exacto, identidades ni filas individuales</p>
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>
    </AppShell>
  );
}

function PrivacyCard({ icon: Icon, title, text }: { icon: typeof ShieldCheck; title: string; text: string }) {
  return (
    <article className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm">
      <Icon className="text-accent" size={20} />
      <h2 className="mt-3 text-sm font-black text-ink">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-ink-muted">{text}</p>
    </article>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line-steel bg-surface-alt p-8 text-center">
      <LockKeyhole className="mx-auto text-accent" size={28} />
      <h3 className="mt-3 text-base font-black text-ink">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-ink-muted">{text}</p>
    </div>
  );
}

function ProfileSelect<T extends string>({
  label,
  labels,
  value,
  onChange,
}: {
  label: string;
  labels: Record<T, string>;
  value: T;
  onChange(value: T): void;
}) {
  return (
    <label className="field-label">
      {label}
      <select className="input-base mt-2" onChange={(event) => onChange(event.target.value as T)} value={value}>
        {(Object.entries(labels) as Array<[T, string]>).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(value);
}
