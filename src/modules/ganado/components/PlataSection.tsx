"use client";

import {
  LIVESTOCK_EXPENSE_CATEGORY_LABELS,
  LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS,
  type Fundo,
  type LivestockContribution,
  type LivestockExpense,
  type LivestockExpenseCategory,
  type LivestockFinanceAuditAction,
  type LivestockFinanceAuditEntry,
  type LivestockExpensePaymentSource,
  type LivestockLot,
  type LivestockPartner,
} from "@/src/core/domain/types";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CircleDollarSign,
  HandCoins,
  History,
  LoaderCircle,
  Plus,
  ReceiptText,
  Sheet,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Collapsible } from "@/src/ui/Collapsible";
import { formatClp, formatDate, formatDateTime, formatInteger, todayISO } from "../lib/format";
import {
  calculatePartnerBalances,
  suggestedTransfers,
  type PartnerBalance,
} from "../lib/livestock-metrics";
import { EgresosSpreadsheet, type ExpenseSpreadsheetCommit } from "./EgresosSpreadsheet";
import { ErrorMessage, Field, Panel, SmallEmpty, StatCard } from "./ui";

type PlataSectionProps = {
  auditEntries: LivestockFinanceAuditEntry[];
  canManageOrganizationFinance: boolean;
  fundos: Fundo[];
  partners: LivestockPartner[];
  contributions: LivestockContribution[];
  expenses: LivestockExpense[];
  lots: LivestockLot[];
  onSavePartner: (partner: LivestockPartner) => Promise<void>;
  onDeletePartner: (id: string, snapshotToken: string) => Promise<void>;
  onSaveContribution: (contribution: LivestockContribution) => Promise<void>;
  onDeleteContribution: (id: string, snapshotToken: string) => Promise<void>;
  onSaveExpense: (expense: LivestockExpense) => Promise<void>;
  onSaveExpenseSpreadsheet: ExpenseSpreadsheetCommit;
  onDeleteExpense: (id: string) => Promise<void>;
};

