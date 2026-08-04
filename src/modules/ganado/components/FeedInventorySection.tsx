"use client";

import type { Fundo, LivestockFeedConsumption, LivestockFeedInventory, LivestockFeedingPlan, LivestockLot } from "@/src/core/domain/types";
import { Boxes, CircleDollarSign, PackagePlus, Utensils } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

type Props = {
  fundos: Fundo[];
  lots: LivestockLot[];
  plans: LivestockFeedingPlan[];
  initialInventory: LivestockFeedInventory[];
  initialConsumptions: LivestockFeedConsumption[];
  canManageFinance: boolean;
};

export function FeedInventorySection({ fundos, lots, plans, initialInventory, initialConsumptions, canManageFinance }: Props) {
  const firstInventory = initialInventory[0] ?? null;
  const firstLotId = lots.find((lot) => lot.status === "active" && (!firstInventory || lot.fieldId === firstInventory.fieldId))?.id ?? "";
  const [inventory, setInventory] = useState(initialInventory);
  const [consumptions, setConsumptions] = useState(initialConsumptions);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState({ fieldId: fundos[0]?.id ?? "", productName: "Concentrado", quantityKg: "", unitCostClp: "", reorderLevelKg: "", createExpense: canManageFinance, expenseAmountClp: "" });
  const [consumption, setConsumption] = useState({ inventoryId: firstInventory?.id ?? "", lotId: firstLotId, occurredAt: today(), quantityKg: "" });
  const selectedInventory = inventory.find((item) => item.id === consumption.inventoryId) ?? null;
  const eligibleLots = lots.filter((lot) => lot.status === "active" && (!selectedInventory || lot.fieldId === selectedInventory.fieldId));
  const selectedLot = eligibleLots.find((lot) => lot.id === consumption.lotId) ?? null;
  const selectedPlan = plans.find((plan) => plan.lotId === selectedLot?.id && normalize(plan.productName) === normalize(selectedInventory?.productName ?? "")) ?? null;
  const lowStock = inventory.filter((item) => item.quantityKg <= item.reorderLevelKg);
  const inventoryValue = inventory.reduce((sum, item) => sum + item.quantityKg * item.unitCostClp, 0);
  const consumedCost = consumptions.reduce((sum, item) => sum + item.costClp, 0);
  const consumptionById = useMemo(() => new Map(inventory.map((item) => [item.id, item])), [inventory]);

  async function receiveStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    const quantityKg = numeric(receipt.quantityKg); const unitCostClp = numeric(receipt.unitCostClp); const expenseAmountClp = numeric(receipt.expenseAmountClp);
    try {
      const inventoryMatch = inventory.find((item) => item.fieldId === receipt.fieldId && normalize(item.productName) === normalize(receipt.productName));
      const requestId = crypto.randomUUID();
      const response = await fetch("/api/ganado/alimentacion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "receive_stock", requestId, inventoryId: inventoryMatch?.id ?? `feed-${crypto.randomUUID()}`, fieldId: receipt.fieldId,
        productName: receipt.productName.trim(), quantityKg, unitCostClp, reorderLevelKg: receipt.reorderLevelKg ? numeric(receipt.reorderLevelKg) : null,
        expense: receipt.createExpense ? { id: `feed-expense-${requestId}`, date: today(), description: `Compra de ${receipt.productName.trim()}`, amountClp: expenseAmountClp || Math.round(quantityKg * unitCostClp), paymentSource: "society", paidById: null } : null,
      }) });
      const payload = await response.json() as { error?: string; inventory?: LivestockFeedInventory; expenseId?: string | null };
      if (!response.ok || !payload.inventory) throw new Error(payload.error ?? "No fue posible recibir el alimento.");
      setInventory((current) => upsert(current, payload.inventory!));
      if (!consumption.inventoryId) setConsumption((current) => ({ ...current, inventoryId: payload.inventory!.id, lotId: lots.find((lot) => lot.status === "active" && lot.fieldId === payload.inventory!.fieldId)?.id ?? "" }));
      setReceipt((current) => ({ ...current, quantityKg: "", expenseAmountClp: "" }));
      setMessage(`Stock actualizado: ${formatKg(payload.inventory.quantityKg)} disponibles.${payload.expenseId ? " El egreso quedó registrado en Plata." : ""}`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No fue posible recibir el alimento."); }
    finally { setBusy(false); }
  }

  async function recordConsumption(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedInventory || !selectedLot) return setMessage("Selecciona alimento y lote.");
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/ganado/alimentacion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "consume", id: `feed-use-${crypto.randomUUID()}`, fieldId: selectedInventory.fieldId, inventoryId: selectedInventory.id, lotId: selectedLot.id, planId: selectedPlan?.id ?? null, occurredAt: consumption.occurredAt, quantityKg: numeric(consumption.quantityKg), source: "Registro manual" }) });
      const payload = await response.json() as { error?: string; inventory?: LivestockFeedInventory; consumption?: LivestockFeedConsumption };
      if (!response.ok || !payload.inventory || !payload.consumption) throw new Error(payload.error ?? "No fue posible registrar el consumo.");
      setInventory((current) => upsert(current, payload.inventory!)); setConsumptions((current) => [payload.consumption!, ...current]); setConsumption((current) => ({ ...current, quantityKg: "" }));
      setMessage(`${formatKg(payload.consumption.quantityKg)} descontados de ${payload.inventory.productName}; costo asignado ${money(payload.consumption.costClp)}.`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No fue posible registrar el consumo."); }
    finally { setBusy(false); }
  }

  function useDailyPlan() {
    if (!selectedPlan || !selectedLot) return setMessage("Este lote no tiene una ración del mismo producto.");
    setConsumption((current) => ({ ...current, quantityKg: String(Math.round(selectedPlan.kgPerAnimalDay * selectedLot.animalCount * 100) / 100) }));
  }

  return <div className="mt-5 space-y-5">
    {message && <p aria-live="polite" className="rounded-xl bg-ink px-4 py-3 text-xs font-bold text-white">{message}</p>}
    <section className="grid gap-3 sm:grid-cols-3"><Metric label="Valor de stock" value={money(inventoryValue)} detail={`${inventory.length} productos`} icon={<Boxes size={16} />} /><Metric label="Costo consumido" value={money(consumedCost)} detail={`${consumptions.length} registros sin duplicar egresos`} icon={<CircleDollarSign size={16} />} /><Metric label="Reposición" value={String(lowStock.length)} detail={lowStock.length ? lowStock.map((item) => item.productName).join(", ") : "Todos sobre el mínimo"} icon={<PackagePlus size={16} />} tone={lowStock.length ? "amber" : "green"} /></section>
    <section className="grid gap-5 xl:grid-cols-2">
      <form className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm" onSubmit={receiveStock}><p className="eyebrow">Inventario y costo</p><h2 className="mt-1 text-lg font-black">Recibir alimento</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><Select label="Fundo" onChange={(value) => setReceipt({ ...receipt, fieldId: value })} options={fundos.map((fundo) => ({ value: fundo.id, label: fundo.name }))} value={receipt.fieldId} /><Input label="Producto" onChange={(productName) => setReceipt({ ...receipt, productName })} required value={receipt.productName} /><Input label="Cantidad recibida (kg)" min="0.001" onChange={(quantityKg) => setReceipt({ ...receipt, quantityKg })} required type="number" value={receipt.quantityKg} /><Input label="Costo unitario CLP/kg" min="0" onChange={(unitCostClp) => setReceipt({ ...receipt, unitCostClp })} required type="number" value={receipt.unitCostClp} /><Input label="Nivel de reposición (kg)" min="0" onChange={(reorderLevelKg) => setReceipt({ ...receipt, reorderLevelKg })} type="number" value={receipt.reorderLevelKg} />{canManageFinance && <label className="field-label flex items-center gap-2 self-end rounded-xl bg-surface-alt p-3"><input checked={receipt.createExpense} onChange={(event) => setReceipt({ ...receipt, createExpense: event.target.checked })} type="checkbox" /> Registrar compra en Plata</label>}{receipt.createExpense && <Input label="Monto egreso CLP (vacío = cantidad × costo)" min="1" onChange={(expenseAmountClp) => setReceipt({ ...receipt, expenseAmountClp })} type="number" value={receipt.expenseAmountClp} />}</div><button className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white disabled:opacity-50" disabled={busy} type="submit"><PackagePlus size={15} /> Recibir y actualizar costo promedio</button></form>
      <form className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm" onSubmit={recordConsumption}><p className="eyebrow">Salida auditable</p><h2 className="mt-1 text-lg font-black">Registrar consumo por lote</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><Select label="Alimento" onChange={(inventoryId) => { const item = inventory.find((entry) => entry.id === inventoryId); setConsumption({ ...consumption, inventoryId, lotId: lots.find((lot) => lot.status === "active" && lot.fieldId === item?.fieldId)?.id ?? "" }); }} options={inventory.map((item) => ({ value: item.id, label: `${item.productName} · ${formatKg(item.quantityKg)}` }))} value={consumption.inventoryId} /><Select label="Lote" onChange={(lotId) => setConsumption({ ...consumption, lotId })} options={eligibleLots.map((lot) => ({ value: lot.id, label: lot.name }))} value={consumption.lotId} /><Input label="Fecha" onChange={(occurredAt) => setConsumption({ ...consumption, occurredAt })} required type="date" value={consumption.occurredAt} /><Input label="Cantidad consumida (kg)" min="0.001" onChange={(quantityKg) => setConsumption({ ...consumption, quantityKg })} required type="number" value={consumption.quantityKg} /></div>{selectedPlan && <button className="action-secondary mt-3" onClick={useDailyPlan} type="button"><Utensils size={14} /> Usar ración diaria: {formatKg(selectedPlan.kgPerAnimalDay * (selectedLot?.animalCount ?? 0))}</button>}<p className="mt-3 text-[12px] text-ink-subtle">El consumo descuenta stock y asigna su costo al lote. No crea otro egreso: la compra ya representa la salida de caja.</p><button className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-xs font-black text-white disabled:opacity-50" disabled={busy || !inventory.length || !eligibleLots.length} type="submit"><Utensils size={15} /> Descontar del inventario</button></form>
    </section>
    <section className="rounded-2xl border border-line-steel bg-white p-5 shadow-sm"><h2 className="text-sm font-black">Stock y últimos consumos</h2><div className="mt-4 grid gap-4 xl:grid-cols-2"><div className="space-y-2">{inventory.map((item) => <div className={`rounded-xl border p-3 ${item.quantityKg <= item.reorderLevelKg ? "border-amber-200 bg-amber-50" : "border-line-steel bg-surface-alt"}`} key={item.id}><div className="flex justify-between gap-3"><div><p className="text-xs font-black">{item.productName}</p><p className="mt-1 text-[12px] text-ink-subtle">{fundos.find((fundo) => fundo.id === item.fieldId)?.name} · mínimo {formatKg(item.reorderLevelKg)}</p></div><div className="text-right"><p className="text-sm font-black text-ink">{formatKg(item.quantityKg)}</p><p className="text-[12px] text-ink-subtle">{money(item.unitCostClp)}/kg</p></div></div></div>)}</div><div className="divide-y divide-line-steel">{consumptions.slice(0, 12).map((item) => <div className="flex justify-between gap-3 py-2.5" key={item.id}><div><p className="text-[12px] font-black">{lots.find((lot) => lot.id === item.lotId)?.name ?? "Lote"}</p><p className="text-[12px] text-ink-subtle">{item.occurredAt} · {consumptionById.get(item.inventoryItemId)?.productName ?? "Alimento"}</p></div><p className="text-[12px] font-black">{formatKg(item.quantityKg)} · {money(item.costClp)}</p></div>)}</div></div></section>
  </div>;
}

