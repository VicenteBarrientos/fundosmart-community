"use client";

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CloudOff,
  FileText,
  LoaderCircle,
  Map as MapIcon,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Field } from "@/src/ui/form";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import {
  buildGisImportCommitPlan,
  createGisImportMappingPlan,
  setGisImportHoleKind,
  updateGisImportMappingFeature,
  withGisImportMappingContext,
  type GisImportCommitPlan,
  type GisImportMappedFeature,
  type GisImportMappingPlan,
  type GisImportMappingRole,
} from "../import/mapping";
import type { GisImportPreview } from "../import/types";
import type { ExclusionKind, Fundo, Potrero } from "../types";
import { FIELD_LANDMARK_KIND_LABELS } from "./FieldLandmarksPanel";
import { ImportGeometryPreview } from "./import/ImportGeometryPreview";
import {
  createDefaultImportLandmarkDrafts,
  executeImportPersistencePlan,
  GIS_IMPORT_ACCEPT,
  GIS_IMPORT_MAX_FILE_MEBIBYTES,
  importCommitUiBlockers,
  importPersistenceOperations,
  parseGisBoundaryFile,
  uniqueImportMessages,
  type ImportPersistenceCallbacks,
  type ImportLandmarkDraft,
  type ImportPersistenceState,
} from "./import/import-boundaries-state";

const EXCLUSION_LABELS: Record<ExclusionKind, string> = {
  laguna: "Laguna",
  bosque: "Bosque",
  construccion: "Construcción",
  roquerio: "Roquerío",
  humedal: "Humedal",
};

type CommitReview = { blockers: readonly string[]; warnings: readonly string[] };

type ImportBoundariesDialogProps = {
  fundo: Fundo;
  paddocks: readonly Potrero[];
  canMutate: boolean;
  networkOnline: boolean;
  onClose: () => void;
  onPersistFieldBoundary: ImportPersistenceCallbacks["persistFieldBoundary"];
  onPersistLandmark: ImportPersistenceCallbacks["persistLandmark"];
  onPersistPaddock: ImportPersistenceCallbacks["persistPaddock"];
  validateCommitPlan?: (plan: GisImportCommitPlan) => CommitReview;
};

