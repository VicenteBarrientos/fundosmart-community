"use client";

import type { Fundo, Potrero } from "@/src/core/domain/types";
import { AppShell } from "@/src/core/layout/AppShell";
import { TableExplorer } from "@/src/ui/TableExplorer";
import Link from "next/link";
import { downloadCsv } from "@/src/core/export/csv.mjs";
import { buildImportValidationCsv } from "./domain/import-audit-csv.mjs";
import {
  AlertTriangle,
  ArrowRight,
  Beef,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  FileUp,
  FlaskConical,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { InboxSection } from "./components/InboxSection";
import { useMemo, useState, type FormEvent } from "react";
import {
  confirmImport,
  fetchImportDashboard,
  fetchImportPreview,
  mapImportColumns,
  reconcileAgronomicPaddocks,
  uploadImportPreview,
} from "./api/import-client";
import type {
  ImportCenterDashboard,
  ImportCenterHistoryItem,
  ImportCenterPreview,
  ImportColumnMapping,
  ImportConfirmationReceipt,
  ImportProfileKey,
  ImportRecord,
} from "./domain/types";

type Props = {
  fundos: Fundo[];
  initialDashboard: ImportCenterDashboard;
  initialFieldId: string;
  initialProfileKey: ImportProfileKey;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  potreros: Potrero[];
  userName: string;
};

const EMPTY_MAPPING: ImportColumnMapping = {
  externalPaddockKey: "",
  biomassKgDmHa: "",
  observedDate: null,
  areaHa: null,
  notes: null,
};

export function ImportacionesPage({
  fundos,
  initialDashboard,
  initialFieldId,
  initialProfileKey,
  isDemo,
  organizationId,
  organizationName,
  potreros,
  userName,
}: Props) {
  const [fieldId, setFieldId] = useState(initialFieldId);
  const [activeTab, setActiveTab] = useState<"import" | "inbox">("import");
  const [inboxVisited, setInboxVisited] = useState(false);
  const [profileKey, setProfileKey] = useState<ImportProfileKey>(initialProfileKey);
  const [effectiveAt, setEffectiveAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportCenterPreview | null>(null);
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [mapping, setMapping] = useState<ImportColumnMapping>(EMPTY_MAPPING);
  const [agronomicPaddocks, setAgronomicPaddocks] = useState<Record<string, string>>({});
  const [soilPaddockId, setSoilPaddockId] = useState("");
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const [confirmationReceipt, setConfirmationReceipt] = useState<ImportConfirmationReceipt | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedFundo = useMemo(
    () => fundos.find((fundo) => fundo.id === fieldId) ?? null,
    [fieldId, fundos],
  );
  const isGeneric = profileKey === "generic.pasture_measurements.table.v1";
  const isSurvet = profileKey === "survet.milk_control.xlsx.v1";
  const isSoil = profileKey === "cooprinsem.soil_report.pdf.v1";
  const isAgronomic = profileKey === "agronomic.visit_report.pdf.v1";
  const canUpload = Boolean(fieldId && file && (!isGeneric || effectiveAt));

  function showPreview(next: ImportCenterPreview) {
    setPreview(next);
    setConfirmationReceipt(null);
    if (next.document.kind === "tabular_pasture_measurements") {
      setMapping(next.mapping ?? EMPTY_MAPPING);
    }
    setAgronomicPaddocks(
      next.document.kind === "agronomic_visit_report"
        ? Object.fromEntries(next.rows.map((row) => [
          row.id,
          textRecord(row.normalizedRecord, "paddockId"),
        ]))
        : {},
    );
    setSoilPaddockId(
      next.document.kind === "cooprinsem_soil_report"
        ? next.soilLink?.paddockId ?? ""
        : "",
    );
  }

  function selectField(next: string) {
    setFieldId(next);
    if (preview && preview.fieldId !== next) {
      setPreview(null);
      setMapping(EMPTY_MAPPING);
      setAgronomicPaddocks({});
      setSoilPaddockId("");
      setConfirmationPhrase("");
      setConfirmationReceipt(null);
    }
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !canUpload) return;
    setLoading(true);
    setError(null);
    try {
      const next = await uploadImportPreview({ fieldId, profileKey, effectiveAt, file });
      showPreview(next);
      setFieldId(next.fieldId);
      setProfileKey(next.profileKey);
      setDashboard(await fetchImportDashboard());
      setConfirmationPhrase("");
      setFile(null);
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible analizar el archivo."));
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setDashboard(await fetchImportDashboard());
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible actualizar el historial."));
      throw cause;
    } finally {
      setLoading(false);
    }
  }

  async function openImport(id: string) {
    setOpeningId(id);
    setError(null);
    try {
      const next = await fetchImportPreview(id);
      showPreview(next);
      setFieldId(next.fieldId);
      setProfileKey(next.profileKey);
      setConfirmationPhrase("");
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible abrir la vista previa."));
    } finally {
      setOpeningId(null);
    }
  }

  async function saveMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      showPreview(await mapImportColumns(preview.id, mapping));
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible guardar el mapeo."));
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!preview || confirmationPhrase !== "CONFIRMAR IMPORTACIÓN") return;
    setLoading(true);
    setError(null);
    try {
      const result = await confirmImport(
        preview.id,
        confirmationPhrase,
        preview.document.kind === "cooprinsem_soil_report" ? soilPaddockId : undefined,
      );
      showPreview(result.preview);
      setConfirmationReceipt(result.confirmation);
      setDashboard(result.dashboard);
      setConfirmationPhrase("");
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible confirmar la importación."));
    } finally {
      setLoading(false);
    }
  }

  async function saveAgronomicPaddocks() {
    if (!preview || preview.document.kind !== "agronomic_visit_report") return;
    const mappings = preview.rows.map((row) => ({
      importRowId: row.id,
      paddockId: agronomicPaddocks[row.id] ?? "",
    }));
    if (mappings.some((mapping) => !mapping.paddockId)) return;
    setLoading(true);
    setError(null);
    try {
      showPreview(await reconcileAgronomicPaddocks(preview.id, mappings));
    } catch (cause) {
      setError(errorMessage(cause, "No fue posible guardar la conciliación de potreros."));
    } finally {
      setLoading(false);
    }
  }

  function selectProfile(next: ImportProfileKey) {
    setProfileKey(next);
    setFile(null);
    setPreview(null);
    setMapping(EMPTY_MAPPING);
    setAgronomicPaddocks({});
    setSoilPaddockId("");
    setConfirmationPhrase("");
    setConfirmationReceipt(null);
    setError(null);
  }

  return (
    <AppShell
      activeSection="integraciones"
      fieldName={selectedFundo?.name ?? "Importaciones"}
      isDemo={isDemo}
      onRefresh={refresh}
      organizationId={organizationId}
      organizationName={organizationName}
      userName={userName}
    >
      <main className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent">
                <span className="size-1.5 rounded-full bg-accent" />
                Entrada controlada de información
              </div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">
                Importaciones
              </h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
                Conserva el original, revisa lo interpretado y confirma recién cuando el documento esté asignado al fundo correcto.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge icon={ShieldCheck} text="Sin OCR ni cobros por documento" />
              <Badge icon={Database} text="Original + trazabilidad" />
            </div>
          </header>

          <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={FileUp} label="Archivos" value={dashboard.totals.importCount} />
            <StatCard icon={CheckCircle2} label="Confirmados" tone="green" value={dashboard.totals.confirmedCount} />
            <StatCard icon={Clock3} label="Por revisar" tone="amber" value={dashboard.totals.pendingReviewCount} />
            <StatCard icon={AlertTriangle} label="Con errores" tone="red" value={dashboard.totals.errorCount} />
          </section>

          <div className="mt-6 flex border-b border-line-steel gap-6">
            <button
              onClick={() => setActiveTab("import")}
              className={`pb-3 text-sm font-bold border-b-2 transition ${
                activeTab === "import"
                  ? "border-accent text-accent"
                  : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              Carga Manual de Archivos
            </button>
            <button
              onClick={() => { setInboxVisited(true); setActiveTab("inbox"); }}
              className={`pb-3 text-sm font-bold border-b-2 transition flex items-center gap-2 ${
                activeTab === "inbox"
                  ? "border-accent text-accent"
                  : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              <Mail size={16} />
              Bandeja de Entrada por Correo
            </button>
          </div>

          {inboxVisited && (
            <div className={activeTab === "inbox" ? "mt-6" : "hidden"}>
              <InboxSection fieldId={fieldId} isDemo={isDemo} />
            </div>
          )}
          <div className={activeTab === "inbox" ? "hidden" : undefined}>
              <section className="mt-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Perfiles disponibles</p>
                <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink">Elige el origen del archivo</h2>
              </div>
              <p className="max-w-xl text-xs leading-5 text-ink-muted">
                Cada marca usa un perfil cerrado. Si cambia el formato, falla sin escribir datos y pide revisión.
              </p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
              <ProviderLink
                description="Controles lecheros DBF y flujo existente de conciliación animal."
                fieldId={fieldId}
                icon={Database}
                title="Cooprinsem"
              />
              <ProviderButton
                active={profileKey === "cooprinsem.soil_report.pdf.v1"}
                description="Análisis básico de suelo en PDF, vinculado manualmente a un potrero."
                disabled={loading}
                icon={FlaskConical}
                onClick={() => selectProfile("cooprinsem.soil_report.pdf.v1")}
                status="Operativo"
                title="Cooprinsem · Suelo"
              />
              <ProviderButton
                active={profileKey === "agronomic.visit_report.pdf.v1"}
                description="Informe de visita con recomendaciones conciliadas manualmente por potrero."
                disabled={loading}
                icon={FileText}
                onClick={() => selectProfile("agronomic.visit_report.pdf.v1")}
                status="Operativo"
                title="Asesoría agronómica"
              />
              <ProviderButton
                active={profileKey === "watts.visit_report.pdf.v1"}
                description="Reporte de visita y plan de pastoreo en PDF con texto."
                disabled={loading}
                icon={FileText}
                onClick={() => selectProfile("watts.visit_report.pdf.v1")}
                status="Operativo"
                title="Watt's"
              />
              <ProviderButton
                active={profileKey === "survet.milk_control.xlsx.v1"}
                description="Planilla de control lechero XLSX, conciliada por DIIO antes de escribir controles."
                disabled={loading}
                icon={Beef}
                onClick={() => selectProfile("survet.milk_control.xlsx.v1")}
                status="Operativo"
                title="Survet"
              />
              <ProviderButton
                active={profileKey === "generic.pasture_measurements.table.v1"}
                description="CSV o XLSX de mediciones, con columnas elegidas por la persona."
                disabled={loading}
                icon={FileSpreadsheet}
                onClick={() => selectProfile("generic.pasture_measurements.table.v1")}
                status="Operativo"
                title="Planilla común"
              />
              <ProviderButton
                description="Se habilitará cuando exista una muestra real y validada."
                disabled
                icon={LockKeyhole}
                status="Requiere muestra"
                title="Ferosor"
              />
            </div>
          </section>

          <section className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(330px,0.85fr)]">
            <form
              className="rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_32px_rgba(35,50,42,0.05)]"
              onSubmit={submit}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Nueva carga</p>
                  <h2 className="mt-1 text-lg font-black text-ink">
                    {isGeneric
                      ? "Mediciones de pradera"
                      : isSurvet
                        ? "Control lechero Survet"
                        : isSoil
                          ? "Análisis de suelo Cooprinsem"
                          : isAgronomic
                            ? "Informe de visita agronómica"
                            : "Reporte Watt's"}
                  </h2>
                </div>
                <div className="grid size-11 place-items-center rounded-xl bg-ok-bg text-accent">
                  {isSurvet
                    ? <Beef size={20} />
                    : isGeneric
                      ? <FileSpreadsheet size={20} />
                      : isSoil
                        ? <FlaskConical size={20} />
                        : <FileText size={20} />}
                </div>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="field-label">
                  Fundo de destino
                  <select className="input-base mt-2" disabled={loading} onChange={(event) => selectField(event.target.value)} value={fieldId}>
                    {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
                  </select>
                </label>
                {isGeneric ? (
                  <label className="field-label">
                    Fecha general de medición
                    <input className="input-base mt-2" disabled={loading} onChange={(event) => setEffectiveAt(event.target.value)} required type="date" value={effectiveAt} />
                  </label>
                ) : (
                  <div className="rounded-xl border border-line-steel bg-surface-alt p-3 text-xs leading-5 text-ink-muted">
                    {isSurvet
                      ? "La fecha y el período RCS se leen desde ORDEN DIIO. Se mostrarán antes de confirmar."
                      : isSoil
                        ? "El folio, la muestra y las fechas se leen del informe. El potrero se elige después de revisar."
                        : isAgronomic
                          ? "La fecha y los manejos se leen del informe. Cada etiqueta externa se concilia después."
                        : "La fecha se obtiene del reporte. Se mostrará antes de confirmar."}
                  </div>
                )}
              </div>
              <label className="mt-4 block rounded-2xl border border-dashed border-line-strong bg-surface-alt p-5 text-center transition hover:border-accent">
                <FileUp className="mx-auto text-accent" size={25} />
                <span className="mt-2 block text-sm font-black text-ink">
                  {file?.name ?? (
                    isSurvet
                      ? "Seleccionar XLSX Survet"
                      : isGeneric
                        ? "Seleccionar CSV o XLSX"
                        : isSoil
                          ? "Seleccionar PDF de suelo Cooprinsem"
                          : isAgronomic
                            ? "Seleccionar informe agronómico PDF"
                            : "Seleccionar PDF Watt's"
                  )}
                </span>
                <span className="mt-1 block text-xs text-ink-muted">
                  {isSurvet
                    ? "Hasta 5 MB y 200 filas útiles. Debe incluir la hoja ORDEN DIIO."
                    : isGeneric
                      ? "Hasta 5 MB y 100 filas. Convierte .xls a .xlsx."
                      : isSoil
                        ? "Hasta 10 MB. Solo Análisis Básico de Suelo v1 con texto; sin OCR."
                        : isAgronomic
                          ? "Hasta 10 MB. Requiere la sección Manejos agronómicos o Plan agronómico."
                        : "Hasta 10 MB. Los PDF escaneados sin texto no se aceptan."}
                </span>
                <input
                  accept={isSurvet ? ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : isGeneric ? ".csv,.xlsx" : ".pdf,application/pdf"}
                  className="sr-only"
                  disabled={loading}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>
              <button
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-chrome px-4 text-xs font-black text-white transition hover:bg-chrome-2 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!canUpload || loading}
                type="submit"
              >
                {loading ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />}
                Analizar y previsualizar
              </button>
            </form>

            <HistoryPanel
              dashboard={dashboard}
              fieldId={fieldId}
              onOpen={openImport}
              openingId={openingId}
            />
          </section>

          {error ? (
            <div aria-live="assertive" className="mt-5 flex items-start gap-2 rounded-xl border border-alert-bar bg-alert-bg p-4 text-xs font-bold text-alert-ink" role="alert">
              <AlertTriangle className="mt-0.5 shrink-0" size={16} />
              {error}
            </div>
          ) : null}

          {preview ? (
            <PreviewWorkspace
              agronomicPaddocks={agronomicPaddocks}
              confirmationPhrase={confirmationPhrase}
              confirmationReceipt={
                confirmationReceipt?.importJobId === preview.id ? confirmationReceipt : null
              }
              loading={loading}
              mapping={mapping}
              onConfirm={confirm}
              onConfirmationPhrase={setConfirmationPhrase}
              onMapping={setMapping}
              onAgronomicPaddocks={setAgronomicPaddocks}
              onSaveAgronomicPaddocks={saveAgronomicPaddocks}
              onSaveMapping={saveMapping}
              onSoilPaddockId={setSoilPaddockId}
              potreros={potreros.filter((potrero) => potrero.fieldId === preview.fieldId)}
              preview={preview}
              soilPaddockId={soilPaddockId}
            />
          ) : null}
          </div>
        </div>
      </main>
    </AppShell>
  );
}

