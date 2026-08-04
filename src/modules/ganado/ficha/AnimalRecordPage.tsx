"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import { Collapsible } from "@/src/ui/Collapsible";
import { Field } from "@/src/ui/form";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Beef,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardPlus,
  DollarSign,
  Droplets,
  FileHeart,
  Gauge,
  HeartPulse,
  Info,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  UserCheck,
  Weight,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import {
  fetchAnimalRecord,
  persistMilkControl,
  persistReproductiveEvent,
} from "./api/animal-record-client";
import { BirthForm, HealthEventForm, RenumberForm } from "./AnimalRecordForms";
import { SalesDocumentModal } from "@/src/modules/ganado/components/SalesDocumentModal";
import type {
  AnimalDirectoryItem,
  AnimalInsight,
  AnimalRecord,
  AnimalTimelineItem,
  LivestockReproductiveEventType,
  MilkControlInput,
  ReproductiveEventInput,
} from "./domain/types";
import { LIVESTOCK_REPRODUCTIVE_EVENT_LABELS } from "./domain/types";

type AnimalRecordPageProps = {
  animals: AnimalDirectoryItem[];
  initialRecord: AnimalRecord | null;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
};

type ActionTab = "milk" | "reproduction" | "birth" | "health" | "renumber";

export function AnimalRecordPage({ animals, initialRecord, isDemo, organizationId, organizationName, userName }: AnimalRecordPageProps) {
  const [record, setRecord] = useState(initialRecord);
  const [selectedId, setSelectedId] = useState(initialRecord?.animal.id ?? animals[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [actionTab, setActionTab] = useState<ActionTab>("milk");
  const [error, setError] = useState<string | null>(null);
  const filteredAnimals = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    if (!normalized) return animals;
    return animals.filter((animal) => [animal.tag, animal.fieldName, animal.lotName].some((value) => value.toLocaleLowerCase("es").includes(normalized)));
  }, [animals, query]);

  async function selectAnimal(id: string) {
    if (id === selectedId && record) return;
    setSelectedId(id);
    setLoadingId(id);
    setError(null);
    try {
      setRecord(await fetchAnimalRecord(id));
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible abrir la ficha animal."));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <AppShell activeSection="ganado" fieldName={record?.fieldName ?? "Ficha animal 360"} isDemo={isDemo} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <Link className="inline-flex items-center gap-1.5 text-[12px] font-black uppercase tracking-[0.14em] text-accent hover:text-accent" href="/app/ganado"><ArrowLeft size={13} /> Volver a Ganado</Link>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Ficha animal 360</h1>
              <p className="mt-1 max-w-3xl text-sm text-ink-muted">Una cronología única para producción, reproducción, genealogía, salud, peso e identificadores, con alertas que ayudan a decidir qué revisar.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2"><div className="flex items-center gap-2 rounded-xl border border-line-steel bg-white px-3.5 py-2.5 text-xs font-black text-ink-muted"><UserCheck size={15} /> {userName}</div><div className="flex items-center gap-2 rounded-xl border border-line-steel bg-surface-alt px-3.5 py-2.5 text-xs font-black text-accent"><ShieldCheck size={16} /> Escritura auditada</div></div>
          </header>

          {error && <div className="mt-4 flex items-start gap-2 rounded-xl border border-alert-bar bg-surface-alt p-3 text-xs font-bold text-alert-ink"><XCircle className="mt-0.5 shrink-0" size={15} /> {error}</div>}

          <div className="mt-6 grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="self-start overflow-hidden rounded-[20px] border border-line-steel bg-white shadow-[0_8px_30px_rgba(35,50,42,0.04)] xl:sticky xl:top-5">
              <div className="border-b border-line-steel p-4"><h2 className="text-sm font-black text-ink">Animales</h2><div className="mt-3 flex h-10 items-center gap-2 rounded-xl border border-line-steel bg-surface-alt px-3"><Search className="text-ink-subtle" size={14} /><input aria-label="Buscar animal" className="min-w-0 flex-1 bg-transparent text-xs font-bold text-ink outline-none placeholder:text-ink-subtle" onChange={(event) => setQuery(event.target.value)} placeholder="DIIO, fundo o lote" value={query} /></div></div>
              <div className="max-h-[620px] overflow-y-auto">
                {filteredAnimals.length === 0 ? <p className="px-4 py-10 text-center text-xs text-ink-subtle">No hay coincidencias.</p> : filteredAnimals.map((animal) => <AnimalDirectoryButton animal={animal} key={animal.id} loading={loadingId === animal.id} onClick={() => selectAnimal(animal.id)} selected={selectedId === animal.id} />)}
              </div>
            </aside>

            {!record ? <EmptyRecord /> : <RecordWorkspace actionTab={actionTab} onActionTab={setActionTab} onError={setError} onRecord={setRecord} record={record} />}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function RecordWorkspace({ actionTab, onActionTab, onError, onRecord, record }: { actionTab: ActionTab; onActionTab: (value: ActionTab) => void; onError: (value: string | null) => void; onRecord: (value: AnimalRecord) => void; record: AnimalRecord }) {
  const [showSalesModal, setShowSalesModal] = useState(false);
  const activeLactation = record.lactations.find((entry) => entry.status === "active") ?? null;
  const lastControl = record.milkControls[0] ?? null;
  const attentionCount = record.insights.filter((entry) => entry.level === "attention").length;
  const daysInMilk = activeLactation ? dayDifference(activeLactation.startedAt, today()) + 1 : null;
  return (
    <main className="min-w-0">
      {showSalesModal && (
        <SalesDocumentModal
          fieldId={record.fieldId}
          animalId={record.animal.id}
          animalTag={record.animal.tag}
          onClose={() => setShowSalesModal(false)}
        />
      )}
      <section className="rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_12px_38px_rgba(35,50,42,0.05)] sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="flex items-start gap-4"><div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-ink text-white"><Beef size={24} /></div><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-black tracking-[-0.04em] text-ink">{record.animal.tag}</h2><span className={`rounded-full px-2.5 py-1 text-[12px] font-black uppercase ${record.animal.status === "active" ? "bg-surface-alt text-accent" : "bg-surface-alt text-ink-muted"}`}>{record.animal.status === "active" ? "Activo" : record.animal.status}</span></div><p className="mt-1 text-xs text-ink-subtle">{record.fieldName} · {record.lotName} · {sexLabel(record.animal.sex)}</p><div className="mt-3 flex flex-wrap gap-1.5">{record.identifiers.map((identifier) => <IdentifierChip identifier={identifier} key={identifier.id} />)}{record.parentage.map((parent) => <span className="rounded-lg border border-line-steel bg-surface-alt px-2.5 py-1 text-[12px] font-bold text-accent" key={parent.birthId}>Madre: {parent.damTag}{parent.sireIdentifier ? ` · Padre: ${parent.sireIdentifier}` : ""}</span>)}</div></div></div><div className="flex flex-col items-end gap-2"><button onClick={() => setShowSalesModal(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-600/30 bg-emerald-950/20 px-3.5 py-2 text-xs font-black text-emerald-700 hover:bg-emerald-900/30 transition"><DollarSign size={14} /> Cierre Económico y Ventas</button><div className="rounded-xl border border-line-steel bg-surface-alt px-4 py-2.5 text-right"><p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Estado inteligente</p><p className={`mt-1 text-sm font-black ${attentionCount > 0 ? "text-warn-ink" : "text-accent"}`}>{attentionCount > 0 ? `${attentionCount} revisión${attentionCount === 1 ? "" : "es"}` : "Sin alertas críticas"}</p></div></div></div>
      </section>

      <section className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric icon={Droplets} label="Último control" value={lastControl ? `${formatNumber(lastControl.totalLiters)} L` : "—"} tone="blue" /><Metric icon={CalendarDays} label="Día en leche" value={daysInMilk ? String(daysInMilk) : "—"} tone="green" /><Metric icon={Beef} label="Partos trazados" value={String(record.births.length)} tone="neutral" /><Metric icon={FileHeart} label="Salud abiertos" value={String(record.healthEvents.filter((entry) => entry.status === "open").length)} tone="amber" /></section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="rounded-[20px] border border-line-steel bg-white p-5 shadow-[0_8px_30px_rgba(35,50,42,0.04)]"><div className="flex items-center justify-between"><div><h3 className="text-sm font-black text-ink">Señales para actuar</h3><p className="mt-1 text-[12px] text-ink-subtle">Hallazgos calculados desde la historia del animal.</p></div><Sparkles className="text-accent" size={18} /></div><div className="mt-4 space-y-2.5">{record.insights.map((insight) => <InsightCard insight={insight} key={insight.code} />)}</div></div>
        <MilkTrend record={record} />
      </section>

      <section className="mt-4 grid gap-4 2xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
        <Timeline items={record.timeline} />
        <ActionPanel actionTab={actionTab} onActionTab={onActionTab} onError={onError} onRecord={onRecord} record={record} />
      </section>
    </main>
  );
}

function ActionPanel({ actionTab, onActionTab, onError, onRecord, record }: { actionTab: ActionTab; onActionTab: (value: ActionTab) => void; onError: (value: string | null) => void; onRecord: (value: AnimalRecord) => void; record: AnimalRecord }) {
  const femaleOnly = actionTab !== "health" && actionTab !== "renumber";
  return <section className="self-start overflow-hidden rounded-[20px] border border-line-steel bg-white shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
    <div className="border-b border-line-steel p-4"><h3 className="text-sm font-black text-ink">Registrar en la ficha</h3><div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-alt p-1">
      <ActionTabButton active={actionTab === "milk"} icon={Droplets} label="Control lechero" onClick={() => onActionTab("milk")} />
      <ActionTabButton active={actionTab === "reproduction"} icon={HeartPulse} label="Reproducción" onClick={() => onActionTab("reproduction")} />
      <ActionTabButton active={actionTab === "birth"} icon={Beef} label="Parto y crías" onClick={() => onActionTab("birth")} />
      <ActionTabButton active={actionTab === "health"} icon={FileHeart} label="Salud animal" onClick={() => onActionTab("health")} />
      <ActionTabButton active={actionTab === "renumber"} icon={Tag} label="Cambio de número" onClick={() => onActionTab("renumber")} />
    </div></div>
    <div className="p-4">{record.animal.sex === "male" && femaleOnly
      ? <div className="rounded-xl border border-warn-bar bg-surface-alt p-3 text-[12px] leading-relaxed text-warn-ink"><Info className="mb-2" size={15} />La ficha identifica este animal como macho. Los formularios lecheros, reproductivos y de parto están deshabilitados; su historia sanitaria y su número siguen disponibles.</div>
      : actionTab === "milk" ? <MilkControlForm animalId={record.animal.id} onError={onError} onSaved={onRecord} />
        : actionTab === "reproduction" ? <ReproductiveEventForm animalId={record.animal.id} onError={onError} onSaved={onRecord} />
          : actionTab === "birth" ? <BirthForm animalId={record.animal.id} onError={onError} onSaved={onRecord} />
            : actionTab === "renumber" ? <RenumberForm animalId={record.animal.id} currentTag={record.animal.tag} onError={onError} onSaved={onRecord} />
              : <HealthEventForm animalId={record.animal.id} onError={onError} onSaved={onRecord} />}
    </div>
  </section>;
}

function IdentifierChip({ identifier }: { identifier: AnimalRecord["identifiers"][number] }) {
  const retired = identifier.validTo !== null;
  const validity = retired
    ? `hasta ${formatDate(identifier.validTo!)}`
    : identifier.validFrom
      ? `desde ${formatDate(identifier.validFrom)}`
      : null;
  return <span
    className={`rounded-lg border px-2.5 py-1 text-[12px] font-bold ${retired ? "border-dashed border-line-steel bg-white text-ink-subtle" : "border-line-steel bg-surface-alt text-ink-muted"}`}
    title={retired ? "Número retirado; sigue resolviendo la historia importada." : undefined}
  >
    {identifier.kind}: <span className={retired ? "line-through" : undefined}>{identifier.value}</span>
    {validity && <span className="ml-1 font-normal opacity-70">· {validity}</span>}
  </span>;
}

function ActionTabButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return <button className={`flex h-9 items-center justify-center gap-2 rounded-lg text-[12px] font-black ${active ? "bg-white text-accent shadow-sm" : "text-ink-subtle"}`} onClick={onClick} type="button"><Icon size={13} /> {label}</button>;
}

function MilkControlForm({ animalId, onError, onSaved }: { animalId: string; onError: (value: string | null) => void; onSaved: (record: AnimalRecord) => void }) {
  const [values, setValues] = useState({ controlDate: today(), morningLiters: "", afternoonLiters: "", thirdMilkingLiters: "", totalLiters: "", fatPct: "", proteinPct: "", somaticCellCount: "", notes: "" });
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); onError(null);
    const input: MilkControlInput = { animalId, controlDate: values.controlDate, morningLiters: numberOrNull(values.morningLiters), afternoonLiters: numberOrNull(values.afternoonLiters), thirdMilkingLiters: numberOrNull(values.thirdMilkingLiters), totalLiters: numberOrNull(values.totalLiters), fatPct: numberOrNull(values.fatPct), proteinPct: numberOrNull(values.proteinPct), somaticCellCount: numberOrNull(values.somaticCellCount), notes: values.notes };
    try { onSaved(await persistMilkControl(input)); setValues((current) => ({ ...current, morningLiters: "", afternoonLiters: "", thirdMilkingLiters: "", totalLiters: "", fatPct: "", proteinPct: "", somaticCellCount: "", notes: "" })); } catch (cause) { onError(errorMessage(cause, "No fue posible guardar el control.")); } finally { setSaving(false); }
  }
  return <form onSubmit={submit}><div className="grid gap-3 sm:grid-cols-2"><Field label="Fecha"><input className={inputClass} max={today()} onChange={(event) => setValues({ ...values, controlDate: event.target.value })} required type="date" value={values.controlDate} /></Field><Field label="Total litros"><NumberInput onChange={(value) => setValues({ ...values, totalLiters: value })} placeholder="Se calcula si lo omites" value={values.totalLiters} /></Field><Field label="Ordeña AM"><NumberInput onChange={(value) => setValues({ ...values, morningLiters: value })} placeholder="Litros" value={values.morningLiters} /></Field><Field label="Ordeña PM"><NumberInput onChange={(value) => setValues({ ...values, afternoonLiters: value })} placeholder="Litros" value={values.afternoonLiters} /></Field><Field label="Tercera ordeña"><NumberInput onChange={(value) => setValues({ ...values, thirdMilkingLiters: value })} placeholder="Litros" value={values.thirdMilkingLiters} /></Field><Field label="Grasa %"><NumberInput onChange={(value) => setValues({ ...values, fatPct: value })} placeholder="Ej. 3,8" value={values.fatPct} /></Field><Field label="Proteína %"><NumberInput onChange={(value) => setValues({ ...values, proteinPct: value })} placeholder="Ej. 3,2" value={values.proteinPct} /></Field><Field label="Células somáticas"><input className={inputClass} min="0" onChange={(event) => setValues({ ...values, somaticCellCount: event.target.value })} placeholder="células/mL" step="1" type="number" value={values.somaticCellCount} /></Field></div><Field label="Notas"><textarea className={`${inputClass} mt-3 min-h-20 py-3`} maxLength={1000} onChange={(event) => setValues({ ...values, notes: event.target.value })} placeholder="Contexto del control…" value={values.notes} /></Field><SaveButton label="Guardar control" saving={saving} /></form>;
}