function Metric({ label, value, detail, icon, tone = "green" }: { label: string; value: string; detail: string; icon: ReactNode; tone?: "green" | "amber" }) { return <div className={`rounded-2xl border p-4 ${tone === "amber" ? "border-amber-200 bg-amber-50" : "border-line-steel bg-white"}`}><div className="text-accent">{icon}</div><p className="mt-2 text-[12px] font-black uppercase tracking-wider text-ink-subtle">{label}</p><p className="mt-1 text-xl font-black">{value}</p><p className="mt-1 truncate text-[12px] text-ink-subtle">{detail}</p></div>; }
function Input({ label, value, onChange, type = "text", min, required = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; min?: string; required?: boolean }) { return <label className="field-label">{label}<input className="input-base mt-1" min={min} onChange={(event) => onChange(event.target.value)} required={required} step={type === "number" ? "any" : undefined} type={type} value={value} /></label>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) { return <label className="field-label">{label}<select className="input-base mt-1" onChange={(event) => onChange(event.target.value)} required value={value}><option disabled value="">Selecciona</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>; }
function upsert<T extends { id: string }>(items: T[], value: T) { return items.some((item) => item.id === value.id) ? items.map((item) => item.id === value.id ? value : item) : [value, ...items]; }
function numeric(value: string) { const parsed = Number(value.replace(",", ".")); return Number.isFinite(parsed) ? parsed : 0; }
function normalize(value: string) { return value.trim().toLocaleLowerCase("es"); }
function formatKg(value: number) { return `${value.toLocaleString("es-CL", { maximumFractionDigits: 2 })} kg`; }
function money(value: number) { return value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }); }
function today() { return new Date().toISOString().slice(0, 10); }
