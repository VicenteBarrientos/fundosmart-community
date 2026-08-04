"use client";

import type { Fundo } from "@/src/core/domain/types";
import { Field } from "@/src/ui/form";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Droplets,
  GitMerge,
  HeartPulse,
  Link2,
  LoaderCircle,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  confirmCooprinsemGenealogy,
  confirmCooprinsemGroupPlan,
  confirmCooprinsemHistoricalServices,
  confirmCooprinsemMilkUnit,
  confirmCooprinsemQuarantineReassignment,
  fetchCooprinsemConfiguration,
  simulateCooprinsemGroupDeactivation,
  simulateCooprinsemGroupMapping,
  simulateCooprinsemQuarantineReassignment,
} from "./api/import-client";
import type {
  CooprinsemConfigurationDashboard,
  CooprinsemGenealogyResolutionRow,
  CooprinsemGroupMappingItem,
  CooprinsemGroupMappingPlan,
  CooprinsemQuarantineReassignmentPlan,
} from "./domain/types";

type Props = {
  fieldId: string;
  fundos: Fundo[];
  onFieldId: (fieldId: string) => void;
};

export function CooprinsemConfigurationWorkspace({ fieldId, fundos, onFieldId }: Props) {
  const [configuration, setConfiguration] = useState<CooprinsemConfigurationDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupCode, setGroupCode] = useState("");
  const [lotId, setLotId] = useState("");
  const [mappingPlan, setMappingPlan] = useState<CooprinsemGroupMappingPlan | null>(null);
  const [mappingAcknowledged, setMappingAcknowledged] = useState(false);
  const [reassignmentPlan, setReassignmentPlan] = useState<CooprinsemQuarantineReassignmentPlan | null>(null);
  const [reassignmentAcknowledged, setReassignmentAcknowledged] = useState(false);
  const [genealogyAcknowledged, setGenealogyAcknowledged] = useState(false);
  const [milkUnitPhrase, setMilkUnitPhrase] = useState("");
  const [servicesPhrase, setServicesPhrase] = useState("");

  async function load() {
    if (!fieldId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCooprinsemConfiguration(fieldId);
      setConfiguration(next);
      setLotId((current) => next.lots.some((lot) => lot.id === current) ? current : next.lots[0]?.id ?? "");
      setGroupCode((current) => current || next.unconfiguredGroups[0]?.groupCode || "");
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible cargar la configuración."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetchCooprinsemConfiguration(fieldId)
      .then((next) => {
        if (!active) return;
        setConfiguration(next);
        setLotId(next.lots[0]?.id ?? "");
        setGroupCode(next.unconfiguredGroups[0]?.groupCode ?? "");
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause, "No fue posible cargar la configuración."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [fieldId]);

  const selectedLot = useMemo(() => configuration?.lots.find((lot) => lot.id === lotId) ?? null, [configuration, lotId]);

  async function simulateMapping() {
    if (!fieldId || !groupCode || !lotId) return;
    setSaving(true);
    setError(null);
    try {
      setMappingPlan(await simulateCooprinsemGroupMapping({ fieldId, groupCode, lotId }));
      setMappingAcknowledged(false);
      setReassignmentPlan(null);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible simular el mapeo."));
    } finally {
      setSaving(false);
    }
  }

  async function simulateDeactivation(mapping: CooprinsemGroupMappingItem) {
    setSaving(true);
    setError(null);
    setGroupCode(mapping.groupCode);
    try {
      setMappingPlan(await simulateCooprinsemGroupDeactivation({ fieldId, groupCode: mapping.groupCode }));
      setMappingAcknowledged(false);
      setReassignmentPlan(null);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible simular la desactivación."));
    } finally {
      setSaving(false);
    }
  }

  async function confirmMapping() {
    if (!mappingPlan?.ready || !mappingAcknowledged) return;
    setSaving(true);
    setError(null);
    try {
      const next = await confirmCooprinsemGroupPlan(mappingPlan);
      setConfiguration(next.configuration);
      setMappingPlan(null);
      setMappingAcknowledged(false);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible confirmar el mapeo."));
    } finally {
      setSaving(false);
    }
  }

  async function simulateReassignment(mapping: CooprinsemGroupMappingItem) {
    setSaving(true);
    setError(null);
    try {
      setReassignmentPlan(await simulateCooprinsemQuarantineReassignment({ fieldId, groupCode: mapping.groupCode }));
      setReassignmentAcknowledged(false);
      setMappingPlan(null);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible simular la reasignación."));
    } finally {
      setSaving(false);
    }
  }

  async function confirmReassignment() {
    if (!reassignmentPlan?.ready || !reassignmentAcknowledged) return;
    setSaving(true);
    setError(null);
    try {
      const next = await confirmCooprinsemQuarantineReassignment(reassignmentPlan);
      setConfiguration(next.configuration);
      setReassignmentPlan(null);
      setReassignmentAcknowledged(false);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible reasignar los animales."));
    } finally {
      setSaving(false);
    }
  }

  async function confirmGenealogy() {
    if (!configuration?.genealogy.ready || !genealogyAcknowledged) return;
    setSaving(true);
    setError(null);
    try {
      const next = await confirmCooprinsemGenealogy(configuration.genealogy);
      setConfiguration(next.configuration);
      setGenealogyAcknowledged(false);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible reconciliar la genealogía."));
    } finally {
      setSaving(false);
    }
  }

  async function confirmMilkUnitContract() {
    if (!configuration || milkUnitPhrase !== configuration.history.milkUnitContract.confirmationPhrase) return;
    setSaving(true);
    setError(null);
    try {
      const next = await confirmCooprinsemMilkUnit(configuration.history.milkUnitContract, milkUnitPhrase);
      setConfiguration(next.configuration);
      setMilkUnitPhrase("");
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible confirmar la unidad de leche."));
    } finally {
      setSaving(false);
    }
  }

  async function confirmHistoricalServices() {
    if (!configuration || servicesPhrase !== configuration.history.services.confirmationPhrase) return;
    setSaving(true);
    setError(null);
    try {
      const next = await confirmCooprinsemHistoricalServices(configuration.history.services, servicesPhrase);
      setConfiguration(next.configuration);
      setServicesPhrase("");
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible confirmar las cubiertas históricas."));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !configuration) return <div className="mt-5 grid min-h-72 place-items-center rounded-[22px] border border-line-steel bg-white"><div className="flex items-center gap-2 text-xs font-black text-ink-muted"><LoaderCircle className="animate-spin text-accent" size={17} /> Cargando configuración segura…</div></div>;

  return (
    <section className="mt-5 space-y-5">
      <div className="flex flex-col gap-4 rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_32px_rgba(35,50,42,0.04)] sm:flex-row sm:items-end sm:justify-between">
        <div><div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.14em] text-accent"><Settings2 size={14} /> Resolución canónica</div><h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-ink">Grupos, historia y genealogía</h2><p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-subtle">Configura destinos e historia sin reescribir el original. Cada cambio se simula, confirma y audita por separado.</p></div>
        <div className="flex gap-2"><select className={inputClass} onChange={(event) => { setMilkUnitPhrase(""); setServicesPhrase(""); onFieldId(event.target.value); }} value={fieldId}>{fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}</select><button aria-label="Actualizar configuración" className="grid size-11 shrink-0 place-items-center rounded-xl border border-line-steel text-ink-muted disabled:opacity-50" disabled={loading} onClick={() => void load()} type="button"><RefreshCcw className={loading ? "animate-spin" : ""} size={15} /></button></div>
      </div>

      {error && <div className="flex items-start gap-2 rounded-xl border border-alert-bar bg-surface-alt p-3 text-xs font-bold text-alert-ink"><XCircle className="mt-0.5 shrink-0" size={15} /> {error}</div>}

      {configuration && <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><ConfigMetric label="Grupos configurados" value={configuration.mappings.length} tone="green" /><ConfigMetric label="Grupos pendientes" value={configuration.unconfiguredGroups.length} tone="amber" /><ConfigMetric label="Por clasificar" value={configuration.quarantine.animalCount} tone="red" /><ConfigMetric label="Genealogías listas" value={configuration.genealogy.summary.readyCount} tone="blue" /></div>

        <HistoryConfirmationPanel
          disabled={saving}
          history={configuration.history}
          milkUnitPhrase={milkUnitPhrase}
          onConfirmMilkUnit={() => void confirmMilkUnitContract()}
          onConfirmServices={() => void confirmHistoricalServices()}
          onMilkUnitPhrase={setMilkUnitPhrase}
          onServicesPhrase={setServicesPhrase}
          servicesPhrase={servicesPhrase}
        />

        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
          <div className="rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_32px_rgba(35,50,42,0.04)]">
            <div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-white"><Boxes size={18} /></div><div><h3 className="text-sm font-black text-ink">Configurar grupo</h3><p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">Sólo se ofrecen lotes activos con seguimiento individual.</p></div></div>
            {configuration.unconfiguredGroups.length > 0 && <div className="mt-4 flex flex-wrap gap-1.5">{configuration.unconfiguredGroups.slice(0, 10).map((candidate) => <button className="rounded-full border border-warn-bar bg-surface-alt px-2.5 py-1 text-[12px] font-black text-warn-ink" key={candidate.normalizedGroupCode} onClick={() => { setGroupCode(candidate.groupCode); setMappingPlan(null); }} type="button">Grupo {candidate.groupCode} · {candidate.impact.stagedRowCount}</button>)}</div>}
            <div className="mt-5 grid gap-3 sm:grid-cols-2"><Field label="Código Cooprinsem"><input className={inputClass} onChange={(event) => { setGroupCode(event.target.value); setMappingPlan(null); }} placeholder="Ej. 4" value={groupCode} /></Field><Field label="Lote FundoSmart"><select className={inputClass} onChange={(event) => { setLotId(event.target.value); setMappingPlan(null); }} value={lotId}>{configuration.lots.length === 0 && <option value="">Sin lotes individuales</option>}{configuration.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name} · {lot.animalCount} animales</option>)}</select></Field></div>
            <button className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={!groupCode || !selectedLot || saving} onClick={() => void simulateMapping()} type="button">{saving ? <LoaderCircle className="animate-spin" size={14} /> : <ShieldCheck size={14} />} Simular mapeo</button>
            {mappingPlan && <MappingPlanCard acknowledged={mappingAcknowledged} disabled={saving} onAcknowledged={setMappingAcknowledged} onConfirm={() => void confirmMapping()} plan={mappingPlan} />}
          </div>

          <div className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_32px_rgba(35,50,42,0.04)]">
            <div className="flex items-center justify-between border-b border-line-steel px-5 py-4"><div><h3 className="text-sm font-black text-ink">Mapeos activos</h3><p className="mt-1 text-[12px] text-ink-subtle">El historial anterior se conserva con fecha de término.</p></div><Link2 className="text-accent" size={18} /></div>
            {configuration.mappings.length === 0 ? <Empty text="Todavía no hay grupos configurados." /> : <div className="divide-y divide-line-steel">{configuration.mappings.map((mapping) => <div className="p-4" key={mapping.id}><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><span className="rounded-lg bg-surface-alt px-2.5 py-1 text-[12px] font-black uppercase text-accent">Grupo {mapping.groupCode}</span><ArrowRight className="text-ink-subtle" size={13} /><span className="text-xs font-black text-ink">{mapping.lotName}</span></div><p className="mt-2 text-[12px] text-ink-subtle">{mapping.impact.stagedRowCount} filas · {mapping.impact.pendingRowCount} por confirmar · {mapping.impact.quarantineAnimalCount} por reclasificar</p></div><div className="flex flex-wrap gap-1.5"><button className={smallButtonClass} onClick={() => { setGroupCode(mapping.groupCode); setLotId(mapping.lotId); setMappingPlan(null); }} type="button">Cambiar</button>{mapping.impact.quarantineAnimalCount > 0 && <button className={smallButtonClass} onClick={() => void simulateReassignment(mapping)} type="button">Reasignar</button>}<button aria-label={`Desactivar grupo ${mapping.groupCode}`} className="grid size-8 place-items-center rounded-lg border border-line-steel text-alert-ink" onClick={() => void simulateDeactivation(mapping)} type="button"><Trash2 size={12} /></button></div></div></div>)}</div>}
          </div>
        </div>

        {reassignmentPlan && <ReassignmentPlanCard acknowledged={reassignmentAcknowledged} disabled={saving} onAcknowledged={setReassignmentAcknowledged} onConfirm={() => void confirmReassignment()} plan={reassignmentPlan} />}

        <div className="grid gap-5 xl:grid-cols-[minmax(300px,0.58fr)_minmax(0,1.42fr)]">
          <aside className="rounded-[22px] border border-line-steel bg-ink p-5 text-white shadow-[0_16px_45px_rgba(23,59,45,0.12)]"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-accent text-ink"><Users size={18} /></div><div><h3 className="text-sm font-black">Lote técnico</h3><p className="mt-1 text-[12px] text-white/55">{configuration.quarantine.lotName}</p></div></div><p className="mt-6 text-4xl font-black tracking-[-0.04em]">{configuration.quarantine.animalCount}</p><p className="mt-1 text-[12px] text-white/60">animales pendientes de clasificación explícita</p><div className="mt-5 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-[12px] leading-relaxed text-white/65">Crear un mapeo no mueve animales históricos. La reasignación tiene su propia simulación para conservar el movimiento y la fecha.</div></aside>
          <GenealogyPanel acknowledged={genealogyAcknowledged} disabled={saving} onAcknowledged={setGenealogyAcknowledged} onConfirm={() => void confirmGenealogy()} plan={configuration.genealogy} />
        </div>
      </>}
    </section>
  );
}