export function PlataSection({
  auditEntries,
  canManageOrganizationFinance,
  fundos,
  partners,
  contributions,
  expenses,
  lots,
  onSavePartner,
  onDeletePartner,
  onSaveContribution,
  onDeleteContribution,
  onSaveExpense,
  onSaveExpenseSpreadsheet,
  onDeleteExpense,
}: PlataSectionProps) {
  const partnerById = useMemo(() => new Map(partners.map((partner) => [partner.id, partner])), [partners]);
  const fundoById = useMemo(() => new Map(fundos.map((fundo) => [fundo.id, fundo])), [fundos]);
  const lotById = useMemo(() => new Map(lots.map((lot) => [lot.id, lot])), [lots]);

  const totalContributions = contributions.reduce((sum, item) => sum + item.amountClp, 0);
  const totalExpenses = expenses.reduce((sum, item) => sum + item.amountClp, 0);
  const societyExpenses = expenses.filter((expense) => expense.paymentSource === "society");
  const societyTotal = societyExpenses.reduce((sum, item) => sum + item.amountClp, 0);
  const unassignedExpenses = expenses.filter((expense) => expense.paymentSource === "unassigned");
  const unassignedTotal = unassignedExpenses.reduce((sum, item) => sum + item.amountClp, 0);

  const partnerBalances = calculatePartnerBalances(partners.map((partner) => ({
    id: partner.id,
    name: partner.name,
    contributionsClp: contributions
      .filter((item) => item.partnerId === partner.id)
      .reduce((sum, item) => sum + item.amountClp, 0),
    paidExpensesClp: expenses
      .filter((item) => item.paymentSource === "partner" && item.paidById === partner.id)
      .reduce((sum, item) => sum + item.amountClp, 0),
  })));

  const categoryBreakdown = (Object.keys(LIVESTOCK_EXPENSE_CATEGORY_LABELS) as LivestockExpenseCategory[])
    .map((category) => ({
      category,
      label: LIVESTOCK_EXPENSE_CATEGORY_LABELS[category],
      total: expenses.filter((expense) => expense.category === category).reduce((sum, item) => sum + item.amountClp, 0),
    }))
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total);

  return (
    <div>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard help="plataAporte" icon={ArrowUpCircle} label="Aportes de socios" tone="dark" value={formatClp(totalContributions)} detail={`${formatInteger(contributions.length)} ${contributions.length === 1 ? "aporte" : "aportes"}`} />
        <StatCard help="plataEgreso" icon={ArrowDownCircle} label="Egresos" value={formatClp(totalExpenses)} detail={`${formatInteger(expenses.length)} ${expenses.length === 1 ? "movimiento" : "movimientos"}`} />
        <StatCard helpText="Plata disponible del negocio: lo que pusieron los socios menos todo lo que ya se gastó." icon={Wallet} label="Caja organización" value={formatClp(totalContributions - totalExpenses)} detail="Aportes menos egresos" />
        <StatCard helpText="Gastos pagados desde la caja común y no por un socio en particular. Los pendientes todavía no tienen a quién cargarse." icon={ReceiptText} label="Pagado por organización" tone="amber" value={formatClp(societyTotal)} detail={`${formatInteger(societyExpenses.length)} movimientos · ${formatClp(unassignedTotal)} pendientes`} />
      </section>

      <section className="mt-5 grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        {canManageOrganizationFinance ? (
          <div className="space-y-3">
            <Collapsible defaultOpen help="plataSocio" icon={Users} persistKey="ganado.plata.socios" title="Socios">
              <PartnersPanel
                onDelete={onDeletePartner}
                onSave={onSavePartner}
                balances={partnerBalances}
                partnerById={partnerById}
              />
            </Collapsible>
            <Collapsible help="plataAporte" icon={HandCoins} persistKey="ganado.plata.aportes" title="Aportes">
              <ContributionsPanel
                contributions={contributions}
                onDelete={onDeleteContribution}
                onSave={onSaveContribution}
                partnerById={partnerById}
                partners={partners}
              />
            </Collapsible>
          </div>
        ) : (
          <Collapsible defaultOpen helpText="Qué fundos puedes ver y modificar en el detalle financiero, según los permisos de tu cuenta." icon={Users} persistKey="ganado.plata.alcance" title="Finanzas del fundo">
            <Panel title="Finanzas del fundo" eyebrow="Alcance asignado" icon={Users}>
            <p className="mt-5 text-xs font-semibold leading-5 text-ink-muted">
              Puedes registrar egresos de tus fundos. Los socios, aportes y movimientos generales de la organización quedan disponibles solo para propietarios y administradores.
            </p>
            </Panel>
          </Collapsible>
        )}
        <Collapsible help="plataEgreso" icon={CircleDollarSign} persistKey="ganado.plata.egresos" title="Egresos">
          <ExpensesPanel
          allowOrganizationWide={canManageOrganizationFinance}
          categoryBreakdown={categoryBreakdown}
          expenses={expenses}
          fundoById={fundoById}
          fundos={fundos}
          lotById={lotById}
          lots={lots}
          onDelete={onDeleteExpense}
          onSave={onSaveExpense}
          onSaveSpreadsheet={onSaveExpenseSpreadsheet}
          partnerById={partnerById}
          partners={partners}
          totalExpenses={totalExpenses}
          />
        </Collapsible>
      </section>
      <div className="mt-3">
        <Collapsible help="plataAuditoria" icon={ShieldCheck} persistKey="ganado.plata.auditoria" title="Auditoría financiera">
          <FinanceAuditPanel
            allowOrganizationWide={canManageOrganizationFinance}
            entries={auditEntries}
            fundoById={fundoById}
          />
        </Collapsible>
      </div>
    </div>
  );
}

const FINANCE_AUDIT_LABELS: Record<LivestockFinanceAuditAction, string> = {
  "finance.partner.created": "Socio creado",
  "finance.partner.updated": "Socio actualizado",
  "finance.partner.deleted": "Socio eliminado",
  "finance.contribution.created": "Aporte creado",
  "finance.contribution.updated": "Aporte actualizado",
  "finance.contribution.deleted": "Aporte eliminado",
  "finance.expense.created": "Egreso creado",
  "finance.expense.updated": "Egreso actualizado",
  "finance.expense.deleted": "Egreso eliminado",
};

