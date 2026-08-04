"use client";

import type { Fundo } from "@/src/core/domain/types";
import { AppShell } from "@/src/core/layout/AppShell";
import { HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  CircleSlash2,
  Database,
  Download,
  FileClock,
  FileJson2,
  FileSearch,
  FileUp,
  History,
  Info,
  LoaderCircle,
  LockKeyhole,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  UserCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  fetchCooprinsemDashboard,
  fetchCooprinsemPreview,
  fetchOriginalIntegrity,
  fetchIntegritySweepDashboard,
  fetchRetentionDashboard,
  deepVerifyOriginal,
  runIntegritySweepBatch,
  confirmCooprinsemProjection,
  preparePortableRecovery,
  preparePortableRestore,
  previewPortableRestore,
  simulateCooprinsemProjection,
  updateCooprinsemIssue,
  uploadCooprinsemPreview,
} from "./api/import-client";
import { CooprinsemConfigurationWorkspace } from "./CooprinsemConfigurationWorkspace";
import type {
  CooprinsemImportDashboard,
  CooprinsemImportErrorStatus,
  CooprinsemImportHistoryItem,
  CooprinsemImportIssueItem,
  CooprinsemImportProjectionPlan,
  CooprinsemImportPreview,
  CooprinsemImportPreviewRow,
  CooprinsemOriginalIntegrityDashboard,
  CooprinsemOriginalDeepVerification,
  CooprinsemIntegritySweepDashboard,
  CooprinsemRetentionDashboard,
  CooprinsemSourceTable,
  FundoSmartPortableRestorePlan,
  FundoSmartRecoveryPreparationReceipt,
  FundoSmartRestoreConfirmation,
  ImportRecord,
} from "./domain/types";

type CooprinsemImportPageProps = {
  fundos: Fundo[];
  initialFieldId: string;
  initialDashboard: CooprinsemImportDashboard;
  organizationId: string;
  organizationName: string;
  userName: string;
  canRestore: boolean;
  isDemo: boolean;
};

type WorkspaceTab = "history" | "upload" | "issues" | "configuration" | "backups";

