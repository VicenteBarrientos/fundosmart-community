"use client";

import type { Fundo, LivestockAnimal, LivestockLot } from "@/src/core/domain/types";
import { Download, FileCheck2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Field } from "@/src/ui/form";

type Props = { fundos: Fundo[]; lots: LivestockLot[]; animals: LivestockAnimal[]; offlineScope: string };

export function SagSection({ fundos, lots, animals, offlineScope }: Props) {
  const [profile, setProfile] = useState({ fieldId: fundos[0]?.id ?? "", rup: "", holderRut: "", holderName: "", commune: "", address: "" });
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [movement, setMovement] = useState({ id: `movement-draft-${today()}`, destinationRup: "", destinationCommune: "", destinationAddress: "", departureDate: today(), departureTime: "08:00", arrivalDate: today(), arrivalTime: "12:00", carrierName: "", carrierRut: "", vehiclePlate: "", trailerPlate: "", referenceFolio: "", observations: "", declarations: { noQuarantine: false, noSymptoms: false, noActiveWithdrawal: false } });
  const storageKey = `fundosmart:sag-profile:${offlineScope}`;
  const fieldLotIds = useMemo(() => new Set(lots.filter((lot) => lot.fieldId === profile.fieldId).map((lot) => lot.id)), [lots, profile.fieldId]);
  const eligible = animals.filter((animal) => animal.status === "active" && fieldLotIds.has(animal.lotId) && /^\d{9}$/.test(animal.tag.replace(/[.\s-]/g, "")));

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (cancelled) return; try { const saved = localStorage.getItem(storageKey); if (saved) setProfile(JSON.parse(saved)); } catch { /* Perfil opcional; se puede completar de nuevo. */ } });
    return () => { cancelled = true; };
  }, [storageKey]);

  function updateProfile(patch: Partial<typeof profile>) { const next = { ...profile, ...patch }; if (patch.fieldId && patch.fieldId !== profile.fieldId) setSelected([]); setProfile(next); localStorage.setItem(storageKey, JSON.stringify(next)); }
  async function exportDraft(action: "dea" | "fma") {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/ganado/sipec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, profile, asOfDate: today(), animalIds: selected, movement }) });
      if (!response.ok) { const body = await response.json() as { error?: string; issues?: { message: string }[] }; throw new Error([body.error, ...(body.issues ?? []).slice(0, 4).map((issue) => issue.message)].filter(Boolean).join(" ")); }
      const blob = await response.blob(); const disposition = response.headers.get("Content-Disposition") ?? ""; const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `sag-${action}-borrador.csv`;
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
      setMessage(`Borrador ${action.toUpperCase()} generado. Revísalo y decláralo en SIPECWeb; FundoSmart no lo envió automáticamente.`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No fue posible preparar el borrador SAG."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-5" id="sag-export">
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><div className="flex gap-3"><ShieldAlert className="mt-0.5 shrink-0 text-amber-700" size={18} /><div><p className="text-xs font-black text-amber-950">Borrador declarable, no declaración automática</p><p className="mt-1 text-[12px] leading-relaxed text-amber-900">Genera hojas de trabajo DEA (formulario 05-03-2025) y FMA (formulario 08-08-2024). El responsable debe revisar, firmar y registrar el movimiento en SIPECWeb/SAG.</p></div></div></section>
    {message && <p className="rounded-xl bg-ink px-4 py-3 text-xs font-bold text-white">{message}</p>}
    <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5"><p className="eyebrow">Perfil del establecimiento</p><h2 className="mt-1 text-lg font-black">Datos SAG del origen</h2><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><Field label="Fundo"><select className="input-base mt-1" onChange={(event) => updateProfile({ fieldId: event.target.value })} value={profile.fieldId}>{fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}</select></Field><Input label="RUP" onChange={(rup) => updateProfile({ rup })} value={profile.rup} /><Input label="RUT titular/mandatario" onChange={(holderRut) => updateProfile({ holderRut })} value={profile.holderRut} /><Input label="Titular/mandatario" onChange={(holderName) => updateProfile({ holderName })} value={profile.holderName} /><Input label="Comuna" onChange={(commune) => updateProfile({ commune })} value={profile.commune} /><Input label="Dirección" onChange={(address) => updateProfile({ address })} value={profile.address} /></div><button className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-50" disabled={busy} onClick={() => exportDraft("dea")} type="button"><Download size={15} /> Exportar borrador DEA</button></section>
    <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5"><p className="eyebrow">Formulario de Movimiento Animal</p><h2 className="mt-1 text-lg font-black">Preparar FMA con hasta 45 DIIO por hoja</h2><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Input label="RUP destino" onChange={(destinationRup) => setMovement({ ...movement, destinationRup })} value={movement.destinationRup} /><Input label="Comuna destino" onChange={(destinationCommune) => setMovement({ ...movement, destinationCommune })} value={movement.destinationCommune} /><Input label="Dirección destino" onChange={(destinationAddress) => setMovement({ ...movement, destinationAddress })} value={movement.destinationAddress} /><Input label="Transportista" onChange={(carrierName) => setMovement({ ...movement, carrierName })} value={movement.carrierName} /><Input label="RUT transportista" onChange={(carrierRut) => setMovement({ ...movement, carrierRut })} value={movement.carrierRut} /><Input label="Patente" onChange={(vehiclePlate) => setMovement({ ...movement, vehiclePlate })} value={movement.vehiclePlate} /><Input label="Patente acoplado" onChange={(trailerPlate) => setMovement({ ...movement, trailerPlate })} value={movement.trailerPlate} /><Field label="Salida"><input className="input-base mt-1" onChange={(event) => setMovement({ ...movement, departureDate: event.target.value })} type="date" value={movement.departureDate} /></Field><Field label="Hora salida"><input className="input-base mt-1" onChange={(event) => setMovement({ ...movement, departureTime: event.target.value })} type="time" value={movement.departureTime} /></Field><Field label="Llegada estimada"><input className="input-base mt-1" min={movement.departureDate} onChange={(event) => setMovement({ ...movement, arrivalDate: event.target.value })} type="date" value={movement.arrivalDate} /></Field><Field label="Hora llegada"><input className="input-base mt-1" onChange={(event) => setMovement({ ...movement, arrivalTime: event.target.value })} type="time" value={movement.arrivalTime} /></Field></div>
      <div className="mt-4 max-h-44 overflow-y-auto rounded-xl border border-line-steel p-2"><button className="mb-2 text-[12px] font-black text-accent" onClick={() => setSelected(selected.length === eligible.length ? [] : eligible.map((animal) => animal.id))} type="button">{selected.length === eligible.length ? "Desmarcar todos" : "Marcar todos"}</button><div className="grid gap-1 sm:grid-cols-3">{eligible.map((animal) => <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] font-bold hover:bg-surface-alt" key={animal.id}><input checked={selected.includes(animal.id)} onChange={() => setSelected((current) => current.includes(animal.id) ? current.filter((id) => id !== animal.id) : [...current, animal.id])} type="checkbox" />{animal.tag}</label>)}</div></div>
      <div className="mt-4 grid gap-2 text-[12px] font-bold sm:grid-cols-3">{([['noQuarantine','Origen sin cuarentena/restricción'],['noSymptoms','Animales sin síntomas EDO'],['noActiveWithdrawal','Sin resguardos activos']] as const).map(([key,label]) => <label className="flex items-start gap-2 rounded-xl bg-surface-alt p-3" key={key}><input checked={movement.declarations[key]} onChange={(event) => setMovement({ ...movement, declarations: { ...movement.declarations, [key]: event.target.checked } })} type="checkbox" />{label}</label>)}</div>
      <button className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white disabled:opacity-50" disabled={busy || !selected.length} onClick={() => exportDraft("fma")} type="button"><FileCheck2 size={15} /> Exportar FMA · {selected.length} animales</button>
    </section>
  </div>;
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <Field label={label}><input className="input-base mt-1" onChange={(event) => onChange(event.target.value)} value={value} /></Field>; }
function today() { return new Date().toISOString().slice(0, 10); }
