"use client";

import {
  Beef,
  AlertTriangle,
  CalendarDays,
  Check,
  CircleDollarSign,
  FlaskConical,
  Leaf,
  MapPinned,
  Pencil,
  Plus,
  Droplets,
  CloudOff,
  Satellite,
  Sprout,
  Tractor,
  Trash2,
  Wheat,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { HelpTip } from "@/src/ui/Hint";
import {
  ACTIVITY_TYPE_LABELS,
  type Activity,
  type ActivityInput,
  type ActivityType,
  type ActivityWithLineage,
  type PaddockStockingLoad,
  type Potrero,
} from "../types";
import type { PaddockNdviListingItem } from "../domain/paddock-ndvi";
import { buildPaddockNdviMonthSeries, paddockNdviMonthKey, type PaddockNdviMonthSlot } from "../ndvi/paddock-ndvi-history";
import { EXCLUSION_KIND_LABELS } from "../utils/exclusions";
import { calculatePerimeterMeters } from "../utils/geometry";
import { LAND_USE_LABELS, paddockAreaMetrics } from "../utils/paddock-metrics";

/**
 * Read-first record of a paddock. Every action that touches the map (edit,
 * boundaries, strips, exclusions, subdivision) lives in the map dashboard, so
 * this card only keeps the history, the satellite series and the soil summary.
 */
type HistorialPotreroProps = {
  potrero: Potrero;
  activities: ActivityWithLineage[];
  canMutate: boolean;
  onClose: () => void;
  onEditExclusion: (index: number) => void;
  onRemoveExclusion: (index: number) => void;
  onManageActivity: (activity: Activity) => void;
  onSave: (activity: ActivityInput) => Promise<void>;
  networkOnline: boolean;
  stockingLoad?: PaddockStockingLoad;
  stockingLoadState: "idle" | "loading" | "loaded" | "error" | "offline";
  ndvi: PaddockNdviListingItem | null;
  ndviLoadState: "idle" | "loading" | "loaded" | "stale" | "offline" | "error";
};

export type UndoPreview = {
  canUndo: boolean;
  blockers: string[];
};

const activityIcons = {
  fertilization: Leaf,
  grazing: Beef,
  soil: FlaskConical,
  harvest: Wheat,
  maintenance: Tractor,
  other: Sprout,
} satisfies Record<ActivityType, typeof Leaf>;

const activityColors = {
  fertilization: "bg-band text-accent",
  grazing: "bg-surface-alt text-accent",
  soil: "bg-surface-alt text-accent",
  harvest: "bg-warn-bg text-warn-ink",
  maintenance: "bg-surface-alt text-accent",
  other: "bg-surface-alt text-ink-muted",
} satisfies Record<ActivityType, string>;

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function HistorialPotrero({
  potrero,
  activities,
  canMutate,
  onClose,
  onEditExclusion,
  onRemoveExclusion,
  onManageActivity,
  onSave,
  networkOnline,
  stockingLoad,
  stockingLoadState,
  ndvi,
  ndviLoadState,
}: HistorialPotreroProps) {
  const [formOpen, setFormOpen] = useState(canMutate && activities.length === 0);
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<ActivityType>("fertilization");
  const [occurredAt, setOccurredAt] = useState(today());
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState("");
  const metrics = paddockAreaMetrics(potrero);
  const hasExclusions = metrics.geometry.holes.length > 0;
  const ndviMonths = useMemo(() => buildPaddockNdviMonthSeries(ndvi), [ndvi]);

  const totalCost = useMemo(
    () => activities.reduce((sum, activity) => sum + (activity.costClp ?? 0), 0),
    [activities],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!description.trim()) return;
    setSaving(true);

    try {
      await onSave({
        potreroId: potrero.id,
        type,
        occurredAt,
        description: description.trim(),
        quantity: toNumber(quantity),
        unit: unit.trim() || null,
        costClp: toNumber(cost),
      });
      setDescription("");
      setQuantity("");
      setUnit("");
      setCost("");
      setFormOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_38px_rgba(35,50,42,0.06)]">
      <div className="flex flex-col gap-4 border-b border-line-steel bg-ink px-5 py-5 text-white md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-accent text-ink">
            <Sprout size={20} />
          </span>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.16em] text-white/45">Ficha del potrero</p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.04em]">{potrero.name}</h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex min-h-11 items-center gap-2 rounded-xl bg-white/[0.08] px-3 text-[12px] font-bold text-white/55">
            <MapPinned size={14} /> Edita, subdivide y agrega hitos desde el panel Potrero del mapa
          </span>
          <SummaryChip label="Superficie total" value={`${metrics.grossAreaHectares.toLocaleString("es-CL")} ha`} />
          <SummaryChip label="Superficie útil" value={`${metrics.effectiveGrazeableAreaHectares.toLocaleString("es-CL")} ha · ${metrics.grazeablePercentage.toLocaleString("es-CL")}%`} />
          <SummaryChip label="Perímetro" value={formatDistance(calculatePerimeterMeters(potrero.coordinates))} />
          <SummaryChip label="Animales" value={stockingLoadState === "loading" ? "Calculando…" : stockingLoad ? stockingLoad.animalCount.toLocaleString("es-CL") : "—"} />
          <SummaryChip label="Carga animal" value={stockingLoad?.animalsPerHectare === null || !stockingLoad ? "—" : `${stockingLoad.animalsPerHectare.toLocaleString("es-CL", { maximumFractionDigits: 2 })} anim/ha`} />
          <button
            aria-label="Cerrar ficha"
            className="grid size-11 place-items-center rounded-xl bg-white/10 text-white/70 hover:bg-white/15 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X size={17} />
          </button>
        </div>
      </div>

      {hasExclusions && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs font-bold text-amber-900" role="status">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} />
          Este potrero tiene exclusiones: las operaciones estructurales están bloqueadas en F1 y el backend no permite crear franjas V1. Puedes editar sus datos y administrar cada exclusión aquí.
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="border-b border-line-steel p-5 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Trazabilidad</p>
              <h3 className="mt-1 flex items-center gap-1.5 text-lg font-black tracking-[-0.035em]">
                Historial de manejos
                <HelpTip label="el historial de manejos" text="Todo lo que se ha hecho en este potrero —pastoreo, fertilización, siembra, corte— con su fecha y su costo." />
              </h3>
            </div>
            <div className="text-right">
              <p className="text-[12px] font-bold uppercase tracking-wide text-ink-subtle">Costo registrado</p>
              <p className="mt-1 text-sm font-black text-ink">{formatClp(totalCost)}</p>
              {potrero.areaHectares > 0 && totalCost > 0 && (
                <p className="mt-0.5 text-[12px] font-bold text-ink-subtle">{formatClp(totalCost / potrero.areaHectares)} por ha</p>
              )}
            </div>
          </div>

          <div className="mt-5 space-y-1">
            {activities.map((activity, index) => {
              const Icon = activityIcons[activity.type];
              return (
                <div className="relative grid grid-cols-[40px_minmax(0,1fr)] gap-3 pb-5" key={activity.id}>
                  {index < activities.length - 1 && <span className="absolute left-[19px] top-9 h-[calc(100%-22px)] w-px bg-band" />}
                  <span className={`z-10 grid size-10 place-items-center rounded-xl ${activityColors[activity.type]}`}>
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-black text-ink">{ACTIVITY_TYPE_LABELS[activity.type]}</p>
                        {activity.inherited && (
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[12px] font-black text-sky-800">
                            Heredada de «{activity.sourcePaddockName ?? "potrero anterior"}»
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="flex items-center gap-1 text-[12px] font-bold text-ink-subtle">
                          <CalendarDays size={11} /> {formatDate(activity.occurredAt)}
                        </span>
                        {!activity.inherited && canMutate && (
                          <button
                            aria-label={`Editar manejo del ${formatDate(activity.occurredAt)}`}
                            className="grid size-7 place-items-center rounded-lg text-ink-subtle transition hover:bg-surface-alt hover:text-accent"
                            onClick={() => onManageActivity(activity)}
                            type="button"
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-[12px] leading-4 text-ink-muted">{activity.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {activity.quantity !== null && (
                        <span className="rounded-full bg-surface-alt px-2 py-1 text-[12px] font-bold text-ink-muted">
                          {activity.quantity.toLocaleString("es-CL")} {activity.unit}
                        </span>
                      )}
                      {activity.costClp !== null && (
                        <span className="flex items-center gap-1 rounded-full bg-warn-bg px-2 py-1 text-[12px] font-bold text-warn-ink">
                          <CircleDollarSign size={10} /> {formatClp(activity.costClp)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {activities.length === 0 && (
              <div className="grid min-h-40 place-items-center rounded-2xl border border-dashed border-line-steel bg-surface-alt p-5 text-center">
                <div>
                  <Sprout className="mx-auto text-accent" size={24} />
                  <p className="mt-2 text-xs font-black">Todavía no hay manejos registrados</p>
                  <p className="mt-1 text-[12px] text-ink-subtle">Crea el primero desde el formulario.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-surface-alt p-5">
          <NdviHistoryCard item={ndvi} loadState={ndviLoadState} months={ndviMonths} />
          <div className="mb-5 rounded-2xl border border-line-steel bg-white p-4">
            <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">Territorio y carga animal</p>
            <p className="mt-2 text-xs font-black text-ink">{LAND_USE_LABELS[potrero.landUse ?? "pradera_permanente"]}</p>
            <p className="mt-1 text-[12px] text-ink-muted">{metrics.netAreaHectares.toLocaleString("es-CL")} ha netas · {metrics.effectiveGrazeableAreaHectares.toLocaleString("es-CL")} ha pastoreables</p>
            {stockingLoadState === "offline" && <p className="mt-2 text-[12px] font-bold text-amber-800">Sin conexión: la carga animal actual no está disponible.</p>}
            {stockingLoadState === "error" && <p className="mt-2 text-[12px] font-bold text-red-700">No fue posible calcular la carga animal.</p>}
            {hasExclusions && (
              <div className="mt-3 space-y-2 border-t border-line-steel pt-3">
                {metrics.geometry.holes.map((_, index) => {
                  const kind = potrero.holeKinds?.[index];
                  return (
                    <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-alt px-3" key={`${potrero.id}-hole-${index}`}>
                      <span className="flex items-center gap-2 text-[12px] font-black text-ink-muted"><Droplets size={14} /> {kind ? EXCLUSION_KIND_LABELS[kind] : `Exclusión ${index + 1}`}</span>
                      {canMutate && (
                        <div className="flex items-center">
                          <button aria-label={`Editar ${kind ? EXCLUSION_KIND_LABELS[kind] : `exclusión ${index + 1}`}`} className="grid size-11 place-items-center rounded-xl text-accent hover:bg-emerald-50 disabled:opacity-40" disabled={!networkOnline} onClick={() => onEditExclusion(index)} type="button"><Pencil size={14} /></button>
                          <button aria-label={`Eliminar ${kind ? EXCLUSION_KIND_LABELS[kind] : `exclusión ${index + 1}`}`} className="grid size-11 place-items-center rounded-xl text-red-700 hover:bg-red-50 disabled:opacity-40" disabled={!networkOnline} onClick={() => onRemoveExclusion(index)} type="button"><Trash2 size={14} /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {canMutate ? (
            <button
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white shadow-[0_8px_20px_rgba(25,120,75,0.16)]"
              onClick={() => setFormOpen((value) => !value)}
              type="button"
            >
              {formOpen ? <X size={15} /> : <Plus size={15} />}
              {formOpen ? "Cancelar registro" : "Registrar manejo"}
            </button>
          ) : (
            <div className="rounded-xl border border-line-steel bg-white px-4 py-3 text-xs font-bold text-ink-muted">Vista de solo lectura</div>
          )}

          {formOpen ? (
            <form className="mt-5 space-y-3" onSubmit={submit}>
              <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                Tipo de manejo
                <select className="input-base" onChange={(event) => setType(event.target.value as ActivityType)} value={type}>
                  {Object.entries(ACTIVITY_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                Fecha
                <input className="input-base" onChange={(event) => setOccurredAt(event.target.value)} type="date" value={occurredAt} />
              </label>
              <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                Descripción
                <textarea
                  className="min-h-20 w-full resize-none rounded-xl border border-line-steel bg-white p-3 text-xs font-medium normal-case tracking-normal text-ink outline-none transition focus:border-accent focus:ring-3 focus:ring-accent/10"
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Ej. Aplicación de urea después del pastoreo"
                  required
                  value={description}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                  Cantidad
                  <input className="input-base" inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} placeholder="—" value={quantity} />
                </label>
                <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                  Unidad
                  <input className="input-base" onChange={(event) => setUnit(event.target.value)} placeholder="kg, ton, animales" value={unit} />
                </label>
              </div>
              <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                Costo total
                <span className="relative">
                  <CircleDollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={14} />
                  <input className="input-base pl-9" inputMode="numeric" onChange={(event) => setCost(event.target.value)} placeholder="0" value={cost} />
                </span>
              </label>
              <button
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-xs font-black text-white disabled:opacity-50"
                disabled={saving || !description.trim()}
                type="submit"
              >
                <Check size={15} /> {saving ? "Guardando…" : "Guardar manejo"}
              </button>
            </form>
          ) : (
            <div className="mt-5 rounded-2xl border border-line-steel bg-white p-4">
              <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">Resumen de suelo</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <SoilMetric label="Nitrógeno" value={potrero.soil.nitrogen} />
                <SoilMetric label="Fósforo" value={potrero.soil.phosphorus} />
                <SoilMetric label="Potasio" value={potrero.soil.potassium} />
                <SoilMetric label="pH" value={potrero.soil.ph} unit="" />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function NdviHistoryCard({
  item,
  loadState,
  months,
}: {
  item: PaddockNdviListingItem | null;
  loadState: HistorialPotreroProps["ndviLoadState"];
  months: readonly PaddockNdviMonthSlot[];
}) {
  const latest = item?.value ?? null;
  const points = months.map((month, index) => {
    const value = month.value?.status === "ok" && month.value.meanNdvi !== null ? month.value.meanNdvi : null;
    return value === null ? null : { x: 18 + index * 52.8, y: 74 - (Math.max(-1, Math.min(1, value)) + 1) * 30, value };
  });
  const segments = points.slice(1).flatMap((point, index) => {
    const previous = points[index];
    return previous && point ? [{ previous, point, key: `${months[index]?.key}-${months[index + 1]?.key}` }] : [];
  });

  return (
    <section aria-labelledby="paddock-ndvi-history-title" className="mb-5 rounded-2xl border border-line-steel bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[12px] font-black uppercase tracking-[0.12em] text-accent"><Satellite size={13} /> Observación satelital</p>
          <h3 className="mt-1 flex items-center gap-1.5 text-xs font-black text-ink" id="paddock-ndvi-history-title">
            NDVI mensual
            <HelpTip help="ndvi" label="el NDVI" />
          </h3>
        </div>
        {latest?.status === "ok" && latest.meanNdvi !== null ? (
          <div className="text-right">
            <p className="text-xl font-black text-accent">{formatNdvi(latest.meanNdvi)}</p>
            <p className="text-[12px] font-bold text-ink-subtle">{formatNdviMonth(latest.month)}</p>
          </div>
        ) : latest?.status === "no_data" ? (
          <div className="text-right"><p className="text-xs font-black text-ink-muted">Sin datos</p><p className="text-[12px] font-bold text-ink-subtle">{formatNdviMonth(latest.month)}</p></div>
        ) : null}
      </div>

      {latest?.status === "ok" && latest.cloudPct !== null && (
        <p className="mt-2 text-[12px] font-bold text-ink-subtle">Nubosidad{latest.cloudPctIsApproximate ? " aproximada" : ""}: {latest.cloudPct.toLocaleString("es-CL", { maximumFractionDigits: 0 })}%</p>
      )}

      {months.length > 0 ? (
        <>
          <svg aria-label="Serie NDVI de los últimos seis meses; los meses sin observación quedan como brechas" className="mt-3 h-24 w-full overflow-visible" role="img" viewBox="0 0 300 88">
            <line stroke="#e5e9e3" strokeDasharray="3 4" x1="10" x2="290" y1="44" y2="44" />
            {segments.map(({ previous, point, key }) => <line key={key} stroke="#19784b" strokeLinecap="round" strokeWidth="3" x1={previous.x} x2={point.x} y1={previous.y} y2={point.y} />)}
            {points.map((point, index) => point ? <circle cx={point.x} cy={point.y} fill="#c8ec74" key={months[index]?.key} r="4" stroke="#173b2d" strokeWidth="2"><title>{months[index]?.label}: {formatNdvi(point.value)}</title></circle> : null)}
          </svg>
          <div className="grid grid-cols-6 gap-1 border-t border-line-steel pt-2">
            {months.map((month) => {
              const known = month.value?.status === "ok" && month.value.meanNdvi !== null;
              return (
                <div className="min-w-0 text-center" key={month.key}>
                  <p className="truncate text-[12px] font-black uppercase text-ink-subtle">{month.label}</p>
                  <p className={`mt-0.5 text-[12px] font-black ${known ? "text-accent" : "text-ink-subtle"}`}>{known ? formatNdvi(month.value!.meanNdvi!) : "—"}</p>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] font-semibold text-ink-subtle">Una brecha indica mes ausente o sin datos; nunca se representa como cero.</p>
        </>
      ) : (
        <p className="mt-3 rounded-xl bg-surface-alt px-3 py-4 text-center text-[12px] font-bold text-ink-subtle">{loadState === "loading" ? "Cargando historial NDVI…" : "Aún no hay observaciones mensuales."}</p>
      )}

      {(loadState === "offline" || loadState === "stale") && item && <p className="mt-3 flex items-center gap-1.5 text-[12px] font-bold text-amber-800" role="status"><CloudOff size={12} /> Historial cargado desde la copia local.</p>}
      {loadState === "error" && !item && <p className="mt-3 text-[12px] font-bold text-red-700" role="alert">No fue posible cargar el historial NDVI.</p>}
    </section>
  );
}

function formatNdvi(value: number) {
  return value.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNdviMonth(value: string) {
  const key = paddockNdviMonthKey(value);
  if (!key) return value;
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("es-CL", { month: "short", year: "numeric", timeZone: "UTC" });
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-xl bg-white/[0.08] px-3 py-2">
      <span className="block text-[12px] font-bold uppercase tracking-wide text-white/40">{label}</span>
      <span className="mt-0.5 block text-[12px] font-black text-white/85">{value}</span>
    </span>
  );
}

function SoilMetric({ label, value, unit = "ppm" }: { label: string; value: number | null; unit?: string }) {
  return (
    <div className="rounded-xl bg-surface-alt p-3">
      <p className="text-[12px] font-bold uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="mt-1 text-sm font-black text-ink">{value?.toLocaleString("es-CL") ?? "—"} <span className="text-[12px] text-ink-subtle">{unit}</span></p>
    </div>
  );
}

function toNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDistance(meters: number) {
  if (meters >= 1_000) return `${(meters / 1_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
  return `${meters.toLocaleString("es-CL", { maximumFractionDigits: 0 })} m`;
}