function ReproductiveEventForm({ animalId, onError, onSaved }: { animalId: string; onError: (value: string | null) => void; onSaved: (record: AnimalRecord) => void }) {
  const [values, setValues] = useState<{ eventType: LivestockReproductiveEventType; occurredAt: string; method: string; result: string; sireIdentifier: string; notes: string }>({ eventType: "heat", occurredAt: today(), method: "", result: "", sireIdentifier: "", notes: "" });
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); onError(null);
    const input: ReproductiveEventInput = { animalId, eventType: values.eventType, occurredAt: values.occurredAt, method: values.method || null, result: values.result || null, sireIdentifier: values.sireIdentifier || null, notes: values.notes };
    try { onSaved(await persistReproductiveEvent(input)); setValues((current) => ({ ...current, method: "", result: "", sireIdentifier: "", notes: "" })); } catch (cause) { onError(errorMessage(cause, "No fue posible guardar el evento.")); } finally { setSaving(false); }
  }
  return <form onSubmit={submit}><div className="grid gap-3 sm:grid-cols-2"><Field label="Evento"><select className={inputClass} onChange={(event) => setValues({ ...values, eventType: event.target.value as LivestockReproductiveEventType })} value={values.eventType}>{Object.entries(LIVESTOCK_REPRODUCTIVE_EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Fecha"><input className={inputClass} max={today()} onChange={(event) => setValues({ ...values, occurredAt: event.target.value })} required type="date" value={values.occurredAt} /></Field><Field label="Método"><input className={inputClass} maxLength={120} onChange={(event) => setValues({ ...values, method: event.target.value })} placeholder="Natural, IA…" value={values.method} /></Field><Field label="Resultado"><input className={inputClass} maxLength={160} onChange={(event) => setValues({ ...values, result: event.target.value })} placeholder="Positivo, negativo…" value={values.result} /></Field><Field label="Toro / pajilla"><input className={inputClass} maxLength={120} onChange={(event) => setValues({ ...values, sireIdentifier: event.target.value })} placeholder="Identificador" value={values.sireIdentifier} /></Field></div><Field label="Notas"><textarea className={`${inputClass} mt-3 min-h-20 py-3`} maxLength={1000} onChange={(event) => setValues({ ...values, notes: event.target.value })} placeholder="Observaciones del evento…" value={values.notes} /></Field><p className="mt-3 flex gap-2 rounded-lg bg-surface-alt p-2.5 text-[12px] leading-relaxed text-ink-subtle"><Sparkles className="mt-0.5 shrink-0 text-accent" size={12} />Un parto inicia automáticamente una nueva lactancia; un secado cierra la lactancia activa. Ambas acciones quedan auditadas.</p><SaveButton label="Guardar evento" saving={saving} /></form>;
}

function Timeline({ items }: { items: AnimalTimelineItem[] }) {
  const icons: Record<AnimalTimelineItem["kind"], LucideIcon> = { milk_control: Droplets, reproductive_event: HeartPulse, birth: Beef, health_event: FileHeart, weighing: Weight, lactation: CalendarDays };
  const tones = { green: "bg-surface-alt text-accent", amber: "bg-warn-bg text-warn-ink", blue: "bg-surface-alt text-accent", neutral: "bg-surface-alt text-ink-muted", red: "bg-surface-alt text-alert-ink" } as const;
  return <Collapsible defaultOpen helpText="Todo lo que le ha pasado a este animal en una sola línea de tiempo: partos, tratamientos, pesajes y controles de leche." icon={Activity} persistKey="ganado.ficha.cronologia" title="Cronología unificada"><section className="rounded-card border border-line-steel bg-white p-5"><p className="text-xs text-ink-subtle">Producción, reproducción, genealogía, salud y peso en un solo lugar.</p>{items.length === 0 ? <div className="py-12 text-center"><FileHeart className="mx-auto text-ink-subtle" size={24} /><p className="mt-3 text-xs font-black text-ink-muted">Sin eventos todavía</p><p className="mt-1 text-xs text-ink-subtle">Usa el formulario para iniciar la historia clínica-productiva.</p></div> : <div className="mt-5 space-y-0">{items.slice(0, 30).map((item, index) => { const Icon = icons[item.kind]; return <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-3" key={`${item.kind}-${item.id}`}><div className="flex flex-col items-center"><span className={`grid size-8 place-items-center rounded-full ${tones[item.tone]}`}><Icon size={14} /></span>{index < Math.min(items.length, 30) - 1 && <span className="min-h-7 w-px flex-1 bg-band" />}</div><div className="pb-5"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-black text-ink">{item.title}</h4><time className="text-xs font-bold text-ink-subtle">{formatDate(item.occurredAt)}</time></div><p className="mt-1 text-xs leading-relaxed text-ink-subtle">{item.summary}</p></div></div>; })}</div>}</section></Collapsible>;
}

function MilkTrend({ record }: { record: AnimalRecord }) {
  const controls = [...record.milkControls].slice(0, 8).reverse();
  const maximum = Math.max(1, ...controls.map((entry) => entry.totalLiters));
  return <Collapsible defaultOpen help="lecheCurvaLactancia" icon={Gauge} persistKey="ganado.ficha.curva-lechera" title="Curva lechera"><section className="rounded-card border border-line-steel bg-white p-5"><p className="text-xs text-ink-subtle">Últimos controles individuales.</p>{controls.length === 0 ? <div className="grid h-36 place-items-center text-center"><p className="text-xs text-ink-subtle">La curva aparecerá con el primer control.</p></div> : <div className="mt-5 flex h-36 items-end gap-2">{controls.map((entry) => <div className="flex min-w-0 flex-1 flex-col items-center justify-end" key={entry.id}><span className="mb-1 font-mono text-xs font-black text-accent">{formatNumber(entry.totalLiters)}</span><div className="w-full rounded-t-md bg-accent" style={{ height: `${Math.max(8, (entry.totalLiters / maximum) * 105)}px` }} /><span className="mt-1 font-mono text-xs font-bold text-ink-subtle">{entry.controlDate.slice(5)}</span></div>)}</div>}</section></Collapsible>;
}

function InsightCard({ insight }: { insight: AnimalInsight }) {
  const config = { attention: { icon: AlertTriangle, style: "border-warn-bar bg-surface-alt text-warn-ink" }, positive: { icon: CheckCircle2, style: "border-line-steel bg-surface-alt text-accent" }, info: { icon: Info, style: "border-line-steel bg-surface-alt text-accent" } } as const;
  const { icon: Icon, style } = config[insight.level];
  return <div className={`flex gap-3 rounded-xl border p-3 ${style}`}><Icon className="mt-0.5 shrink-0" size={15} /><div><p className="text-[12px] font-black">{insight.title}</p><p className="mt-1 text-[12px] leading-relaxed opacity-80">{insight.detail}</p></div></div>;
}

function AnimalDirectoryButton({ animal, loading, onClick, selected }: { animal: AnimalDirectoryItem; loading: boolean; onClick: () => void; selected: boolean }) {
  return <button className={`flex w-full items-center gap-3 border-b border-line-steel px-4 py-3.5 text-left transition ${selected ? "bg-surface-alt" : "hover:bg-surface-alt"}`} onClick={onClick} type="button"><span className={`grid size-9 shrink-0 place-items-center rounded-xl ${selected ? "bg-accent text-white" : "bg-surface-alt text-ink-muted"}`}><Beef size={15} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-black text-ink">{animal.tag}</span><span className="mt-0.5 block truncate text-[12px] text-ink-subtle">{animal.fieldName} · {animal.lotName}</span></span>{loading ? <LoaderCircle className="animate-spin text-accent" size={14} /> : <ChevronRight className={selected ? "text-accent" : "text-ink-subtle"} size={14} />}</button>;
}

function Metric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: "green" | "blue" | "amber" | "neutral" }) {
  const styles = { green: "border-line-steel text-accent", blue: "border-line-steel text-accent", amber: "border-warn-bar text-warn-ink", neutral: "border-line-steel text-ink-muted" } as const;
  return <div className={`rounded-2xl border bg-white p-4 ${styles[tone]}`}><div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.11em] opacity-70"><Icon size={14} /> {label}</div><p className="mt-2 text-xl font-black tracking-[-0.04em]">{value}</p></div>;
}

