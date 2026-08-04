"use client";

import { CircleDot, Info, LoaderCircle, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Field } from "@/src/ui/form";
import { persistBirth, persistHealthEvent, persistRenumber } from "./api/animal-record-client";
import type {
  AnimalRecord,
  BirthInput,
  HealthEventInput,
  LivestockHealthEventStatus,
  LivestockHealthEventType,
  LivestockOffspringOutcome,
} from "./domain/types";
import {
  LIVESTOCK_CALVING_DIFFICULTY_LABELS,
  LIVESTOCK_HEALTH_EVENT_LABELS,
} from "./domain/types";

type FormProps = {
  animalId: string;
  onError: (value: string | null) => void;
  onSaved: (record: AnimalRecord) => void;
};

type OffspringDraft = {
  temporaryIdentifier: string;
  sex: "female" | "male" | "unknown";
  outcome: LivestockOffspringOutcome;
  birthWeightKg: string;
  notes: string;
};

const emptyOffspring = (): OffspringDraft => ({
  temporaryIdentifier: "",
  sex: "unknown",
  outcome: "alive",
  birthWeightKg: "",
  notes: "",
});

export function BirthForm({ animalId, onError, onSaved }: FormProps) {
  const [values, setValues] = useState({
    occurredAt: today(),
    difficulty: "unassisted" as BirthInput["difficulty"],
    outcome: "live" as BirthInput["outcome"],
    sireIdentifier: "",
    notes: "",
  });
  const [offspring, setOffspring] = useState<OffspringDraft[]>([emptyOffspring()]);
  const [saving, setSaving] = useState(false);

  function setOffspringCount(count: number) {
    setOffspring((current) => Array.from({ length: count }, (_, index) => current[index] ?? emptyOffspring()));
  }

  function updateOffspring(index: number, patch: Partial<OffspringDraft>) {
    setOffspring((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError(null);
    const input: BirthInput = {
      animalId,
      occurredAt: values.occurredAt,
      calvingType: offspring.length === 1 ? "single" : offspring.length === 2 ? "twin" : "multiple",
      difficulty: values.difficulty,
      outcome: values.outcome,
      sireIdentifier: values.sireIdentifier || null,
      notes: values.notes,
      offspring: offspring.map((entry) => ({
        ...entry,
        birthWeightKg: numberOrNull(entry.birthWeightKg),
      })),
    };
    try {
      onSaved(await persistBirth(input));
      setOffspring([emptyOffspring()]);
      setValues((current) => ({ ...current, sireIdentifier: "", notes: "" }));
    } catch (cause) {
      onError(errorMessage(cause, "No fue posible guardar el parto."));
    } finally {
      setSaving(false);
    }
  }

  return <form onSubmit={submit}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Fecha del parto"><input className={inputClass} max={today()} onChange={(event) => setValues({ ...values, occurredAt: event.target.value })} required type="date" value={values.occurredAt} /></Field>
      <Field label="Número de crías"><select className={inputClass} onChange={(event) => setOffspringCount(Number(event.target.value))} value={offspring.length}><option value="1">1 · Parto único</option><option value="2">2 · Mellizos</option><option value="3">3 · Múltiple</option></select></Field>
      <Field label="Dificultad"><select className={inputClass} onChange={(event) => setValues({ ...values, difficulty: event.target.value as BirthInput["difficulty"] })} value={values.difficulty}>{Object.entries(LIVESTOCK_CALVING_DIFFICULTY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Resultado"><select className={inputClass} onChange={(event) => setValues({ ...values, outcome: event.target.value as BirthInput["outcome"] })} value={values.outcome}><option value="live">Crías vivas</option><option value="mixed">Resultado mixto</option><option value="stillbirth">Mortinato</option><option value="unknown">Pendiente</option></select></Field>
      <Field label="Toro / pajilla"><input className={inputClass} maxLength={120} onChange={(event) => setValues({ ...values, sireIdentifier: event.target.value })} placeholder="Identificador paterno" value={values.sireIdentifier} /></Field>
    </div>
    <div className="mt-4 space-y-3">
      {offspring.map((entry, index) => <fieldset className="rounded-xl border border-line-steel bg-surface-alt p-3" key={index}>
        <legend className="px-1 text-[12px] font-black uppercase tracking-[0.1em] text-accent">Cría {index + 1}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="DIIO o identificador temporal"><input className={inputClass} maxLength={120} onChange={(event) => updateOffspring(index, { temporaryIdentifier: event.target.value })} placeholder="Ej. CRIA-2026-041" required value={entry.temporaryIdentifier} /></Field>
          <Field label="Sexo"><select className={inputClass} onChange={(event) => updateOffspring(index, { sex: event.target.value as OffspringDraft["sex"] })} value={entry.sex}><option value="unknown">Pendiente</option><option value="female">Hembra</option><option value="male">Macho</option></select></Field>
          <Field label="Condición"><select className={inputClass} onChange={(event) => updateOffspring(index, { outcome: event.target.value as LivestockOffspringOutcome })} value={entry.outcome}><option value="alive">Viva</option><option value="stillborn">Mortinata</option><option value="deceased">Fallecida</option><option value="unknown">Pendiente</option></select></Field>
          <Field label="Peso al nacer (kg)"><input className={inputClass} max="100" min="0.01" onChange={(event) => updateOffspring(index, { birthWeightKg: event.target.value })} placeholder="Ej. 38,5" step="0.01" type="number" value={entry.birthWeightKg} /></Field>
        </div>
      </fieldset>)}
    </div>
    <Field label="Notas"><textarea className={`${inputClass} mt-3 min-h-20 py-3`} maxLength={1000} onChange={(event) => setValues({ ...values, notes: event.target.value })} placeholder="Observaciones del parto y las crías…" value={values.notes} /></Field>
    <p className="mt-3 flex gap-2 rounded-lg bg-surface-alt p-2.5 text-[12px] leading-relaxed text-ink-subtle"><Sparkles className="mt-0.5 shrink-0 text-accent" size={12} />El parto abre la lactancia, crea el evento reproductivo y enlaza automáticamente las crías que ya existan por DIIO.</p>
    <SaveButton label="Guardar parto y genealogía" saving={saving} />
  </form>;
}

export function HealthEventForm({ animalId, onError, onSaved }: FormProps) {
  const [values, setValues] = useState({
    eventType: "observation" as LivestockHealthEventType,
    occurredAt: today(),
    status: "open" as LivestockHealthEventStatus,
    condition: "",
    productName: "",
    activeIngredient: "",
    doseAmount: "",
    doseUnit: "",
    route: "",
    withdrawalMilkUntil: "",
    withdrawalMeatUntil: "",
    professional: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError(null);
    const input: HealthEventInput = {
      animalId,
      eventType: values.eventType,
      occurredAt: values.occurredAt,
      status: values.status,
      condition: values.condition || null,
      productName: values.productName || null,
      activeIngredient: values.activeIngredient || null,
      doseAmount: numberOrNull(values.doseAmount),
      doseUnit: values.doseUnit || null,
      route: values.route || null,
      withdrawalMilkUntil: values.withdrawalMilkUntil || null,
      withdrawalMeatUntil: values.withdrawalMeatUntil || null,
      professional: values.professional || null,
      notes: values.notes,
    };
    try {
      onSaved(await persistHealthEvent(input));
      setValues((current) => ({ ...current, condition: "", productName: "", activeIngredient: "", doseAmount: "", doseUnit: "", route: "", withdrawalMilkUntil: "", withdrawalMeatUntil: "", professional: "", notes: "" }));
    } catch (cause) {
      onError(errorMessage(cause, "No fue posible guardar el evento sanitario."));
    } finally {
      setSaving(false);
    }
  }

  return <form onSubmit={submit}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Evento"><select className={inputClass} onChange={(event) => setValues({ ...values, eventType: event.target.value as LivestockHealthEventType })} value={values.eventType}>{Object.entries(LIVESTOCK_HEALTH_EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Fecha"><input className={inputClass} max={today()} onChange={(event) => setValues({ ...values, occurredAt: event.target.value })} required type="date" value={values.occurredAt} /></Field>
      <Field label="Estado"><select className={inputClass} onChange={(event) => setValues({ ...values, status: event.target.value as LivestockHealthEventStatus })} value={values.status}><option value="open">Seguimiento abierto</option><option value="completed">Completado</option><option value="cancelled">Anulado</option></select></Field>
      <Field label="Condición o motivo"><input className={inputClass} maxLength={180} onChange={(event) => setValues({ ...values, condition: event.target.value })} placeholder="Ej. mastitis cuarto posterior" value={values.condition} /></Field>
      <Field label="Producto aplicado"><input className={inputClass} maxLength={180} onChange={(event) => setValues({ ...values, productName: event.target.value })} placeholder="Nombre comercial" value={values.productName} /></Field>
      <Field label="Principio activo"><input className={inputClass} maxLength={180} onChange={(event) => setValues({ ...values, activeIngredient: event.target.value })} placeholder="Según etiqueta o receta" value={values.activeIngredient} /></Field>
      <Field label="Dosis"><input className={inputClass} min="0" onChange={(event) => setValues({ ...values, doseAmount: event.target.value })} placeholder="Valor registrado" step="0.001" type="number" value={values.doseAmount} /></Field>
      <Field label="Unidad"><input className={inputClass} maxLength={40} onChange={(event) => setValues({ ...values, doseUnit: event.target.value })} placeholder="mL, mg, dosis…" value={values.doseUnit} /></Field>
      <Field label="Vía"><input className={inputClass} maxLength={80} onChange={(event) => setValues({ ...values, route: event.target.value })} placeholder="IM, SC, intramamaria…" value={values.route} /></Field>
      <Field label="Profesional / responsable"><input className={inputClass} maxLength={160} onChange={(event) => setValues({ ...values, professional: event.target.value })} placeholder="Nombre o referencia" value={values.professional} /></Field>
      <Field label="Retiro leche hasta"><input className={inputClass} min={values.occurredAt} onChange={(event) => setValues({ ...values, withdrawalMilkUntil: event.target.value })} type="date" value={values.withdrawalMilkUntil} /></Field>
      <Field label="Retiro carne hasta"><input className={inputClass} min={values.occurredAt} onChange={(event) => setValues({ ...values, withdrawalMeatUntil: event.target.value })} type="date" value={values.withdrawalMeatUntil} /></Field>
    </div>
    <Field label="Notas"><textarea className={`${inputClass} mt-3 min-h-20 py-3`} maxLength={1000} onChange={(event) => setValues({ ...values, notes: event.target.value })} placeholder="Evolución, control posterior o respaldo…" value={values.notes} /></Field>
    <p className="mt-3 flex gap-2 rounded-lg border border-warn-bar bg-surface-alt p-2.5 text-[12px] leading-relaxed text-warn-ink"><Info className="mt-0.5 shrink-0" size={12} />Este formulario documenta hechos. No diagnostica ni recomienda productos, dosis o retiros; registra siempre la indicación profesional y la etiqueta vigente.</p>
    <SaveButton label="Guardar evento sanitario" saving={saving} />
  </form>;
}


export function RenumberForm({ animalId, currentTag, onError, onSaved }: FormProps & { currentTag: string }) {
  const [values, setValues] = useState({ newTag: "", effectiveOn: today(), reason: "" });
  const [saving, setSaving] = useState(false);
  const trimmedTag = values.newTag.trim();
  const sameTag = trimmedTag.toUpperCase() === currentTag.trim().toUpperCase();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError(null);
    try {
      onSaved(await persistRenumber({
        animalId,
        newTag: trimmedTag,
        effectiveOn: values.effectiveOn,
        reason: values.reason.trim() || null,
      }));
      setValues({ newTag: "", effectiveOn: today(), reason: "" });
    } catch (cause) {
      onError(errorMessage(cause, "No fue posible cambiar el número."));
    } finally {
      setSaving(false);
    }
  }
  return <form onSubmit={submit}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Número actual"><input className={`${inputClass} bg-surface-alt`} disabled readOnly value={currentTag} /></Field>
      <Field label="Número nuevo"><input className={inputClass} maxLength={60} onChange={(event) => setValues({ ...values, newTag: event.target.value })} pattern="[A-Za-z0-9.\-]+" placeholder="Ej. 954.124" required value={values.newTag} /></Field>
      <Field label="Vigente desde"><input className={inputClass} max={today()} onChange={(event) => setValues({ ...values, effectiveOn: event.target.value })} required type="date" value={values.effectiveOn} /></Field>
      <Field label="Motivo"><input className={inputClass} maxLength={300} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="Crotal perdido, renumeración…" value={values.reason} /></Field>
    </div>
    {sameTag && trimmedTag !== "" && <p className="mt-3 text-[12px] font-bold text-warn-ink">El número nuevo es igual al actual.</p>}
    <p className="mt-3 flex gap-2 rounded-lg bg-surface-alt p-2.5 text-[12px] leading-relaxed text-ink-subtle"><Sparkles className="mt-0.5 shrink-0 text-accent" size={12} />El número anterior no se borra: queda cerrado en la fecha indicada y sigue resolviendo la historia importada desde Cliex u otro sistema. El motivo se guarda en la auditoría.</p>
    <SaveButton disabled={sameTag} label="Cambiar número" saving={saving} />
  </form>;
}

function SaveButton({ disabled = false, label, saving }: { disabled?: boolean; label: string; saving: boolean }) {
  return <button className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-50" disabled={saving || disabled} type="submit">{saving ? <LoaderCircle className="animate-spin" size={14} /> : <CircleDot size={14} />}{saving ? "Guardando…" : label}</button>;
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

const inputClass = "h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15";
