"use client";

import type { Fundo, MilkSettlement } from "@/src/core/domain/types";
import { Field } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import { FileText, LoaderCircle, Milk, Save, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { chileDateKey } from "../domain/chile-date.mjs";
import {
  isoInstantToLocalDateTimeInput,
  localDateTimeInputToIso,
} from "../domain/local-date-time.mjs";

type ManageMilkSettlementDialogProps = {
  fundos: Fundo[];
  settlement: MilkSettlement | null;
  onClose: () => void;
  onSave: (settlement: MilkSettlement) => Promise<void>;
};

export function ManageMilkSettlementDialog({
  fundos,
  settlement,
  onClose,
  onSave,
}: ManageMilkSettlementDialogProps) {
  const [fieldId, setFieldId] = useState(settlement?.fieldId ?? fundos[0]?.id ?? "");
  const [period, setPeriod] = useState(
    settlement?.period ?? chileDateKey(new Date()).slice(0, 7),
  );
  const [generatedAt, setGeneratedAt] = useState(
    isoInstantToLocalDateTimeInput(settlement?.generatedAt),
  );
  const [plant, setPlant] = useState(settlement?.plant ?? "");
  const [purchaseOrder, setPurchaseOrder] = useState(settlement?.purchaseOrder ?? "");
  const [producerCode, setProducerCode] = useState(settlement?.producerCode ?? "");
  const [producerName, setProducerName] = useState(settlement?.producerName ?? "");
  const [buyerName, setBuyerName] = useState(settlement?.buyerName ?? "");
  const [litersFirstHalf, setLitersFirstHalf] = useState(toInput(settlement?.litersFirstHalf));
  const [litersSecondHalf, setLitersSecondHalf] = useState(toInput(settlement?.litersSecondHalf));
  const [totalLiters, setTotalLiters] = useState(toInput(settlement?.totalLiters));
  const [netAmount, setNetAmount] = useState(toInput(settlement?.netAmountClp));
  const [taxAmount, setTaxAmount] = useState(toInput(settlement?.taxAmountClp));
  const [sourceDocumentName, setSourceDocumentName] = useState(settlement?.sourceDocumentName ?? "");
  const [notes, setNotes] = useState(settlement?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose, !saving);

  const parsedNet = parseNumber(netAmount) ?? 0;
  const parsedTax = parseNumber(taxAmount) ?? 0;
  const parsedLiters = parseNumber(totalLiters);
  const parsedFirstHalf = parseNumber(litersFirstHalf);
  const parsedSecondHalf = parseNumber(litersSecondHalf);
  const grossAmount = parsedNet + parsedTax;
  const derivedNetPrice = parsedLiters && parsedLiters > 0 ? parsedNet / parsedLiters : null;
  const derivedGrossPrice = parsedLiters && parsedLiters > 0 ? grossAmount / parsedLiters : null;
  const hasHalfLiters = Boolean(litersFirstHalf.trim() || litersSecondHalf.trim());
  const halfInputsValid = (!litersFirstHalf.trim() || parsedFirstHalf !== null)
    && (!litersSecondHalf.trim() || parsedSecondHalf !== null);
  const halfLitersMismatch = hasHalfLiters
    && halfInputsValid
    && parsedLiters !== null
    && parsedLiters > 0
    && Math.abs((parsedFirstHalf ?? 0) + (parsedSecondHalf ?? 0) - parsedLiters) > 0.0010000001;
  const preservedLineItemsTotal = (settlement?.lineItems ?? []).reduce(
    (sum, lineItem) => sum + lineItem.amountClp,
    0,
  );
  const parsedNetInteger = parseInteger(netAmount);
  const lineItemsMismatch = Boolean(settlement?.lineItems.length)
    && parsedNetInteger !== null
    && (
      !Number.isSafeInteger(preservedLineItemsTotal)
      || Math.abs(preservedLineItemsTotal - parsedNetInteger) > 1
    );
  const consistencyWarnings = [
    halfLitersMismatch ? "La suma de ambas quincenas debe coincidir con el total de litros." : null,
    lineItemsMismatch
      ? "El monto neto ya no coincide con el detalle importado. Restablece el monto o vuelve a importar la liquidación."
      : null,
  ].filter((message): message is string => message !== null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const liters = parseNumber(totalLiters);
    const net = parseInteger(netAmount);
    const tax = parseInteger(taxAmount);

    if (!fieldId || !period || !purchaseOrder.trim() || !producerName.trim() || !buyerName.trim()) {
      setError("Completa el fundo, período, orden de compra, productor y comprador.");
      return;
    }
    if (!liters || liters <= 0 || net === null || net < 0 || tax === null || tax < 0) {
      setError("Revisa los litros y montos de la liquidación.");
      return;
    }
    if (!halfInputsValid) {
      setError("Revisa los litros informados para cada quincena.");
      return;
    }
    if (consistencyWarnings.length > 0) {
      setError(consistencyWarnings[0]);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await onSave({
        id: settlement?.id ?? crypto.randomUUID(),
        fieldId,
        period,
        generatedAt: localDateTimeInputToIso(generatedAt),
        plant: plant.trim(),
        purchaseOrder: purchaseOrder.trim(),
        producerCode: producerCode.trim(),
        producerName: producerName.trim(),
        buyerName: buyerName.trim(),
        litersFirstHalf: parsedFirstHalf,
        litersSecondHalf: parsedSecondHalf,
        totalLiters: liters,
        netAmountClp: net,
        taxAmountClp: tax,
        grossAmountClp: net + tax,
        netPricePerLiterClp: roundPrice(net / liters),
        grossPricePerLiterClp: roundPrice((net + tax) / liters),
        sourceDocumentName: sourceDocumentName.trim() || null,
        notes: notes.trim(),
        lineItems: settlement?.lineItems ?? [],
        createdAt: settlement?.createdAt ?? now,
        updatedAt: settlement?.updatedAt ?? now,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar la liquidación.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[1200] grid place-items-center bg-black/45 p-4 backdrop-blur-sm">
      <div aria-modal="true" className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-[24px] border border-white/20 bg-surface-alt shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line-steel bg-white px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-surface-alt text-accent"><Milk size={20} /></span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Módulo Leche</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.04em] text-ink">{settlement ? "Editar liquidación" : "Nueva liquidación"}</h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-9 place-items-center rounded-xl text-ink-muted hover:bg-surface-alt" onClick={onClose} type="button"><X size={18} /></button>
        </header>

        <form className="p-5 sm:p-6" onSubmit={submit}>
          <Section title="Identificación">
            <Field label="Fundo">
              <select className="input-base" onChange={(event) => setFieldId(event.target.value)} value={fieldId}>
                <option value="">Selecciona un fundo</option>
                {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
              </select>
            </Field>
            <Field label="Período">
              <input className="input-base" onChange={(event) => setPeriod(event.target.value)} type="month" value={period} />
            </Field>
            <Field label="Orden de compra">
              <input className="input-base" maxLength={128} onChange={(event) => setPurchaseOrder(event.target.value)} placeholder="Ej. 4500000000" value={purchaseOrder} />
            </Field>
            <Field label="Fecha de generación">
              <input className="input-base" onChange={(event) => setGeneratedAt(event.target.value)} step="0.001" type="datetime-local" value={generatedAt} />
            </Field>
            <Field label="Planta">
              <input className="input-base" maxLength={128} onChange={(event) => setPlant(event.target.value)} value={plant} />
            </Field>
            <Field label="Comprador">
              <input className="input-base" maxLength={200} onChange={(event) => setBuyerName(event.target.value)} value={buyerName} />
            </Field>
            <Field label="Código productor">
              <input className="input-base" maxLength={128} onChange={(event) => setProducerCode(event.target.value)} value={producerCode} />
            </Field>
            <Field label="Productor">
              <input className="input-base" maxLength={200} onChange={(event) => setProducerName(event.target.value)} value={producerName} />
            </Field>
          </Section>

          <Section title="Producción y pago">
            <Field label="Litros primera quincena">
              <input className="input-base" min="0" onChange={(event) => setLitersFirstHalf(event.target.value)} step="0.001" type="number" value={litersFirstHalf} />
            </Field>
            <Field label="Litros segunda quincena">
              <input className="input-base" min="0" onChange={(event) => setLitersSecondHalf(event.target.value)} step="0.001" type="number" value={litersSecondHalf} />
            </Field>
            <Field label="Total litros">
              <input className="input-base" min="0.001" onChange={(event) => setTotalLiters(event.target.value)} step="0.001" type="number" value={totalLiters} />
            </Field>
            <Field label="Precio neto por litro">
              <input aria-readonly="true" className="input-base bg-surface-alt" readOnly value={toPriceInput(derivedNetPrice)} />
            </Field>
            <Field label="Monto neto (CLP)">
              <input className="input-base" min="0" onChange={(event) => setNetAmount(event.target.value)} step="1" type="number" value={netAmount} />
            </Field>
            <Field label="IVA (CLP)">
              <input className="input-base" min="0" onChange={(event) => setTaxAmount(event.target.value)} step="1" type="number" value={taxAmount} />
            </Field>
            <Field label="Precio con IVA por litro">
              <input aria-readonly="true" className="input-base bg-surface-alt" readOnly value={toPriceInput(derivedGrossPrice)} />
            </Field>
            <div className="rounded-xl border border-line-steel bg-white px-3 py-2.5">
              <p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Total calculado</p>
              <p className="mt-1 text-sm font-black text-ink">{formatClp(grossAmount)}</p>
            </div>
          </Section>

          {consistencyWarnings.length > 0 && (
            <div aria-live="polite" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900" role="alert">
              {consistencyWarnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}
          {Boolean(settlement?.lineItems.length) && !lineItemsMismatch && (
            <p className="mt-3 text-xs font-semibold text-ink-muted" role="status">
              Se conservarán {settlement!.lineItems.length} líneas de detalle; su suma debe seguir coincidiendo con el monto neto.
            </p>
          )}

          <section className="mt-5 rounded-2xl border border-line-steel bg-white p-4">
            <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.13em] text-accent"><FileText size={14} /> Trazabilidad</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Nombre del documento fuente">
                <input className="input-base" maxLength={255} onChange={(event) => setSourceDocumentName(event.target.value)} placeholder="Ej. proforma.pdf" value={sourceDocumentName} />
              </Field>
              <Field label="Notas">
                <input className="input-base" maxLength={4000} onChange={(event) => setNotes(event.target.value)} placeholder="Observaciones de la liquidación" value={notes} />
              </Field>
            </div>
          </section>

          {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-xs font-bold text-red-800">{error}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <button className="h-11 rounded-xl border border-line-steel bg-white px-4 text-xs font-black text-ink-muted" onClick={onClose} type="button">Cancelar</button>
            <button className="flex h-11 items-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:opacity-60" disabled={saving} type="submit">
              {saving ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />} Guardar liquidación
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="text-[12px] font-black uppercase tracking-[0.13em] text-accent">{title}</h3>
      <div className="mt-3 grid gap-3 rounded-2xl border border-line-steel bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  );
}

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string): number | null {
  const parsed = parseNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function toInput(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function toPriceInput(value: number | null): string {
  return value === null ? "" : String(roundPrice(value));
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}