function EmptyRecord() {
  return <div className="grid min-h-[460px] place-items-center rounded-[22px] border border-line-steel bg-white p-8 text-center"><div><div className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-alt text-accent"><ClipboardPlus size={22} /></div><h2 className="mt-4 text-lg font-black text-ink">No hay animales individuales</h2><p className="mt-2 max-w-md text-xs leading-relaxed text-ink-subtle">Crea un lote con trazabilidad individual y registra animales para comenzar sus fichas cronológicas.</p><Link className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white" href="/app/ganado">Ir a Ganado <ChevronRight size={14} /></Link></div></div>;
}


function NumberInput({ onChange, placeholder, value }: { onChange: (value: string) => void; placeholder: string; value: string }) {
  return <input className={inputClass} min="0" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} step="0.01" type="number" value={value} />;
}

function SaveButton({ label, saving }: { label: string; saving: boolean }) {
  return <button className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-50" disabled={saving} type="submit">{saving ? <LoaderCircle className="animate-spin" size={14} /> : <CircleDot size={14} />}{saving ? "Guardando…" : label}</button>;
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  return value.toLocaleString("es-CL", { maximumFractionDigits: 2 });
}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function dayDifference(from: string, to: string): number {
  const start = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  const end = new Date(`${to.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function sexLabel(value: AnimalRecord["animal"]["sex"]): string {
  return { female: "Hembra", male: "Macho", unknown: "Sexo pendiente" }[value];
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

const inputClass = "h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15";
