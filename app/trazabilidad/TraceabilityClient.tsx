"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import type { TraceabilityDashboard } from "@/src/modules/trazabilidad/server/traceability-repository";
import { TableExplorer } from "@/src/ui/TableExplorer";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Download,
  FileCheck2,
  FileText,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Tags,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";

type Section = "overview" | "diio" | "fma" | "dea" | "import";
type TraceabilityMutation = (payload: Record<string, unknown> | FormData) => Promise<Record<string, unknown> | null>;

export function TraceabilityClient({
  fields,
  initialDashboard,
  isDemo,
  organizationId,
  organizationName,
  userName,
}: {
  fields: Array<{ id: string; name: string }>;
  initialDashboard: TraceabilityDashboard;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [section, setSection] = useState<Section>("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAnimals, setSelectedAnimals] = useState<string[]>([]);
  const assigned = dashboard.devices.filter((device) => device.status === "assigned").length;
  const available = dashboard.devices.filter((device) => device.status === "available").length;
  const individualInventory = dashboard.inventory.filter((entry) => entry.trackingMode === "individual" && entry.animalId);

  async function mutate(payload: Record<string, unknown> | FormData) {
    setBusy(true);
    setError(null);
    try {
      const isForm = payload instanceof FormData;
      if (isForm) payload.set("fieldId", dashboard.field.id);
      const response = await fetch("/api/trazabilidad", isForm ? {
        method: "POST",
        body: payload,
      } : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, fieldId: dashboard.field.id }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(body.error ?? "No fue posible completar la operación."));
      if ("field" in body && "devices" in body) setDashboard(body as unknown as TraceabilityDashboard);
      else await refresh();
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible completar la operación.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const response = await fetch(`/api/trazabilidad?fieldId=${encodeURIComponent(dashboard.field.id)}`, { cache: "no-store" });
    const body = await response.json() as TraceabilityDashboard & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "No fue posible actualizar la trazabilidad.");
    setDashboard(body);
  }

  async function refreshModule() {
    setBusy(true);
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible actualizar la trazabilidad.");
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell activeSection="trazabilidad" fieldName={dashboard.field.name} isDemo={isDemo} onRefresh={refreshModule} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="min-h-screen bg-surface-alt px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        <div className="mx-auto max-w-7xl">
          <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-ink px-3 py-1 text-[12px] font-black uppercase tracking-[0.16em] text-white">SIPEC / SAG</span>
                <span className="rounded-full bg-warn-ink px-3 py-1 text-[12px] font-black uppercase tracking-[0.12em] text-warn-ink">Emisión interna · no declarada SAG</span>
                {dashboard.dataMode === "demo" && <span className="rounded-full bg-alert-bg px-3 py-1 text-[12px] font-black uppercase tracking-[0.12em] text-alert-ink">Datos ficticios</span>}
              </div>
              <h1 className="text-3xl font-black tracking-[-0.045em] text-ink sm:text-4xl">Trazabilidad animal</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">DIIO, conciliación y documentos preservados con hash. El formato oficial y cualquier envío a SIPEC siguen pendientes de confirmación SAG.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {fields.map((field) => (
                <Link className={`rounded-xl border px-3 py-2 text-xs font-bold ${field.id === dashboard.field.id ? "border-ink bg-ink text-white" : "border-line-steel bg-white text-ink-muted"}`} href={`/app/trazabilidad?fieldId=${encodeURIComponent(field.id)}`} key={field.id}>{field.name}</Link>
              ))}
            </div>
          </header>

          {error && <div className="mt-6 flex items-start gap-3 rounded-2xl border border-alert-bar bg-surface-alt p-4 text-sm font-semibold text-alert-ink" role="alert"><AlertTriangle className="mt-0.5 shrink-0" size={18} />{error}</div>}
          {dashboard.readOnly && <div className="mt-6 flex items-center gap-3 rounded-2xl border border-line-steel bg-band p-4 text-sm text-ink-muted"><ShieldCheck size={19} /><span><strong>Vista de solo lectura.</strong> La demostración no puede emitir folios ni modificar registros.</span></div>}

          <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="DIIO asignados" value={assigned} detail={`${available} disponibles`} icon={<Tags size={18} />} />
            <Metric label="Inventario trazado" value={individualInventory.length} detail={`${dashboard.inventory.length} registros conciliables`} icon={<ShieldCheck size={18} />} />
            <Metric label="Hallazgos" value={dashboard.reconciliation.findings.length} detail={dashboard.reconciliation.healthy ? "Conciliación íntegra" : "Requieren revisión"} icon={dashboard.reconciliation.healthy ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} />
            <Metric label="Documentos" value={dashboard.movements.length + dashboard.declarations.length} detail="PDF privados e inmutables" icon={<FileCheck2 size={18} />} />
          </div>

          <nav className="mt-7 flex gap-2 overflow-x-auto pb-1" aria-label="Secciones de trazabilidad">
            {([
              ["overview", "Resumen"], ["diio", "DIIO"], ["fma", "FMA"], ["dea", "DEA"], ["import", "Importar"],
            ] as Array<[Section, string]>).map(([id, label]) => <button className={`min-h-11 whitespace-nowrap rounded-xl px-4 text-sm font-bold ${section === id ? "bg-ink text-white" : "border border-line-steel bg-white text-ink-muted"}`} key={id} onClick={() => setSection(id)} type="button">{label}</button>)}
          </nav>

          <section className="mt-4 rounded-3xl border border-line-steel bg-white p-5 shadow-[0_18px_55px_rgba(30,57,43,0.06)] sm:p-7">
            {section === "overview" && <Overview dashboard={dashboard} />}
            {section === "diio" && <DiioSection dashboard={dashboard} disabled={dashboard.readOnly || busy} mutate={mutate} />}
            {section === "fma" && <FmaSection dashboard={dashboard} disabled={dashboard.readOnly || busy} selected={selectedAnimals} setSelected={setSelectedAnimals} mutate={mutate} />}
            {section === "dea" && <DeaSection dashboard={dashboard} disabled={dashboard.readOnly || busy} mutate={mutate} />}
            {section === "import" && <ImportSection dashboard={dashboard} disabled={dashboard.readOnly || busy} mutate={mutate} />}
          </section>
          {busy && <div className="fixed inset-0 z-[1100] grid place-items-center bg-ink/20 backdrop-blur-[2px]" aria-live="polite"><div className="flex items-center gap-3 rounded-2xl bg-white px-5 py-4 text-sm font-bold text-ink shadow-xl"><LoaderCircle className="animate-spin" size={20} />Guardando y verificando…</div></div>}
        </div>
      </div>
    </AppShell>
  );
}

