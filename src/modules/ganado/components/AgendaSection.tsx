"use client";

import type { LivestockAnimal, LivestockLot } from "@/src/core/domain/types";
import { HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import type { HerdOperations, HerdWorkItem } from "../domain/operations";
import type { LivestockHealthEventType } from "../ficha/domain/types";
import { persistBatchHealth } from "../api/livestock-client";
import { BellRing, CalendarDays, CheckCircle2, Download, Mail, ShieldAlert, Stethoscope, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

type AgendaSectionProps = {
  operations: HerdOperations;
  onOperationsChange: (value: HerdOperations) => void;
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  fieldIds: string[];
  onOpenSag: () => void;
};

export function AgendaSection({ operations, onOperationsChange, animals, lots, fieldIds, onOpenSag }: AgendaSectionProps) {
  const activeAnimals = animals.filter((entry) => entry.status === "active");
  const individualLots = lots.filter((entry) => entry.trackingMode === "individual" && activeAnimals.some((animal) => animal.lotId === entry.id));
  const [lotId, setLotId] = useState(individualLots[0]?.id ?? "");
  const lotAnimals = activeAnimals.filter((entry) => entry.lotId === lotId);
  const [selected, setSelected] = useState<string[]>([]);
  const [event, setEvent] = useState({
    eventType: "vaccination" as LivestockHealthEventType,
    occurredAt: today(), condition: "", productName: "", activeIngredient: "", doseAmount: "", doseUnit: "mL", route: "SC",
    withdrawalMilkUntil: "", withdrawalMeatUntil: "", professional: "", notes: "", status: "completed" as const,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submitBatch(eventForm: FormEvent<HTMLFormElement>) {
    eventForm.preventDefault();
    const ids = selected.length ? selected : lotAnimals.map((entry) => entry.id);
    if (!ids.length) return setMessage("Selecciona un lote con animales o marca animales específicos.");
    if (ids.length > 40) return setMessage("Selecciona hasta 40 animales por operación para mantener el registro atómico y auditable.");
    setSaving(true); setMessage(null);
    try {
      const result = await persistBatchHealth(ids, {
        eventType: event.eventType, occurredAt: event.occurredAt, status: event.status,
        condition: event.condition.trim() || null, productName: event.productName.trim() || null,
        activeIngredient: event.activeIngredient.trim() || null,
        doseAmount: event.doseAmount ? Number(event.doseAmount.replace(",", ".")) : null,
        doseUnit: event.doseUnit.trim() || null, route: event.route.trim() || null,
        withdrawalMilkUntil: event.withdrawalMilkUntil || null, withdrawalMeatUntil: event.withdrawalMeatUntil || null,
        professional: event.professional.trim() || null, notes: event.notes.trim(),
      });
      onOperationsChange(result.operations);
      setSelected([]);
      setMessage(`${result.created} fichas actualizadas en una sola operación.`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No fue posible registrar el tratamiento grupal."); }
    finally { setSaving(false); }
  }

  async function enableBrowserAlerts() {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return setMessage("Este navegador no admite notificaciones instalables.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return setMessage("Las notificaciones quedaron desactivadas en el navegador.");
    const registration = await navigator.serviceWorker.register("/sw.js");
    const urgent = operations.workItems.filter((entry) => entry.priority === "overdue" || entry.priority === "today");
    await registration.showNotification("FundoSmart · Agenda de ganado", {
      body: urgent.length ? `${urgent.length} tarea${urgent.length === 1 ? "" : "s"} requiere${urgent.length === 1 ? "" : "n"} atención.` : "La agenda del rebaño está al día.",
      icon: "/fundosmart-ultra-min-app-icon-192.png", badge: "/fundosmart-ultra-min-app-icon-192.png", tag: "fundosmart-herd-agenda", data: { url: "/ganado" },
    });
    localStorage.setItem("fundosmart:herd-notifications", "enabled");
    await saveNotificationPreferences(fieldIds, false, true);
    setMessage("Alertas del navegador activadas. Se actualizarán al abrir o sincronizar FundoSmart.");
  }

  async function enableEmailAlerts() {
    try {
      await saveNotificationPreferences(fieldIds, true, localStorage.getItem("fundosmart:herd-notifications") === "enabled");
      setMessage("Resumen automático por email activado para tus fundos, con 14 días de anticipación.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No fue posible activar los emails automáticos."); }
  }

  const emailHref = useMemo(() => buildEmailDigest(operations.workItems), [operations.workItems]);
  const urgentCount = operations.workItems.filter((entry) => entry.priority === "overdue" || entry.priority === "today").length;

  return <div className="space-y-5">
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric helpText="Tareas de la agenda que ya están atrasadas o vencen hoy." label="Tareas urgentes" value={urgentCount} detail={`${operations.workItems.length} acciones en agenda`} icon={<ShieldAlert size={17} />} tone="amber" />
      <Metric help="analiticaTasaPrenez" label="Tasa de preñez" value={pct(operations.kpis.pregnancyRatePct)} detail={`${operations.kpis.confirmedPregnancies} de ${operations.kpis.servedFemales} servidas`} icon={<TrendingUp size={17} />} />
      <Metric helpText="Cuántas inseminaciones costó, en promedio, dejar preñada a una vaca. Más de dos encarece bastante la reproducción." label="Servicios / concepción" value={number(operations.kpis.servicesPerConception)} detail="Últimos 12 meses" icon={<Stethoscope size={17} />} />
      <Metric help="reproIntervaloPartos" label="Intervalo entre partos" value={operations.kpis.averageCalvingIntervalDays ? `${operations.kpis.averageCalvingIntervalDays} días` : "Sin base"} detail={`${pct(operations.kpis.difficultBirthRatePct)} partos asistidos`} icon={<CalendarDays size={17} />} />
    </section>

    <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="eyebrow">Lista de trabajo</p><h2 className="mt-1 text-lg font-black text-ink">Qué hay que hacer en el rebaño</h2><p className="mt-1 text-xs text-ink-muted">Ordenado por vencimiento para actuar sin abrir ficha por ficha.</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="action-secondary" onClick={enableBrowserAlerts} type="button"><BellRing size={14} /> Activar alertas</button>
          <button className="action-secondary" onClick={enableEmailAlerts} type="button"><Mail size={14} /> Activar email</button>
          <a className="action-secondary" href={emailHref}>Email manual</a>
          <button className="action-secondary" onClick={onOpenSag} type="button"><Download size={14} /> Exportar SIPEC/SAG</button>
        </div>
      </div>
      {message && <p className="mt-3 rounded-xl bg-band px-3 py-2 text-xs font-bold text-accent">{message}</p>}
      <div className="mt-4 grid gap-2 lg:grid-cols-2">
        {operations.workItems.slice(0, 40).map((item) => <WorkItemCard item={item} key={item.id} />)}
        {operations.workItems.length === 0 && <div className="rounded-xl bg-surface-alt p-5 text-sm font-bold text-ink-muted">No hay tareas pendientes con la información actual.</div>}
      </div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
      <div className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5">
        <p className="eyebrow">Calendario reproductivo</p><h2 className="mt-1 text-lg font-black text-ink">Partos y secados proyectados</h2>
        <TableExplorer
          className="mt-4"
          description="Partos, secados y diagnósticos proyectados del rebaño."
          filter={{ label: "Estado", allLabel: "Todos los estados", columnIndex: 4 }}
          id="ganado.agenda.calendario"
          searchPlaceholder="Buscar animal, lote o estado..."
          title="Calendario reproductivo"
        >
          <table className="w-full min-w-[720px] text-left text-xs"><thead className="text-[12px] uppercase tracking-wider text-ink-subtle"><tr><th className="pb-2">Animal</th><th className="pb-2">Diagnóstico</th><th className="pb-2">Secado</th><th className="pb-2">Parto</th><th className="pb-2">Estado</th></tr></thead><tbody className="divide-y divide-line-steel">{operations.projections.map((entry) => <tr key={entry.animalId}><td className="py-2.5 font-black"><Link href={`/ganado/ficha?animalId=${encodeURIComponent(entry.animalId)}`}>{entry.animalTag}</Link><span className="block text-[12px] font-medium text-ink-subtle">{entry.lotName}</span></td><td>{date(entry.diagnosisDueDate)}</td><td>{date(entry.dryOffDueDate)}</td><td>{date(entry.calvingDueDate)}</td><td><span className={`rounded-full px-2 py-1 text-[12px] font-black ${entry.confirmedPregnant ? "bg-band text-accent" : "bg-amber-50 text-amber-800"}`}>{entry.confirmedPregnant ? "Confirmada" : "Por confirmar"}</span></td></tr>)}</tbody></table>
        </TableExplorer>
      </div>

      <form className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5" onSubmit={submitBatch}>
        <p className="eyebrow">Manejo grupal</p><h2 className="mt-1 text-lg font-black text-ink">Tratamiento o vacunación</h2><p className="mt-1 text-xs text-ink-muted">Una captura crea un evento auditable en cada ficha.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="field-label">Lote<select className="input-base mt-1" onChange={(e) => { setLotId(e.target.value); setSelected([]); }} value={lotId}>{individualLots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}</select></label>
          <label className="field-label">Evento<select className="input-base mt-1" onChange={(e) => setEvent({ ...event, eventType: e.target.value as LivestockHealthEventType })} value={event.eventType}><option value="vaccination">Vacunación</option><option value="treatment">Tratamiento</option><option value="observation">Observación</option></select></label>
          <label className="field-label">Fecha<input className="input-base mt-1" max={today()} onChange={(e) => setEvent({ ...event, occurredAt: e.target.value })} required type="date" value={event.occurredAt} /></label>
          <label className="field-label">Producto<input className="input-base mt-1" onChange={(e) => setEvent({ ...event, productName: e.target.value })} placeholder="Nombre comercial" required={event.eventType === "vaccination" || event.eventType === "treatment"} value={event.productName} /></label>
          {event.eventType !== "vaccination" && <label className="field-label sm:col-span-2">Motivo o condición<input className="input-base mt-1" onChange={(e) => setEvent({ ...event, condition: e.target.value })} placeholder="Diagnóstico, motivo o seguimiento" required value={event.condition} /></label>}
          <label className="field-label">Dosis<input className="input-base mt-1" min="0" onChange={(e) => setEvent({ ...event, doseAmount: e.target.value })} step="0.01" type="number" value={event.doseAmount} /></label>
          <label className="field-label">Unidad / vía<div className="mt-1 grid grid-cols-2 gap-2"><input className="input-base" onChange={(e) => setEvent({ ...event, doseUnit: e.target.value })} value={event.doseUnit} /><input className="input-base" onChange={(e) => setEvent({ ...event, route: e.target.value })} value={event.route} /></div></label>
          <label className="field-label">Retiro leche<input className="input-base mt-1" min={event.occurredAt} onChange={(e) => setEvent({ ...event, withdrawalMilkUntil: e.target.value })} type="date" value={event.withdrawalMilkUntil} /></label>
          <label className="field-label">Retiro carne<input className="input-base mt-1" min={event.occurredAt} onChange={(e) => setEvent({ ...event, withdrawalMeatUntil: e.target.value })} type="date" value={event.withdrawalMeatUntil} /></label>
        </div>
        <div className="mt-3 max-h-36 overflow-y-auto rounded-xl border border-line-steel p-2"><button className="mb-2 text-[12px] font-black text-accent" onClick={() => setSelected(selected.length === lotAnimals.length ? [] : lotAnimals.map((entry) => entry.id))} type="button">{selected.length === lotAnimals.length ? "Usar lote completo" : "Marcar todos"}</button><div className="grid gap-1 sm:grid-cols-2">{lotAnimals.map((animal) => <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] font-bold hover:bg-surface-alt" key={animal.id}><input checked={selected.includes(animal.id)} onChange={() => setSelected((current) => current.includes(animal.id) ? current.filter((id) => id !== animal.id) : [...current, animal.id])} type="checkbox" />{animal.tag}</label>)}</div></div>
        <button className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white disabled:opacity-50" disabled={saving || !lotAnimals.length} type="submit"><CheckCircle2 size={15} />{saving ? "Guardando…" : `Aplicar a ${selected.length || lotAnimals.length} animales`}</button>
      </form>
    </section>

    <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5">
      <p className="eyebrow">Cierre económico</p><h2 className="mt-1 text-lg font-black text-ink">Margen estimado de animales vendidos</h2><p className="mt-1 text-xs text-ink-muted">Precio de venta menos compra y prorrateo de gastos del lote hasta la fecha. Revisa el detalle antes de liquidar.</p>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">{operations.lotMargins.map((entry) => <div className="rounded-xl bg-surface-alt p-4" key={entry.lotId}><p className="text-xs font-black">{entry.lotName}</p><p className={`mt-2 text-xl font-black ${entry.marginClp >= 0 ? "text-accent" : "text-red-700"}`}>{money(entry.marginClp)}</p><p className="mt-1 text-[12px] text-ink-muted">{entry.soldAnimals} vendidos · ingresos {money(entry.revenueClp)}</p></div>)}</div>
    </section>
  </div>;
}

function WorkItemCard({ item }: { item: HerdWorkItem }) { const tone = item.priority === "overdue" ? "border-red-200 bg-red-50" : item.priority === "today" ? "border-amber-200 bg-amber-50" : "border-line-steel bg-surface-alt"; return <Link className={`rounded-xl border p-3 ${tone}`} href={`/ganado/ficha?animalId=${encodeURIComponent(item.animalId)}`}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-ink">{item.title} · {item.animalTag}</p><p className="mt-1 text-[12px] text-ink-muted">{item.lotName} · {item.detail}</p></div><span className="shrink-0 text-[12px] font-black text-ink-muted">{date(item.dueDate)}</span></div></Link>; }
function Metric({ help, helpText, label, value, detail, icon, tone = "green" }: { help?: HelpKey; helpText?: string; label: string; value: string | number; detail: string; icon: ReactNode; tone?: "green" | "amber" }) { return <div className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm"><div className={`grid size-8 place-items-center rounded-lg ${tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-band text-accent"}`}>{icon}</div><p className="mt-3 flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">{label}<HelpTip help={help} label={label} text={helpText} /></p><p className="mt-1 text-2xl font-black text-ink">{value}</p><p className="mt-1 text-[12px] text-ink-subtle">{detail}</p></div>; }
function buildEmailDigest(items: HerdWorkItem[]): string { const body = items.slice(0, 30).map((entry) => `- ${entry.title}: ${entry.animalTag} (${entry.lotName}), vence ${date(entry.dueDate)}. ${entry.detail}`).join("\n"); return `mailto:?subject=${encodeURIComponent("FundoSmart · Agenda del rebaño")}&body=${encodeURIComponent(`Agenda generada por FundoSmart\n\n${body || "Sin tareas pendientes."}`)}`; }
function today() { return new Date().toISOString().slice(0, 10); }
function date(value: string) { return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)); }
function money(value: number) { return value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }); }
function pct(value: number | null) { return value === null ? "Sin base" : `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`; }
function number(value: number | null) { return value === null ? "Sin base" : value.toLocaleString("es-CL", { maximumFractionDigits: 2 }); }
async function saveNotificationPreferences(fieldIds: string[], emailEnabled: boolean, browserEnabled: boolean) { const response = await fetch("/api/ganado/notificaciones", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fieldIds, emailEnabled, browserEnabled, reminderDays: 14 }) }); if (!response.ok) { const payload = await response.json() as { error?: string }; throw new Error(payload.error ?? "No fue posible guardar las preferencias de alertas."); } }