export function CooprinsemImportPage({
  fundos,
  initialFieldId,
  initialDashboard,
  organizationId,
  organizationName,
  userName,
  canRestore,
  isDemo,
}: CooprinsemImportPageProps) {
  const [fieldId, setFieldId] = useState(initialFieldId || fundos[0]?.id || "");
  const [sourceTable, setSourceTable] = useState<CooprinsemSourceTable>("PreDetimp.dbf");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CooprinsemImportPreview | null>(null);
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [tab, setTab] = useState<WorkspaceTab>(initialDashboard.imports.length > 0 ? "history" : "upload");
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [updatingIssueId, setUpdatingIssueId] = useState<string | null>(null);
  const [projection, setProjection] = useState<CooprinsemImportProjectionPlan | null>(null);
  const [simulatingId, setSimulatingId] = useState<string | null>(null);
  const [confirmingProjection, setConfirmingProjection] = useState(false);
  const [issueStatus, setIssueStatus] = useState<CooprinsemImportErrorStatus | "all">("open");
  const [error, setError] = useState<string | null>(null);

  const selectedFundo = useMemo(() => fundos.find((fundo) => fundo.id === fieldId) ?? null, [fieldId, fundos]);
  const needsEffectiveDate = sourceTable === "_Traspasos.DBF";
  const canSubmit = Boolean(fieldId && file && (!needsEffectiveDate || effectiveAt));
  const visibleIssues = issueStatus === "all"
    ? dashboard.issues
    : dashboard.issues.filter((issue) => issue.status === issueStatus);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const next = await uploadCooprinsemPreview({ effectiveAt, fieldId, file, sourceTable });
      setPreview(next);
      setProjection(null);
      setDashboard(await fetchCooprinsemDashboard());
      setFile(null);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible analizar el archivo."));
    } finally {
      setLoading(false);
    }
  }

  async function refreshDashboard() {
    setError(null);
    try {
      setDashboard(await fetchCooprinsemDashboard());
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible actualizar el centro de migración."));
      throw cause;
    }
  }

  async function openImport(id: string) {
    setOpeningId(id);
    setError(null);
    try {
      setPreview(await fetchCooprinsemPreview(id));
      setProjection(null);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible abrir la vista previa."));
    } finally {
      setOpeningId(null);
    }
  }

  async function resolveIssue(id: string, status: CooprinsemImportErrorStatus, resolutionNotes: string) {
    setUpdatingIssueId(id);
    setError(null);
    try {
      const nextDashboard = await updateCooprinsemIssue({ id, status, resolutionNotes });
      setDashboard(nextDashboard);
      if (preview && nextDashboard.issues.some((issue) => issue.importJobId === preview.id)) {
        setPreview(await fetchCooprinsemPreview(preview.id));
        setProjection(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible registrar la resolución."));
    } finally {
      setUpdatingIssueId(null);
    }
  }

  async function simulateProjection(id: string) {
    setSimulatingId(id);
    setError(null);
    try {
      setProjection(await simulateCooprinsemProjection(id));
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible simular la integración."));
    } finally {
      setSimulatingId(null);
    }
  }

  async function confirmProjection() {
    if (!projection?.ready) return;
    setConfirmingProjection(true);
    setError(null);
    try {
      const result = await confirmCooprinsemProjection(projection.importJobId);
      setDashboard(result.dashboard);
      setPreview(result.preview);
      setProjection(result.projection);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible confirmar la integración."));
    } finally {
      setConfirmingProjection(false);
    }
  }

  return (
    <AppShell activeSection="integraciones" fieldName={selectedFundo?.name ?? "Centro de migración"} isDemo={isDemo} onRefresh={refreshDashboard} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent"><span className="size-1.5 rounded-full bg-accent" /> Centro de migración auditable</div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Integración Cooprinsem</h1>
              <p className="mt-1 max-w-3xl text-sm text-ink-muted">Carga, revisa y confirma información canónica conservando el original, cada decisión y la trazabilidad del destino.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-xl border border-line-steel bg-white px-3.5 py-2.5 text-xs font-black text-ink-muted"><UserCheck size={15} /> {userName}</div>
              <div className="flex items-center gap-2 rounded-xl border border-line-steel bg-surface-alt px-3.5 py-2.5 text-xs font-black text-accent"><ShieldCheck size={16} /> {projection?.confirmedAt ? "Integración confirmada" : projection?.ready ? "Simulación lista" : "Confirmación controlada"}</div>
            </div>
          </header>

          <section className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard helpText="Archivos que has subido desde Cooprinsem hasta ahora." icon={FileClock} label="Cargas" value={dashboard.totals.importCount} tone="dark" />
            <StatCard help="integracionInconsistencias" icon={AlertTriangle} label="Pendientes" value={dashboard.totals.openIssueCount} tone={dashboard.totals.openIssueCount > 0 ? "amber" : "green"} />
            <StatCard helpText="Inconsistencias que ya resolviste o decidiste ignorar. Quedan registradas por si hay que revisarlas después." icon={CheckCircle2} label="Gestionadas" value={dashboard.totals.resolvedIssueCount + dashboard.totals.ignoredIssueCount} tone="green" />
            <StatCard helpText="Filas del archivo que quedaron guardadas y se pueden rastrear hasta el documento original." icon={Database} label="Filas trazadas" value={dashboard.totals.rowCount} tone="neutral" />
          </section>

          <div className="mt-5 flex flex-col gap-3 border-b border-line-steel sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Secciones del centro de migración">
              <TabButton active={tab === "history"} icon={History} label="Historial" onClick={() => setTab("history")} />
              <TabButton active={tab === "upload"} icon={FileUp} label="Nueva carga" onClick={() => setTab("upload")} />
              <TabButton active={tab === "issues"} count={dashboard.totals.openIssueCount} icon={AlertTriangle} label="Inconsistencias" onClick={() => setTab("issues")} />
              <TabButton active={tab === "configuration"} icon={Settings2} label="Configuración" onClick={() => setTab("configuration")} />
              <TabButton active={tab === "backups"} icon={ArchiveRestore} label="Respaldos" onClick={() => setTab("backups")} />
            </div>
          </div>

          {error && <div className="mt-4 flex items-start gap-2 rounded-xl border border-alert-bar bg-surface-alt p-3 text-xs font-bold text-alert-ink"><XCircle className="mt-0.5 shrink-0" size={15} /> {error}</div>}

          {tab === "history" && <HistoryWorkspace imports={dashboard.imports} onOpen={openImport} openingId={openingId} openIssueCount={dashboard.totals.openIssueCount} />}
          {tab === "upload" && (
            <UploadWorkspace
              canSubmit={canSubmit}
              effectiveAt={effectiveAt}
              fieldId={fieldId}
              file={file}
              fundos={fundos}
              loading={loading}
              needsEffectiveDate={needsEffectiveDate}
              onEffectiveAt={setEffectiveAt}
              onFieldId={setFieldId}
              onFile={setFile}
              onSourceTable={setSourceTable}
              onSubmit={submit}
              sourceTable={sourceTable}
            />
          )}
          {tab === "issues" && (
            <IssuesWorkspace
              filter={issueStatus}
              issues={visibleIssues}
              onFilter={setIssueStatus}
              onResolve={resolveIssue}
              updatingId={updatingIssueId}
            />
          )}
          {tab === "configuration" && <CooprinsemConfigurationWorkspace fieldId={fieldId} fundos={fundos} key={fieldId} onFieldId={setFieldId} />}
          {tab === "backups" && <BackupWorkspace canRestore={canRestore} fieldId={fieldId} fundos={fundos} imports={dashboard.imports} onFieldId={setFieldId} />}

          {preview && tab !== "configuration" && tab !== "backups" && <PreviewSection confirming={confirmingProjection} onConfirm={confirmProjection} onSimulate={simulateProjection} preview={preview} projection={projection} simulating={simulatingId === preview.id} />}
        </div>
      </div>
    </AppShell>
  );
}

function HistoryWorkspace({ imports, onOpen, openingId, openIssueCount }: {
  imports: CooprinsemImportHistoryItem[];
  onOpen: (id: string) => void;
  openingId: string | null;
  openIssueCount: number;
}) {
  return (
    <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)]">
      <div className="overflow-hidden rounded-[20px] border border-line-steel bg-white shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
        <div className="flex items-center justify-between border-b border-line-steel px-5 py-4"><div><h2 className="text-sm font-black text-ink">Historial de archivos</h2><p className="mt-1 text-[12px] text-ink-subtle">Cada carga conserva fuente, resultado y huella digital.</p></div><History className="text-accent" size={18} /></div>
        {imports.length === 0 ? <EmptyState icon={FileClock} title="Aún no hay cargas" text="Carga el primer DBF para iniciar el historial auditable." /> : (
          <div className="divide-y divide-line-steel">
            {imports.map((item) => {
              const pending = item.openIssueCount;
              return (
                <button className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-surface-alt" key={item.id} onClick={() => onOpen(item.id)} type="button">
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent"><FileSearch size={17} /></div>
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-xs font-black text-ink">{item.originalFilename}</p><JobStatus status={item.status} /></div><p className="mt-1 text-[12px] text-ink-subtle">{item.fieldName} · {item.sourceTable} · {formatDate(item.createdAt)}</p></div>
                  <div className="hidden text-right sm:block"><p className="text-xs font-black text-ink">{item.importedRowCount > 0 ? `${item.importedRowCount} integradas` : `${item.summary.rowCount} filas`}</p><p className={`mt-1 text-[12px] font-black ${pending > 0 ? "text-warn-ink" : "text-accent"}`}>{pending > 0 ? `${pending} pendientes` : item.confirmedAt ? "Confirmada" : "Sin pendientes"}</p></div>
                  {openingId === item.id ? <LoaderCircle className="animate-spin text-accent" size={16} /> : <ChevronRight className="text-ink-subtle" size={16} />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <aside className="rounded-[20px] border border-line-steel bg-ink p-5 text-white shadow-[0_16px_45px_rgba(23,59,45,0.12)]">
        <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-accent text-ink"><ShieldCheck size={18} /></div><div><h2 className="text-sm font-black">Puerta de calidad</h2><p className="mt-1 text-[12px] text-white/55">Control de la proyección canónica</p></div></div>
        <div className="mt-6 space-y-3">
          <QualityGate done={imports.length > 0} label="Archivo original protegido" />
          <QualityGate done={imports.some((item) => item.status === "preview_ready")} label="Filas analizadas y trazables" />
          <QualityGate done={openIssueCount === 0 && imports.length > 0} label="Observaciones gestionadas" />
          <QualityGate done={imports.some((item) => item.confirmedAt !== null)} label="Maestro animal proyectado" />
        </div>
        <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-[12px] leading-relaxed text-white/65">La simulación separa filas elegibles, excluidas y conflictivas. La confirmación solo crea o enlaza el maestro animal; la historia productiva se evalúa sin escribirla.</div>
      </aside>
    </section>
  );
}

function BackupWorkspace({ canRestore, fieldId, fundos, imports, onFieldId }: {
  canRestore: boolean;
  fieldId: string;
  fundos: Fundo[];
  imports: CooprinsemImportHistoryItem[];
  onFieldId: (value: string) => void;
}) {
  const fieldImports = imports.filter((item) => item.fieldId === fieldId);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePlan, setRestorePlan] = useState<FundoSmartPortableRestorePlan | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState<FundoSmartRestoreConfirmation | null>(null);
  const [restorePreparation, setRestorePreparation] = useState<FundoSmartRecoveryPreparationReceipt | null>(null);
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<CooprinsemOriginalIntegrityDashboard | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [integrityError, setIntegrityError] = useState<string | null>(null);
  async function simulateRestore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restoreFile) return;
    setRestoreLoading(true);
    setRestoreError(null);
    setRestorePlan(null);
    setRestoreConfirmation(null);
    setRestorePreparation(null);
    setConfirmationPhrase("");
    try {
      const result = await previewPortableRestore(restoreFile);
      setRestorePlan(result.plan);
    } catch (cause) {
      setRestoreError(errorMessage(cause, "No fue posible verificar el respaldo."));
    } finally {
      setRestoreLoading(false);
    }
  }
  async function prepareConfirmation() {
    if (!restoreFile || !canRestore || restorePlan?.assessment !== "ready") return;
    setRestoreLoading(true);
    setRestoreError(null);
    setRestoreConfirmation(null);
    setRestorePreparation(null);
    setConfirmationPhrase("");
    try {
      const result = await preparePortableRestore(restoreFile);
      setRestorePlan(result.plan);
      setRestoreConfirmation(result.confirmation);
    } catch (cause) {
      setRestoreError(errorMessage(cause, "No fue posible preparar la confirmacion segura."));
    } finally {
      setRestoreLoading(false);
    }
  }
  async function prepareRecovery() {
    if (!restoreFile || !restoreConfirmation || confirmationPhrase.trim() !== restoreConfirmation.requiredPhrase) return;
    setRestoreLoading(true);
    setRestoreError(null);
    setRestorePreparation(null);
    try {
      const result = await preparePortableRecovery(restoreFile, restoreConfirmation, confirmationPhrase);
      setRestorePlan(result.plan);
      setRestorePreparation(result.recovery);
      setRestoreConfirmation(null);
      setConfirmationPhrase("");
    } catch (cause) {
      setRestoreError(errorMessage(cause, "No fue posible preparar el ensayo de recuperación."));
    } finally {
      setRestoreLoading(false);
    }
  }
  async function verifyOriginals() {
    setIntegrityLoading(true);
    setIntegrityError(null);
    try {
      setIntegrity(await fetchOriginalIntegrity(fieldId));
    } catch (cause) {
      setIntegrityError(errorMessage(cause, "No fue posible verificar los originales R2."));
    } finally {
      setIntegrityLoading(false);
    }
  }
  if (!fieldId) {
    return <section className="mt-5 rounded-[22px] border border-line-steel bg-white"><EmptyState icon={ArchiveRestore} title="Sin fundos asignados" text="Un propietario debe asignarte al menos un fundo antes de generar respaldos." /></section>;
  }
  return (
    <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
      <div className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_32px_rgba(35,50,42,0.04)]">
        <div className="flex flex-col gap-4 border-b border-line-steel p-5 sm:flex-row sm:items-end sm:justify-between">
          <div><div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.14em] text-accent"><ArchiveRestore size={14} /> Portabilidad verificable</div><h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-ink">Respaldos abiertos</h2><p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-subtle">Descarga datos canónicos, staging, trazabilidad y auditoría en JSON UTF-8 con SHA-256 por sección.</p></div>
          <select className={inputClass} onChange={(event) => { onFieldId(event.target.value); setIntegrity(null); setIntegrityError(null); }} value={fieldId}>{fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}</select>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap gap-2"><a className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white" download href={backupUrl("field", fieldId, "backup")}><Download size={14} /> Descargar respaldo completo del fundo</a><button className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line-steel bg-surface-alt px-4 text-[12px] font-black text-accent disabled:opacity-45" disabled={integrityLoading} onClick={() => void verifyOriginals()} type="button">{integrityLoading ? <LoaderCircle className="animate-spin" size={14} /> : <Database size={14} />}{integrityLoading ? "Verificando R2…" : "Verificar conservación R2"}</button></div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-subtle">Incluye potreros, ganado, controles, eventos, importaciones e historial de auditoría del fundo autorizado. Las tablas sin alcance seguro se declaran como excluidas en el manifiesto.</p>
          {integrityError && <p className="mt-3 rounded-xl border border-alert-bar bg-surface-alt p-3 text-[12px] font-bold text-alert-ink">{integrityError}</p>}
          {integrity && <OriginalIntegrityPanel dashboard={integrity} />}
          <IntegritySweepPanel fieldId={fieldId} key={fieldId} />
          <RetentionPolicyPanel fieldId={fieldId} key={`retention:${fieldId}`} />
        </div>
        <form className="border-t border-line-steel p-5" onSubmit={simulateRestore}>
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent"><FileSearch size={17} /></div>
            <div>
              <h3 className="text-sm font-black text-ink">Ensayar restauración</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">Compara hashes, alcance, referencias y claves. Un ensayo confirmado solo deja un trabajo durable con la ejecución bloqueada.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <label className="flex h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-alt px-3 text-[12px] font-bold text-ink-muted">
              <FileJson2 className="shrink-0 text-accent" size={15} />
              <span className="truncate">{restoreFile?.name ?? "Seleccionar .fundosmart.json"}</span>
              <input
                accept=".json,application/json"
                className="sr-only"
                onChange={(event) => {
                  setRestoreFile(event.target.files?.[0] ?? null);
                  setRestorePlan(null);
                  setRestoreConfirmation(null);
                  setRestorePreparation(null);
                  setConfirmationPhrase("");
                  setRestoreError(null);
                }}
                type="file"
              />
            </label>
            <button className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[12px] font-black text-white disabled:opacity-45" disabled={!restoreFile || restoreLoading} type="submit">
              {restoreLoading ? <LoaderCircle className="animate-spin" size={14} /> : <FileSearch size={14} />}
              {restoreLoading ? "Verificando…" : "Ejecutar dry-run"}
            </button>
          </div>
          {restoreError && <p className="mt-3 rounded-xl border border-alert-bar bg-surface-alt p-3 text-[12px] font-bold leading-relaxed text-alert-ink">{restoreError}</p>}
          {restorePlan && <RestorePlanPanel plan={restorePlan} />}
          {restorePlan?.assessment === "ready" && !restoreConfirmation && !restorePreparation && (canRestore
            ? <button className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl border border-line-steel bg-surface-alt px-4 text-[12px] font-black text-accent disabled:opacity-45" disabled={restoreLoading} onClick={() => void prepareConfirmation()} type="button"><LockKeyhole size={13} /> Preparar confirmación segura</button>
            : <p className="mt-3 rounded-xl border border-line-steel bg-surface-alt p-3 text-[12px] font-bold text-warn-ink">La confirmación queda reservada a propietarios y administradores con la capacidad restore_data.</p>)}
          {restoreConfirmation && (
            <div className="mt-3 rounded-xl border border-warn-bar bg-surface-alt p-3">
              <p className="text-[12px] font-black text-warn-ink">Confirmación temporal de un solo uso</p>
              <p className="mt-1 text-[12px] leading-relaxed text-warn-ink">Está ligada al archivo, actor, fundo, plan y snapshot hasta {formatDate(restoreConfirmation.expiresAt)}; escribe la frase exacta. Solo se registrará el ensayo en D1: no cambiarán los datos del fundo ni R2.</p>
              <label className="mt-3 block text-[12px] font-black text-warn-ink">
                Escribe <span className="select-all font-mono">{restoreConfirmation.requiredPhrase}</span>
                <input
                  autoComplete="off"
                  className={`${inputClass} mt-1 h-10 font-mono`}
                  onChange={(event) => setConfirmationPhrase(event.target.value)}
                  spellCheck={false}
                  value={confirmationPhrase}
                />
              </label>
              <button
                className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[12px] font-black text-white disabled:opacity-45"
                disabled={restoreLoading || confirmationPhrase.trim() !== restoreConfirmation.requiredPhrase}
                onClick={() => void prepareRecovery()}
                type="button"
              >
                {restoreLoading ? <LoaderCircle className="animate-spin" size={13} /> : <LockKeyhole size={13} />}
                {restoreLoading ? "Preparando…" : "Confirmar ensayo durable"}
              </button>
            </div>
          )}
          {restorePreparation && (
            <div className="mt-3 rounded-xl border border-line-steel bg-surface-alt p-3">
              <p className="flex items-center gap-2 text-[12px] font-black text-accent"><ShieldCheck size={13} /> Ensayo durable preparado</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">La confirmación fue consumida de forma atómica. Quedaron registradas {restorePreparation.expectedRowCount} {restorePreparation.expectedRowCount === 1 ? "inserción pendiente" : "inserciones pendientes"} y {restorePreparation.originalFileCount} originales, con ejecución deshabilitada y sin escrituras sobre datos del fundo ni R2.</p>
            </div>
          )}
        </form>
        <div className="border-t border-line-steel"><div className="px-5 py-3"><h3 className="text-xs font-black text-ink">Respaldos por importación</h3><p className="mt-1 text-[12px] text-ink-subtle">El JSON conserva filas, inconsistencias y destinos; el original se entrega solo si su tamaño y SHA-256 coinciden con D1.</p></div>
          {fieldImports.length === 0 ? <EmptyState icon={FileClock} title="Sin importaciones en este fundo" text="Cuando exista una carga, aquí podrás descargar su trazabilidad y el DBF original." /> : <div className="divide-y divide-line-steel">{fieldImports.map((item) => <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center" key={item.id}><div className="min-w-0 flex-1"><p className="truncate text-xs font-black text-ink">{item.originalFilename}</p><p className="mt-1 text-[12px] text-ink-subtle">{item.sourceTable} · {formatDate(item.createdAt)}</p></div><div className="flex flex-wrap gap-2"><a className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-steel bg-white px-3 text-[12px] font-black text-ink-muted" download href={backupUrl("import", item.id, "backup")}><FileJson2 size={13} /> Trazabilidad JSON</a><a className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-steel bg-surface-alt px-3 text-[12px] font-black text-accent" download href={backupUrl("import", item.id, "original")}><Download size={13} /> Original DBF</a></div></div>)}</div>}
        </div>
      </div>
      <aside className="rounded-[22px] border border-line-steel bg-ink p-5 text-white shadow-[0_16px_45px_rgba(23,59,45,0.12)] sm:p-6">
        <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-accent text-ink"><ShieldCheck size={18} /></div><div><h2 className="text-base font-black">Cómo verificar</h2><p className="mt-1 text-[12px] text-white/55">Sin depender de FundoSmart</p></div></div>
        <ol className="mt-6 space-y-4"><GuardrailStep number="1" title="Conserva el manifiesto" text="Declara formato, alcance, fecha, conteos y exclusiones explícitas." /><GuardrailStep number="2" title="Recalcula cada hash" text="Serializa la sección en JSON canónico y compara su SHA-256 con sectionSha256." /><GuardrailStep number="3" title="Verifica el archivo completo" text="La respuesta incluye X-FundoSmart-SHA256 para comprobar el contenido descargado." /></ol>
        <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-[12px] leading-relaxed text-white/65">Cada descarga queda auditada. Los respaldos no interpretan unidades ni códigos Cooprinsem aún ambiguos: preservan el dato original y su contexto.</div>
      </aside>
    </section>
  );
}

function OriginalIntegrityPanel({ dashboard }: { dashboard: CooprinsemOriginalIntegrityDashboard }) {
  const allHealthy = dashboard.totals.checkedCount === dashboard.totals.healthyCount;
  const [deepById, setDeepById] = useState<Record<string, CooprinsemOriginalDeepVerification>>({});
  const [deepLoadingId, setDeepLoadingId] = useState<string | null>(null);
  const [deepError, setDeepError] = useState<string | null>(null);
  async function verifyBytes(importJobId: string) {
    setDeepLoadingId(importJobId);
    setDeepError(null);
    try {
      const verification = await deepVerifyOriginal(importJobId);
      setDeepById((current) => ({ ...current, [importJobId]: verification }));
    } catch (cause) {
      setDeepError(errorMessage(cause, "No fue posible recalcular la huella del original."));
    } finally {
      setDeepLoadingId(null);
    }
  }
  return (
    <div className={`mt-4 rounded-2xl border p-4 ${allHealthy ? "border-line-steel bg-surface-alt" : "border-line-steel bg-surface-alt"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[12px] font-black uppercase tracking-wide text-accent">Conservación de originales</p><h4 className="mt-1 text-sm font-black text-ink">{allHealthy ? "Inventario R2 coincide con D1" : "Revisión requerida"}</h4></div><span className="text-[12px] font-bold text-ink-subtle">{formatDate(dashboard.checkedAt)}</span></div>
      <div className="mt-3 grid grid-cols-3 gap-2"><MiniRestoreMetric label="Saludables" value={dashboard.totals.healthyCount} /><MiniRestoreMetric label="Faltantes" value={dashboard.totals.missingCount} /><MiniRestoreMetric label="Diferencias" value={dashboard.totals.mismatchCount} /></div>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-subtle">El inventario usa metadatos. La acción individual relee el DBF y recalcula su SHA-256 desde los bytes.</p>
      {deepError && <p className="mt-2 rounded-lg border border-alert-bar bg-white p-2 text-[12px] font-bold text-alert-ink">{deepError}</p>}
      {dashboard.items.length === 0 ? <p className="mt-3 text-[12px] text-ink-subtle">Este fundo todavía no tiene archivos originales registrados.</p> : (
        <div className="mt-3 divide-y divide-black/5 overflow-hidden rounded-xl border border-black/5 bg-white">
          {dashboard.items.slice(0, 20).map((item) => {
            const deep = deepById[item.importJobId];
            const loading = deepLoadingId === item.importJobId;
            return <div className="px-3 py-2.5" key={item.importJobId}><div className="flex items-start gap-3"><span className={`mt-1 size-2 shrink-0 rounded-full ${item.status === "healthy" ? "bg-accent" : "bg-alert-ink"}`} /><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-black text-ink">{item.originalFilename}</p><p className="mt-0.5 text-[12px] text-ink-subtle">{item.status === "healthy" ? "Tamaño y metadatos SHA-256/alcance coinciden con D1" : item.issues.join(" ")}</p></div><button className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-steel bg-surface-alt px-2.5 text-[12px] font-black text-accent disabled:opacity-40" disabled={deepLoadingId !== null || item.status === "missing"} onClick={() => void verifyBytes(item.importJobId)} type="button">{loading ? <LoaderCircle className="animate-spin" size={11} /> : <FileSearch size={11} />}{loading ? "Recalculando…" : "Recalcular bytes"}</button></div>{deep && <p className={`mt-2 rounded-lg px-2.5 py-2 text-[12px] font-bold ${deep.status === "healthy" ? "bg-surface-alt text-accent" : "bg-surface-alt text-alert-ink"}`}>{deep.status === "healthy" ? "Verificación profunda correcta: el SHA-256 de los bytes coincide con D1." : deep.issues.join(" ")}</p>}</div>;
          })}
        </div>
      )}
      {dashboard.truncated && <p className="mt-2 text-[12px] font-bold text-warn-ink">Se verificaron los primeros {dashboard.limit} archivos; el inventario continúa.</p>}
    </div>
  );
}

function IntegritySweepPanel({ fieldId }: { fieldId: string }) {
  const [dashboard, setDashboard] = useState<CooprinsemIntegritySweepDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchIntegritySweepDashboard(fieldId).then((next) => {
      if (active) setDashboard(next);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause, "No fue posible cargar la cobertura automática."));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [fieldId]);
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setDashboard(await fetchIntegritySweepDashboard(fieldId));
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible actualizar la cobertura automática."));
    } finally {
      setLoading(false);
    }
  }
  async function runBatch() {
    setRunning(true);
    setError(null);
    try {
      const result = await runIntegritySweepBatch(fieldId);
      setDashboard(result.sweep);
    } catch (cause) {
      setError(errorMessage(cause, "El lote se interrumpió y quedó preparado para reintento."));
      await refresh();
    } finally {
      setRunning(false);
    }
  }
  const state = dashboard?.state;
  const statusLabel = state ? ({
    pending: "Cobertura en curso",
    running: "Procesando lote",
    completed: "Inventario íntegro",
    completed_with_issues: "Alertas abiertas",
    failed: "Reintento pendiente",
  } as const)[state.status] : "Primera ronda pendiente";
  const healthy = state?.status === "completed" && dashboard?.openIncidents.length === 0;
  return <div className={`mt-4 rounded-2xl border p-4 ${healthy ? "border-line-steel bg-surface-alt" : "border-line-steel bg-surface-alt"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[12px] font-black uppercase tracking-wide text-accent">Cobertura reanudable</p><h4 className="mt-1 text-sm font-black text-ink">{statusLabel}</h4><p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink-subtle">Cada lote relee hasta 4 originales y reserva como máximo 24 MB. El progreso continúa con un latido al abrir el centro y admite un disparador Cron.</p></div><div className="flex gap-2"><button aria-label="Actualizar cobertura" className="grid size-9 place-items-center rounded-lg border border-line-steel bg-white text-ink-muted disabled:opacity-40" disabled={loading || running} onClick={() => void refresh()} type="button"><RefreshCcw className={loading ? "animate-spin" : ""} size={13} /></button><button className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-[12px] font-black text-white disabled:opacity-45" disabled={running || loading} onClick={() => void runBatch()} type="button">{running ? <LoaderCircle className="animate-spin" size={12} /> : <ShieldCheck size={12} />}{running ? "Procesando…" : "Procesar siguiente lote"}</button></div></div>{error && <p className="mt-3 rounded-lg border border-alert-bar bg-surface-alt p-2.5 text-[12px] font-bold text-alert-ink">{error}</p>}{state && <><div className="mt-3 grid grid-cols-3 gap-2"><MiniRestoreMetric label="Revisados" value={state.checkedCount} /><MiniRestoreMetric label="Íntegros" value={state.healthyCount} /><MiniRestoreMetric label="Alertas" value={dashboard?.openIncidents.length ?? 0} /></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-bold text-ink-subtle"><span>Leídos: {formatBytes(state.readBytes)}</span><span>Último lote: {state.lastBatchAt ? formatDate(state.lastBatchAt) : "pendiente"}</span><span>Próxima ronda: {formatDate(state.nextRunAt)}</span></div></>}{dashboard && dashboard.openIncidents.length > 0 && <div className="mt-3 overflow-hidden rounded-xl border border-line-steel bg-white"><div className="border-b border-line-steel px-3 py-2 text-[12px] font-black uppercase text-alert-ink">Incidentes activos</div>{dashboard.openIncidents.slice(0, 8).map((incident) => <div className="border-b border-black/5 px-3 py-2.5 last:border-0" key={incident.id}><div className="flex items-center justify-between gap-3"><p className="truncate text-[12px] font-black text-ink">{incident.originalFilename}</p><span className="shrink-0 rounded-full bg-surface-alt px-2 py-0.5 text-[12px] font-black uppercase text-alert-ink">{incident.issueType.replaceAll("_", " ")}</span></div><p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">{incident.summary}</p></div>)}</div>}{!state && !loading && !error && <p className="mt-3 text-[12px] text-ink-subtle">La primera visita iniciará el estado persistente de cobertura.</p>}</div>;
}

function RetentionPolicyPanel({ fieldId }: { fieldId: string }) {
  const [dashboard, setDashboard] = useState<CooprinsemRetentionDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchRetentionDashboard(fieldId).then((next) => {
      if (active) setDashboard(next);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause, "No fue posible simular la política de retención."));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [fieldId]);

  if (loading) return <div className="mt-4 flex min-h-24 items-center justify-center rounded-2xl border border-line-steel bg-surface-alt"><LoaderCircle className="animate-spin text-accent" size={16} /></div>;
  if (error || !dashboard) return <div className="mt-4 rounded-2xl border border-alert-bar bg-surface-alt p-4 text-[12px] font-bold text-alert-ink">{error ?? "No fue posible cargar la política de retención."}</div>;

  const blockedGates = dashboard.gates.filter((gate) => !gate.satisfied);
  return (
    <div className="mt-4 rounded-2xl border border-warn-bar bg-surface-alt p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-black uppercase tracking-wide text-warn-ink">Simulación de retención</p>
          <h4 className="mt-1 text-sm font-black text-ink">{dashboard.status === "empty" ? "Sin originales registrados" : "Conservar todos los originales"}</h4>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-warn-ink">La política v{dashboard.policy.version} no inventa un plazo: ninguna referencia es elegible hasta aprobar y demostrar todos los controles.</p>
        </div>
        <span className="rounded-full border border-warn-bar bg-white px-2.5 py-1 text-[12px] font-black uppercase text-warn-ink">Eliminación deshabilitada</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2"><MiniRestoreMetric label="Originales" value={dashboard.totals.originalCount} /><MiniRestoreMetric label="Conservar" value={dashboard.totals.retainCount} /><MiniRestoreMetric label="Eliminables" value={dashboard.totals.eligibleForDeletionCount} /></div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-bold text-warn-ink"><span>Volumen: {formatBytes(dashboard.totals.totalSizeBytes)}</span><span>Incidentes: {dashboard.totals.openIntegrityIncidentCount}</span><span>Evaluado: {formatDate(dashboard.evaluatedAt)}</span></div>
      <div className="mt-3 overflow-hidden rounded-xl border border-warn-bar bg-white">
        {dashboard.gates.map((gate) => <div className="flex items-start gap-2.5 border-b border-line-steel px-3 py-2.5 last:border-0" key={gate.code}>{gate.satisfied ? <CheckCircle2 className="mt-0.5 shrink-0 text-accent" size={12} /> : <CircleSlash2 className="mt-0.5 shrink-0 text-warn-ink" size={12} />}<div><p className="text-[12px] font-black text-ink-muted">{gate.label}</p><p className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{gate.detail}</p></div></div>)}
      </div>
      <p className="mt-2 text-[12px] font-bold text-warn-ink">{blockedGates.length} controles pendientes · sin consultas de contenido ni escrituras sobre R2.</p>
    </div>
  );
}

function RestorePlanPanel({ plan }: { plan: FundoSmartPortableRestorePlan }) {
  const tone = plan.assessment === "conflicts" ? "border-line-steel bg-surface-alt" : plan.assessment === "ready" ? "border-line-steel bg-surface-alt" : "border-line-steel bg-surface-alt";
  return <div className={`mt-4 rounded-2xl border p-4 ${tone}`}><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[12px] font-black uppercase tracking-wide text-accent">Resultado del dry-run</p><h4 className="mt-1 text-sm font-black text-ink">{{ ready: "Estructura compatible", conflicts: "Conflictos detectados", no_changes: "Sin cambios pendientes" }[plan.assessment]}</h4></div><span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-black uppercase text-ink-muted">Escritura deshabilitada</span></div><div className="mt-3 grid grid-cols-3 gap-2"><MiniRestoreMetric label="Insertables" value={plan.totals.insertableRowCount} /><MiniRestoreMetric label="Sin cambios" value={plan.totals.unchangedRowCount} /><MiniRestoreMetric label="Conflictos" value={plan.totals.conflictRowCount} /></div>{plan.blockers.length > 0 && <ul className="mt-3 space-y-1 text-[12px] font-bold text-alert-ink">{plan.blockers.map((entry) => <li className="flex gap-2" key={entry}><XCircle className="mt-0.5 shrink-0" size={11} />{entry}</li>)}</ul>}{plan.warnings.length > 0 && <ul className="mt-3 space-y-1 text-[12px] leading-relaxed text-warn-ink">{plan.warnings.map((entry) => <li className="flex gap-2" key={entry}><AlertTriangle className="mt-0.5 shrink-0" size={11} />{entry}</li>)}</ul>}</div>;
}

function MiniRestoreMetric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl bg-white px-3 py-2"><p className="text-[12px] font-black uppercase text-ink-subtle">{label}</p><p className="mt-1 text-base font-black text-ink">{value}</p></div>;
}

function UploadWorkspace(props: {
  canSubmit: boolean;
  effectiveAt: string;
  fieldId: string;
  file: File | null;
  fundos: Fundo[];
  loading: boolean;
  needsEffectiveDate: boolean;
  onEffectiveAt: (value: string) => void;
  onFieldId: (value: string) => void;
  onFile: (value: File | null) => void;
  onSourceTable: (value: CooprinsemSourceTable) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  sourceTable: CooprinsemSourceTable;
}) {
  return (
    <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
      <form className="rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_12px_38px_rgba(35,50,42,0.05)] sm:p-6" onSubmit={props.onSubmit}>
        <div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-white"><FileUp size={19} /></div><div><h2 className="text-base font-black text-ink">Preparar archivo</h2><p className="mt-1 text-xs leading-relaxed text-ink-subtle">Compatible con controles individuales y calidad de laboratorio CLDigital.</p></div></div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Fundo de destino"><select className={inputClass} onChange={(event) => props.onFieldId(event.target.value)} value={props.fieldId}>{props.fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}</select></Field>
          <Field label="Tabla de origen"><select className={inputClass} onChange={(event) => props.onSourceTable(event.target.value as CooprinsemSourceTable)} value={props.sourceTable}><option value="PreDetimp.dbf">PreDetimp.dbf · control fechado</option><option value="_Traspasos.DBF">_Traspasos.DBF · traspaso consolidado</option><option value="CalidadLeche.dbf">CalidadLeche.dbf · laboratorio</option></select></Field>
          {props.needsEffectiveDate && <Field label="Fecha efectiva del control"><input className={inputClass} onChange={(event) => props.onEffectiveAt(event.target.value)} required type="date" value={props.effectiveAt} /></Field>}
          <Field label="Archivo DBF"><label className="flex h-12 cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-alt px-3 text-xs font-bold text-ink-muted hover:border-accent"><FileSearch className="shrink-0 text-accent" size={17} /><span className="min-w-0 truncate">{props.file?.name ?? "Seleccionar archivo .DBF"}</span><input accept=".dbf" className="sr-only" onChange={(event) => props.onFile(event.target.files?.[0] ?? null)} type="file" /></label></Field>
        </div>
        <button className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white shadow-lg shadow-accent/10 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto" disabled={!props.canSubmit || props.loading} type="submit">{props.loading ? <LoaderCircle className="animate-spin" size={16} /> : <FileSearch size={16} />}{props.loading ? "Analizando y guardando…" : "Generar vista previa"}</button>
      </form>
      <aside className="rounded-[22px] border border-line-steel bg-ink p-5 text-white shadow-[0_16px_45px_rgba(23,59,45,0.12)] sm:p-6">
        <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-accent text-ink"><LockKeyhole size={18} /></div><h2 className="text-base font-black">Qué ocurre en esta etapa</h2></div>
        <ol className="mt-6 space-y-4"><GuardrailStep number="1" title="Original protegido" text="El archivo se guarda de forma privada y se identifica por SHA-256." /><GuardrailStep number="2" title="Lectura aislada" text="Se interpreta la estructura DBF sin ejecutar software heredado." /><GuardrailStep number="3" title="Decisiones trazables" text="Cada resolución registra estado, justificación, usuario y fecha." /></ol>
        <div className="mt-6 flex gap-2 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-[12px] leading-relaxed text-white/68"><Info className="mt-0.5 shrink-0 text-white" size={15} /> Esta pantalla no crea animales, controles lecheros ni eventos reproductivos.</div>
      </aside>
    </section>
  );
}

function IssuesWorkspace({ filter, issues, onFilter, onResolve, updatingId }: {
  filter: CooprinsemImportErrorStatus | "all";
  issues: CooprinsemImportIssueItem[];
  onFilter: (status: CooprinsemImportErrorStatus | "all") => void;
  onResolve: (id: string, status: CooprinsemImportErrorStatus, notes: string) => Promise<void>;
  updatingId: string | null;
}) {
  return (
    <section className="mt-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-base font-black text-ink">Bandeja de inconsistencias</h2><p className="mt-1 text-xs text-ink-subtle">Revisa, justifica o reabre decisiones sin alterar el dato original.</p></div><div className="flex flex-wrap gap-1.5">{(["open", "resolved", "ignored", "all"] as const).map((status) => <button className={`rounded-lg px-3 py-2 text-[12px] font-black uppercase tracking-wide ${filter === status ? "bg-ink text-white" : "border border-line-steel bg-white text-ink-subtle"}`} key={status} onClick={() => onFilter(status)} type="button">{{ open: "Pendientes", resolved: "Resueltas", ignored: "Ignoradas", all: "Todas" }[status]}</button>)}</div></div>
      {issues.length === 0 ? <div className="mt-4 rounded-[20px] border border-line-steel bg-white"><EmptyState icon={CheckCircle2} title="No hay inconsistencias en esta vista" text="Las nuevas observaciones aparecerán aquí con su archivo y registro de origen." /></div> : <><div className="mt-4 grid gap-3 xl:grid-cols-2">{issues.map((issue) => <IssueResolutionCard issue={issue} key={issue.id} onResolve={onResolve} updating={updatingId === issue.id} />)}</div><p className="mt-3 text-[12px] font-bold text-ink-subtle">Se muestran hasta 300 observaciones recientes; los indicadores superiores consideran el historial completo.</p></>}
    </section>
  );
}

function IssueResolutionCard({ issue, onResolve, updating }: { issue: CooprinsemImportIssueItem; onResolve: (id: string, status: CooprinsemImportErrorStatus, notes: string) => Promise<void>; updating: boolean }) {
  const [notes, setNotes] = useState(issue.resolutionNotes ?? "");
  const identity = animalIdentity(issue.rawRecord);
  return (
    <article className="rounded-[18px] border border-line-steel bg-white p-4 shadow-[0_6px_22px_rgba(35,50,42,0.04)]">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><IssueStatus status={issue.status} /><span className={`text-[12px] font-black uppercase ${issue.severity === "error" ? "text-alert-ink" : "text-warn-ink"}`}>{issue.severity === "error" ? "Error" : "Advertencia"}</span></div><h3 className="mt-2 text-xs font-black leading-relaxed text-ink">{issue.message}</h3></div>{issue.severity === "error" ? <XCircle className="shrink-0 text-alert-ink" size={18} /> : <AlertTriangle className="shrink-0 text-warn-ink" size={18} />}</div>
      <div className="mt-3 grid gap-2 rounded-xl bg-surface-alt p-3 text-[12px] text-ink-subtle sm:grid-cols-2"><p><strong className="text-ink-muted">Origen:</strong> {issue.originalFilename} · fila {issue.recordNumber || "archivo"}</p><p><strong className="text-ink-muted">Fundo:</strong> {issue.fieldName}</p><p><strong className="text-ink-muted">Referencia:</strong> {identity}</p><p className="truncate" title={sourceValue(issue.sourceValue)}><strong className="text-ink-muted">Valor:</strong> {sourceValue(issue.sourceValue)}</p></div>
      {issue.status !== "open" && issue.resolutionNotes && <p className="mt-3 rounded-lg border border-line-steel bg-surface-alt px-3 py-2 text-[12px] leading-relaxed text-ink-muted"><strong>Justificación:</strong> {issue.resolutionNotes}</p>}
      {issue.status === "open" ? <><textarea className="mt-3 min-h-20 w-full resize-y rounded-xl border border-line-steel bg-white p-3 text-xs text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/15" maxLength={500} onChange={(event) => setNotes(event.target.value)} placeholder="Añadir criterio o justificación (obligatoria para ignorar)…" value={notes} /><div className="mt-3 flex flex-wrap gap-2"><button className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-[12px] font-black text-white disabled:opacity-50" disabled={updating} onClick={() => onResolve(issue.id, "resolved", notes)} type="button">{updating ? <LoaderCircle className="animate-spin" size={13} /> : <CheckCircle2 size={13} />} Marcar resuelta</button><button className="inline-flex h-9 items-center gap-2 rounded-lg border border-warn-bar bg-surface-alt px-3 text-[12px] font-black text-warn-ink disabled:opacity-50" disabled={updating || notes.trim().length < 5} onClick={() => onResolve(issue.id, "ignored", notes)} type="button"><CircleSlash2 size={13} /> Ignorar con justificación</button></div></> : <button className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-line-steel bg-white px-3 text-[12px] font-black text-ink-muted disabled:opacity-50" disabled={updating} onClick={() => onResolve(issue.id, "open", "")} type="button">{updating ? <LoaderCircle className="animate-spin" size={13} /> : <RefreshCcw size={13} />} Reabrir observación</button>}
    </article>
  );
}

function PreviewSection({ confirming, onConfirm, onSimulate, preview, projection, simulating }: {
  confirming: boolean;
  onConfirm: () => Promise<void>;
  onSimulate: (id: string) => Promise<void>;
  preview: CooprinsemImportPreview;
  projection: CooprinsemImportProjectionPlan | null;
  simulating: boolean;
}) {
  const summary = preview.summary;
  return (
    <section className="mt-6 border-t border-line-steel pt-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Vista previa persistida</p><h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-ink">{preview.originalFilename}</h2><p className="mt-1 text-xs text-ink-subtle">{preview.fieldName} · {preview.sourceTable}{preview.reused ? " · archivo ya analizado" : ""}</p></div><p className="max-w-md truncate font-mono text-[12px] text-ink-subtle" title={preview.sha256}>SHA-256 {preview.sha256}</p></div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5"><StatCard helpText="Total de filas que trae el archivo." icon={Database} label="Filas" value={summary.rowCount} tone="dark" /><StatCard helpText="Filas que se pueden integrar tal cual, sin corregir nada." icon={CheckCircle2} label="Válidas" value={summary.validRowCount} tone="green" /><StatCard helpText="Filas que se integran, pero con algo raro que conviene mirar: un dato fuera de rango o un duplicado probable." icon={AlertTriangle} label="Advertencias" value={summary.warningRowCount} tone="amber" /><StatCard helpText="Filas que no se pueden integrar hasta corregirlas. Se quedan fuera de la importación." icon={XCircle} label="Con errores" value={summary.errorRowCount} tone="red" /><StatCard helpText="Problemas del archivo completo, no de una fila: formato inesperado, columnas faltantes o encabezado distinto." icon={FileSearch} label="Archivo" value={summary.fileIssueCount} tone="neutral" /></div>
      <ProjectionPanel confirming={confirming} onConfirm={onConfirm} onSimulate={() => onSimulate(preview.id)} plan={projection} simulating={simulating} />
      <TableExplorer
        className="mt-4"
        description="Busca y filtra únicamente las filas de la vista previa cargada para localizar animales, referencias y observaciones. Los totales superiores siguen representando el archivo completo."
        filter={{ label: "Filtrar registros por estado", allLabel: "Todos los estados", columnIndex: 2 }}
        id="cooprinsem.preview"
        maxHeight="36rem"
        searchPlaceholder="Buscar dentro de la vista previa cargada…"
        title="Registros de la vista previa"
      >
        <table className="w-full min-w-[840px] border-collapse text-left"><thead className="bg-surface-alt text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle"><tr><th className="px-4 py-3">Registro</th><th className="px-4 py-3">Animal / referencia</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Observaciones</th></tr></thead><tbody className="divide-y divide-line-steel">{preview.rows.map((row) => <PreviewRow key={row.id} row={row} />)}</tbody></table>
        {preview.summary.rowCount > preview.rows.filter((row) => row.recordNumber > 0).length && <p className="border-t border-line-steel px-4 py-3 text-[12px] font-bold text-ink-subtle">Se muestran las primeras 200 filas; los totales consideran el archivo completo.</p>}
      </TableExplorer>
    </section>
  );
}

function ProjectionPanel({ confirming, onConfirm, onSimulate, plan, simulating }: {
  confirming: boolean;
  onConfirm: () => Promise<void>;
  onSimulate: () => Promise<void>;
  plan: CooprinsemImportProjectionPlan | null;
  simulating: boolean;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  if (!plan) {
    return <section className="mt-4 rounded-[20px] border border-line-steel bg-surface-alt p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-white"><Database size={17} /></div><div><h3 className="text-sm font-black text-ink">Simular integración canónica</h3><p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-subtle">Calcula qué animales se crearían, cuáles se enlazarían y qué filas quedarían fuera. La simulación no modifica información productiva.</p></div></div><button className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-50" disabled={simulating} onClick={onSimulate} type="button">{simulating ? <LoaderCircle className="animate-spin" size={14} /> : <FileSearch size={14} />}{simulating ? "Simulando…" : "Simular integración"}</button></div></section>;
  }

  const confirmed = plan.status === "completed" || plan.status === "completed_with_errors";
  const projectableCount = plan.summary.createAnimalCount + plan.summary.linkAnimalCount;
  const milkControlCount = plan.summary.projectableMilkControlCount + plan.summary.alreadyImportedMilkControlCount;
  const milkQualityCount = plan.summary.projectableMilkQualitySampleCount + plan.summary.alreadyImportedMilkQualitySampleCount;
  const confirmableCount = projectableCount + plan.summary.projectableMilkQualitySampleCount;
  return <section className={`mt-4 overflow-hidden rounded-[20px] border ${confirmed ? "border-line-steel bg-surface-alt" : "border-line-steel bg-white"}`}>
    <div className="flex flex-col gap-4 border-b border-line-steel p-5 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><span className={`grid size-8 place-items-center rounded-xl ${confirmed ? "bg-accent text-white" : plan.ready ? "bg-ink text-white" : "bg-warn-bg text-warn-ink"}`}>{confirmed ? <CheckCircle2 size={15} /> : plan.ready ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}</span><div><h3 className="text-sm font-black text-ink">{confirmed ? "Integración confirmada" : "Resultado de simulación"}</h3><p className="mt-0.5 text-[12px] text-ink-subtle">{plan.fieldIdentifier ? `Predio Cooprinsem ${plan.fieldIdentifier.value} · vínculo ${plan.fieldIdentifier.action === "create" ? "nuevo" : "existente"}` : "Sin código de predio proyectable en esta tabla"}</p></div></div></div>{!confirmed && <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-line-steel bg-white px-3 text-[12px] font-black text-ink-muted disabled:opacity-50" disabled={simulating} onClick={onSimulate} type="button"><RefreshCcw className={simulating ? "animate-spin" : ""} size={12} /> Recalcular</button>}</div>
    <div className="grid grid-cols-2 gap-2 p-5 lg:grid-cols-8"><ProjectionMetric label="Crear" value={plan.summary.createAnimalCount} tone="green" /><ProjectionMetric label="Enlazar" value={plan.summary.linkAnimalCount} tone="blue" /><ProjectionMetric label="Controles" value={milkControlCount} tone="green" /><ProjectionMetric label="Muestras" value={milkQualityCount} tone="blue" /><ProjectionMetric label="Ya integradas" value={plan.summary.alreadyImportedCount} tone="neutral" /><ProjectionMetric label="Excluidas" value={plan.summary.excludedRowCount} tone="amber" /><ProjectionMetric label="Conflictos" value={plan.summary.conflictRowCount} tone="red" /><ProjectionMetric label="Identificadores" value={plan.summary.identifierWriteCount} tone="neutral" /></div>
    <HistoryAssessmentPanel assessment={plan.historyAssessment} />
    {plan.blockers.length > 0 && <div className="mx-5 mb-4 rounded-xl border border-line-steel bg-surface-alt p-3 text-[12px] font-bold leading-relaxed text-alert-ink">{plan.blockers.map((blocker) => <p className="flex gap-2" key={blocker}><XCircle className="mt-0.5 shrink-0" size={12} /> {blocker}</p>)}</div>}
    {plan.summary.unresolvedGroupCount > 0 && <p className="mx-5 mb-4 flex gap-2 rounded-xl border border-warn-bar bg-surface-alt p-3 text-[12px] leading-relaxed text-warn-ink"><AlertTriangle className="mt-0.5 shrink-0" size={13} />{plan.summary.unresolvedGroupCount} fila{plan.summary.unresolvedGroupCount === 1 ? "" : "s"} usarán el lote “Migración Cooprinsem · por clasificar”; el grupo original seguirá trazado para su configuración posterior.</p>}
    {plan.rows.length > 0 && <div className="mx-5 mb-4 overflow-hidden rounded-xl border border-line-steel"><div className="divide-y divide-line-steel bg-white">{plan.rows.slice(0, 8).map((row) => <div className="grid gap-2 px-3 py-2.5 text-[12px] sm:grid-cols-[64px_minmax(0,1fr)_130px]" key={row.importRowId}><span className="font-black text-ink-subtle">Fila {row.recordNumber}</span><div><p className="font-black text-ink">{row.animalTag ?? (row.milkQualitySample ? `Muestra ${row.milkQualitySample.sampledAt}` : "Sin destino")}</p><p className="mt-0.5 text-ink-subtle">{row.lotName ?? row.issues[0] ?? (row.milkQualitySample ? "Calidad de laboratorio" : "Sin lote")}</p></div><ProjectionAction action={row.action} /></div>)}</div>{(plan.rows.length > 8 || plan.rowsTruncated) && <p className="border-t border-line-steel bg-surface-alt px-3 py-2 text-[12px] font-bold text-ink-subtle">Vista resumida; los totales consideran todas las filas.</p>}</div>}
    {!confirmed && <div className="border-t border-line-steel bg-surface-alt p-5"><label className="flex cursor-pointer items-start gap-3"><input checked={acknowledged} className="mt-0.5 size-4 accent-accent" onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" /><span className="text-[12px] leading-relaxed text-ink-muted"><strong className="text-ink">Revisé la simulación.</strong> Confirmo {projectableCount} fila{projectableCount === 1 ? "" : "s"} del maestro animal, {plan.summary.projectableMilkControlCount} control{plan.summary.projectableMilkControlCount === 1 ? "" : "es"} individual{plan.summary.projectableMilkControlCount === 1 ? "" : "es"} y {plan.summary.projectableMilkQualitySampleCount} muestra{plan.summary.projectableMilkQualitySampleCount === 1 ? "" : "s"} de laboratorio. La evaluación histórica reproductiva permanece informativa.</span></label><button className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[12px] font-black text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={!plan.ready || !acknowledged || confirming} onClick={onConfirm} type="button">{confirming ? <LoaderCircle className="animate-spin" size={14} /> : <LockKeyhole size={14} />}{confirming ? "Integrando…" : confirmableCount > 0 ? `Integrar ${confirmableCount} filas seguras` : "Sin filas pendientes"}</button></div>}
  </section>;
}

function HistoryAssessmentPanel({ assessment }: { assessment: CooprinsemImportProjectionPlan["historyAssessment"] }) {
  return <section className="mx-5 mb-4 rounded-2xl border border-line-steel bg-surface-alt p-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><History className="text-accent" size={15} /><h4 className="text-xs font-black text-ink">Historia productiva detectada</h4></div><p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-subtle">Evaluación deduplicada por animal y fecha. Unidad de leche: {assessment.milkUnitContract.confirmed ? "litros confirmados" : "contrato pendiente"}. Los controles proyectables se importan; la historia reproductiva sigue en solo lectura.</p></div><span className="self-start rounded-full bg-warn-bg px-2.5 py-1 text-[12px] font-black uppercase text-warn-ink">Reproducción en lectura</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4"><ProjectionMetric label="Controles detectados" value={assessment.milkControlCandidateCount} tone="blue" /><ProjectionMetric label="Controles listos" value={assessment.milkControlReadyCount} tone="neutral" /><ProjectionMetric label="Cubiertas listas" value={assessment.reproductiveServiceReadyCount} tone="green" /><ProjectionMetric label="Cubiertas bloqueadas" value={assessment.reproductiveServiceBlockedCount} tone="amber" /></div>
    {assessment.blockers.length > 0 && <div className="mt-3 space-y-1 rounded-xl border border-warn-bar bg-surface-alt p-3 text-[12px] font-bold leading-relaxed text-warn-ink">{assessment.blockers.map((blocker) => <p className="flex gap-2" key={blocker}><AlertTriangle className="mt-0.5 shrink-0" size={11} />{blocker}</p>)}</div>}
  </section>;
}

function ProjectionMetric({ label, tone, value }: { label: string; tone: "green" | "blue" | "amber" | "red" | "neutral"; value: number }) {
  const styles = { green: "bg-surface-alt text-accent", blue: "bg-surface-alt text-accent", amber: "bg-surface-alt text-warn-ink", red: "bg-surface-alt text-alert-ink", neutral: "bg-surface-alt text-ink-muted" } as const;
  return <div className={`rounded-xl px-3 py-3 ${styles[tone]}`}><p className="text-[12px] font-black uppercase tracking-wide opacity-70">{label}</p><p className="mt-1 text-lg font-black">{value}</p></div>;
}

function ProjectionAction({ action }: { action: CooprinsemImportProjectionPlan["rows"][number]["action"] }) {
  const styles = { create_animal: "bg-surface-alt text-accent", link_animal: "bg-surface-alt text-accent", create_quality_sample: "bg-surface-alt text-accent", already_imported: "bg-surface-alt text-accent", already_imported_quality_sample: "bg-surface-alt text-accent", excluded: "bg-warn-bg text-warn-ink", conflict: "bg-surface-alt text-alert-ink" } as const;
  const labels = { create_animal: "Crear animal", link_animal: "Enlazar", create_quality_sample: "Crear muestra", already_imported: "Integrada", already_imported_quality_sample: "Muestra integrada", excluded: "Excluir", conflict: "Conflicto" } as const;
  return <span className={`self-start justify-self-start rounded-full px-2.5 py-1 text-[12px] font-black uppercase sm:justify-self-end ${styles[action]}`}>{labels[action]}</span>;
}

function PreviewRow({ row }: { row: CooprinsemImportPreviewRow }) {
  const title = row.recordNumber === 0 ? "Cabecera del archivo" : recordValue(row.rawRecord, "FECHA") ? `Muestra ${recordValue(row.rawRecord, "FECHA")}` : animalIdentity(row.rawRecord);
  const secondary = row.recordNumber === 0 ? "Validaciones generales" : [recordValue(row.rawRecord, "NUMVACA") && `Nº ${recordValue(row.rawRecord, "NUMVACA")}`, recordValue(row.rawRecord, "RP") && `RP ${recordValue(row.rawRecord, "RP")}`].filter(Boolean).join(" · ");
  return <tr className="align-top"><td className="px-4 py-3 text-xs font-black text-ink">{row.recordNumber === 0 ? "Archivo" : row.recordNumber}</td><td className="px-4 py-3"><p className="text-xs font-black text-ink">{title}</p>{secondary && <p className="mt-1 text-[12px] text-ink-subtle">{secondary}</p>}</td><td className="px-4 py-3"><RowStatus status={row.status} /></td><td className="px-4 py-3">{row.issues.length === 0 ? <span className="text-[12px] font-bold text-ink-subtle">Sin observaciones</span> : <ul className="space-y-1.5">{row.issues.slice(0, 4).map((entry, index) => <li className={`flex gap-1.5 text-[12px] font-bold leading-relaxed ${entry.severity === "error" ? "text-alert-ink" : "text-warn-ink"}`} key={`${entry.ruleCode}-${index}`}>{entry.severity === "error" ? <XCircle className="mt-0.5 shrink-0" size={12} /> : <AlertTriangle className="mt-0.5 shrink-0" size={12} />}{entry.message}{entry.status && entry.status !== "open" ? ` · ${entry.status === "resolved" ? "resuelta" : "ignorada"}` : ""}</li>)}</ul>}</td></tr>;
}

function TabButton({ active, count, icon: Icon, label, onClick }: { active: boolean; count?: number; icon: LucideIcon; label: string; onClick: () => void }) {
  return <button aria-selected={active} className={`flex h-11 items-center gap-2 border-b-2 px-3 text-[12px] font-black uppercase tracking-wide ${active ? "border-accent text-accent" : "border-transparent text-ink-subtle hover:text-ink-muted"}`} onClick={onClick} role="tab" type="button"><Icon size={14} /> {label}{count ? <span className="grid min-w-5 place-items-center rounded-full bg-warn-bg px-1.5 py-0.5 text-[12px] text-warn-ink">{count}</span> : null}</button>;
}

function StatCard({ help, helpText, icon: Icon, label, value, tone }: { help?: HelpKey; helpText?: string; icon: LucideIcon; label: string; value: number; tone: "dark" | "green" | "amber" | "red" | "neutral" }) {
  const tones = { dark: "bg-ink text-white", green: "border border-line-steel bg-white text-accent", amber: "border border-warn-bar bg-surface-alt text-warn-ink", red: "border border-line-steel bg-surface-alt text-alert-ink", neutral: "border border-line-steel bg-white text-ink-muted" } as const;
  return <div className={`rounded-2xl p-4 ${tones[tone]}`}><div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.12em] opacity-70"><Icon size={14} /> {label}<HelpTip help={help} label={label} text={helpText} tone={tone === "dark" ? "inverse" : "muted"} /></div><p className="mt-2 text-2xl font-black tracking-[-0.04em]">{value}</p></div>;
}

function QualityGate({ done, label }: { done: boolean; label: string }) {
  return <div className="flex items-center gap-3"><span className={`grid size-6 place-items-center rounded-full ${done ? "bg-accent text-ink" : "bg-white/10 text-white/35"}`}>{done ? <CheckCircle2 size={13} /> : <CircleSlash2 size={12} />}</span><span className={`text-[12px] font-bold ${done ? "text-white" : "text-white/45"}`}>{label}</span></div>;
}

function JobStatus({ status }: { status: CooprinsemImportHistoryItem["status"] }) {
  const styles = { uploaded: "bg-surface-alt text-ink-subtle", parsing: "bg-surface-alt text-accent", preview_ready: "bg-surface-alt text-accent", importing: "bg-surface-alt text-accent", completed: "bg-surface-alt text-accent", completed_with_errors: "bg-warn-bg text-warn-ink", failed: "bg-surface-alt text-alert-ink", cancelled: "bg-surface-alt text-ink-subtle" } as const;
  const labels = { uploaded: "Cargada", parsing: "Analizando", preview_ready: "Vista lista", importing: "Integrando", completed: "Completada", completed_with_errors: "Con errores", failed: "Fallida", cancelled: "Cancelada" } as const;
  return <span className={`rounded-full px-2 py-0.5 text-[12px] font-black uppercase tracking-wide ${styles[status]}`}>{labels[status]}</span>;
}

function IssueStatus({ status }: { status: CooprinsemImportErrorStatus }) {
  const styles = { open: "bg-warn-bg text-warn-ink", resolved: "bg-surface-alt text-accent", ignored: "bg-surface-alt text-ink-subtle" } as const;
  return <span className={`rounded-full px-2 py-1 text-[12px] font-black uppercase tracking-wide ${styles[status]}`}>{{ open: "Pendiente", resolved: "Resuelta", ignored: "Ignorada" }[status]}</span>;
}

function RowStatus({ status }: { status: CooprinsemImportPreviewRow["status"] }) {
  const styles = { valid: "bg-surface-alt text-accent", warning: "bg-warn-bg text-warn-ink", error: "bg-surface-alt text-alert-ink", skipped: "bg-surface-alt text-ink-subtle", pending: "bg-surface-alt text-ink-subtle", imported: "bg-surface-alt text-accent" } as const;
  const labels = { valid: "Válida", warning: "Advertencia", error: "Error", skipped: "Omitida", pending: "Pendiente", imported: "Importada" } as const;
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black uppercase tracking-wide ${styles[status]}`}>{labels[status]}</span>;
}

function GuardrailStep({ number, title, text }: { number: string; title: string; text: string }) {
  return <li className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-[12px] font-black text-white">{number}</span><div><p className="text-xs font-black">{title}</p><p className="mt-1 text-[12px] leading-relaxed text-white/55">{text}</p></div></li>;
}

function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return <div className="grid place-items-center px-6 py-12 text-center"><div className="grid size-11 place-items-center rounded-2xl bg-surface-alt text-accent"><Icon size={19} /></div><h3 className="mt-3 text-sm font-black text-ink">{title}</h3><p className="mt-1 max-w-sm text-[12px] leading-relaxed text-ink-subtle">{text}</p></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[12px] font-black uppercase tracking-[0.1em] text-ink-muted">{label}</span>{children}</label>;
}

function animalIdentity(record: ImportRecord): string {
  return recordValue(record, "NOMBRE") || recordValue(record, "RP") || recordValue(record, "NUMVACA") || recordValue(record, "CODBARRA") || "Sin identificador";
}

function recordValue(record: ImportRecord, key: string): string {
  const value = record[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function sourceValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Sin valor";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function backupUrl(scope: "field" | "import", id: string, asset: "backup" | "original"): string {
  const params = new URLSearchParams({ scope, id, asset });
  return `/api/integraciones/cooprinsem/respaldos?${params.toString()}`;
}

function formatDate(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(date).replace(/[\u00a0\u202f]/g, " ");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

const inputClass = "h-12 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15";