export function ImportBoundariesDialog({
  fundo,
  paddocks,
  canMutate,
  networkOnline,
  onClose,
  onPersistFieldBoundary,
  onPersistLandmark,
  onPersistPaddock,
  validateCommitPlan,
}: ImportBoundariesDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GisImportPreview | null>(null);
  const [mappingPlan, setMappingPlan] = useState<GisImportMappingPlan | null>(null);
  const [acceptedWarningFingerprint, setAcceptedWarningFingerprint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [persistence, setPersistence] = useState<ImportPersistenceState | null>(null);
  const [landmarkDrafts, setLandmarkDrafts] = useState<ImportLandmarkDraft[]>([]);

  const mappingContext = useMemo(() => ({
    currentFieldBoundary: fundo.coordinates,
    existingPaddockBoundaries: paddocks.map((paddock) => paddock.geometry ?? paddock.coordinates),
  }), [fundo.coordinates, paddocks]);

  const evaluatedPlan = useMemo(() => mappingPlan
    ? persistence ? mappingPlan : withGisImportMappingContext(mappingPlan, mappingContext)
    : null, [mappingContext, mappingPlan, persistence]);
  const resolvedLandmarkDrafts = useMemo(() => {
    const existing = new Map(landmarkDrafts.map((draft) => [draft.candidateId, draft]));
    const missing = (evaluatedPlan?.features ?? []).flatMap((feature) => {
      if (feature.kind !== "landmark" || feature.role !== "landmark_candidate" || existing.has(feature.targetId)) return [];
      return [{ candidateId: feature.targetId, kind: "otro" as const, name: feature.name.trim() || "Hito importado", notes: "" }];
    });
    return missing.length > 0 ? [...landmarkDrafts, ...missing] : landmarkDrafts;
  }, [evaluatedPlan, landmarkDrafts]);

  const commitBuild = useMemo(
    () => evaluatedPlan ? buildGisImportCommitPlan(evaluatedPlan) : null,
    [evaluatedPlan],
  );

  const commitReview = useMemo<CommitReview>(() => {
    if (!commitBuild?.ok) return { blockers: [], warnings: [] };
    return validateCommitPlan?.(commitBuild.plan) ?? { blockers: [], warnings: [] };
  }, [commitBuild, validateCommitPlan]);
  const uiBlockers = useMemo(() => commitBuild?.ok
    ? uniqueImportMessages([
        ...importCommitUiBlockers(
          commitBuild.plan,
          canMutate,
          networkOnline || Boolean(persistence?.completed.some((entry) => entry.kind === "field_boundary")),
          resolvedLandmarkDrafts,
        ),
        ...commitReview.blockers,
      ])
    : [], [canMutate, commitBuild, commitReview.blockers, networkOnline, persistence?.completed, resolvedLandmarkDrafts]);
  const allWarnings = useMemo(() => uniqueImportMessages([
    ...(commitBuild ? commitBuild.ok ? commitBuild.plan.warnings : commitBuild.warnings : []),
    ...commitReview.warnings,
  ]), [commitBuild, commitReview.warnings]);
  const warningFingerprint = allWarnings.join("\u0000");
  const warningsAccepted = allWarnings.length > 0 && acceptedWarningFingerprint === warningFingerprint;
  const editsLocked = saving || Boolean(persistence && (persistence.completed.length > 0 || persistence.failure));
  const canConfirm = Boolean(
    commitBuild?.ok
    && uiBlockers.length === 0
    && (!allWarnings.length || warningsAccepted)
    && !saving
    && !persistence?.complete,
  );

  async function readFile(file: File) {
    if (editsLocked) return;
    setParsing(true);
    setParseError(null);
    setPreview(null);
    setMappingPlan(null);
    setPersistence(null);
    setAcceptedWarningFingerprint(null);
    try {
      if (file.size > GIS_IMPORT_MAX_FILE_MEBIBYTES * 1024 * 1024) {
        throw new Error(`El archivo supera el límite de ${GIS_IMPORT_MAX_FILE_MEBIBYTES} MiB.`);
      }
      const nextPreview = await parseGisBoundaryFile(file, fundo.id);
      const nextPlan = createGisImportMappingPlan(nextPreview, mappingContext);
      setPreview(nextPreview);
      setMappingPlan(nextPlan);
      const nextBuild = buildGisImportCommitPlan(nextPlan);
      setLandmarkDrafts(nextBuild.ok ? createDefaultImportLandmarkDrafts(nextBuild.plan) : []);
    } catch (cause) {
      setParseError(cause instanceof Error ? cause.message : "No fue posible interpretar el archivo.");
    } finally {
      setParsing(false);
    }
  }

  function updateFeature(planFeatureId: string, patch: Parameters<typeof updateGisImportMappingFeature>[2]) {
    if (editsLocked) return;
    setMappingPlan((current) => current ? updateGisImportMappingFeature(current, planFeatureId, patch) : current);
    setAcceptedWarningFingerprint(null);
  }

  function updateHole(planFeatureId: string, holeIndex: number, kind: ExclusionKind | null) {
    if (editsLocked) return;
    setMappingPlan((current) => current ? setGisImportHoleKind(current, planFeatureId, holeIndex, kind) : current);
    setAcceptedWarningFingerprint(null);
  }

  async function confirmImport() {
    if (!mappingPlan) return;
    const latestPlan = persistence ? mappingPlan : withGisImportMappingContext(mappingPlan, mappingContext);
    const latestBuild = buildGisImportCommitPlan(latestPlan);
    if (!latestBuild.ok) {
      setParseError("El plan cambió y volvió a tener bloqueos. Revísalos antes de confirmar.");
      return;
    }
    const latestReview = validateCommitPlan?.(latestBuild.plan) ?? { blockers: [], warnings: [] };
    const latestUiBlockers = uniqueImportMessages([
      ...importCommitUiBlockers(
        latestBuild.plan,
        canMutate,
        networkOnline || Boolean(persistence?.completed.some((entry) => entry.kind === "field_boundary")),
        resolvedLandmarkDrafts,
      ),
      ...latestReview.blockers,
    ]);
    const latestWarnings = uniqueImportMessages([...latestBuild.plan.warnings, ...latestReview.warnings]);
    if (latestUiBlockers.length > 0 || (latestWarnings.length > 0 && !warningsAccepted)) return;

    const priorCompleted = persistence?.completed ?? [];
    setMappingPlan(latestPlan);
    setSaving(true);
    setParseError(null);
    setPersistence({
      total: importPersistenceOperations(latestBuild.plan, resolvedLandmarkDrafts).length,
      completed: priorCompleted,
      failure: null,
      complete: false,
    });
    try {
      await executeImportPersistencePlan(
        latestBuild.plan,
        { persistFieldBoundary: onPersistFieldBoundary, persistPaddock: onPersistPaddock, persistLandmark: onPersistLandmark },
        priorCompleted,
        setPersistence,
        resolvedLandmarkDrafts,
      );
    } finally {
      setSaving(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  const closeEnabled = !saving;
  useDialogA11y(dialogRef, onClose, closeEnabled);

  return (
    <div
      className="fixed inset-0 z-[2400] grid place-items-center bg-chrome/70 p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={(event) => { if (event.target === event.currentTarget && closeEnabled) onClose(); }}
      role="presentation"
    >
      <section
        aria-describedby="gis-import-description"
        aria-labelledby="gis-import-title"
        aria-modal="true"
        className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-[26px] bg-white text-ink shadow-2xl outline-none focus-visible:ring-3 focus-visible:ring-accent"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line-steel px-5 py-4 sm:px-6 sm:py-5">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-band text-accent"><Upload size={20} /></span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">GeoJSON · KML · KMZ · SHP</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em]" id="gis-import-title">Importar mapa</h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted" id="gis-import-description">
                Todo se interpreta en este navegador. Revisa cada geometría, asigna su rol y confirma el plan antes de guardar en {fundo.name}.
              </p>
            </div>
          </div>
          <button aria-label="Cerrar importación" className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-alt text-ink-muted disabled:opacity-40" disabled={!closeEnabled} onClick={onClose} type="button"><X size={18} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {!mappingPlan && (
            <div
              className={`grid min-h-56 place-items-center rounded-[22px] border-2 border-dashed p-6 text-center transition ${dragActive ? "border-accent bg-surface-alt" : "border-line-steel bg-surface-alt"}`}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <div>
                {parsing ? <LoaderCircle className="mx-auto animate-spin text-accent" size={34} /> : <FileText className="mx-auto text-accent" size={34} />}
                <p className="mt-4 text-sm font-black">{parsing ? "Interpretando geometrías…" : "Arrastra aquí tu archivo de límites"}</p>
                <p className="mx-auto mt-2 max-w-lg text-xs leading-5 text-ink-muted">
                  GeoJSON/JSON, KML, KMZ o Shapefile empaquetado en ZIP. Máximo {GIS_IMPORT_MAX_FILE_MEBIBYTES} MiB; hasta 500 features y 100.000 vértices de origen.
                </p>
                <input
                  accept={GIS_IMPORT_ACCEPT}
                  className="sr-only"
                  disabled={parsing}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                    event.target.value = "";
                  }}
                  ref={inputRef}
                  type="file"
                />
                <button className="mt-5 min-h-11 rounded-xl bg-ink px-5 text-xs font-black text-white disabled:opacity-45" disabled={parsing} onClick={() => inputRef.current?.click()} type="button">
                  Seleccionar archivo
                </button>
              </div>
            </div>
          )}

          {parseError && <Message tone="error" role="alert">{parseError}</Message>}

          {evaluatedPlan && preview && (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 rounded-2xl border border-line-steel bg-surface-alt p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black">{preview.fileName}</p>
                  <p className="mt-1 text-[12px] font-semibold text-ink-subtle">
                    {formatBytes(preview.compressedBytes)} · {formatName(preview.format)} · {preview.sourceFeatureCount} de origen · {preview.previewFeatureCount} geometrías normalizadas
                  </p>
                </div>
                <button className="min-h-10 rounded-xl border border-line-steel bg-white px-4 text-[12px] font-black text-ink-muted disabled:opacity-40" disabled={editsLocked} onClick={() => { setPreview(null); setMappingPlan(null); setPersistence(null); setLandmarkDrafts([]); setParseError(null); }} type="button">
                  Elegir otro archivo
                </button>
              </div>

              {!canMutate && (
                <Message tone="info" role="status">
                  <CloudOff className="mt-0.5 shrink-0" size={16} /> Estás en modo demo o visor. Puedes cargar, editar y revisar toda la previsualización, pero nunca se ejecutará una mutación.
                </Message>
              )}

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h3 className="text-xs font-black uppercase tracking-[0.12em] text-ink-muted">Vista previa visual</h3>
                    <span className="text-[12px] font-bold text-ink-subtle">No modifica el mapa principal</span>
                  </div>
                  <ImportGeometryPreview plan={evaluatedPlan} />
                  <div className="mt-2 flex flex-wrap gap-3 text-[12px] font-black text-ink-muted">
                    <Legend color="#173b2d" label="Límite" />
                    <Legend color="#78a933" label="Potrero" />
                    <Legend color="#d97706" label="Candidato de infraestructura" />
                    <Legend color="#a7afa9" label="Ignorado" />
                  </div>
                </div>
                <PlanSummary plan={evaluatedPlan} />
              </div>

              <div>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-black">Features y geometrías</h3>
                    <p className="mt-1 text-[12px] font-semibold text-ink-subtle">Se muestran las {evaluatedPlan.features.length}; ninguna geometría se descarta silenciosamente.</p>
                  </div>
                  <span className="rounded-full bg-surface-alt px-3 py-1 text-[12px] font-black text-ink-muted">Revisión {evaluatedPlan.revision}</span>
                </div>
                <div className="space-y-3">
                  {evaluatedPlan.features.map((feature, index) => (
                    <FeatureEditor
                      disabled={editsLocked}
                      feature={feature}
                      index={index}
                      key={feature.planFeatureId}
                      landmarkDraft={feature.kind === "landmark" ? resolvedLandmarkDrafts.find(({ candidateId }) => candidateId === feature.targetId) : undefined}
                      onHoleChange={updateHole}
                      onLandmarkDraftChange={(draft) => setLandmarkDrafts((current) => current.some((item) => item.candidateId === draft.candidateId)
                        ? current.map((item) => item.candidateId === draft.candidateId ? draft : item)
                        : [...current, draft])}
                      onPatch={updateFeature}
                    />
                  ))}
                </div>
              </div>

              {evaluatedPlan.globalBlockers.length > 0 && (
                <Message tone="error" role="alert">
                  <div><p className="font-black">El plan aún está bloqueado</p><MessageList values={evaluatedPlan.globalBlockers} /></div>
                </Message>
              )}
              {uiBlockers.length > 0 && (
                <Message tone="error" role="alert">
                  <div><p className="font-black">La aplicación del plan no está disponible</p><MessageList values={uiBlockers} /></div>
                </Message>
              )}
              {allWarnings.length > 0 && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950">
                  <p className="flex items-center gap-2 font-black"><AlertTriangle size={16} /> Advertencias que requieren confirmación</p>
                  <MessageList values={allWarnings} />
                  <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-amber-300 bg-white/70 p-3 font-black">
                    <input checked={warningsAccepted} className="mt-0.5 size-4 accent-accent" disabled={editsLocked} onChange={(event) => setAcceptedWarningFingerprint(event.target.checked ? warningFingerprint : null)} type="checkbox" />
                    Revisé estas advertencias y autorizo continuar con este plan exacto.
                  </label>
                </div>
              )}

              {persistence && <PersistenceReport state={persistence} />}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-line-steel bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p aria-live="polite" className="text-[12px] font-bold text-ink-subtle">
            {saving
              ? `Persistiendo ${persistence?.completed.length ?? 0} de ${persistence?.total ?? 0}…`
              : persistence?.complete
                ? "Todas las persistencias terminaron."
                : persistence?.failure
                  ? "La importación quedó parcial; reintenta la operación fallida."
                  : "Los candidatos punto/línea quedarán pendientes para la futura capa de infraestructura."}
          </p>
          <div className="flex justify-end gap-3">
            <button className="min-h-11 rounded-xl border border-line-steel px-5 text-xs font-black text-ink-muted disabled:opacity-40" disabled={!closeEnabled} onClick={onClose} type="button">
              {persistence?.complete ? "Cerrar" : "Cancelar"}
            </button>
            {mappingPlan && !persistence?.complete && (
              <button className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40" disabled={!canConfirm} onClick={() => { void confirmImport(); }} type="button">
                {saving
                  ? <><LoaderCircle className="animate-spin" size={16} /> Aplicando plan</>
                  : persistence?.failure
                    ? <><Upload size={16} /> Reintentar pendiente</>
                    : <><Check size={16} /> Confirmar importación</>}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function FeatureEditor({
  feature,
  index,
  disabled,
  onPatch,
  onHoleChange,
  landmarkDraft,
  onLandmarkDraftChange,
}: {
  feature: GisImportMappedFeature;
  index: number;
  disabled: boolean;
  onPatch: (planFeatureId: string, patch: Parameters<typeof updateGisImportMappingFeature>[2]) => void;
  onHoleChange: (planFeatureId: string, holeIndex: number, kind: ExclusionKind | null) => void;
  landmarkDraft?: ImportLandmarkDraft;
  onLandmarkDraftChange: (draft: ImportLandmarkDraft) => void;
}) {
  const geometryLabel = feature.kind === "polygon"
    ? `Polígono · ${(feature.areaSquareMeters / 10_000).toLocaleString("es-CL", { maximumFractionDigits: 3 })} ha · ${feature.geometry.holes.length} huecos`
    : feature.kind === "landmark"
      ? feature.geometry.type === "Point" ? "Punto" : `Línea · ${feature.geometry.coordinates.length} vértices`
      : "Geometría no soportada";
  const roleOptions: [GisImportMappingRole, string][] = feature.kind === "polygon"
    ? [["field_boundary", "Límite del fundo"], ["paddock", "Potrero"], ["ignore", "Ignorar"]]
    : feature.kind === "landmark"
      ? [["landmark_candidate", "Candidato de infraestructura"], ["ignore", "Ignorar"]]
      : [["ignore", "Ignorar"]];

  return (
    <article className={`rounded-2xl border p-4 ${feature.blockers.length > 0 ? "border-red-200 bg-red-50/40" : feature.warnings.length > 0 ? "border-amber-200 bg-amber-50/30" : "border-line-steel bg-white"}`}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-surface-alt text-[12px] font-black text-accent">{index + 1}</span>
            <p className="truncate text-xs font-black">{feature.name || "Sin nombre"}</p>
            <span className={`rounded-full px-2 py-1 text-[12px] font-black uppercase tracking-wide ${feature.confirmable ? "bg-band text-accent" : "bg-red-100 text-red-800"}`}>{feature.confirmable ? "Confirmable" : "Con bloqueos"}</span>
          </div>
          <p className="mt-2 text-[12px] font-semibold text-ink-subtle">{geometryLabel} · Tipo detectado: {categoryLabel(feature.sourceCategory)}</p>
          <p className="mt-1 break-all font-mono text-[12px] text-ink-subtle">ID destino: {feature.targetId}</p>
        </div>
        <label className="block min-w-52">
          <span className="mb-1 block text-[12px] font-black uppercase tracking-wide text-ink-muted">Rol</span>
          <select aria-label={`Rol de ${feature.name || `feature ${index + 1}`}`} className="input-base" disabled={disabled || feature.kind === "unsupported"} onChange={(event) => onPatch(feature.planFeatureId, { role: event.target.value as GisImportMappingRole })} value={feature.role}>
            {roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      {feature.kind !== "unsupported" && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Nombre">
            <input aria-label={`Nombre de feature ${index + 1}`} className="input-base" disabled={disabled} maxLength={120} onChange={(event) => onPatch(feature.planFeatureId, { name: event.target.value })} value={feature.name} />
          </Field>
          <Field label="Sector">
            <input aria-label={`Sector de feature ${index + 1}`} className="input-base" disabled={disabled} maxLength={120} onChange={(event) => onPatch(feature.planFeatureId, { sector: event.target.value })} value={feature.sector} />
          </Field>
        </div>
      )}

      {feature.kind === "polygon" && feature.geometry.holes.length > 0 && (
        <fieldset className="mt-3 rounded-xl border border-line-steel bg-surface-alt p-3">
          <legend className="px-1 text-[12px] font-black uppercase tracking-wide text-ink-muted">Tipo de exclusión por hueco</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {feature.geometry.holes.map((hole, holeIndex) => (
              <label className="block" key={holeIndex}>
                <span className="mb-1 block text-[12px] font-bold text-ink-subtle">Hueco {holeIndex + 1} · {hole.length} vértices</span>
                <select aria-label={`Tipo del hueco ${holeIndex + 1} de ${feature.name}`} className="input-base" disabled={disabled} onChange={(event) => onHoleChange(feature.planFeatureId, holeIndex, event.target.value ? event.target.value as ExclusionKind : null)} value={feature.holeKinds[holeIndex] ?? ""}>
                  <option value="">Seleccionar…</option>
                  {(Object.entries(EXCLUSION_LABELS) as [ExclusionKind, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {feature.kind === "landmark" && feature.role === "landmark_candidate" && (
        <fieldset className="mt-3 rounded-xl border border-orange-200 bg-orange-50 p-3">
          <legend className="px-1 text-[12px] font-black uppercase tracking-wide text-orange-900">Hito que se persistirá</legend>
          <div className="mt-1 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Tipo explícito">
              <select aria-label={`Tipo de hito ${feature.name}`} className="input-base" disabled={disabled || !landmarkDraft} onChange={(event) => { if (landmarkDraft) onLandmarkDraftChange({ ...landmarkDraft, kind: event.target.value as ImportLandmarkDraft["kind"] }); }} value={landmarkDraft?.kind ?? "otro"}>
                {(Object.entries(FIELD_LANDMARK_KIND_LABELS) as [ImportLandmarkDraft["kind"], string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Nombre del hito">
              <input aria-label={`Nombre de hito ${feature.name}`} className="input-base" disabled={disabled || !landmarkDraft} maxLength={160} onChange={(event) => { if (landmarkDraft) onLandmarkDraftChange({ ...landmarkDraft, name: event.target.value }); }} value={landmarkDraft?.name ?? ""} />
            </Field>
            <Field label="Notas">
              <input aria-label={`Notas de hito ${feature.name}`} className="input-base" disabled={disabled || !landmarkDraft} maxLength={2000} onChange={(event) => { if (landmarkDraft) onLandmarkDraftChange({ ...landmarkDraft, notes: event.target.value }); }} placeholder="Opcional" value={landmarkDraft?.notes ?? ""} />
            </Field>
          </div>
          <p className="mt-2 text-[12px] font-bold text-orange-900">El valor inicial visible es «Otro»; nunca se infiere el tipo desde el nombre o las propiedades.</p>
        </fieldset>
      )}

      <FeatureMessages feature={feature} />
    </article>
  );
}

function FeatureMessages({ feature }: { feature: GisImportMappedFeature }) {
  if (feature.errors.length + feature.warnings.length + feature.blockers.length === 0) return null;
  return (
    <div className="mt-3 grid gap-2 lg:grid-cols-3">
      <CompactMessages label="Errores" tone="error" values={feature.errors} />
      <CompactMessages label="Advertencias" tone="warning" values={feature.warnings} />
      <CompactMessages label="Bloqueos" tone="blocker" values={feature.blockers} />
    </div>
  );
}

function CompactMessages({ label, values, tone }: { label: string; values: readonly string[]; tone: "error" | "warning" | "blocker" }) {
  if (values.length === 0) return null;
  const className = tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800";
  return <div className={`rounded-xl border p-3 text-[12px] font-semibold leading-4 ${className}`}><p className="font-black">{label}</p><MessageList values={values} /></div>;
}

function PlanSummary({ plan }: { plan: GisImportMappingPlan }) {
  const items = [
    ["Features", plan.summary.totalFeatures],
    ["Límites", plan.summary.fieldBoundaries],
    ["Potreros", plan.summary.paddocks],
    ["Candidatos", plan.summary.landmarkCandidates],
    ["Ignorados", plan.summary.ignored],
    ["Huecos sin tipo", plan.summary.unclassifiedHoles],
  ];
  return (
    <aside className="rounded-2xl border border-line-steel bg-ink p-4 text-white">
      <div className="flex items-center gap-2"><MapIcon size={16} className="text-white" /><h3 className="text-xs font-black">Resumen del plan</h3></div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {items.map(([label, value]) => <div className="rounded-xl bg-white/8 p-3" key={label}><p className="text-lg font-black">{value}</p><p className="mt-0.5 text-[12px] font-bold text-white/55">{label}</p></div>)}
      </div>
      <p className="mt-3 text-[12px] font-semibold leading-4 text-white/65">
        Límite efectivo: {plan.effectiveBoundarySource === "imported" ? "importado" : plan.effectiveBoundarySource === "current" ? "actual del fundo" : "no definido"}.
      </p>
    </aside>
  );
}

function PersistenceReport({ state }: { state: ImportPersistenceState }) {
  const queued = state.completed.filter((entry) => entry.disposition === "queued").length;
  return (
    <div aria-live="polite" className={`rounded-2xl border p-4 ${state.complete ? "border-emerald-200 bg-emerald-50 text-emerald-950" : state.failure ? "border-red-200 bg-red-50 text-red-900" : "border-line-steel bg-surface-alt text-ink"}`}>
      <p className="flex items-center gap-2 text-xs font-black">
        {state.complete ? <Check size={16} /> : state.failure ? <CircleAlert size={16} /> : <LoaderCircle className="animate-spin" size={16} />}
        {state.complete ? "Importación terminada" : state.failure ? "Importación parcial" : "Persistiendo el plan"}
      </p>
      <p className="mt-1 text-[12px] font-semibold leading-4">{state.completed.length} de {state.total} persistencias completadas{queued > 0 ? `; ${queued} en cola offline` : ""}.</p>
      {state.completed.length > 0 && <MessageList values={state.completed.map((entry) => `${entry.label}: ${entry.disposition === "queued" ? "en cola offline" : "aplicado"}`)} />}
      {state.failure && <p className="mt-2 rounded-lg bg-white/60 p-2 text-[12px] font-bold">Falló {state.failure.label}: {state.failure.message}</p>}
      {state.completed.some(({ kind }) => kind === "landmark") && <p className="mt-2 text-[12px] font-bold">Los hitos punto/línea confirmados conservaron su geometría y operación idempotente.</p>}
    </div>
  );
}

function Message({ tone, role, children }: { tone: "error" | "info"; role: "alert" | "status"; children: React.ReactNode }) {
  const className = tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-sky-200 bg-sky-50 text-sky-900";
  return <div className={`mt-4 flex items-start gap-2 rounded-2xl border p-4 text-xs font-semibold leading-5 ${className}`} role={role}>{tone === "error" && <CircleAlert className="mt-0.5 shrink-0" size={16} />}{children}</div>;
}

function MessageList({ values }: { values: readonly string[] }) {
  return <ul className="mt-1 space-y-1 text-[12px] font-semibold leading-4">{values.map((value) => <li key={value}>• {value}</li>)}</ul>;
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ backgroundColor: color }} />{label}</span>;
}

function categoryLabel(category: GisImportMappedFeature["sourceCategory"]) {
  if (category === "paddock") return "polígono";
  if (category === "infrastructure_candidate") return "infraestructura candidata";
  return "no soportado";
}

function formatName(format: GisImportPreview["format"]) {
  return format === "shapefile" ? "SHP/ZIP" : format.toUpperCase();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("es-CL", { maximumFractionDigits: 1 })} KiB`;
  return `${(bytes / 1024 / 1024).toLocaleString("es-CL", { maximumFractionDigits: 1 })} MiB`;
}