function FinanceAuditPanel({
  allowOrganizationWide,
  entries,
  fundoById,
}: {
  allowOrganizationWide: boolean;
  entries: LivestockFinanceAuditEntry[];
  fundoById: Map<string, Fundo>;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line-steel bg-white shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
      <div className="flex flex-col gap-3 border-b border-line-steel bg-surface-alt px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.14em] text-accent"><ShieldCheck size={14} /> Registro inmutable</div>
          <h2 className="mt-1 text-lg font-black tracking-[-0.03em] text-ink">Auditoría financiera</h2>
          <p className="mt-1 text-[12px] font-semibold leading-4 text-ink-subtle">
            {allowOrganizationWide
              ? "Ves los cambios de socios, aportes y egresos de toda la organización."
              : "Ves únicamente los cambios de egresos asociados a tus fundos asignados."}
          </p>
        </div>
        <div className="inline-flex h-9 items-center gap-2 self-start rounded-xl border border-line-steel bg-white px-3 text-[12px] font-black uppercase tracking-wide text-ink-muted">
          <History size={13} /> {entries.length} eventos recientes
        </div>
      </div>
      {entries.length > 0 ? (
        <div className="divide-y divide-line-steel">
          {entries.map((entry) => (
            <div className="grid gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={entry.id}>
              <div className="min-w-0">
                <p className="truncate text-xs font-black text-ink">
                  {FINANCE_AUDIT_LABELS[entry.action]} · {entry.subject}
                  {entry.amountClp != null && <span className="text-accent"> · {formatClp(entry.amountClp)}</span>}
                </p>
                <p className="mt-1 truncate text-[12px] font-semibold text-ink-subtle">
                  {entry.actor}
                  {entry.fieldId && <span> · {fundoById.get(entry.fieldId)?.name ?? "Fundo asignado"}</span>}
                </p>
              </div>
              <time className="text-[12px] font-black text-ink-subtle" dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-5 py-6"><SmallEmpty text="Aún no hay movimientos financieros auditados para este alcance." /></div>
      )}
    </section>
  );
}

function PartnersPanel({
  balances,
  partnerById,
  onSave,
  onDelete,
}: {
  balances: PartnerBalance[];
  partnerById: Map<string, LivestockPartner>;
  onSave: (partner: LivestockPartner) => Promise<void>;
  onDelete: (id: string, snapshotToken: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transfers = suggestedTransfers(balances);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Ingresa el nombre del socio.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: crypto.randomUUID(),
        name: name.trim(),
        email: email.trim() || null,
        createdAt: new Date().toISOString(),
        snapshotToken: null,
      });
      setName("");
      setEmail("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el socio.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const snapshotToken = partnerById.get(id)?.snapshotToken;
    if (!snapshotToken) {
      setError("El socio cambió desde la última carga. Recarga la página antes de continuar.");
      return;
    }
    setDeletingId(id);
    setError(null);
    try {
      await onDelete(id, snapshotToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el socio.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Panel title="Socios" eyebrow="Quiénes ponen la plata" icon={Users}>
      <form className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" onSubmit={submit}>
        <Field label="Nombre">
          <input className="input-base" onChange={(event) => setName(event.target.value)} placeholder="Ej. Juan Pérez" value={name} />
        </Field>
        <Field label="Correo (opcional)">
          <input className="input-base" onChange={(event) => setEmail(event.target.value)} placeholder="correo@ejemplo.cl" type="email" value={email} />
        </Field>
        <div className="flex items-end">
          <button className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-60" disabled={saving} type="submit">
            {saving ? <LoaderCircle className="animate-spin" size={15} /> : <Plus size={15} />} Agregar
          </button>
        </div>
      </form>
      {error && <ErrorMessage text={error} />}

      {balances.length > 0 ? (
        <div className="mt-4 space-y-2.5">
          {balances.map((balance) => (
            <div className="flex items-center gap-3 rounded-2xl border border-line-steel bg-surface-alt px-4 py-3" key={balance.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-black text-ink">{balance.name}</p>
                <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
                  Capital {formatClp(balance.contributionsClp)} · Gastos adelantados {formatClp(balance.paidExpensesClp)}
                </p>
                <p className="mt-1 text-[12px] font-semibold text-ink-muted">
                  Participación {(balance.participation * 100).toFixed(1)}% · Cuota de adelantos {formatClp(balance.quotaClp)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">Saldo entre socios</p>
                <p className={`mt-0.5 text-[12px] font-black ${balance.balanceClp > 0 ? "text-accent" : balance.balanceClp < 0 ? "text-red-700" : "text-ink-subtle"}`}>
                  Saldo {formatClp(balance.balanceClp)}
                </p>
              </div>
              <button
                aria-label={`Eliminar socio ${balance.name}`}
                className="grid size-8 place-items-center rounded-lg border border-red-100 text-red-700 disabled:opacity-50"
                disabled={deletingId === balance.id}
                onClick={() => remove(balance.id)}
                type="button"
              >
                {deletingId === balance.id ? <LoaderCircle className="animate-spin" size={13} /> : <Trash2 size={13} />}
              </button>
            </div>
          ))}
          {transfers.length > 0 && (
            <div className="rounded-2xl border border-line-steel bg-white p-4">
              <p className="text-[12px] font-black uppercase tracking-[0.12em] text-accent">Para quedar a mano</p>
              <div className="mt-2 space-y-1.5">
                {transfers.map((transfer, index) => (
                  <p className="text-[12px] font-semibold text-ink-muted" key={`${transfer.debtor}-${transfer.creditor}-${index}`}>
                    <span className="font-black text-ink">{transfer.debtor}</span> le paga {formatClp(transfer.amountClp)} a <span className="font-black text-ink">{transfer.creditor}</span>
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <SmallEmpty text="Registra a los socios para llevar aportes y egresos pagados." />
      )}
    </Panel>
  );
}

function ContributionsPanel({
  partners,
  partnerById,
  contributions,
  onSave,
  onDelete,
}: {
  partners: LivestockPartner[];
  partnerById: Map<string, LivestockPartner>;
  contributions: LivestockContribution[];
  onSave: (contribution: LivestockContribution) => Promise<void>;
  onDelete: (id: string, snapshotToken: string) => Promise<void>;
}) {
  const [partnerId, setPartnerId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountClp = Number(amount);
    if (!partnerId) {
      setError("Selecciona el socio que aporta.");
      return;
    }
    if (!Number.isInteger(amountClp) || amountClp <= 0) {
      setError("El monto debe ser un CLP entero mayor que cero.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: crypto.randomUUID(),
        partnerId,
        amountClp,
        date: date || null,
        description: description.trim(),
        createdAt: new Date().toISOString(),
        snapshotToken: null,
      });
      setAmount("");
      setDescription("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el aporte.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const snapshotToken = contributions.find((contribution) => contribution.id === id)?.snapshotToken;
    if (!snapshotToken) {
      setError("El aporte cambió desde la última carga. Recarga la página antes de continuar.");
      return;
    }
    setDeletingId(id);
    setError(null);
    try {
      await onDelete(id, snapshotToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el aporte.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Panel title="Aportes" eyebrow="Plata que entra" icon={HandCoins}>
      <form className="mt-5 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Socio">
          <select className="input-base" onChange={(event) => setPartnerId(event.target.value)} value={partnerId}>
            <option value="">Selecciona un socio</option>
            {partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}
          </select>
        </Field>
        <Field label="Monto (CLP)">
          <input className="input-base" inputMode="numeric" min="1" onChange={(event) => setAmount(event.target.value)} placeholder="Ej. 500000" step="1" type="number" value={amount} />
        </Field>
        <Field label="Fecha">
          <input className="input-base" onChange={(event) => setDate(event.target.value)} type="date" value={date} />
        </Field>
        <Field label="Descripción">
          <input className="input-base" onChange={(event) => setDescription(event.target.value)} placeholder="Opcional" value={description} />
        </Field>
        <button className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-60 sm:col-span-2" disabled={saving || partners.length === 0} type="submit">
          {saving ? <LoaderCircle className="animate-spin" size={15} /> : <Plus size={15} />} Registrar aporte
        </button>
      </form>
      {error && <ErrorMessage text={error} />}

      {contributions.length > 0 ? (
        <div className="mt-4 space-y-2">
          {contributions.map((contribution) => (
            <div className="flex items-center gap-3 rounded-xl border border-line-steel px-3.5 py-2.5" key={contribution.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-ink">
                  {partnerById.get(contribution.partnerId)?.name ?? "Socio"}
                  {contribution.description && <span className="font-medium text-ink-muted"> · {contribution.description}</span>}
                </p>
                <p className="text-[12px] font-semibold text-ink-subtle">{formatDate(contribution.date)}</p>
              </div>
              <p className="text-xs font-black text-ink">{formatClp(contribution.amountClp)}</p>
              <button
                aria-label="Eliminar aporte"
                className="grid size-8 place-items-center rounded-lg border border-red-100 text-red-700 disabled:opacity-50"
                disabled={deletingId === contribution.id}
                onClick={() => remove(contribution.id)}
                type="button"
              >
                {deletingId === contribution.id ? <LoaderCircle className="animate-spin" size={13} /> : <Trash2 size={13} />}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <SmallEmpty text="Sin aportes registrados todavía." />
      )}
    </Panel>
  );
}

function ExpensesPanel({
  allowOrganizationWide,
  fundos,
  fundoById,
  partners,
  partnerById,
  lots,
  lotById,
  expenses,
  categoryBreakdown,
  totalExpenses,
  onSave,
  onSaveSpreadsheet,
  onDelete,
}: {
  allowOrganizationWide: boolean;
  fundos: Fundo[];
  fundoById: Map<string, Fundo>;
  partners: LivestockPartner[];
  partnerById: Map<string, LivestockPartner>;
  lots: LivestockLot[];
  lotById: Map<string, LivestockLot>;
  expenses: LivestockExpense[];
  categoryBreakdown: { category: LivestockExpenseCategory; label: string; total: number }[];
  totalExpenses: number;
  onSave: (expense: LivestockExpense) => Promise<void>;
  onSaveSpreadsheet: ExpenseSpreadsheetCommit;
  onDelete: (id: string) => Promise<void>;
}) {
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<LivestockExpenseCategory>("alimento");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [fieldId, setFieldId] = useState(fundos[0]?.id ?? "");
  const [paymentSource, setPaymentSource] = useState<LivestockExpensePaymentSource>("society");
  const [paidById, setPaidById] = useState("");
  const [lotId, setLotId] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetMode, setSheetMode] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountClp = Number(amount);
    if (!description.trim()) {
      setError("Describe el egreso.");
      return;
    }
    if (!Number.isInteger(amountClp) || amountClp <= 0) {
      setError("El monto debe ser un CLP entero mayor que cero.");
      return;
    }
    if (paymentSource === "partner" && !paidById) {
      setError("Selecciona el socio que adelantó el pago.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: crypto.randomUUID(),
        fieldId: fieldId || null,
        date: date || null,
        description: description.trim(),
        category,
        amountClp,
        paymentSource,
        paidById: paymentSource === "partner" ? paidById || null : null,
        lotId: lotId || null,
        createdAt: new Date().toISOString(),
      });
      setDescription("");
      setAmount("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar el egreso.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      await onDelete(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el egreso.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Panel title="Egresos" eyebrow="Plata que sale" icon={CircleDollarSign}>
      <form className="mt-5 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Descripción">
          <input className="input-base" onChange={(event) => setDescription(event.target.value)} placeholder="Ej. concentrado terneros" value={description} />
        </Field>
        <Field label="Categoría">
          <select className="input-base" onChange={(event) => setCategory(event.target.value as LivestockExpenseCategory)} value={category}>
            {Object.entries(LIVESTOCK_EXPENSE_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Monto (CLP)">
          <input className="input-base" inputMode="numeric" min="1" onChange={(event) => setAmount(event.target.value)} placeholder="Ej. 120000" step="1" type="number" value={amount} />
        </Field>
        <Field label="Fecha">
          <input className="input-base" onChange={(event) => setDate(event.target.value)} type="date" value={date} />
        </Field>
        <Field label="Origen del pago">
          <select className="input-base" onChange={(event) => setPaymentSource(event.target.value as LivestockExpensePaymentSource)} value={paymentSource}>
            <option value="society">Organización</option>
            {allowOrganizationWide && <option value="partner">Un socio adelantó el pago</option>}
            <option value="unassigned">Origen pendiente</option>
          </select>
        </Field>
        <Field label="Fundo">
          <select className="input-base" onChange={(event) => setFieldId(event.target.value)} value={fieldId}>
            {allowOrganizationWide && <option value="">Sin fundo</option>}
            {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
          </select>
        </Field>
        {paymentSource === "partner" && (
          <Field label="Socio que pagó">
            <select className="input-base" onChange={(event) => setPaidById(event.target.value)} value={paidById}>
              <option value="">Selecciona un socio</option>
              {partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Lote asociado">
          <select className="input-base" onChange={(event) => setLotId(event.target.value)} value={lotId}>
            <option value="">Sin lote</option>
            {lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}
          </select>
        </Field>
        <button className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-60 sm:col-span-2" disabled={saving} type="submit">
          {saving ? <LoaderCircle className="animate-spin" size={15} /> : <Plus size={15} />} Registrar egreso
        </button>
      </form>
      {error && <ErrorMessage text={error} />}

      {categoryBreakdown.length > 0 && (
        <div className="mt-5 space-y-3 rounded-2xl border border-line-steel bg-surface-alt p-4">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Egresos por categoría</p>
          {categoryBreakdown.map((item) => {
            const share = totalExpenses > 0 ? (item.total / totalExpenses) * 100 : 0;
            return (
              <div key={item.category}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-black text-ink">{item.label}</p>
                  <p className="text-xs font-black text-ink">{formatClp(item.total)}</p>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-alt">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-black ${sheetMode ? "border-accent bg-band text-accent" : "border-line-steel text-ink"}`}
          onClick={() => setSheetMode((current) => !current)}
          type="button"
        >
          <Sheet size={14} /> {sheetMode ? "Volver a la lista" : "Editar en planilla"}
        </button>
        <span className="text-[12px] font-semibold text-ink-subtle">
          Corrige montos, fechas y categorías de varios egresos a la vez, o agrega los del mes pegándolos desde Excel.
        </span>
      </div>

      {sheetMode && (
        <EgresosSpreadsheet
          defaultFieldId={fieldId}
          expenses={expenses}
          fundos={fundos}
          lots={lots}
          onClose={() => setSheetMode(false)}
          onCommit={onSaveSpreadsheet}
          partners={partners}
        />
      )}

      {expenses.length > 0 ? (
        <div className="mt-4 space-y-2">
          {expenses.map((expense) => (
            <div className="flex items-center gap-3 rounded-xl border border-line-steel px-3.5 py-2.5" key={expense.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-ink">{expense.description}</p>
                <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
                  {[
                    formatDate(expense.date),
                    LIVESTOCK_EXPENSE_CATEGORY_LABELS[expense.category],
                    expense.fieldId ? fundoById.get(expense.fieldId)?.name : null,
                    expense.paymentSource === "partner"
                      ? `Pagó ${partnerById.get(expense.paidById ?? "")?.name ?? "socio"}`
                      : LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS[expense.paymentSource],
                    expense.lotId ? lotById.get(expense.lotId)?.name : null,
                  ].filter(Boolean).join(" · ")}
                </p>
                {expense.paymentSource === "unassigned" && (
                  <ExpensePayerAssignment expense={expense} onSave={onSave} partners={partners} />
                )}
              </div>
              <p className="text-xs font-black text-ink">{formatClp(expense.amountClp)}</p>
              <button
                aria-label="Eliminar egreso"
                className="grid size-8 place-items-center rounded-lg border border-red-100 text-red-700 disabled:opacity-50"
                disabled={deletingId === expense.id}
                onClick={() => remove(expense.id)}
                type="button"
              >
                {deletingId === expense.id ? <LoaderCircle className="animate-spin" size={13} /> : <Trash2 size={13} />}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <SmallEmpty text="Sin egresos registrados todavía." />
      )}
    </Panel>
  );
}

function ExpensePayerAssignment({
  expense,
  partners,
  onSave,
}: {
  expense: LivestockExpense;
  partners: LivestockPartner[];
  onSave: (expense: LivestockExpense) => Promise<void>;
}) {
  const [assignment, setAssignment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assignment) return;
    setSaving(true);
    setError(null);
    try {
      if (assignment === "society") {
        await onSave({ ...expense, paymentSource: "society", paidById: null });
      } else {
        await onSave({ ...expense, paymentSource: "partner", paidById: assignment });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible asignar el pagador.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={assign}>
      <select
        aria-label={`Asignar pagador a ${expense.description}`}
        className="h-8 min-w-36 rounded-lg border border-amber-200 bg-amber-50 px-2 text-[12px] font-black text-ink-muted outline-none"
        disabled={saving}
        onChange={(event) => setAssignment(event.target.value)}
        value={assignment}
      >
        <option value="">Asignar origen…</option>
        <option value="society">Organización</option>
        {partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}
      </select>
      <button className="h-8 rounded-lg bg-amber-700 px-3 text-[12px] font-black text-white disabled:opacity-50" disabled={saving || !assignment} type="submit">
        {saving ? "Asignando…" : "Asignar"}
      </button>
      {error && <span className="text-[12px] font-bold text-red-700">{error}</span>}
    </form>
  );
}