function Overview({ dashboard }: { dashboard: TraceabilityDashboard }) {
  const establishment = dashboard.establishment;
  return <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
    <div>
      <SectionTitle icon={<MapPin size={18} />} title="Establecimiento pecuario" />
      {establishment ? <dl className="mt-5 grid gap-4 rounded-2xl bg-surface-alt p-5 sm:grid-cols-2">
        <Data label="RUP" value={establishment.displayRup} />
        <Data label="Tipo" value={establishment.type} />
        <Data label="Titular" value={establishment.holderName} />
        <Data label="RUT" value={establishment.holderRut} />
        <Data label="Comuna" value={establishment.commune} />
        <Data label="Dirección" value={establishment.address} />
      </dl> : <Empty text="Aún no hay un establecimiento pecuario registrado para este fundo." />}
    </div>
    <div>
      <SectionTitle icon={<RefreshCw size={18} />} title="Conciliación" />
      <div className="mt-5 space-y-3">
        {dashboard.reconciliation.findings.length === 0 ? <div className="rounded-2xl border border-line-steel bg-surface-alt p-5 text-sm text-ink-muted"><strong>Sin huérfanos ni duplicados.</strong><p className="mt-1 text-xs leading-5">El inventario individual y los DIIO asignados cuadran en esta proyección.</p></div> : dashboard.reconciliation.findings.slice(0, 8).map((finding, index) => <div className="rounded-xl border border-warn-bar bg-surface-alt p-3 text-xs text-warn-ink" key={`${finding.code}-${index}`}><strong>{finding.code}</strong><p className="mt-1">{finding.officialNumber ?? finding.animalId ?? "Registro sin identidad"}</p></div>)}
      </div>
    </div>
  </div>;
}