function HistoryConfirmationPanel({
  disabled,
  history,
  milkUnitPhrase,
  onConfirmMilkUnit,
  onConfirmServices,
  onMilkUnitPhrase,
  onServicesPhrase,
  servicesPhrase,
}: {
  disabled: boolean;
  history: CooprinsemConfigurationDashboard["history"];
  milkUnitPhrase: string;
  onConfirmMilkUnit: () => void;
  onConfirmServices: () => void;
  onMilkUnitPhrase: (value: string) => void;
  onServicesPhrase: (value: string) => void;
  servicesPhrase: string;
}) {
  const unit = history.milkUnitContract;
  const services = history.services;
  return <section className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_32px_rgba(35,50,42,0.04)]">
    <div className="border-b border-line-steel p-5"><div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent"><HeartPulse size={18} /></div><div><p className="text-[12px] font-black uppercase tracking-wide text-accent">Historia productiva</p><h3 className="mt-1 text-sm font-black text-ink">Dos confirmaciones independientes</h3><p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-ink-subtle">El contrato solo declara la unidad canónica. Las cubiertas tienen su propia confirmación idempotente; los controles lecheros todavía no se escriben.</p></div></div></div>
    <div className="grid gap-0 xl:grid-cols-2">
      <div className="border-b border-line-steel p-5 xl:border-b-0 xl:border-r">
        <div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent"><Droplets size={16} /></div><div><h4 className="text-xs font-black text-ink">Unidad de LECHE*</h4><p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">{unit.contractVersion} · {unit.sourceFields.join(", ")}</p></div></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-black uppercase ${unit.confirmed ? "bg-surface-alt text-accent" : "bg-warn-bg text-warn-ink"}`}>{unit.confirmed ? "Confirmado" : "Pendiente"}</span></div>
        <div className="mt-4 grid grid-cols-3 gap-2"><MiniMetric label="Detectados" value={unit.candidateCount} /><MiniMetric label="Listos después" value={unit.readyAfterConfirmationCount} /><MiniMetric label="Bloqueados" value={unit.blockedAfterConfirmationCount} /></div>
        {unit.confirmed ? <div className="mt-4 rounded-xl border border-line-steel bg-surface-alt p-3 text-[12px] font-bold leading-relaxed text-accent">Contrato append-only activo. La unidad canónica es litros; no se insertaron controles lecheros.</div> : <div className="mt-4"><Field label={`Escribe ${unit.confirmationPhrase}`}><input autoComplete="off" className={inputClass} onChange={(event) => onMilkUnitPhrase(event.target.value)} spellCheck={false} value={milkUnitPhrase} /></Field><button className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={disabled || milkUnitPhrase !== unit.confirmationPhrase} onClick={onConfirmMilkUnit} type="button">{disabled ? <LoaderCircle className="animate-spin" size={13} /> : <ShieldCheck size={13} />} Confirmar contrato de litros</button></div>}
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between gap-3"><div><h4 className="text-xs font-black text-ink">Cubiertas históricas</h4><p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">Solo fecha/reproductor inequívocos; el reintento reutiliza evento y procedencia.</p></div><span className="shrink-0 rounded-full bg-surface-alt px-2.5 py-1 text-[12px] font-black uppercase text-accent">{services.summary.readyCount} listas</span></div>
        <div className="mt-4 grid grid-cols-3 gap-2"><MiniMetric label="Crear" value={services.summary.createCount} /><MiniMetric label="Reutilizar" value={services.summary.reuseCount} /><MiniMetric label="Bloqueadas" value={services.summary.blockedCount} /></div>
        {services.rows.length > 0 && <div className="mt-4 divide-y divide-line-steel rounded-xl border border-line-steel">{services.rows.slice(0, 5).map((row, index) => <div className="grid gap-2 p-3 text-[12px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={`${row.animalId}:${row.occurredAt ?? "blocked"}:${index}`}><div className="min-w-0"><p className="truncate font-black text-ink">{row.animalTag} · {row.occurredAt ? formatDate(row.occurredAt) : "Sin fecha"}</p><p className="mt-0.5 truncate text-ink-subtle">{row.blockers[0] ?? `${row.sireIdentifier ? `Toro ${row.sireIdentifier}` : "Reproductor no informado"} · ${row.sourceCount} fuente${row.sourceCount === 1 ? "" : "s"}`}</p></div><span className={`justify-self-start rounded-full px-2 py-1 text-[12px] font-black uppercase sm:justify-self-end ${row.state === "ready" ? "bg-surface-alt text-accent" : "bg-surface-alt text-alert-ink"}`}>{row.action === "create" ? "Crear" : row.action === "reuse" ? "Reutilizar" : "Bloqueada"}</span></div>)}</div>}
        {services.rowsTruncated && <p className="mt-2 text-[12px] font-bold text-ink-subtle">Vista resumida; la confirmación considera todas las cubiertas listas.</p>}
        {services.ready && <div className="mt-4"><Field label={`Escribe ${services.confirmationPhrase}`}><input autoComplete="off" className={inputClass} onChange={(event) => onServicesPhrase(event.target.value)} spellCheck={false} value={servicesPhrase} /></Field><button className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={disabled || servicesPhrase !== services.confirmationPhrase} onClick={onConfirmServices} type="button">{disabled ? <LoaderCircle className="animate-spin" size={13} /> : <HeartPulse size={13} />} Confirmar {services.summary.readyCount} cubiertas</button></div>}
        {!services.ready && <div className="mt-4 rounded-xl border border-line-steel bg-surface-alt p-3 text-[12px] font-bold text-ink-subtle">No hay cubiertas inequívocas pendientes de confirmación.</div>}
      </div>
    </div>
  </section>;
}

function MappingPlanCard({ acknowledged, disabled, onAcknowledged, onConfirm, plan }: { acknowledged: boolean; disabled: boolean; onAcknowledged: (value: boolean) => void; onConfirm: () => void; plan: CooprinsemGroupMappingPlan }) {
  const actionLabel = { create: "Crear mapeo", change: "Cambiar destino", deactivate: "Desactivar mapeo", noop: "Sin cambios" }[plan.action];
  return <div className="mt-5 rounded-xl border border-line-steel bg-surface-alt p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[12px] font-black uppercase tracking-wide text-accent">{actionLabel}</p><p className="mt-1 text-xs font-black text-ink">Grupo {plan.groupCode} {plan.targetLot ? `→ ${plan.targetLot.name}` : "→ sin destino activo"}</p></div><span className="rounded-lg bg-white px-2 py-1 text-[12px] font-black text-ink-muted">{plan.impact.stagedRowCount} filas</span></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><MiniMetric label="Pendientes" value={plan.impact.pendingRowCount} /><MiniMetric label="Integradas" value={plan.impact.importedRowCount} /><MiniMetric label="Por clasificar" value={plan.impact.quarantineAnimalCount} /><MiniMetric label="Acción" text={actionLabel} /></div>{plan.blockers.length > 0 && <div className="mt-3 rounded-lg border border-line-steel bg-surface-alt p-2.5 text-[12px] font-bold text-alert-ink">{plan.blockers.join(" ")}</div>}{plan.ready && <><label className="mt-4 flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-ink-muted"><input checked={acknowledged} className="mt-0.5 size-4 accent-accent" onChange={(event) => onAcknowledged(event.target.checked)} type="checkbox" /><span>Revisé el impacto. Este cambio afecta la resolución futura; no mueve animales existentes por sí solo.</span></label><button className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={!acknowledged || disabled} onClick={onConfirm} type="button">{disabled ? <LoaderCircle className="animate-spin" size={13} /> : <ShieldCheck size={13} />} Confirmar {actionLabel.toLocaleLowerCase("es")}</button></>}</div>;
}

function ReassignmentPlanCard({ acknowledged, disabled, onAcknowledged, onConfirm, plan }: { acknowledged: boolean; disabled: boolean; onAcknowledged: (value: boolean) => void; onConfirm: () => void; plan: CooprinsemQuarantineReassignmentPlan }) {
  return <section className="rounded-[22px] border border-line-steel bg-surface-alt p-5"><div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-white"><Boxes size={18} /></div><div><p className="text-[12px] font-black uppercase tracking-wide text-accent">Simulación de reasignación</p><h3 className="mt-1 text-sm font-black text-ink">Grupo {plan.groupCode}: {plan.sourceLotName} → {plan.targetLotName ?? "sin destino"}</h3><p className="mt-1 text-[12px] text-ink-subtle">{plan.candidateCount} animales conservan su movimiento histórico y reciben una nueva pertenencia fechada.</p></div></div>{plan.blockers.length > 0 && <div className="mt-4 rounded-xl border border-line-steel bg-surface-alt p-3 text-[12px] font-bold text-alert-ink">{plan.blockers.join(" ")}</div>}{plan.candidates.length > 0 && <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{plan.candidates.slice(0, 8).map((animal) => <div className="rounded-xl border border-line-steel bg-white p-3" key={animal.animalId}><p className="text-xs font-black text-ink">{animal.tag}</p><p className="mt-1 truncate text-[12px] text-ink-subtle">{animal.sourceTable} · {animal.sourceKey ?? animal.importRowId}</p></div>)}</div>}{plan.rowsTruncated && <p className="mt-2 text-[12px] font-bold text-ink-subtle">Vista resumida; la confirmación considera todos los candidatos.</p>}{plan.ready && <div className="mt-4 border-t border-line-steel pt-4"><label className="flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-ink-muted"><input checked={acknowledged} className="mt-0.5 size-4 accent-accent" onChange={(event) => onAcknowledged(event.target.checked)} type="checkbox" /><span>Revisé los animales y confirmo el movimiento al lote configurado. La fila Cooprinsem original seguirá enlazada.</span></label><button className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={!acknowledged || disabled} onClick={onConfirm} type="button">{disabled ? <LoaderCircle className="animate-spin" size={13} /> : <ArrowRight size={13} />} Reasignar {plan.candidateCount} animales</button></div>}</section>;
}

function GenealogyPanel({ acknowledged, disabled, onAcknowledged, onConfirm, plan }: { acknowledged: boolean; disabled: boolean; onAcknowledged: (value: boolean) => void; onConfirm: () => void; plan: CooprinsemConfigurationDashboard["genealogy"] }) {
  return <section className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_32px_rgba(35,50,42,0.04)]"><div className="flex items-start justify-between border-b border-line-steel p-5"><div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent"><GitMerge size={18} /></div><div><h3 className="text-sm font-black text-ink">Reconciliación de genealogía</h3><p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">Detecta crías pendientes contra tags e identificadores activos del mismo fundo.</p></div></div><span className="rounded-lg bg-surface-alt px-2.5 py-1 text-[12px] font-black text-accent">{plan.summary.readyCount} listas</span></div><div className="grid grid-cols-2 gap-2 border-b border-line-steel p-4 sm:grid-cols-4"><MiniMetric label="Pendientes" value={plan.summary.unresolvedCount} /><MiniMetric label="Listas" value={plan.summary.readyCount} /><MiniMetric label="Sin animal" value={plan.summary.unmatchedCount} /><MiniMetric label="Conflictos" value={plan.summary.conflictCount} /></div>{plan.rows.length === 0 ? <Empty text="No hay crías pendientes de enlazar." /> : <div className="divide-y divide-line-steel">{plan.rows.slice(0, 8).map((row) => <GenealogyRow key={row.offspringId} row={row} />)}</div>}{plan.rowsTruncated && <p className="border-t border-line-steel bg-surface-alt px-4 py-2 text-[12px] font-bold text-ink-subtle">Vista resumida; los totales consideran todos los registros.</p>}{plan.ready && <div className="border-t border-line-steel bg-surface-alt p-4"><label className="flex cursor-pointer items-start gap-2 text-[12px] leading-relaxed text-ink-muted"><input checked={acknowledged} className="mt-0.5 size-4 accent-accent" onChange={(event) => onAcknowledged(event.target.checked)} type="checkbox" /><span>Revisé las coincidencias únicas. Conflictos y registros sin candidato permanecerán pendientes.</span></label><button className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={!acknowledged || disabled} onClick={onConfirm} type="button">{disabled ? <LoaderCircle className="animate-spin" size={13} /> : <GitMerge size={13} />} Enlazar {plan.summary.readyCount} genealogías</button></div>}</section>;
}

function GenealogyRow({ row }: { row: CooprinsemGenealogyResolutionRow }) {
  const style = row.status === "ready" ? "bg-surface-alt text-accent" : row.status === "conflict" ? "bg-surface-alt text-alert-ink" : "bg-surface-alt text-warn-ink";
  return <div className="grid gap-2 px-4 py-3 text-[12px] sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_100px] sm:items-center"><div><p className="font-black text-ink">Cría {row.temporaryIdentifier}</p><p className="mt-0.5 text-ink-subtle">Madre {row.damTag} · {formatDate(row.occurredAt)}</p></div><ArrowRight className="hidden text-ink-subtle sm:block" size={13} /><div><p className="font-black text-ink">{row.candidateTag ?? "Sin candidato"}</p><p className="mt-0.5 text-ink-subtle">{row.issues[0] ?? row.matchedBy.join(" · ")}</p></div><span className={`justify-self-start rounded-full px-2.5 py-1 text-[12px] font-black uppercase sm:justify-self-end ${style}`}>{row.status === "ready" ? "Enlazar" : row.status === "conflict" ? "Conflicto" : "Pendiente"}</span></div>;
}

function ConfigMetric({ label, tone, value }: { label: string; tone: "green" | "amber" | "red" | "blue"; value: number }) { const styles = { green: "border-line-steel bg-surface-alt text-accent", amber: "border-warn-bar bg-surface-alt text-warn-ink", red: "border-line-steel bg-surface-alt text-alert-ink", blue: "border-line-steel bg-surface-alt text-accent" } as const; return <div className={`rounded-[18px] border p-4 ${styles[tone]}`}><p className="text-[12px] font-black uppercase tracking-wide opacity-70">{label}</p><p className="mt-1 text-2xl font-black">{value}</p></div>; }
function MiniMetric({ label, text, value }: { label: string; text?: string; value?: number }) { return <div className="rounded-lg border border-line-steel bg-white px-2.5 py-2"><p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">{label}</p><p className="mt-1 truncate text-[12px] font-black text-ink-muted">{text ?? value ?? 0}</p></div>; }
function Empty({ text }: { text: string }) { return <div className="grid min-h-28 place-items-center p-5 text-center text-[12px] font-bold text-ink-subtle"><div><CheckCircle2 className="mx-auto mb-2 text-accent" size={18} />{text}</div></div>; }
function errorMessage(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
function formatDate(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)); }

const inputClass = "h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink-muted outline-none transition focus:border-accent";
const smallButtonClass = "h-8 rounded-lg border border-line-steel bg-white px-2.5 text-[12px] font-black text-ink-muted hover:border-line-strong";