function HistoryPanel({
  dashboard,
  fieldId,
  onOpen,
  openingId,
}: {
  dashboard: ImportCenterDashboard;
  fieldId: string;
  onOpen(id: string): void;
  openingId: string | null;
}) {
  return (
    <aside className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_32px_rgba(35,50,42,0.05)]">
      <div className="flex items-center justify-between border-b border-line-steel p-5">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Historial reciente</p>
          <h2 className="mt-1 text-lg font-black text-ink">Archivos del espacio</h2>
        </div>
      </div>
      {dashboard.imports.length === 0 ? (
        <div className="p-8 text-center">
          <Clock3 className="mx-auto text-ink-subtle" size={25} />
          <p className="mt-3 text-sm font-black text-ink">Aún no hay importaciones</p>
          <p className="mt-1 text-xs text-ink-muted">La primera carga aparecerá aquí.</p>
        </div>
      ) : (
        <div className="max-h-[28rem] divide-y divide-line-steel overflow-y-auto">
          {dashboard.imports.map((item) => item.sourceSystem === "cooprinsem" ? (
            <Link
              className="flex items-center gap-3 p-4 transition hover:bg-surface-alt"
              href={`/app/integraciones/cooprinsem?fieldId=${encodeURIComponent(item.fieldId || fieldId)}`}
              key={item.id}
            >
              <HistoryContent item={item} />
              <ArrowRight className="shrink-0 text-ink-subtle" size={15} />
            </Link>
          ) : (
            <button
              className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-surface-alt"
              key={item.id}
              onClick={() => onOpen(item.id)}
              type="button"
            >
              <HistoryContent item={item} />
              {openingId === item.id
                ? <LoaderCircle className="animate-spin text-accent" size={15} />
                : <ArrowRight className="shrink-0 text-ink-subtle" size={15} />}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

function HistoryContent({ item }: { item: ImportCenterHistoryItem }) {
  return (
    <>
      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-alt text-accent">
        {item.sourceFormat === "pdf" ? <FileText size={17} /> : item.sourceSystem === "cooprinsem" ? <Database size={17} /> : <FileSpreadsheet size={17} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-xs font-black text-ink">{item.originalFilename}</p>
          <StatusPill status={item.status} />
        </div>
        <p className="mt-1 text-[12px] text-ink-subtle">
          {sourceLabel(item.sourceSystem)} · {item.fieldName} · {formatDate(item.createdAt)}
        </p>
      </div>
    </>
  );
}

function PreviewWorkspace({
  agronomicPaddocks,
  confirmationPhrase,
  confirmationReceipt,
  loading,
  mapping,
  onConfirm,
  onConfirmationPhrase,
  onMapping,
  onAgronomicPaddocks,
  onSaveAgronomicPaddocks,
  onSaveMapping,
  onSoilPaddockId,
  potreros,
  preview,
  soilPaddockId,
}: {
  agronomicPaddocks: Record<string, string>;
  confirmationPhrase: string;
  confirmationReceipt: ImportConfirmationReceipt | null;
  loading: boolean;
  mapping: ImportColumnMapping;
  onConfirm(): void;
  onConfirmationPhrase(value: string): void;
  onMapping(value: ImportColumnMapping): void;
  onAgronomicPaddocks(value: Record<string, string>): void;
  onSaveAgronomicPaddocks(): void;
  onSaveMapping(event: FormEvent<HTMLFormElement>): void;
  onSoilPaddockId(value: string): void;
  potreros: Potrero[];
  preview: ImportCenterPreview;
  soilPaddockId: string;
}) {
  const isConfirmed = preview.status === "completed" || preview.status === "completed_with_errors";
  const isTabular = preview.document.kind === "tabular_pasture_measurements";
  const isSoil = preview.document.kind === "cooprinsem_soil_report";
  const isAgronomic = preview.document.kind === "agronomic_visit_report";
  const agronomicReconciliationSaved = !isAgronomic || preview.rows.every((row) => {
    const savedPaddockId = textRecord(row.normalizedRecord, "paddockId");
    return row.status === "valid"
      && Boolean(savedPaddockId)
      && agronomicPaddocks[row.id] === savedPaddockId;
  });
  const canConfirm = !isConfirmed
    && preview.summary.errorRowCount === 0
    && preview.summary.fileIssueCount === 0
    && (!isTabular || Boolean(preview.mapping))
    && (!isSoil || Boolean(soilPaddockId))
    && agronomicReconciliationSaved;

  return (
    <section className="mt-7 scroll-mt-5" id="vista-previa">
      <div className="flex flex-col gap-3 rounded-[22px] border border-line-steel bg-ink p-5 text-white sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-lime-300">Vista previa auditable</p>
          <h2 className="mt-1 text-xl font-black">{preview.originalFilename}</h2>
          <p className="mt-1 text-xs text-white/60">
            {preview.fieldName} · {sourceLabel(preview.sourceSystem)} · {preview.summary.rowCount} filas
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DarkBadge text={`${preview.summary.validRowCount} válidas`} />
          <DarkBadge text={`${preview.summary.warningRowCount} avisos`} tone={preview.summary.warningRowCount > 0 ? "amber" : "neutral"} />
          <DarkBadge text={`${preview.summary.skippedRowCount} omitidas`} tone={preview.summary.skippedRowCount > 0 ? "amber" : "neutral"} />
          <DarkBadge text={`${preview.summary.errorRowCount} errores`} tone={preview.summary.errorRowCount > 0 ? "red" : "neutral"} />
          <button
            className="inline-flex min-h-8 items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3 py-1 text-xs font-bold text-white transition hover:bg-white/20"
            onClick={() => exportImportValidationCsv(preview)}
            type="button"
          >
            <Download size={13} />
            Descargar informe de validación (CSV)
          </button>
        </div>
      </div>

      {preview.document.kind === "cooprinsem_soil_report" ? (
        <SoilSummary preview={preview} />
      ) : preview.document.kind === "agronomic_visit_report" ? (
        <AgronomicSummary preview={preview} />
      ) : preview.document.kind === "watts_visit_report" ? (
        <WattsSummary preview={preview} />
      ) : preview.document.kind === "survet_milk_control" ? (
        <SurvetSummary preview={preview} />
      ) : preview.document.kind === "tabular_pasture_measurements" ? (
        <MappingWorkspace
          loading={loading}
          mapping={mapping}
          onMapping={onMapping}
          onSubmit={onSaveMapping}
          preview={preview}
        />
      ) : null}

      {isAgronomic ? (
        <AgronomicReconciliation
          loading={loading}
          onChange={onAgronomicPaddocks}
          onSave={onSaveAgronomicPaddocks}
          paddockByRow={agronomicPaddocks}
          potreros={potreros}
          preview={preview}
        />
      ) : null}

      <div className="mt-5">
        <PreviewTable preview={preview} />
      </div>

      <div className="mt-5 grid gap-4 rounded-[22px] border border-line-steel bg-white p-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.55fr)]">
        <div className="rounded-2xl bg-surface-alt p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 shrink-0 text-accent" size={20} />
            <div>
              <h3 className="text-sm font-black text-ink">Qué ocurre al confirmar</h3>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                {preview.document.kind === "survet_milk_control"
                  ? "Se crean controles lecheros solo para las vacas conciliadas por DIIO y cada control queda enlazado al libro original. Las filas sin coincidencia se mantienen omitidas; no se crean diagnósticos ni tratamientos."
                  : preview.document.kind === "cooprinsem_soil_report"
                    ? "Se guarda un análisis técnico con sus 11 resultados, el PDF original privado y el vínculo al potrero elegido. No se crean recomendaciones, dosis, fertilizaciones ni actividades."
                    : preview.document.kind === "agronomic_visit_report"
                      ? "Se guardan la visita y sus recomendaciones como evidencia vinculada a los potreros elegidos. No se crean actividades, fertilizaciones, compras, dosis ni reservas."
                    : "Se crea una visita importada y se enlaza cada fila al documento original. Las etiquetas externas quedan sin vínculo automático con los potreros internos."}
              </p>
              {isAgronomic && preview.summary.warningRowCount > 0 ? (
                <p className="mt-2 text-xs font-bold text-warn-ink">
                  Los avisos bloquean esta importación hasta que cada etiqueta externa tenga un potrero confirmado.
                </p>
              ) : preview.summary.warningRowCount > 0 ? (
                <p className="mt-2 text-xs font-bold text-warn-ink">
                  Los avisos no bloquean: indican conciliaciones posteriores, no datos inventados.
                </p>
              ) : null}
            </div>
          </div>
        </div>
        {isConfirmed ? (
          <div className="flex items-center gap-3 rounded-2xl border border-ok-ink/20 bg-ok-bg p-4 text-ok-ink">
            <CheckCircle2 size={22} />
            <div>
              <p className="text-sm font-black">Importación confirmada</p>
              <p className="mt-1 text-xs">La operación es idempotente y conserva su procedencia.</p>
            </div>
          </div>
        ) : (
          <div>
            {isSoil ? (
              <label className="field-label">
                Potrero de la muestra *
                <select
                  className="input-base mt-2"
                  disabled={loading}
                  onChange={(event) => onSoilPaddockId(event.target.value)}
                  value={soilPaddockId}
                >
                  <option value="">Seleccionar potrero</option>
                  {potreros.map((potrero) => (
                    <option key={potrero.id} value={potrero.id}>
                      {potrero.name} · {formatNumber(potrero.areaHectares)} ha
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field-label">
              Confirmación explícita
              <input
                className={isSoil ? "input-base mt-3" : "input-base mt-2"}
                onChange={(event) => onConfirmationPhrase(event.target.value)}
                placeholder="CONFIRMAR IMPORTACIÓN"
                value={confirmationPhrase}
              />
            </label>
            <button
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-45"
              disabled={!canConfirm || confirmationPhrase !== "CONFIRMAR IMPORTACIÓN" || loading}
              onClick={onConfirm}
              type="button"
            >
              {loading ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
              {preview.document.kind === "survet_milk_control"
                ? "Confirmar controles conciliados"
                : preview.document.kind === "cooprinsem_soil_report"
                  ? "Confirmar análisis de suelo"
                  : preview.document.kind === "agronomic_visit_report"
                    ? "Confirmar recomendaciones conciliadas"
                  : "Confirmar visita importada"}
            </button>
            {!canConfirm ? (
              <p className="mt-2 text-[12px] font-semibold text-alert-ink">
                {isTabular && !preview.mapping
                  ? "Guarda el mapeo de columnas primero."
                  : isSoil && !soilPaddockId
                    ? "Selecciona el potrero que corresponde a la muestra."
                    : isAgronomic
                      ? "Guarda primero la conciliación de todos los potreros."
                    : "Corrige los errores antes de confirmar."}
              </p>
            ) : null}
          </div>
        )}
      </div>
      {confirmationReceipt ? <ConfirmationReceiptPanel receipt={confirmationReceipt} /> : null}
    </section>
  );
}

function ConfirmationReceiptPanel({ receipt }: { receipt: ImportConfirmationReceipt }) {
  const totals = [
    ["Insertadas", receipt.insertedRowCount],
    ["Actualizadas", receipt.updatedRowCount],
    ["Sin cambios", receipt.unchangedRowCount],
    ["Conflictos", receipt.conflictRowCount],
    ["Rechazadas", receipt.rejectedRowCount],
  ] as const;

  return (
    <section
      aria-labelledby="import-confirmation-receipt-title"
      className="mt-5 rounded-[22px] border border-ok-ink/20 bg-ok-bg p-5 text-ok-ink"
    >
      <div
        aria-atomic="true"
        aria-live="polite"
        className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
        role="status"
      >
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em]">Recibo durable de confirmación</p>
          <h3 className="mt-1 text-base font-black" id="import-confirmation-receipt-title">
            {receipt.reused ? "Replay idempotente verificado" : "Resultado confirmado"}
          </h3>
          <p className="mt-1 text-xs leading-5">
            {formatDate(receipt.confirmedAt)} · {receipt.rowCount} filas · {receipt.receiptVersion}
          </p>
        </div>
        <span className="w-fit rounded-full border border-ok-ink/20 bg-white/60 px-3 py-1 text-[10px] font-black uppercase tracking-wide">
          {receipt.reused ? "Replay" : "Original"}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {totals.map(([label, value]) => (
          <div className="rounded-xl border border-ok-ink/15 bg-white/65 p-3" key={label}>
            <p className="text-lg font-black">{value}</p>
            <p className="mt-0.5 text-[11px] font-bold">{label}</p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs font-bold">
        Total verificado: {receipt.rowCount} = {receipt.insertedRowCount} + {receipt.updatedRowCount}
        {" + "}{receipt.unchangedRowCount} + {receipt.conflictRowCount} + {receipt.rejectedRowCount}.
      </p>
      <p className="mt-1 text-[11px] leading-5">
        Los perfiles vigentes son insert-only; actualizaciones, filas iguales y conflictos permanecen en cero
        hasta que la persistencia pueda demostrarlos.
      </p>
      <details className="mt-3 rounded-xl border border-ok-ink/15 bg-white/65 p-3">
        <summary className="cursor-pointer text-xs font-black">
          Ver resultado fila por fila ({receipt.rowOutcomes.length})
        </summary>
        <ol className="mt-3 grid max-h-64 gap-1 overflow-auto text-xs sm:grid-cols-2">
          {receipt.rowOutcomes.map((row) => (
            <li className="rounded-lg bg-white px-3 py-2" key={`${receipt.importJobId}:${row.recordNumber}`}>
              Fila {row.recordNumber}: <strong>{confirmationOutcomeLabel(row.outcome)}</strong>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function confirmationOutcomeLabel(outcome: ImportConfirmationReceipt["rowOutcomes"][number]["outcome"]) {
  if (outcome === "inserted") return "Insertada";
  if (outcome === "updated") return "Actualizada";
  if (outcome === "unchanged") return "Sin cambios";
  if (outcome === "conflict") return "Conflicto";
  return "Rechazada";
}

function SoilSummary({ preview }: { preview: ImportCenterPreview }) {
  if (preview.document.kind !== "cooprinsem_soil_report") return null;
  const report = preview.document;
  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Folio" value={report.folio} />
        <Metric label="Muestra" value={report.sampleId} />
        <Metric label="Fecha informe" value={formatDate(report.reportDate)} />
        <Metric label="Resultados" suffix="analitos" value={String(report.results.length)} />
        <Metric
          label={preview.soilLink ? "Potrero vinculado" : "Estado documental"}
          value={preview.soilLink?.paddockName ?? "Firma y QR no verificados"}
        />
      </div>
      <div className="mt-3 rounded-2xl border border-warn-bar bg-warn-bg p-4 text-xs leading-5 text-warn-ink">
        Registro técnico solamente. La firma, el sello, la acreditación y cualquier QR se revisan en el PDF original;
        FundoSmart no los valida ni genera una recomendación agronómica.
      </div>
    </>
  );
}

function AgronomicSummary({ preview }: { preview: ImportCenterPreview }) {
  if (preview.document.kind !== "agronomic_visit_report") return null;
  const report = preview.document;
  const externalPaddocks = new Set(
    report.actionGroups.flatMap((group) => group.externalPaddockKeys),
  );
  const unscopedGroups = report.actionGroups.filter((group) => group.externalPaddockKeys.length === 0).length;
  return (
    <>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Origen" value={report.sourceLabel} />
        <Metric label="Fecha de visita" value={formatDate(report.visitDate)} />
        <Metric label="Bloques agronómicos" value={String(report.actionGroups.length)} />
        <Metric label="Potreros externos" value={String(externalPaddocks.size)} />
        <Metric label="Bloques sin potrero" value={String(unscopedGroups)} />
      </div>
      <div className="mt-3 rounded-2xl border border-warn-bar bg-warn-bg p-4 text-xs leading-5 text-warn-ink">
        La superficie informada pertenece al bloque completo y no se reparte entre potreros.
        Los bloques sin etiqueta explícita quedan conservados en la visita, sin generar trabajo ni vínculos automáticos.
      </div>
    </>
  );
}

function AgronomicReconciliation({
  loading,
  onChange,
  onSave,
  paddockByRow,
  potreros,
  preview,
}: {
  loading: boolean;
  onChange(value: Record<string, string>): void;
  onSave(): void;
  paddockByRow: Record<string, string>;
  potreros: Potrero[];
  preview: ImportCenterPreview;
}) {
  if (preview.document.kind !== "agronomic_visit_report") return null;
  const isConfirmed = preview.status === "completed" || preview.status === "completed_with_errors";
  const allSelected = preview.rows.every((row) => Boolean(paddockByRow[row.id]));

  function selectPaddock(rowId: string, externalPaddockKey: string, paddockId: string) {
    const next = { ...paddockByRow };
    for (const row of preview.rows) {
      const rowExternalKey = textRecord(row.normalizedRecord, "externalPaddockKey");
      if (rowExternalKey === externalPaddockKey) {
        next[row.id] = paddockId;
      } else if (paddockId && next[row.id] === paddockId) {
        next[row.id] = "";
      }
    }
    if (!preview.rows.some((row) => row.id === rowId)) return;
    onChange(next);
  }

  return (
    <section className="mt-5 rounded-[22px] border border-line-steel bg-white p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Conciliación humana</p>
          <h3 className="mt-1 text-lg font-black text-ink">Relaciona cada etiqueta con un potrero</h3>
        </div>
        <p className="max-w-xl text-xs leading-5 text-ink-muted">
          La misma etiqueta se sincroniza entre bloques. Dos etiquetas distintas no pueden apuntar al mismo potrero.
        </p>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {preview.rows.map((row) => {
          const externalPaddockKey = textRecord(row.normalizedRecord, "externalPaddockKey");
          return (
            <article className="rounded-2xl border border-line-steel bg-surface-alt p-4" key={row.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">
                    Potrero externo {externalPaddockKey}
                  </p>
                  <p className="mt-1 text-sm font-black leading-5 text-ink">
                    {textRecord(row.normalizedRecord, "actionHeading")}
                  </p>
                </div>
                <RowStatus status={row.status} />
              </div>
              <label className="field-label mt-3 block">
                Potrero de FundoSmart *
                <select
                  className="input-base mt-2"
                  disabled={isConfirmed || loading}
                  onChange={(event) => selectPaddock(row.id, externalPaddockKey, event.target.value)}
                  value={paddockByRow[row.id] ?? ""}
                >
                  <option value="">Seleccionar potrero</option>
                  {potreros.map((potrero) => (
                    <option key={potrero.id} value={potrero.id}>
                      {potrero.name} · {formatNumber(potrero.areaHectares)} ha
                    </option>
                  ))}
                </select>
              </label>
            </article>
          );
        })}
      </div>
      {!isConfirmed ? (
        <button
          className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-chrome px-4 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!allSelected || loading}
          onClick={onSave}
          type="button"
        >
          {loading ? <LoaderCircle className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
          Guardar conciliación de potreros
        </button>
      ) : null}
    </section>
  );
}

function WattsSummary({ preview }: { preview: ImportCenterPreview }) {
  if (preview.document.kind !== "watts_visit_report") return null;
  const report = preview.document;
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Productor" value={`${report.producer.name} (${report.producer.code})`} />
      <Metric label="Fecha de visita" value={formatDate(report.visitDate)} />
      <Metric label="Vacas en ordeña" value={formatNumber(report.herd.milkingCows)} />
      <Metric label="Consumo total" suffix="kg MS/vaca/día" value={formatNumber(report.grazing.totalKgDmCowDay)} />
      <Metric label="Plan importado" suffix={`${report.plan.totalAdjustedDays} días`} value={`${formatNumber(report.plan.totalAreaHa)} ha`} />
    </div>
  );
}

function SurvetSummary({ preview }: { preview: ImportCenterPreview }) {
  if (preview.document.kind !== "survet_milk_control") return null;
  const report = preview.document;
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Predio del libro" value={report.farmName ?? "No informado"} />
      <Metric label="Fecha declarada" value={formatDate(report.controlDate)} />
      <Metric label="Período RCS" value={report.controlPeriod ?? report.currentRcsPeriodLabel} />
      <Metric label="Animales leídos" value={String(report.sourceRowCount)} />
      <Metric label="Unidades fuente" suffix="RCS se normaliza a células/ml" value="kg · miles RCS/ml" />
    </div>
  );
}

function MappingWorkspace({
  loading,
  mapping,
  onMapping,
  onSubmit,
  preview,
}: {
  loading: boolean;
  mapping: ImportColumnMapping;
  onMapping(value: ImportColumnMapping): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  preview: ImportCenterPreview;
}) {
  if (preview.document.kind !== "tabular_pasture_measurements") return null;
  const headers = preview.document.headers;
  return (
    <form className="mt-5 rounded-[22px] border border-line-steel bg-white p-5" onSubmit={onSubmit}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Mapeo guiado</p>
          <h3 className="mt-1 text-lg font-black text-ink">Indica qué significa cada columna</h3>
        </div>
        <p className="text-xs text-ink-muted">Potrero y biomasa son obligatorios. Nada se adivina por el nombre.</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MappingSelect
          headers={headers}
          label="Potrero externo *"
          onChange={(value) => onMapping({ ...mapping, externalPaddockKey: value ?? "" })}
          value={mapping.externalPaddockKey || null}
        />
        <MappingSelect
          headers={headers}
          label="Biomasa kg MS/ha *"
          onChange={(value) => onMapping({ ...mapping, biomassKgDmHa: value ?? "" })}
          value={mapping.biomassKgDmHa || null}
        />
        <MappingSelect headers={headers} label="Fecha por fila" onChange={(value) => onMapping({ ...mapping, observedDate: value })} value={mapping.observedDate} />
        <MappingSelect headers={headers} label="Superficie ha" onChange={(value) => onMapping({ ...mapping, areaHa: value })} value={mapping.areaHa} />
        <MappingSelect headers={headers} label="Notas" onChange={(value) => onMapping({ ...mapping, notes: value })} value={mapping.notes} />
      </div>
      <button
        className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-chrome px-4 text-xs font-black text-white disabled:opacity-45"
        disabled={!mapping.externalPaddockKey || !mapping.biomassKgDmHa || loading}
        type="submit"
      >
        {loading ? <LoaderCircle className="animate-spin" size={15} /> : <Sparkles size={15} />}
        Validar mapeo
      </button>
    </form>
  );
}

function MappingSelect({
  headers,
  label,
  onChange,
  value,
}: {
  headers: string[];
  label: string;
  onChange(value: string | null): void;
  value: string | null;
}) {
  return (
    <label className="field-label">
      {label}
      <select className="input-base mt-2" onChange={(event) => onChange(event.target.value || null)} value={value ?? ""}>
        <option value="">No importar</option>
        {headers.map((header) => <option key={header} value={header}>{header}</option>)}
      </select>
    </label>
  );
}

function PreviewTable({ preview }: { preview: ImportCenterPreview }) {
  const isSurvet = preview.document.kind === "survet_milk_control";
  const isSoil = preview.document.kind === "cooprinsem_soil_report";
  const isAgronomic = preview.document.kind === "agronomic_visit_report";
  const rawHeaders = preview.document.kind === "tabular_pasture_measurements" && !preview.mapping
    ? preview.document.headers.slice(0, 7)
    : null;
  const statusColumnIndex = rawHeaders ? rawHeaders.length + 1 : isSurvet || isSoil || isAgronomic ? 6 : 5;
  return (
    <TableExplorer
      defaultCompact
      description="Puedes buscar filas y revisar los valores antes de confirmar. En pantallas pequeñas, desliza horizontalmente."
      filter={{ allLabel: "Todos los estados", columnIndex: statusColumnIndex, label: "Estado" }}
      id="importaciones.preview"
      maxHeight="30rem"
      rowLabel={{ singular: "fila", plural: "filas" }}
      searchPlaceholder={
        isSurvet
          ? "Buscar DIIO, vaca, RCS o aviso…"
          : isSoil
            ? "Buscar analito, unidad, clasificación o método…"
            : isAgronomic
              ? "Buscar potrero, recomendación o manejo…"
            : "Buscar potrero, fecha o valor…"
      }
      title="Filas interpretadas"
    >
      <table className="min-w-full text-left text-xs">
        <thead>
          <tr className="text-[12px] font-black uppercase tracking-wider text-ink-muted">
            <th className="px-4 py-3">Fila</th>
            {rawHeaders ? rawHeaders.map((header) => <th className="whitespace-nowrap px-4 py-3" key={header}>{header}</th>) : isSoil ? (
              <>
                <th className="px-4 py-3">Analito</th>
                <th className="px-4 py-3">Resultado</th>
                <th className="px-4 py-3">Rango ideal</th>
                <th className="px-4 py-3">Clasificación</th>
                <th className="px-4 py-3">Método informado</th>
              </>
            ) : isAgronomic ? (
              <>
                <th className="px-4 py-3">Potrero externo</th>
                <th className="px-4 py-3">Fecha visita</th>
                <th className="px-4 py-3">Manejo informado</th>
                <th className="px-4 py-3">Recomendación</th>
                <th className="px-4 py-3">Superficie del bloque</th>
              </>
            ) : isSurvet ? (
              <>
                <th className="px-4 py-3">DIIO fuente</th>
                <th className="px-4 py-3">Vaca conciliada</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Total kg</th>
                <th className="px-4 py-3">RCS células/ml</th>
              </>
            ) : (
              <>
                <th className="px-4 py-3">Potrero externo</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Biomasa kg MS/ha</th>
                <th className="px-4 py-3">Superficie ha</th>
              </>
            )}
            <th className="px-4 py-3">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-steel">
          {preview.rows.map((row) => (
            <tr
              data-table-search={`${JSON.stringify(row.rawRecord)} ${row.issues.map((issue) => issue.message).join(" ")}`}
              key={row.id}
            >
              <td className="px-4 py-3 font-mono text-ink-subtle">{row.recordNumber}</td>
              {rawHeaders ? rawHeaders.map((header) => (
                <td className="max-w-[16rem] truncate px-4 py-3 text-ink" key={header}>{displayValue(row.rawRecord[header])}</td>
              )) : isSoil ? (
                <>
                  <td className="px-4 py-3 font-black text-ink">{displayValue(row.normalizedRecord?.analyteName)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-ink">
                    {formatNumber(numberRecord(row.normalizedRecord, "value"))} {displayValue(row.normalizedRecord?.unit)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-ink-muted">
                    {displayValue(row.normalizedRecord?.idealRangeText)}
                  </td>
                  <td className="px-4 py-3 font-bold text-ink">
                    {textRecord(row.normalizedRecord, "reportedClassification")
                      || rangeAssessmentLabel(textRecord(row.normalizedRecord, "rangeAssessment"))}
                  </td>
                  <td className="max-w-[18rem] px-4 py-3 leading-5 text-ink-muted">
                    {textRecord(row.normalizedRecord, "methodLabel") || "No individualizado en el informe"}
                  </td>
                </>
              ) : isAgronomic ? (
                <>
                  <td className="px-4 py-3 font-black text-ink">
                    {displayValue(row.normalizedRecord?.externalPaddockKey)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                    {formatDate(textRecord(row.normalizedRecord, "visitDate"))}
                  </td>
                  <td className="max-w-[18rem] px-4 py-3 font-bold leading-5 text-ink">
                    {displayValue(row.normalizedRecord?.actionHeading)}
                  </td>
                  <td className="max-w-[28rem] px-4 py-3 leading-5 text-ink-muted">
                    {displayValue(row.normalizedRecord?.recommendationText)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-ink">
                    {formatNumber(numberRecord(row.normalizedRecord, "reportedGroupAreaHa"))}
                  </td>
                </>
              ) : isSurvet ? (
                <>
                  <td className="px-4 py-3 font-mono font-black text-ink">{displayValue(row.normalizedRecord?.externalAnimalId)}</td>
                  <td className="px-4 py-3 font-black text-ink">{displayValue(row.normalizedRecord?.animalTag)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{formatDate(textRecord(row.normalizedRecord, "controlDate"))}</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">{formatNumber(numberRecord(row.normalizedRecord, "totalMilkKg"))}</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">{formatNumber(numberRecord(row.normalizedRecord, "somaticCellCount"))}</td>
                </>
              ) : (
                <>
                  <td className="px-4 py-3 font-black text-ink">{displayValue(row.normalizedRecord?.externalPaddockKey)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{formatDate(textRecord(row.normalizedRecord, "plannedEntryDate") || textRecord(row.normalizedRecord, "observedAt"))}</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">{formatNumber(numberRecord(row.normalizedRecord, "currentBiomassKgDmHa") ?? numberRecord(row.normalizedRecord, "projectedBiomassKgDmHa"))}</td>
                  <td className="px-4 py-3 text-right font-mono text-ink">{formatNumber(numberRecord(row.normalizedRecord, "areaHa"))}</td>
                </>
              )}
              <td className="min-w-48 px-4 py-3" data-table-filter-label={rowStatusLabel(row.status)}>
                <div className="flex flex-col items-start gap-1.5">
                  <RowStatus status={row.status} />
                  {row.issues.length > 0 ? (
                    <ul className="space-y-1 text-[11px] leading-4 text-ink-muted">
                      {row.issues.map((issue, index) => (
                        <li key={`${issue.ruleCode}-${issue.fieldName ?? "file"}-${index}`}>{issue.message}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableExplorer>
  );
}

function ProviderButton({
  active = false,
  description,
  disabled = false,
  icon: Icon,
  onClick,
  status,
  title,
}: {
  active?: boolean;
  description: string;
  disabled?: boolean;
  icon: LucideIcon;
  onClick?(): void;
  status: string;
  title: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={`rounded-[18px] border p-4 text-left transition ${
        active ? "border-accent bg-ok-bg shadow-sm" : "border-line-steel bg-white hover:border-line-strong"
      } disabled:cursor-not-allowed disabled:bg-surface-alt disabled:opacity-70`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`grid size-10 place-items-center rounded-xl ${active ? "bg-accent text-white" : "bg-surface-alt text-accent"}`}><Icon size={18} /></div>
        <span className={`rounded-full px-2 py-1 text-[12px] font-black ${disabled ? "bg-band text-ink-muted" : "bg-ok-bg text-ok-ink"}`}>{status}</span>
      </div>
      <h3 className="mt-3 text-sm font-black text-ink">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-ink-muted">{description}</p>
    </button>
  );
}

function ProviderLink({ description, fieldId, icon: Icon, title }: {
  description: string;
  fieldId: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <Link
      className="rounded-[18px] border border-line-steel bg-white p-4 transition hover:border-line-strong hover:shadow-sm"
      href={`/app/integraciones/cooprinsem?fieldId=${encodeURIComponent(fieldId)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-surface-alt text-accent"><Icon size={18} /></div>
        <span className="rounded-full bg-ok-bg px-2 py-1 text-[12px] font-black text-ok-ink">Operativo</span>
      </div>
      <h3 className="mt-3 text-sm font-black text-ink">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-ink-muted">{description}</p>
    </Link>
  );
}

function StatCard({ icon: Icon, label, tone = "neutral", value }: {
  icon: LucideIcon;
  label: string;
  tone?: "neutral" | "green" | "amber" | "red";
  value: number;
}) {
  const color = tone === "green" ? "text-ok-ink bg-ok-bg" : tone === "amber" ? "text-warn-ink bg-warn-bg" : tone === "red" ? "text-alert-ink bg-alert-bg" : "text-ink bg-surface-alt";
  return (
    <article className="rounded-[18px] border border-line-steel bg-white p-4">
      <div className={`grid size-9 place-items-center rounded-xl ${color}`}><Icon size={16} /></div>
      <p className="mt-3 text-2xl font-black tracking-[-0.04em] text-ink">{value}</p>
      <p className="mt-1 text-[12px] font-black uppercase tracking-wider text-ink-subtle">{label}</p>
    </article>
  );
}

function Metric({ label, suffix, value }: { label: string; suffix?: string; value: string }) {
  return (
    <article className="rounded-[18px] border border-line-steel bg-white p-4">
      <p className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-2 text-base font-black text-ink">{value}</p>
      {suffix ? <p className="mt-1 text-[12px] text-ink-muted">{suffix}</p> : null}
    </article>
  );
}

function Badge({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return <div className="inline-flex items-center gap-2 rounded-xl border border-line-steel bg-white px-3 py-2 text-xs font-black text-ink-muted"><Icon className="text-accent" size={15} />{text}</div>;
}

function DarkBadge({ text, tone = "neutral" }: { text: string; tone?: "neutral" | "amber" | "red" }) {
  const className = tone === "amber" ? "bg-amber-300/15 text-amber-200" : tone === "red" ? "bg-red-300/15 text-red-200" : "bg-white/10 text-white/75";
  return <span className={`rounded-lg px-2.5 py-1.5 text-[12px] font-black ${className}`}>{text}</span>;
}

function StatusPill({ status }: { status: ImportCenterHistoryItem["status"] }) {
  const label = status === "preview_ready" ? "Revisar" : status === "completed" || status === "completed_with_errors" ? "Confirmado" : status === "failed" ? "Falló" : "Procesando";
  const tone = status === "failed" ? "bg-alert-bg text-alert-ink" : status === "completed" || status === "completed_with_errors" ? "bg-ok-bg text-ok-ink" : "bg-warn-bg text-warn-ink";
  return <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide ${tone}`}>{label}</span>;
}

function RowStatus({ status }: { status: ImportCenterPreview["rows"][number]["status"] }) {
  const tone = status === "error"
    ? "bg-alert-bg text-alert-ink"
    : status === "warning" || status === "skipped"
      ? "bg-warn-bg text-warn-ink"
      : status === "imported"
        ? "bg-ok-bg text-ok-ink"
        : "bg-surface-alt text-ink-muted";
  return <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide ${tone}`}>{rowStatusLabel(status)}</span>;
}

function rowStatusLabel(status: ImportCenterPreview["rows"][number]["status"]) {
  return status === "error"
    ? "Error"
    : status === "warning"
      ? "Aviso"
      : status === "skipped"
        ? "Omitida"
        : status === "imported"
          ? "Importada"
          : status === "valid"
            ? "Válida"
            : "Pendiente";
}

function sourceLabel(source: string) {
  if (source === "watts") return "Watt's";
  if (source === "agronomic_advisor") return "Asesoría agronómica";
  if (source === "survet") return "Survet";
  if (source === "cooprinsem_soil") return "Cooprinsem · Suelo";
  if (source === "cooprinsem") return "Cooprinsem";
  if (source === "generic") return "Planilla común";
  return source;
}

function rangeAssessmentLabel(value: string) {
  if (value === "below") return "Bajo el rango ideal";
  if (value === "within") return "Dentro del rango ideal";
  if (value === "above") return "Sobre el rango ideal";
  return "Sin clasificación";
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function textRecord(record: ImportRecord | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function numberRecord(record: ImportRecord | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const source = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const date = new Date(source);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function exportImportValidationCsv(preview: ImportCenterPreview) {
  const report = buildImportValidationCsv(preview);
  downloadCsv(report.filename, report.headers, report.rows);
}