function DiioSection({ dashboard, disabled, mutate }: { dashboard: TraceabilityDashboard; disabled: boolean; mutate: TraceabilityMutation }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate({ action: "add_diio", officialNumber: form.get("officialNumber"), deviceType: form.get("deviceType"), rfidId: form.get("rfidId"), idempotencyKey: newIdempotencyKey("diio") });
    event.currentTarget.reset();
  }
  return <div>
    <SectionTitle icon={<Tags size={18} />} title="Dispositivos DIIO" />
    {!dashboard.establishment ? <Empty text="Registra un establecimiento antes de administrar DIIO." /> : <>
      <form className="mt-5 grid gap-3 rounded-2xl bg-surface-alt p-4 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={submit}>
        <Input label="Número oficial (9 dígitos)" name="officialNumber" pattern="[0-9 .-]{9,16}" required />
        <Select label="Tipo" name="deviceType" options={[["double_ear_tag", "Arete doble"], ["ear_button", "Botón"], ["ruminal_bolus", "Bolo ruminal"]]} />
        <Input label="RFID opcional" name="rfidId" />
        <button className="min-h-11 self-end rounded-xl bg-ink px-4 text-sm font-black text-white disabled:opacity-40" disabled={disabled} type="submit"><Plus className="inline" size={16} /> Agregar</button>
      </form>
      <TableExplorer
        className="mt-5"
        description="Dispositivos oficiales, asignación y estado operativo del fundo."
        filter={{ label: "Estado", allLabel: "Todos los estados", columnIndex: 2 }}
        id="trazabilidad.diio"
        searchPlaceholder="Buscar DIIO, tipo, estado o animal..."
        title="Dispositivos DIIO"
      >
        <table className="w-full min-w-[680px] text-left text-sm"><thead className="text-[12px] uppercase tracking-wider text-ink-subtle"><tr><th className="pb-3">DIIO</th><th className="pb-3">Tipo</th><th className="pb-3">Estado</th><th className="pb-3">Animal</th><th className="pb-3">Versión</th><th className="pb-3">Acciones</th></tr></thead><tbody>{dashboard.devices.map((device) => <tr className="border-t border-line-steel" key={device.id}><td className="py-3 font-black text-ink">{device.officialNumber}</td><td>{device.deviceType}</td><td><Status value={device.status} /></td><td>{device.animalId ?? "—"}</td><td>{device.version}</td><td>{device.status === "assigned" && <button className="rounded-lg border border-warn-bar px-2.5 py-1.5 text-xs font-bold text-warn-ink disabled:opacity-40" disabled={disabled} onClick={() => mutate({ action: "transition_diio", deviceId: device.id, transition: "report_lost", occurredAt: new Date().toISOString(), idempotencyKey: newIdempotencyKey("lost") })} type="button">Reportar pérdida</button>}</td></tr>)}</tbody></table>
      </TableExplorer>
    </>}
  </div>;
}

function FmaSection({ dashboard, disabled, selected, setSelected, mutate }: { dashboard: TraceabilityDashboard; disabled: boolean; selected: string[]; setSelected: (ids: string[]) => void; mutate: TraceabilityMutation }) {
  const [supersedesDocumentId, setSupersedesDocumentId] = useState<string | null>(null);
  const candidates = dashboard.inventory.filter((entry) => entry.trackingMode === "individual" && entry.animalId && entry.diio);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = await mutate({ action: "issue_fma", animalIds: selected, idempotencyKey: newIdempotencyKey("fma-issue"), supersedesDocumentId, movement: {
      destinationRup: form.get("destinationRup"), destinationCommune: form.get("destinationCommune"), destinationAddress: form.get("destinationAddress"),
      departureDate: form.get("departureDate"), departureTime: form.get("departureTime"), arrivalDate: form.get("arrivalDate"), arrivalTime: form.get("arrivalTime"),
      carrierName: form.get("carrierName"), carrierRut: form.get("carrierRut"), vehiclePlate: form.get("vehiclePlate"), observations: form.get("observations"),
      destinationPurpose: "domestic", declarations: { noQuarantine: true, noSymptoms: true, noActiveWithdrawal: true },
    }});
    if (body) setSupersedesDocumentId(null);
  }
  return <div>
    <SectionTitle icon={<ArrowRightLeft size={18} />} title="Emitir FMA interno" />
    <p className="mt-2 text-xs text-ink-muted">Valida inventario, DIIO y RUP de origen; asigna un folio interno inmutable y preserva el PDF con hash. No envía ni declara el movimiento ante SAG.</p>
    {supersedesDocumentId && <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-accent bg-surface-alt p-3 text-xs text-accent"><span>Corrección de <strong>{supersedesDocumentId}</strong>; se emitirá un documento nuevo.</span><button className="font-black" onClick={() => setSupersedesDocumentId(null)} type="button">Cancelar</button></div>}
    <form className="mt-5 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]" onSubmit={submit}>
      <div className="max-h-[430px] overflow-y-auto rounded-2xl border border-line-steel p-3"><div className="mb-2 flex items-center justify-between"><strong className="text-sm">Animales ({selected.length})</strong><button className="text-xs font-bold text-accent" onClick={() => setSelected(selected.length === candidates.length ? [] : candidates.map((entry) => entry.animalId!))} type="button">{selected.length === candidates.length ? "Quitar todos" : "Seleccionar todos"}</button></div>{candidates.map((entry) => <label className="flex min-h-11 items-center gap-3 border-t border-line-steel text-xs" key={entry.id}><input checked={selected.includes(entry.animalId!)} onChange={(event) => setSelected(event.target.checked ? [...selected, entry.animalId!] : selected.filter((id) => id !== entry.animalId))} type="checkbox" /><span className="font-black">{entry.diio}</span><span className="ml-auto text-ink-subtle">{entry.categoryCode}</span></label>)}</div>
      <div className="grid gap-3 sm:grid-cols-2"><Input label="RUP destino" name="destinationRup" required /><Input label="Comuna destino" name="destinationCommune" required /><Input label="Dirección destino" name="destinationAddress" required /><Input label="Transportista" name="carrierName" required /><Input label="RUT transportista" name="carrierRut" placeholder="12.345.678-5" required /><Input label="Patente" name="vehiclePlate" required /><Input label="Fecha salida" name="departureDate" type="date" required /><Input label="Hora salida" name="departureTime" type="time" required /><Input label="Fecha llegada" name="arrivalDate" type="date" required /><Input label="Hora llegada" name="arrivalTime" type="time" required /><Input label="Observaciones" name="observations" /><button className="min-h-11 self-end rounded-xl bg-ink px-4 text-sm font-black text-white disabled:opacity-40" disabled={disabled || selected.length === 0} type="submit"><FileText className="inline" size={16} /> Emitir y preservar</button></div>
    </form>
    <DocumentList documents={dashboard.movements} disabled={disabled} fieldId={dashboard.field.id} kind="fma" mutate={mutate} onCorrect={setSupersedesDocumentId} />
  </div>;
}

function DeaSection({ dashboard, disabled, mutate }: { dashboard: TraceabilityDashboard; disabled: boolean; mutate: TraceabilityMutation }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await mutate({ action: "generate_dea", period: Number(form.get("period")), asOfDate: form.get("asOfDate"), idempotencyKey: newIdempotencyKey("dea") }); }
  return <div><SectionTitle icon={<FileCheck2 size={18} />} title="Declaración de existencias derivada" /><p className="mt-2 text-xs text-ink-muted">Los conteos se calculan desde el inventario; no se capturan manualmente.</p><form className="mt-5 grid max-w-xl gap-3 rounded-2xl bg-surface-alt p-4 sm:grid-cols-[1fr_1fr_auto]" onSubmit={submit}><Input defaultValue={String(new Date().getUTCFullYear())} label="Período" max="2100" min="2000" name="period" type="number" required /><Input label="Fecha de corte" name="asOfDate" type="date" required /><button className="min-h-11 self-end rounded-xl bg-ink px-4 text-sm font-black text-white disabled:opacity-40" disabled={disabled} type="submit"><FileText className="inline" size={16} /> Generar PDF</button></form><DocumentList documents={dashboard.declarations} fieldId={dashboard.field.id} kind="dea" /></div>;
}

function ImportSection({ dashboard, disabled, mutate }: { dashboard: TraceabilityDashboard; disabled: boolean; mutate: TraceabilityMutation }) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [sourceKind, setSourceKind] = useState("cliex_dbf");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (sourceKind === "cliex_dbf") {
      form.set("action", "stage_import_file");
      form.set("sourceKind", sourceKind);
      form.set("idempotencyKey", newIdempotencyKey("import-stage"));
      setPreview(await mutate(form));
      return;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(String(form.get("rows")));
    } catch {
      setPreview({ error: "El JSON no es válido." });
      return;
    }
    setPreview(await mutate({
      action: "stage_import",
      sourceKind,
      rows,
      idempotencyKey: newIdempotencyKey("import-stage"),
    }));
  }
  const stageId = typeof preview?.stageId === "string" ? preview.stageId : null;
  return <div><SectionTitle icon={<Upload size={18} />} title="Importación conciliada" /><p className="mt-2 text-xs leading-5 text-ink-muted">El DBF se procesa con el mismo parser de Cooprinsem y resuelve sus identificadores al inventario del fundo. La plantilla manual acepta filas normalizadas. SIPEC permanece bloqueado hasta confirmar una especificación oficial; no se interpretan ni generan archivos supuestos. El stage no escribe DIIO.</p><div className="mt-3 rounded-xl border border-warn-bar bg-surface-alt p-3 text-xs text-warn-ink">Adaptador {dashboard.sipecAdapter.adapterVersion}: <strong>{dashboard.sipecAdapter.specificationStatus}</strong> · oficialmente presentable: no.</div><form className="mt-5 space-y-3" onSubmit={submit}><label className="block text-xs font-bold text-ink-muted">Origen<select className="mt-1 min-h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-sm outline-none focus:border-accent" name="sourceKind" onChange={(event) => setSourceKind(event.target.value)} value={sourceKind}><option value="cliex_dbf">DBF Cliex / Cooprinsem</option><option disabled value="sipec_file">Archivo SIPEC (pendiente de especificación oficial)</option><option value="manual_template">Plantilla manual</option></select></label>{sourceKind === "cliex_dbf" ? <label className="block text-xs font-bold text-ink-muted">Archivo DBF<input accept=".dbf,application/x-dbf,application/octet-stream" className="mt-1 min-h-11 w-full rounded-xl border border-line-steel bg-white p-2 text-sm" name="file" required type="file" /></label> : <label className="block text-xs font-bold text-ink-muted">Filas JSON normalizadas<textarea className="mt-1 min-h-44 w-full rounded-xl border border-line-steel bg-white p-3 font-mono text-xs outline-none focus:border-accent" defaultValue={'[{"diio":"123456789","animal_id":"animal-id","tipo_dispositivo":"arete"}]'} name="rows" required /></label>}<button className="min-h-11 rounded-xl bg-ink px-4 text-sm font-black text-white disabled:opacity-40" disabled={disabled} type="submit">Conciliar sin guardar</button></form>{preview && <pre className="mt-4 max-h-64 overflow-auto rounded-2xl bg-chrome p-4 text-[12px] text-accent">{JSON.stringify(preview, null, 2)}</pre>}{stageId && <button className="mt-3 min-h-11 rounded-xl bg-accent px-4 text-sm font-black text-ink disabled:opacity-40" disabled={disabled} onClick={() => mutate({ action: "commit_import", stageId, idempotencyKey: newIdempotencyKey("import-commit") })} type="button">Confirmar filas aceptadas</button>}<div className="mt-6 space-y-2">{dashboard.imports.map((item) => <div className="flex items-center justify-between rounded-xl border border-line-steel p-3 text-xs" key={String(item.id)}><span>{String(item.sourceKind)} · {String(item.rowCount)} filas</span><Status value={String(item.status)} /></div>)}</div></div>;
}

function DocumentList({ documents, disabled = false, fieldId, kind, mutate, onCorrect }: { documents: Array<Record<string, unknown>>; disabled?: boolean; fieldId: string; kind: "fma" | "dea"; mutate?: TraceabilityMutation; onCorrect?: (id: string) => void }) { return <div className="mt-7 space-y-2"><h3 className="text-xs font-black uppercase tracking-wider text-ink-subtle">Documentos preservados</h3>{documents.length === 0 ? <Empty text="Todavía no hay documentos guardados." /> : documents.map((document) => <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line-steel p-3 text-xs" key={String(document.id)}><FileText size={17} className="text-accent" /><strong>{String(document.folio ?? document.id)}</strong><Status value={String(document.status ?? document.documentStatus)} />{Boolean(document.supersedesMovementId) && <span className="text-ink-subtle">Corrige {String(document.supersedesMovementId)}</span>}<span className="ml-auto text-ink-subtle">{document.documentSizeBytes ? `${Math.round(Number(document.documentSizeBytes) / 1024)} KB` : "Pendiente"}</span>{document.documentStatus === "stored" && <a className="rounded-lg bg-surface-alt px-3 py-2 font-black text-accent" href={`/api/trazabilidad/documentos?fieldId=${encodeURIComponent(fieldId)}&kind=${kind}&documentId=${encodeURIComponent(String(document.id))}`}><Download className="inline" size={14} /> PDF</a>}{kind === "fma" && document.status === "issued" && mutate && <AnnulmentControl disabled={disabled} document={document} mutate={mutate} />}{kind === "fma" && document.status === "annulled" && onCorrect && <button className="rounded-lg border border-accent px-3 py-2 font-black text-accent disabled:opacity-40" disabled={disabled} onClick={() => onCorrect(String(document.id))} type="button">Corregir con nuevo FMA</button>}</div>)}</div>; }

function AnnulmentControl({ disabled, document, mutate }: { disabled: boolean; document: Record<string, unknown>; mutate: TraceabilityMutation }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button className="rounded-lg border border-alert-bar px-3 py-2 font-black text-alert-ink disabled:opacity-40" disabled={disabled} onClick={() => setOpen(true)} type="button">Anular</button>;
  return <div className="flex min-w-full flex-wrap items-end gap-2 rounded-xl bg-surface-alt p-3"><Input label="Razón de anulación" minLength={5} onChange={(event) => setReason(event.target.value)} value={reason} /><button className="min-h-11 rounded-lg bg-alert-ink px-3 font-black text-white disabled:opacity-40" disabled={disabled || reason.trim().length < 5} onClick={() => mutate({ action: "annul_fma", documentId: document.id, reason, expectedVersion: Number(document.version), idempotencyKey: newIdempotencyKey("fma-annul") })} type="button">Confirmar anulación</button><button className="min-h-11 px-3 font-black text-ink-muted" onClick={() => setOpen(false)} type="button">Volver</button></div>;
}
function Metric({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: React.ReactNode }) { return <div className="rounded-2xl border border-line-steel bg-white p-4"><div className="flex items-center justify-between text-ink-muted"><span className="text-[12px] font-black uppercase tracking-wider">{label}</span>{icon}</div><p className="mt-3 text-3xl font-black tracking-tight text-ink">{value}</p><p className="mt-1 text-xs text-ink-subtle">{detail}</p></div>; }
function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) { return <h2 className="flex items-center gap-2 text-lg font-black tracking-tight text-ink">{icon}{title}</h2>; }
function Data({ label, value }: { label: string; value: string }) { return <div><dt className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">{label}</dt><dd className="mt-1 text-sm font-bold text-ink">{value}</dd></div>; }
function Status({ value }: { value: string }) { const good = ["assigned", "stored", "committed", "active", "issued"].includes(value); return <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black uppercase tracking-wide ${good ? "bg-band text-accent" : "bg-warn-bg text-warn-ink"}`}>{value}</span>; }
function Empty({ text }: { text: string }) { return <div className="mt-5 rounded-2xl border border-dashed border-line-steel bg-surface-alt p-6 text-center text-sm text-ink-subtle">{text}</div>; }
function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) { const { label, ...input } = props; return <label className="block text-xs font-bold text-ink-muted">{label}<input {...input} className="mt-1 min-h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-sm outline-none focus:border-accent" /></label>; }
function Select({ label, name, options }: { label: string; name: string; options: Array<[string, string]> }) { return <label className="block text-xs font-bold text-ink-muted">{label}<select className="mt-1 min-h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-sm outline-none focus:border-accent" name={name}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>; }
function newIdempotencyKey(prefix: string) { return `${prefix}:${crypto.randomUUID()}`; }
