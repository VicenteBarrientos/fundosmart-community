"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import type { OrganizationPlanUsage } from "@/src/modules/access/domain/types";
import { HelpTip } from "@/src/ui/Hint";
import { HELP, type HelpKey } from "@/src/ui/help-copy";
import { Beef, CalendarDays, CircleAlert, Cloud, CloudOff, Map as MapIcon, Plus, RefreshCw, Sprout, TrendingUp, type LucideIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyActivityOutboxOperation, fetchActivities, fetchActivitiesWithLineage, persistActivity, removeActivity } from "./api/activities-client";
import { fetchFundos, persistFundo } from "./api/fundos-client";
import {
  fetchFieldLandmarks,
  saveFieldLandmark,
} from "./api/field-landmarks-client";
import { fetchPaddockNdvi, refreshPaddockNdvi } from "./api/paddock-ndvi-client";
import {
  closeActivePaddockCells,
  confirmPaddockCellGeneration,
  fetchFieldActivePaddockCells,
  fetchPaddockCellPreview,
  fetchPaddockCells,
  PaddockCellApiError,
} from "./api/paddock-cells-client";
import {
  confirmPaddockOperation,
  fetchPaddockOperationPreview as fetchServerPaddockOperationPreview,
  PaddockOperationApiError,
} from "./api/paddock-operations-client";
import {
  fetchArchivedPotreros as fetchArchivedPaddocks,
  fetchPotreros,
  applyPotreroOutboxOperation,
  persistLinkedFieldBoundary,
  persistPotrero,
  persistPotreroBoundaries,
  removePotrero,
} from "./api/potreros-client";
import { fetchFieldStockingLoad } from "./api/stocking-load-client";
import { fetchPaddockRotation, PaddockRotationApiError, savePaddockRotationSettings } from "./api/paddock-rotation-client";
import {
  fetchScopedSubdivisionDraft as fetchServerScopedSubdivisionDraft,
  persistScopedSubdivisionDraft as persistServerScopedSubdivisionDraft,
  removeScopedSubdivisionDraft as removeServerScopedSubdivisionDraft,
  SubdivisionDraftApiError,
} from "./api/subdivision-drafts-client";
import { BulkSubdivisionDialog, type LotMovePreview } from "./components/BulkSubdivisionDialog";
import { ExclusionPreviewDialog, ExclusionSetupDialog } from "./components/ExclusionDialogs";
import {
  FieldLandmarksPanel,
  type FieldLandmarkEditorDraft,
  type FieldLandmarkLoadState,
} from "./components/FieldLandmarksPanel";
import { CreateFundoDialog, type NewFundoDetails } from "./components/CreateFundoDialog";
import { FundoSelector } from "./components/FundoSelector";
import { HistorialPotrero, type UndoPreview } from "./components/HistorialPotrero";
import { ImportBoundariesDialog } from "./components/ImportBoundariesDialog";
import { ListaPotreros } from "./components/ListaPotreros";
import { ManageActivityDialog } from "./components/ManageActivityDialog";
import { ManageFundoDialog } from "./components/ManageFundoDialog";
import { ManagePotreroDialog } from "./components/ManagePotreroDialog";
import { PaddockCellsDialog } from "./components/PaddockCellsDialog";
import { PaddockNdviPanel, type PaddockNdviLoadState } from "./components/PaddockNdviPanel";
import { RotationOverviewPanel, type RotationLoadState } from "./components/RotationOverviewPanel";
import type { ExclusionDrawMode, SubdivisionScope } from "./components/MapaPotreros";
import type {
  FieldActivePaddockCellListing,
  PaddockCellGenerationPlanRequest,
  PaddockCellGenerationPreview,
  PaddockCellListing,
  PaddockRotationSettingsUpdateRequest,
  PaddockRotationSnapshot,
} from "./domain/cells-rotation";
import type { GisCanonicalImportPolygon, GisImportCommitPlan } from "./import/mapping";
import type {
  FieldLandmark,
  FieldLandmarkKind,
  FieldLandmarkListing,
  FieldLandmarkOperationResult,
  FieldLandmarkUpsertRequest,
} from "./domain/field-landmarks";
import {
  PADDOCK_NDVI_REFRESH_MAX_PADDOCKS,
  type PaddockNdviListing,
} from "./domain/paddock-ndvi";
import {
  createOfflineOutbox,
  OfflineNetworkError,
  offlineOutboxStorageKey,
  type OfflineOutboxOperation,
} from "./sync/offline-outbox";
import {
  createGeographicMutationId,
  GeographicSyncConflictError,
  queueFieldLandmarkArchive,
  queueFieldLandmarkUpsert,
  queuePaddockGeometrySync,
  readGeographicOfflineSnapshot,
  seedGeographicOfflineSnapshot,
  synchronizeGeographicOfflineSnapshot,
} from "./sync/geographic-offline";
import {
  type Activity,
  type ActivityInput,
  type ActivityWithLineage,
  type Coordinate,
  type ExclusionKind,
  type FieldStockingLoad,
  type Fundo,
  type PaddockStockingLoad,
  type PaddockOperationKind,
  type PaddockOperationPlanRequest,
  type PaddockOperationPreview as ServerPaddockOperationPreview,
  type PaddockOperationResult,
  type PolygonRings,
  type Potrero,
  type PotreroInput,
  type ScopedSubdivisionDraft,
} from "./types";
import {
  changedBoundaryDraftIds,
  cloneBoundaryDrafts,
  type BoundaryDrafts,
} from "./utils/boundary-editor";
import { calculateGrossHectares, calculateHectares } from "./utils/geometry";
import {
  buildExclusionPreview,
  buildExclusionEditPreview,
  removePaddockExclusion,
  type ExclusionPreview,
  type ExclusionScope,
} from "./utils/exclusions";
import { planMerge, type GeometryOperationPlan } from "./utils/paddock-operations";
import { paddockAreaMetrics } from "./utils/paddock-metrics";
import { compactSubdivisionHistory, subdividePolygons } from "./utils/subdivide";
import { validatePotreroGeometry, validatePotreroGeometryCollection } from "./utils/validate";

const LEGACY_STORAGE_KEYS = ["fundosmart-potreros-v3", "fundosmart-activities-v2", "fundosmart-fundos-v1"];
const MIN_PRACTICAL_PADDOCK_AREA_HECTARES = 0.1;
const POTRERO_NAME_COLLATOR = new Intl.Collator("es-CL", { numeric: true, sensitivity: "base" });

type SyncState = "syncing" | "synced" | "offline" | "error";
type DraftSyncState = "loading" | "saving" | "saved" | "offline" | "stale";
type SubdivisionSaveSession = { id: number; updatedAt: string | null; state: DraftSyncState };
type StockingLoadState = "idle" | "loading" | "loaded" | "error" | "offline";
type FieldCellsLoadState = "idle" | "loading" | "loaded" | "stale" | "offline" | "error";
type GeometryValidation = { errors: string[]; warnings: string[] };
type PaddockOperationRequest = PaddockOperationPlanRequest;
type PaddockOperationPreview = {
  requestHash: string;
  snapshotToken: string;
  parents: Potrero[];
  proposedPaddocks: Potrero[];
  lotMoves: LotMovePreview[];
  activityCount: number;
  warnings: string[];
  blockers: string[];
  valid: boolean;
};
type PendingPaddockOperation = {
  operationId: string;
  kind: Exclude<PaddockOperationKind, "undo">;
  parentPaddockIds: string[];
  polygons: Coordinate[][];
  proposedPaddockIds: string[];
  localPlan: GeometryOperationPlan | null;
};
type Phase1Potrero = Potrero & {
  archivedAt?: string | null;
  archiveReason?: string | null;
  createdByOperationId?: string | null;
};
type Phase1Fundo = Fundo & { snapshotToken?: string };

const EMPTY_GEOMETRY_VALIDATION: GeometryValidation = { errors: [], warnings: [] };

function offlineStorageKey(dataset: string, scope: string) {
  return `fundosmart:${scope}:${dataset}`;
}

function fieldFeatureCacheKey(dataset: string, scope: string, fieldId: string) {
  return `fundosmart:${scope}:field:${fieldId}:${dataset}`;
}

function paddockCellsCacheKey(scope: string, fieldId: string, paddockId: string) {
  return `${fieldFeatureCacheKey("paddock-cells-v1", scope, fieldId)}:${paddockId}`;
}

function loadCachedSnapshot<Value>(key: string): { value: Value; savedAt: string } | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: number; value?: Value; savedAt?: string };
    return parsed.version === 1 && parsed.value && typeof parsed.savedAt === "string"
      ? { value: parsed.value, savedAt: parsed.savedAt }
      : null;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

function saveCachedSnapshot<Value>(key: string, value: Value) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, value, savedAt: new Date().toISOString() }));
  } catch {
    // A successful server mutation must not be reported as failed only because
    // the browser denied or exhausted local storage.
  }
}

async function applyOfflineOutboxOperation(operation: OfflineOutboxOperation) {
  if (operation.entity === "potrero") {
    await applyPotreroOutboxOperation(operation);
    return;
  }
  await applyActivityOutboxOperation(operation);
}

function syncFailureState(error: unknown): SyncState {
  return error instanceof OfflineNetworkError || error instanceof TypeError ? "offline" : "error";
}

function syncFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : "No fue posible sincronizar los cambios pendientes.";
}

const MapaPotreros = dynamic(
  () => import("./components/MapaPotreros").then((module) => module.MapaPotreros),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-[520px] place-items-center rounded-[22px] bg-line-steel lg:h-[590px]">
        <div className="flex items-center gap-3 rounded-2xl bg-white/90 px-4 py-3 text-xs font-black text-ink shadow-xl">
          <span className="size-2 animate-pulse rounded-full bg-accent" /> Preparando mapa del campo…
        </div>
      </div>
    ),
  },
);

export function PotrerosPage({ initialFundos = [], initialPlan = null, isDemo, offlineScope, organizationId, organizationName, userName }: {
  initialFundos?: Fundo[];
  initialPlan?: OrganizationPlanUsage | null;
  isDemo: boolean;
  offlineScope: string;
  organizationId: string;
  organizationName: string;
  userName: string;
}) {
  const [fundos, setFundos] = useState<Fundo[]>(initialFundos);
  const [organizationPlan, setOrganizationPlan] = useState<OrganizationPlanUsage | null>(initialPlan);
  const [selectedFundoId, setSelectedFundoId] = useState<string | null>(initialFundos[0]?.id ?? null);
  const seededFundosRef = useRef(initialFundos.length > 0);
  const [potreros, setPotreros] = useState<Potrero[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityLineageByPaddock, setActivityLineageByPaddock] = useState<Record<string, ActivityWithLineage[]>>({});
  const [draftPoints, setDraftPoints] = useState<Coordinate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedPotreros, setArchivedPotreros] = useState<Potrero[]>([]);
  const [managedActivity, setManagedActivity] = useState<Activity | null>(null);
  const [manageMode, setManageMode] = useState<"edit" | "delete" | null>(null);
  const [fundoEditOpen, setFundoEditOpen] = useState(false);
  const [fundoCreateOpen, setFundoCreateOpen] = useState(false);
  const [pendingNewFundo, setPendingNewFundo] = useState<(NewFundoDetails & {
    id: string;
    previousSelectedId: string | null;
  }) | null>(null);
  const [importMapOpen, setImportMapOpen] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [boundaryEditing, setBoundaryEditing] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState<Coordinate[]>([]);
  const [fieldBoundaryPaddockDrafts, setFieldBoundaryPaddockDrafts] = useState<BoundaryDrafts>({});
  const [potreroBoundaryEditingId, setPotreroBoundaryEditingId] = useState<string | null>(null);
  const [potreroBoundaryDrafts, setPotreroBoundaryDrafts] = useState<BoundaryDrafts>({});
  const [potreroBoundaryCapturedWithGps, setPotreroBoundaryCapturedWithGps] = useState(false);
  const [exclusionSetupScope, setExclusionSetupScope] = useState<ExclusionScope | null>(null);
  const [exclusionMode, setExclusionMode] = useState<ExclusionDrawMode | null>(null);
  const [exclusionDraft, setExclusionDraft] = useState<Coordinate[]>([]);
  const [exclusionPreview, setExclusionPreview] = useState<ExclusionPreview | null>(null);
  const [exclusionSaving, setExclusionSaving] = useState(false);
  const [exclusionError, setExclusionError] = useState<string | null>(null);
  const [fieldStockingLoad, setFieldStockingLoad] = useState<FieldStockingLoad | null>(null);
  const [stockingLoadState, setStockingLoadState] = useState<StockingLoadState>("idle");
  const [stockingRefreshKey, setStockingRefreshKey] = useState(0);
  const [subdivisionHistory, setSubdivisionHistory] = useState<Coordinate[][][]>([]);
  const [subdivisionScope, setSubdivisionScope] = useState<SubdivisionScope | null>(null);
  const [subdivisionBaseSnapshotToken, setSubdivisionBaseSnapshotToken] = useState<string | null>(null);
  const [staleSubdivisionDraft, setStaleSubdivisionDraft] = useState<ScopedSubdivisionDraft | null>(null);
  const [subdivisionLine, setSubdivisionLine] = useState<Coordinate[]>([]);
  const [subdivisionError, setSubdivisionError] = useState<string | null>(null);
  const [subdivisionConfirmOpen, setSubdivisionConfirmOpen] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingPaddockOperation | null>(null);
  const [operationPreview, setOperationPreview] = useState<PaddockOperationPreview | null>(null);
  const [undoPreviewState, setUndoPreviewState] = useState<{ sourceOperationId: string; preview: UndoPreview } | null>(null);
  const [subdivisionDraftState, setSubdivisionDraftState] = useState<DraftSyncState>("saved");
  const [subdivisionRestored, setSubdivisionRestored] = useState(false);
  const [subdivisionStartCount, setSubdivisionStartCount] = useState(0);
  const [subdivisionStartSource, setSubdivisionStartSource] = useState<"draft" | "saved-paddocks" | "field-boundary" | "paddock-boundary" | "stale-draft">("field-boundary");
  const [ready, setReady] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(true);
  const [paddockSyncState, setPaddockSyncState] = useState<SyncState>("syncing");
  const [activitySyncState, setActivitySyncState] = useState<SyncState>("syncing");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rotationSnapshot, setRotationSnapshot] = useState<PaddockRotationSnapshot | null>(null);
  const [rotationLoadState, setRotationLoadState] = useState<RotationLoadState>("idle");
  const [rotationRefreshKey, setRotationRefreshKey] = useState(0);
  const [fieldCells, setFieldCells] = useState<FieldActivePaddockCellListing | null>(null);
  const [fieldCellsLoadState, setFieldCellsLoadState] = useState<FieldCellsLoadState>("idle");
  const [cellsRefreshKey, setCellsRefreshKey] = useState(0);
  const [selectedCellListing, setSelectedCellListing] = useState<PaddockCellListing | null>(null);
  const [cellsDialogOpen, setCellsDialogOpen] = useState(false);
  const [cellBearingDegrees, setCellBearingDegrees] = useState<number | null>(null);
  const [cellPreview, setCellPreview] = useState<PaddockCellGenerationPreview | null>(null);
  const [cellBusy, setCellBusy] = useState(false);
  const [cellError, setCellError] = useState<string | null>(null);
  const [cellOperationIds, setCellOperationIds] = useState<Record<string, { create: string; close: string }>>({});
  const [fieldLandmarks, setFieldLandmarks] = useState<FieldLandmarkListing | null>(null);
  const [fieldLandmarkLoadState, setFieldLandmarkLoadState] = useState<FieldLandmarkLoadState>("idle");
  const [fieldLandmarkDraft, setFieldLandmarkDraft] = useState<FieldLandmarkEditorDraft | null>(null);
  const [fieldLandmarkBusy, setFieldLandmarkBusy] = useState(false);
  const [fieldLandmarkError, setFieldLandmarkError] = useState<string | null>(null);
  const [ndviListing, setNdviListing] = useState<PaddockNdviListing | null>(null);
  const [ndviLoadState, setNdviLoadState] = useState<PaddockNdviLoadState>("idle");
  const [ndviRefreshing, setNdviRefreshing] = useState(false);
  const [ndviError, setNdviError] = useState<string | null>(null);
  const subdivisionSavePromiseRef = useRef<Promise<unknown>>(Promise.resolve());
  const subdivisionSaveSequenceRef = useRef(0);
  const subdivisionSaveSessionRef = useRef<SubdivisionSaveSession>({ id: 0, updatedAt: null, state: subdivisionDraftState });
  const outboxesRef = useRef(new Map<string, ReturnType<typeof createOfflineOutbox>>());
  const landmarkArchiveOperationIdsRef = useRef(new Map<string, string>());
  const ndviAutoRefreshFieldsRef = useRef(new Set<string>());
  const fieldLandmarksRef = useRef<FieldLandmarkListing | null>(null);
  const activeFieldIdRef = useRef(selectedFundoId);
  const activeOfflineScopeRef = useRef(offlineScope);
  activeFieldIdRef.current = selectedFundoId;
  activeOfflineScopeRef.current = offlineScope;
  subdivisionSaveSessionRef.current.state = subdivisionDraftState;
  const potrerosStorageKey = offlineStorageKey("potreros-v4", offlineScope);
  const activitiesStorageKey = offlineStorageKey("activities-v3", offlineScope);
  const fundosStorageKey = offlineStorageKey("fundos-v2", offlineScope);
  const outboxStorageKey = offlineOutboxStorageKey(offlineScope);
  const canMutate = !isDemo && !offlineScope.split(".").includes("viewer");
  const structuralOperationsEnabled = canMutate && networkOnline;
  const fieldLimitReached = organizationPlan?.fieldLimit !== null
    && organizationPlan?.fieldLimit !== undefined
    && fundos.length >= organizationPlan.fieldLimit;
  const canCreateFundo = canMutate && networkOnline && !fieldLimitReached && !boundaryEditing;
  const createFundoDisabledReason = !canMutate
    ? "Tu acceso no permite crear fundos."
    : !networkOnline
      ? "Conéctate a internet para crear un fundo."
      : fieldLimitReached
        ? `El plan Gratis permite hasta ${organizationPlan?.fieldLimit} fundos.`
        : boundaryEditing
          ? "Termina o cancela la edición del límite actual."
          : null;

  const getOfflineOutbox = useCallback(() => {
    const existing = outboxesRef.current.get(outboxStorageKey);
    if (existing) return existing;
    const outbox = createOfflineOutbox(window.localStorage, outboxStorageKey);
    outboxesRef.current.set(outboxStorageKey, outbox);
    return outbox;
  }, [outboxStorageKey]);

  useEffect(() => {
    for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key);
  }, []);

  useEffect(() => {
    const updateConnection = () => {
      setNetworkOnline(window.navigator.onLine);
      if (window.navigator.onLine) return;
      setPaddockSyncState("offline");
      setActivitySyncState("offline");
    };
    updateConnection();
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    if (!mapFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mapFullscreen]);

  const loadFundos = useCallback(async () => {
    try {
      const remote = await fetchFundos();
      setFundos(remote.fundos);
      setOrganizationPlan(remote.plan);
      setSelectedFundoId((current) => current && remote.fundos.some((fundo) => fundo.id === current) ? current : remote.fundos[0]?.id ?? null);
      window.localStorage.setItem(fundosStorageKey, JSON.stringify(remote.fundos));
    } catch {
      const cached = window.localStorage.getItem(fundosStorageKey);
      if (!cached) return;
      const local = JSON.parse(cached) as Fundo[];
      setFundos(local);
      setSelectedFundoId((current) => current ?? local[0]?.id ?? null);
    }
  }, [fundosStorageKey]);

  useEffect(() => {
    /* Los fundos que trajo la página son de este mismo request: repetir el fetch
       al montar sólo retrasaría la cadena que depende del fundo activo. El
       reintento al recuperar conexión se mantiene, que es cuando sí pueden haber
       quedado atrás. */
    if (seededFundosRef.current) seededFundosRef.current = false;
    else void loadFundos();
    window.addEventListener("online", loadFundos);
    return () => window.removeEventListener("online", loadFundos);
  }, [loadFundos]);

  const synchronize = useCallback(async () => {
    const requestedScope = offlineScope;
    setPaddockSyncState("syncing");
    setSyncError(null);

    try {
      const activeFieldId = activeFieldIdRef.current;
      const geographic = activeFieldId
        ? await synchronizeGeographicOfflineSnapshot({ scope: offlineScope, fieldId: activeFieldId })
        : null;
      const remote = await getOfflineOutbox().synchronize(applyOfflineOutboxOperation, () => fetchPotreros());
      if (activeOfflineScopeRef.current !== requestedScope) return;
      setPotreros(remote);
      window.localStorage.setItem(potrerosStorageKey, JSON.stringify(remote));
      if (activeFieldId && geographic?.snapshot?.fieldId === activeFieldId) {
        const listing = landmarkListingFromSnapshot(activeFieldId, geographic.snapshot.landmarks);
        fieldLandmarksRef.current = listing;
        setFieldLandmarks(listing);
      }
      if (activeFieldId) void seedGeographicOfflineSnapshot({ scope: offlineScope, fieldId: activeFieldId, paddocks: remote });
      setPaddockSyncState(geographic?.conflicts ? "error" : "synced");
      if (geographic?.conflicts) setSyncError(`${geographic.conflicts} cambio geográfico requiere revisión antes de aplicarse.`);
    } catch (error) {
      if (activeOfflineScopeRef.current !== requestedScope) return;
      setPaddockSyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
    }
  }, [getOfflineOutbox, offlineScope, potrerosStorageKey]);

  useEffect(() => {
    const handleWorker = (event: MessageEvent) => {
      if (event.data?.type === "fundosmart:offline-sync-request") void synchronize();
    };
    navigator.serviceWorker?.addEventListener("message", handleWorker);
    return () => navigator.serviceWorker?.removeEventListener("message", handleWorker);
  }, [synchronize]);

  const synchronizeActivities = useCallback(async () => {
    const requestedScope = offlineScope;
    setActivitySyncState("syncing");
    setSyncError(null);
    try {
      const remote = await getOfflineOutbox().synchronize(applyOfflineOutboxOperation, () => fetchActivities());
      if (activeOfflineScopeRef.current !== requestedScope) return;
      setActivities(remote);
      window.localStorage.setItem(activitiesStorageKey, JSON.stringify(remote));
      setActivitySyncState("synced");
    } catch (error) {
      if (activeOfflineScopeRef.current !== requestedScope) return;
      setActivitySyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
    }
  }, [activitiesStorageKey, getOfflineOutbox, offlineScope]);

  const refreshModule = useCallback(async () => {
    await Promise.all([loadFundos(), synchronize(), synchronizeActivities()]);
    setStockingRefreshKey((value) => value + 1);
    setRotationRefreshKey((value) => value + 1);
    setCellsRefreshKey((value) => value + 1);
  }, [loadFundos, synchronize, synchronizeActivities]);

  const saveSubdivisionDraftNow = useCallback((scope: SubdivisionScope, baseSnapshotToken: string, history: Coordinate[][][], line: Coordinate[]) => {
    const sequence = subdivisionSaveSequenceRef.current + 1;
    const session = subdivisionSaveSessionRef.current;
    const persistedHistory = compactSubdivisionHistory(history);
    subdivisionSaveSequenceRef.current = sequence;
    session.state = "saving";
    setSubdivisionDraftState("saving");
    const request = subdivisionSavePromiseRef.current
      .catch(() => undefined)
      .then(async () => {
        if (session.state === "stale") return;
        try {
          const saved = await persistScopedSubdivisionDraft(
            scope,
            baseSnapshotToken,
            session.updatedAt,
            persistedHistory,
            line,
          );
          session.updatedAt = saved.updatedAt;
          if (subdivisionSaveSessionRef.current === session && subdivisionSaveSequenceRef.current === sequence) {
            session.state = "saved";
            setSubdivisionDraftState("saved");
          }
        } catch (error) {
          const conflict = isConflictError(error);
          session.state = conflict ? "stale" : "offline";
          if (subdivisionSaveSessionRef.current === session && (conflict || subdivisionSaveSequenceRef.current === sequence)) {
            setSubdivisionDraftState(conflict ? "stale" : "offline");
            setSubdivisionError(conflict
              ? "El mapa cambió mientras editabas. Recarga el scope antes de guardar este borrador."
              : "El borrador no pudo guardarse; la operación estructural seguirá bloqueada sin conexión.");
          }
          throw error;
        }
      });
    subdivisionSavePromiseRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(potrerosStorageKey);
    let localSnapshot: Potrero[] = [];

    if (saved) {
      try {
        localSnapshot = JSON.parse(saved) as Potrero[];
      } catch {
        window.localStorage.removeItem(potrerosStorageKey);
      }
    }

    const initialize = window.setTimeout(() => {
      setPotreros(localSnapshot);
      setReady(true);
      void synchronize();
    }, 0);

    const handleOnline = () => {
      void synchronize();
    };

    window.addEventListener("online", handleOnline);
    return () => {
      window.clearTimeout(initialize);
      window.removeEventListener("online", handleOnline);
    };
  }, [potrerosStorageKey, synchronize]);

  useEffect(() => {
    const saved = window.localStorage.getItem(activitiesStorageKey);
    let localSnapshot: Activity[] = [];
    if (saved) {
      try {
        localSnapshot = JSON.parse(saved) as Activity[];
      } catch {
        window.localStorage.removeItem(activitiesStorageKey);
      }
    }
    const initialize = window.setTimeout(() => {
      setActivities(localSnapshot);
      void synchronizeActivities();
    }, 0);

    const handleOnline = () => {
      void synchronizeActivities();
    };
    window.addEventListener("online", handleOnline);
    return () => {
      window.clearTimeout(initialize);
      window.removeEventListener("online", handleOnline);
    };
  }, [activitiesStorageKey, synchronizeActivities]);

  useEffect(() => {
    if (ready) window.localStorage.setItem(potrerosStorageKey, JSON.stringify(potreros));
  }, [potreros, potrerosStorageKey, ready]);

  useEffect(() => {
    if (ready) window.localStorage.setItem(activitiesStorageKey, JSON.stringify(activities));
  }, [activities, activitiesStorageKey, ready]);

  useEffect(() => {
    if (fundos.length > 0) window.localStorage.setItem(fundosStorageKey, JSON.stringify(fundos));
  }, [fundos, fundosStorageKey]);

  useEffect(() => {
    if (!showArchived || !selectedFundoId || !networkOnline) return;
    let active = true;
    void fetchArchivedPaddocks(selectedFundoId)
      .then((items) => { if (active) setArchivedPotreros(items); })
      .catch((error) => { if (active) setSyncError(syncFailureMessage(error)); });
    return () => { active = false; };
  }, [networkOnline, selectedFundoId, showArchived]);

  useEffect(() => {
    if (!selectedId || !networkOnline) return;
    let active = true;
    void fetchActivitiesWithLineage(selectedId)
      .then((items) => {
        if (!active) return;
        setActivityLineageByPaddock((current) => ({ ...current, [selectedId]: items }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [networkOnline, selectedId]);

  useEffect(() => {
    if (!selectedFundoId) {
      const reset = window.setTimeout(() => {
        setFieldStockingLoad(null);
        setStockingLoadState("idle");
      }, 0);
      return () => window.clearTimeout(reset);
    }
    if (!networkOnline) {
      const reset = window.setTimeout(() => {
        setFieldStockingLoad(null);
        setStockingLoadState("offline");
      }, 0);
      return () => window.clearTimeout(reset);
    }
    let active = true;
    const loading = window.setTimeout(() => {
      setFieldStockingLoad(null);
      setStockingLoadState("loading");
    }, 0);
    void fetchFieldStockingLoad(selectedFundoId)
      .then((load) => {
        if (!active) return;
        setFieldStockingLoad(load);
        setStockingLoadState("loaded");
      })
      .catch(() => {
        if (!active) return;
        setFieldStockingLoad(null);
        setStockingLoadState("error");
      });
    return () => { active = false; window.clearTimeout(loading); };
  }, [networkOnline, selectedFundoId, stockingRefreshKey]);

  useEffect(() => {
    let active = true;
    const initialize = window.setTimeout(() => {
      if (!selectedFundoId) {
        setRotationSnapshot(null);
        setRotationLoadState("idle");
        return;
      }
      const cacheKey = fieldFeatureCacheKey("rotation-v1", offlineScope, selectedFundoId);
      const cached = loadCachedSnapshot<PaddockRotationSnapshot>(cacheKey);
      setRotationSnapshot(cached?.value ?? null);
      setRotationLoadState(networkOnline ? cached ? "stale" : "loading" : cached ? "offline" : "offline");
      if (!networkOnline) return;
      void fetchPaddockRotation(selectedFundoId)
        .then((snapshot) => {
          if (!active) return;
          setRotationSnapshot(snapshot);
          setRotationLoadState("loaded");
          saveCachedSnapshot(cacheKey, snapshot);
        })
        .catch(() => {
          if (!active) return;
          setRotationLoadState(cached ? "stale" : "error");
        });
    }, 0);
    return () => { active = false; window.clearTimeout(initialize); };
  }, [networkOnline, offlineScope, rotationRefreshKey, selectedFundoId, stockingRefreshKey]);

  useEffect(() => {
    let active = true;
    const initialize = window.setTimeout(() => {
      if (!selectedFundoId) {
        setFieldCells(null);
        setFieldCellsLoadState("idle");
        return;
      }
      const cacheKey = fieldFeatureCacheKey("active-cells-v1", offlineScope, selectedFundoId);
      const cached = loadCachedSnapshot<FieldActivePaddockCellListing>(cacheKey);
      setFieldCells(cached?.value ?? null);
      setFieldCellsLoadState(networkOnline ? cached ? "stale" : "loading" : cached ? "offline" : "offline");
      if (!networkOnline) return;
      void fetchFieldActivePaddockCells(selectedFundoId)
        .then((listing) => {
          if (!active) return;
          setFieldCells(listing);
          setFieldCellsLoadState("loaded");
          saveCachedSnapshot(cacheKey, listing);
        })
        .catch(() => {
          if (!active) return;
          setFieldCellsLoadState(cached ? "stale" : "error");
        });
    }, 0);
    return () => { active = false; window.clearTimeout(initialize); };
  }, [cellsRefreshKey, networkOnline, offlineScope, selectedFundoId, stockingRefreshKey]);

  useEffect(() => {
    let active = true;
    const initialize = window.setTimeout(() => {
      if (!selectedFundoId || !selectedId) {
        setSelectedCellListing(null);
        return;
      }
      const cacheKey = paddockCellsCacheKey(offlineScope, selectedFundoId, selectedId);
      const cached = loadCachedSnapshot<PaddockCellListing>(cacheKey);
      setSelectedCellListing(cached?.value ?? null);
      if (!networkOnline) return;
      void fetchPaddockCells(selectedFundoId, selectedId)
        .then((listing) => {
          if (!active) return;
          setSelectedCellListing(listing);
          saveCachedSnapshot(cacheKey, listing);
        })
        .catch(() => undefined);
    }, 0);
    return () => { active = false; window.clearTimeout(initialize); };
  }, [cellsRefreshKey, networkOnline, offlineScope, selectedFundoId, selectedId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setFieldLandmarkDraft(null);
      setFieldLandmarkBusy(false);
      setFieldLandmarkError(null);
      if (!selectedFundoId) {
        fieldLandmarksRef.current = null;
        setFieldLandmarks(null);
        setFieldLandmarkLoadState("idle");
        return;
      }
      const snapshot = await readGeographicOfflineSnapshot(offlineScope, selectedFundoId);
      if (!active) return;
      const cached = snapshot ? landmarkListingFromSnapshot(snapshot.fieldId, snapshot.landmarks) : null;
      if (snapshot) {
        const paddocksById = new Map(snapshot.paddocks.map((paddock) => [paddock.id, paddock]));
        setPotreros((current) => current.map((paddock) => paddocksById.get(paddock.id) ?? paddock));
      }
      fieldLandmarksRef.current = cached;
      setFieldLandmarks(cached);
      setFieldLandmarkLoadState(networkOnline ? cached ? "stale" : "loading" : "offline");
      if (!networkOnline) return;
      try {
        const listing = await fetchFieldLandmarks(selectedFundoId);
        if (!active || activeFieldIdRef.current !== listing.fieldId) return;
        fieldLandmarksRef.current = listing;
        setFieldLandmarks(listing);
        setFieldLandmarkLoadState("loaded");
        void seedGeographicOfflineSnapshot({ scope: offlineScope, fieldId: listing.fieldId, landmarks: listing });
      } catch {
        if (active) setFieldLandmarkLoadState(cached ? "stale" : "error");
      }
    })();
    return () => { active = false; };
  }, [networkOnline, offlineScope, selectedFundoId]);

  useEffect(() => {
    let active = true;
    const initialize = window.setTimeout(() => {
      setNdviError(null);
      if (!selectedFundoId) {
        setNdviListing(null);
        setNdviLoadState("idle");
        return;
      }
      const cacheKey = fieldFeatureCacheKey("ndvi-v1", offlineScope, selectedFundoId);
      const cached = loadCachedSnapshot<PaddockNdviListing>(cacheKey);
      setNdviListing(cached?.value ?? null);
      setNdviLoadState(networkOnline ? cached ? "stale" : "loading" : "offline");
      if (!networkOnline) return;
      void fetchPaddockNdvi(selectedFundoId)
        .then((listing) => {
          if (!active || activeFieldIdRef.current !== listing.fieldId) return;
          setNdviListing(listing);
          setNdviLoadState("loaded");
          saveCachedSnapshot(cacheKey, listing);
        })
        .catch(() => {
          if (!active) return;
          setNdviLoadState(cached ? "stale" : "error");
        });
    }, 0);
    return () => { active = false; window.clearTimeout(initialize); };
  }, [networkOnline, offlineScope, selectedFundoId]);

  useEffect(() => {
    if (!canMutate || !subdivisionScope || !subdivisionBaseSnapshotToken || subdivisionSaveSessionRef.current.state === "stale" || staleSubdivisionDraft || subdivisionHistory.length === 0) return;
    const timeout = window.setTimeout(() => {
      void saveSubdivisionDraftNow(subdivisionScope, subdivisionBaseSnapshotToken, subdivisionHistory, subdivisionLine).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [canMutate, saveSubdivisionDraftNow, staleSubdivisionDraft, subdivisionBaseSnapshotToken, subdivisionHistory, subdivisionLine, subdivisionScope]);

  const selectedFundo = useMemo(() => fundos.find((fundo) => fundo.id === selectedFundoId) ?? null, [fundos, selectedFundoId]);
  const visiblePotreros = useMemo(
    () => potreros
      .filter((potrero) => potrero.fieldId === selectedFundoId && !(potrero as Phase1Potrero).archivedAt)
      .sort((first, second) => POTRERO_NAME_COLLATOR.compare(first.name, second.name)),
    [potreros, selectedFundoId],
  );
  const refreshNdviOnDemand = useCallback(async () => {
    if (!selectedFundoId || isDemo || !canMutate || !networkOnline || ndviRefreshing) return;
    const fieldId = selectedFundoId;
    const requestScope = offlineScope;
    const maximumBatches = Math.max(1, Math.ceil(visiblePotreros.length / PADDOCK_NDVI_REFRESH_MAX_PADDOCKS) + 1);
    const completedPaddockIds = new Set<string>();
    setNdviRefreshing(true);
    setNdviError(null);
    try {
      for (let attempt = 0; attempt < maximumBatches; attempt += 1) {
        const batch = await refreshPaddockNdvi({ fieldId });
        const completedBefore = completedPaddockIds.size;
        batch.values.forEach((value) => {
          if (value.state === "cached" || value.state === "refreshed" || value.state === "no_data") completedPaddockIds.add(value.paddockId);
        });
        const batchIssues = batch.values.filter((value) => (value.state === "unavailable" || value.state === "error" || value.state === "stale") && value.error);
        const batchIssueMessage = batchIssues[0]?.error?.message
          ? `${batchIssues[0].error.message}${batchIssues.length > 1 ? ` (${batchIssues.length} potreros afectados)` : ""}`
          : null;
        if (batchIssueMessage && activeFieldIdRef.current === fieldId && activeOfflineScopeRef.current === requestScope) {
          setNdviError(`${batchIssueMessage} Se conserva el caché vigente.`);
        }
        if (batch.retryAfterMs !== null) {
          if (activeFieldIdRef.current === fieldId && activeOfflineScopeRef.current === requestScope) {
            setNdviError(`El proveedor pidió reintentar en aproximadamente ${Math.ceil(batch.retryAfterMs / 1000)} s. Conservamos el caché vigente.`);
          }
          break;
        }
        if (!batch.hasMore) break;
        if (completedPaddockIds.size <= completedBefore) {
          if (activeFieldIdRef.current === fieldId && activeOfflineScopeRef.current === requestScope) {
            setNdviError(batchIssueMessage ? `${batchIssueMessage} Se conserva el caché vigente.` : "La actualización no avanzó; se detuvo para evitar reintentos indefinidos y se conserva el caché.");
          }
          break;
        }
      }
      const listing = await fetchPaddockNdvi(fieldId);
      if (activeFieldIdRef.current === fieldId && activeOfflineScopeRef.current === requestScope) {
        setNdviListing(listing);
        setNdviLoadState("loaded");
        saveCachedSnapshot(fieldFeatureCacheKey("ndvi-v1", requestScope, fieldId), listing);
      }
    } catch (cause) {
      if (activeFieldIdRef.current === fieldId && activeOfflineScopeRef.current === requestScope) {
        setNdviError(cause instanceof Error ? cause.message : "No fue posible actualizar el NDVI; el caché local sigue disponible.");
        setNdviLoadState(ndviListing?.fieldId === fieldId ? "stale" : "error");
      }
    } finally {
      setNdviRefreshing(false);
    }
  }, [canMutate, isDemo, ndviListing?.fieldId, ndviRefreshing, networkOnline, offlineScope, selectedFundoId, visiblePotreros.length]);
  useEffect(() => {
    if (!selectedFundoId || isDemo || !canMutate || !networkOnline || ndviLoadState !== "loaded" || ndviRefreshing) return;
    if (ndviAutoRefreshFieldsRef.current.has(selectedFundoId)) return;
    ndviAutoRefreshFieldsRef.current.add(selectedFundoId);
    void refreshNdviOnDemand();
  }, [canMutate, isDemo, ndviLoadState, ndviRefreshing, networkOnline, refreshNdviOnDemand, selectedFundoId]);
  const totalHectares = useMemo(() => visiblePotreros.reduce((sum, item) => sum + paddockAreaMetrics(item).grossAreaHectares, 0), [visiblePotreros]);
  const totalUsefulHectares = useMemo(() => visiblePotreros.reduce((sum, item) => sum + paddockAreaMetrics(item).effectiveGrazeableAreaHectares, 0), [visiblePotreros]);
  const fieldHasExclusions = useMemo(() => visiblePotreros.some((item) => paddockAreaMetrics(item).geometry.holes.length > 0), [visiblePotreros]);
  const fieldStructuralOperationsEnabled = structuralOperationsEnabled && !fieldHasExclusions;
  const mergeStructuralOperationsEnabled = structuralOperationsEnabled && selectedIds.every((id) => {
    const paddock = visiblePotreros.find((item) => item.id === id);
    return !paddock || paddockAreaMetrics(paddock).geometry.holes.length === 0;
  });
  const stockingLoadsByPaddock = useMemo(() => Object.fromEntries(
    (fieldStockingLoad?.paddocks ?? []).map((load) => [load.paddockId, load]),
  ) as Record<string, PaddockStockingLoad>, [fieldStockingLoad]);
  const paddockCounts = useMemo(() => potreros.reduce<Record<string, number>>((counts, potrero) => {
    counts[potrero.fieldId] = (counts[potrero.fieldId] ?? 0) + 1;
    return counts;
  }, {}), [potreros]);
  const selectedPotrero = useMemo(
    () => [...potreros, ...archivedPotreros].find((potrero) => potrero.id === selectedId) ?? null,
    [archivedPotreros, potreros, selectedId],
  );
  const potreroBoundaryDraft = useMemo(
    () => potreroBoundaryEditingId ? potreroBoundaryDrafts[potreroBoundaryEditingId] ?? [] : [],
    [potreroBoundaryDrafts, potreroBoundaryEditingId],
  );
  const potreroBoundaryChangedIds = useMemo(
    () => changedBoundaryDraftIds(potreroBoundaryDrafts, visiblePotreros),
    [potreroBoundaryDrafts, visiblePotreros],
  );
  const fieldBoundaryPaddockChangedIds = useMemo(
    () => changedBoundaryDraftIds(fieldBoundaryPaddockDrafts, visiblePotreros),
    [fieldBoundaryPaddockDrafts, visiblePotreros],
  );
  const selectedStockingLoad = selectedPotrero ? stockingLoadsByPaddock[selectedPotrero.id] : undefined;
  const selectedSourceOperationId = (selectedPotrero as Phase1Potrero | null)?.createdByOperationId ?? null;
  const undoPreview = undoPreviewState?.sourceOperationId === selectedSourceOperationId ? undoPreviewState.preview : null;
  const selectedActivities = useMemo(() => {
    if (!selectedId) return [];
    const ownActivities: ActivityWithLineage[] = activities
      .filter((activity) => activity.potreroId === selectedId)
      .map((activity) => ({ ...activity, inherited: false, sourcePaddockId: selectedId, sourcePaddockName: selectedPotrero?.name ?? "Potrero", lineageDepth: 0 }));
    const inheritedActivities = (activityLineageByPaddock[selectedId] ?? []).filter((activity) => activity.inherited);
    return [...ownActivities, ...inheritedActivities].sort((first, second) => second.occurredAt.localeCompare(first.occurredAt));
  }, [activities, activityLineageByPaddock, selectedId, selectedPotrero?.name]);
  const subdivisionPolygons = useMemo(
    () => subdivisionHistory[subdivisionHistory.length - 1] ?? [],
    [subdivisionHistory],
  );
  const subdivisionMode = subdivisionHistory.length > 0;
  const subdivisionBoundary = useMemo(() => {
    if (subdivisionScope?.kind === "paddock") {
      return visiblePotreros.find((potrero) => potrero.id === subdivisionScope.paddockId)?.coordinates ?? [];
    }
    return selectedFundo?.coordinates ?? [];
  }, [selectedFundo?.coordinates, subdivisionScope, visiblePotreros]);
  const draftValidation = useMemo(
    () => draftPoints.length > 0 && selectedFundo
      ? validatePotreroGeometry(draftPoints, visiblePotreros.map((potrero) => potrero.coordinates), selectedFundo.coordinates)
      : EMPTY_GEOMETRY_VALIDATION,
    [draftPoints, selectedFundo, visiblePotreros],
  );
  const boundaryValidation = useMemo(
    () => boundaryEditing && boundaryDraft.length > 0 && (selectedFundo || pendingNewFundo)
      ? validateLinkedFundoBoundaryChange(
          boundaryDraft,
          selectedFundo?.coordinates ?? [],
          visiblePotreros,
          fieldBoundaryPaddockDrafts,
          fieldBoundaryPaddockChangedIds,
        )
      : EMPTY_GEOMETRY_VALIDATION,
    [
      boundaryDraft,
      boundaryEditing,
      fieldBoundaryPaddockChangedIds,
      fieldBoundaryPaddockDrafts,
      pendingNewFundo,
      selectedFundo,
      visiblePotreros,
    ],
  );
  const potreroBoundaryValidation = useMemo(
    () => potreroBoundaryEditingId && potreroBoundaryDraft.length > 0 && selectedFundo
      ? mergeGeometryValidations(
          visiblePotreros
            .filter((potrero) => potreroBoundaryChangedIds.includes(potrero.id))
            .map((potrero) => {
              const coordinates = potreroBoundaryDrafts[potrero.id] ?? potrero.coordinates;
              const siblings = visiblePotreros
                .filter((sibling) => sibling.id !== potrero.id)
                .map((sibling) => potreroBoundaryDrafts[sibling.id] ?? sibling.coordinates);
              return prefixGeometryValidation(
                validatePotreroGeometry(coordinates, siblings, selectedFundo.coordinates),
                potrero.name,
              );
            }),
        )
      : EMPTY_GEOMETRY_VALIDATION,
    [
      potreroBoundaryChangedIds,
      potreroBoundaryDraft,
      potreroBoundaryDrafts,
      potreroBoundaryEditingId,
      selectedFundo,
      visiblePotreros,
    ],
  );
  const subdivisionValidation = useMemo(
    () => subdivisionBoundary.length > 0 && subdivisionPolygons.length > 0
      ? validateGeometryCollection(subdivisionPolygons, subdivisionBoundary)
      : EMPTY_GEOMETRY_VALIDATION,
    [subdivisionBoundary, subdivisionPolygons],
  );
  useEffect(() => {
    const sourceOperationId = selectedSourceOperationId;
    if (!sourceOperationId || !selectedFundo || !canMutate || !networkOnline) {
      return;
    }
    let active = true;
    const request: PaddockOperationRequest = {
      fieldId: selectedFundo.id,
      kind: "undo",
      parentPaddockIds: [],
      proposedPaddocks: [],
      sourceOperationId,
    };
    void fetchPaddockOperationPreview(request)
      .then((preview) => {
        if (active) setUndoPreviewState({
          sourceOperationId,
          preview: { canUndo: preview.valid && preview.blockers.length === 0, blockers: preview.blockers },
        });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canMutate, networkOnline, selectedFundo, selectedSourceOperationId]);
  const syncState: SyncState = syncError || paddockSyncState === "error" || activitySyncState === "error"
    ? "error"
    : !networkOnline || paddockSyncState === "offline" || activitySyncState === "offline"
    ? "offline"
    : paddockSyncState === "syncing" || activitySyncState === "syncing"
      ? "syncing"
      : "synced";

  function savePotrero(input: PotreroInput): Promise<void>;
  function savePotrero(
    input: PotreroInput,
    options: { id: string; geometryAlreadyApproved: true; select: false; clearDraft: false },
  ): Promise<"applied" | "queued">;
  async function savePotrero(
    input: PotreroInput,
    options: { id?: string; geometryAlreadyApproved?: boolean; select?: boolean; clearDraft?: boolean } = {},
  ): Promise<void | "applied" | "queued"> {
    if (!selectedFundoId || !selectedFundo) throw new Error("Selecciona un fundo antes de guardar el potrero.");
    if (!options.geometryAlreadyApproved) {
      requireGeometryApproval(
        validatePotreroGeometry(input.coordinates, visiblePotreros.map((potrero) => potrero.coordinates), selectedFundo.coordinates),
        "guardar este potrero",
      );
    }
    const created: Potrero = {
      ...input,
      id: options.id ?? crypto.randomUUID(),
      fieldId: selectedFundoId,
      lastActivity: "Creado · ahora",
      status: "Disponible",
    };

    const existing = potreros.find((potrero) => potrero.id === created.id);
    if (existing) {
      if (!sameImportedPotrero(existing, created)) {
        throw new Error("El ID estable del plan ya pertenece a otro potrero. No se sobrescribió el registro existente.");
      }
      const queued = getOfflineOutbox().list().some((operation) => operation.entity === "potrero" && operation.payload.id === existing.id);
      return queued ? "queued" : "applied";
    }

    setPotreros((current) => [created, ...current]);
    if (options.select !== false) setSelectedId(created.id);
    if (options.clearDraft !== false) setDraftPoints([]);

    setPaddockSyncState("syncing");
    setSyncError(null);
    try {
      const result = await getOfflineOutbox().executeOrQueue({
        op: "create",
        entity: "potrero",
        payload: created,
        queuedAt: new Date().toISOString(),
      }, () => persistPotrero(created));
      if (result.status === "applied") {
        setPotreros((current) => current.map((potrero) => (potrero.id === result.value.id ? result.value : potrero)));
        setPaddockSyncState("synced");
        setStockingRefreshKey((value) => value + 1);
      } else {
        setPaddockSyncState("offline");
      }
      return result.status;
    } catch (error) {
      setPotreros((current) => current.filter((potrero) => potrero.id !== created.id));
      if (options.select !== false) setSelectedId(null);
      if (options.clearDraft !== false) setDraftPoints(input.coordinates);
      setPaddockSyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
      throw error;
    }
  }

  /**
   * Paddocks are born on the map: the drawing is stored right away with a free
   * name and the edit dialog opens so the operator completes the record without
   * a second creation form.
   */
  async function createPaddockFromDraft() {
    if (!canMutate || !selectedFundo || draftPoints.length < 3) return;
    const coordinates = draftPoints.map(([latitude, longitude]): Coordinate => [latitude, longitude]);
    const areaHectaresDrawn = calculateHectares(coordinates);
    if (areaHectaresDrawn <= 0) return;
    try {
      await savePotrero({
        name: nextAvailablePaddockName(visiblePotreros),
        sector: visiblePotreros.find((potrero) => potrero.sector.trim())?.sector.trim() ?? "Sin sector",
        areaHectares: areaHectaresDrawn,
        coordinates,
        geometry: { outer: coordinates, holes: [] },
        netAreaHectares: areaHectaresDrawn,
        grazeableAreaHectares: null,
        effectiveGrazeableAreaHectares: areaHectaresDrawn,
        landUse: "pradera_permanente",
        holeKinds: [],
        soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
      });
      setManageMode("edit");
    } catch {
      // savePotrero already restores the drawing and reports the failure through
      // the synchronization banner, so the operator can retry without redrawing.
    }
  }

  async function persistImportedPaddock(polygon: GisCanonicalImportPolygon): Promise<"applied" | "queued"> {
    const geometry = clonePolygonRings(polygon.geometry);
    return savePotrero({
      name: polygon.name,
      sector: polygon.sector,
      areaHectares: calculateGrossHectares(geometry),
      coordinates: geometry.outer,
      geometry,
      netAreaHectares: calculateHectares(geometry),
      effectiveGrazeableAreaHectares: calculateHectares(geometry),
      landUse: "pradera_permanente",
      holeKinds: [...polygon.holeKinds],
      soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    }, {
      id: polygon.id,
      geometryAlreadyApproved: true,
      select: false,
      clearDraft: false,
    });
  }

  async function persistImportedFieldBoundary(polygon: GisCanonicalImportPolygon): Promise<"applied"> {
    if (!selectedFundo || polygon.geometry.holes.length > 0) {
      throw new Error("El límite del fundo no puede persistir huecos con el contrato actual.");
    }
    await updateFundo({
      ...selectedFundo,
      coordinates: polygon.geometry.outer.map(([latitude, longitude]) => [latitude, longitude]),
      areaHectares: calculateGrossHectares(polygon.geometry),
    });
    return "applied";
  }

  function reviewImportedCommitPlan(plan: GisImportCommitPlan) {
    const importedPaddockOuters = plan.paddocks.map((polygon) => polygon.geometry.outer);
    const validations: GeometryValidation[] = [];
    if (plan.fieldBoundary && selectedFundo) {
      validations.push(validateFundoBoundaryChange(
        plan.fieldBoundary.geometry.outer,
        selectedFundo.coordinates,
        visiblePotreros,
      ));
    }
    plan.paddocks.forEach((polygon, index) => {
      validations.push(prefixGeometryValidation(validatePotreroGeometry(
        polygon.geometry.outer,
        [
          ...visiblePotreros.map((potrero) => potrero.coordinates),
          ...importedPaddockOuters.filter((_, siblingIndex) => siblingIndex !== index),
        ],
        plan.validationBoundary.geometry.outer,
      ), polygon.name));
    });
    const review = mergeGeometryValidations(validations);
    return { blockers: review.errors, warnings: review.warnings };
  }

  function cacheFieldLandmarkListing(listing: FieldLandmarkListing) {
    void seedGeographicOfflineSnapshot({ scope: offlineScope, fieldId: listing.fieldId, landmarks: listing });
    if (activeOfflineScopeRef.current !== offlineScope || activeFieldIdRef.current !== listing.fieldId) return;
    fieldLandmarksRef.current = listing;
    setFieldLandmarks(listing);
  }

  function applyFieldLandmarkResult(result: FieldLandmarkOperationResult) {
    const fieldId = result.landmark.fieldId;
    const current = fieldLandmarksRef.current?.fieldId === fieldId
      ? fieldLandmarksRef.current
      : { fieldId, active: [], archived: [] };
    const active = current.active.filter(({ id }) => id !== result.landmark.id);
    const archived = current.archived.filter(({ id }) => id !== result.landmark.id);
    if (result.landmark.deletedAt === null) active.push(result.landmark);
    else archived.push(result.landmark);
    active.sort((first, second) => POTRERO_NAME_COLLATOR.compare(first.name, second.name));
    archived.sort((first, second) => POTRERO_NAME_COLLATOR.compare(first.name, second.name));
    cacheFieldLandmarkListing({ fieldId, active, archived });
  }

  async function reloadFieldLandmarks(fieldId: string) {
    const listing = await fetchFieldLandmarks(fieldId);
    if (activeFieldIdRef.current === fieldId) {
      cacheFieldLandmarkListing(listing);
      setFieldLandmarkLoadState("loaded");
    }
    return listing;
  }

  /** The landmark editor lives inside the map, so page-level entry points bring it into view. */
  function focusMapEditor() {
    document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function startFieldLandmark(geometryType: FieldLandmarkEditorDraft["geometryType"]) {
    if (!selectedFundoId || !canMutate) return;
    setFieldLandmarkError(null);
    setFieldLandmarkDraft({
      id: crypto.randomUUID(),
      geometryType,
      geometry: [],
      expectedVersion: null,
      operationId: createGeographicMutationId(),
    });
  }

  function editFieldLandmark(landmark: FieldLandmark) {
    if (!canMutate) return;
    setFieldLandmarkError(null);
    setFieldLandmarkDraft({
      id: landmark.id,
      geometryType: landmark.geometryType,
      geometry: landmark.geometry.map(([latitude, longitude]) => [latitude, longitude]),
      expectedVersion: landmark.version,
      operationId: createGeographicMutationId(),
    });
  }

  async function saveFieldLandmarkDraft(values: Readonly<{ kind: FieldLandmarkKind; name: string; notes: string }>) {
    if (!selectedFundoId || !fieldLandmarkDraft || !canMutate) return;
    const draft = fieldLandmarkDraft;
    const fieldId = selectedFundoId;
    setFieldLandmarkBusy(true);
    setFieldLandmarkError(null);
    try {
      const queued = await queueFieldLandmarkUpsert({
        scope: offlineScope,
        current: draft.expectedVersion === null
          ? null
          : fieldLandmarksRef.current?.active.find(({ id }) => id === draft.id) ?? null,
        request: {
          id: draft.id,
          fieldId,
          kind: values.kind,
          geometryType: draft.geometryType,
          geometry: draft.geometry,
          name: values.name,
          notes: values.notes,
          expectedVersion: draft.expectedVersion,
          operationId: draft.operationId,
        },
      });
      applyFieldLandmarkResult(queued.result);
      setFieldLandmarkLoadState(queued.queued ? "offline" : "loaded");
      if (activeFieldIdRef.current === fieldId) setFieldLandmarkDraft(null);
    } catch (cause) {
      if (cause instanceof GeographicSyncConflictError) {
        if (networkOnline) await reloadFieldLandmarks(fieldId).catch(() => undefined);
        if (activeFieldIdRef.current === fieldId) {
          setFieldLandmarkDraft(null);
          setFieldLandmarkError("El hito cambió en otra sesión. Recargamos la versión vigente; vuelve a editarlo.");
        }
      } else if (activeFieldIdRef.current === fieldId) {
        setFieldLandmarkError(cause instanceof Error ? cause.message : "No fue posible guardar el hito. Reintenta con la misma operación.");
      }
    } finally {
      if (activeFieldIdRef.current === fieldId) setFieldLandmarkBusy(false);
    }
  }

  async function archiveFieldLandmark(landmark: FieldLandmark) {
    if (!canMutate) return;
    if (!window.confirm(`¿Archivar ${landmark.name}? Dejará de mostrarse en la capa activa.`)) return;
    const operationId = landmarkArchiveOperationIdsRef.current.get(landmark.id) ?? createGeographicMutationId();
    landmarkArchiveOperationIdsRef.current.set(landmark.id, operationId);
    setFieldLandmarkBusy(true);
    setFieldLandmarkError(null);
    try {
      const queued = await queueFieldLandmarkArchive({
        scope: offlineScope,
        current: landmark,
        request: {
          id: landmark.id,
          fieldId: landmark.fieldId,
          expectedVersion: landmark.version,
          operationId,
        },
      });
      applyFieldLandmarkResult(queued.result);
      setFieldLandmarkLoadState(queued.queued ? "offline" : "loaded");
      landmarkArchiveOperationIdsRef.current.delete(landmark.id);
      if (activeFieldIdRef.current === landmark.fieldId && fieldLandmarkDraft?.id === landmark.id) setFieldLandmarkDraft(null);
    } catch (cause) {
      if (cause instanceof GeographicSyncConflictError) {
        if (networkOnline) await reloadFieldLandmarks(landmark.fieldId).catch(() => undefined);
        landmarkArchiveOperationIdsRef.current.delete(landmark.id);
        if (activeFieldIdRef.current === landmark.fieldId) setFieldLandmarkError("El hito cambió antes de archivarlo. Recargamos su versión vigente.");
      } else if (activeFieldIdRef.current === landmark.fieldId) {
        setFieldLandmarkError(cause instanceof Error ? cause.message : "No fue posible archivar el hito; puedes reintentar sin duplicar la operación.");
      }
    } finally {
      if (activeFieldIdRef.current === landmark.fieldId) setFieldLandmarkBusy(false);
    }
  }

  async function persistImportedLandmark(request: FieldLandmarkUpsertRequest): Promise<"applied"> {
    const requestScope = offlineScope;
    if (!canMutate || !networkOnline || requestScope !== activeOfflineScopeRef.current || request.fieldId !== activeFieldIdRef.current) {
      throw new Error("Los hitos importados requieren conexión y un fundo activo con permiso de operador.");
    }
    const result = await saveFieldLandmark(request);
    if (requestScope !== activeOfflineScopeRef.current || request.fieldId !== activeFieldIdRef.current) {
      throw new Error("El fundo activo cambió durante la importación; reabre la revisión antes de reintentar los hitos pendientes.");
    }
    applyFieldLandmarkResult(result);
    return "applied";
  }

  async function saveActivity(input: ActivityInput) {
    const created: Activity = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    setActivities((current) => [created, ...current]);

    setActivitySyncState("syncing");
    setSyncError(null);
    let refreshPaddocks = false;
    try {
      const result = await getOfflineOutbox().executeOrQueue({
        op: "create",
        entity: "activity",
        payload: created,
        queuedAt: new Date().toISOString(),
      }, () => persistActivity(created));
      if (result.status === "applied") {
        setActivities((current) => sortActivities(current.map((activity) => activity.id === result.value.id ? result.value : activity)));
        setActivitySyncState("synced");
        refreshPaddocks = true;
      } else {
        setActivitySyncState("offline");
      }
    } catch (error) {
      setActivities((current) => current.filter((activity) => activity.id !== created.id));
      setActivitySyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
      throw error;
    }
    if (refreshPaddocks) await refreshPotrerosAfterActivity();
  }

  async function updateActivity(activity: Activity) {
    const expectedUpdatedAt = activity.updatedAt ?? null;
    if (!expectedUpdatedAt) throw new Error("Recarga el manejo antes de editarlo; falta su versión persistida.");
    setActivitySyncState("syncing");
    setSyncError(null);
    let refreshPaddocks = false;
    try {
      const result = await getOfflineOutbox().executeOrQueue({
        op: "update",
        entity: "activity",
        payload: activity,
        queuedAt: new Date().toISOString(),
      }, () => persistActivity(activity));
      const saved = result.status === "applied" ? result.value : activity;
      setActivities((current) => sortActivities(current.map((item) => item.id === saved.id ? saved : item)));
      setActivitySyncState(result.status === "applied" ? "synced" : "offline");
      refreshPaddocks = result.status === "applied";
    } catch (error) {
      setActivitySyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
      throw error;
    }
    if (refreshPaddocks) await refreshPotrerosAfterActivity();
  }

  async function deleteManagedActivity(activityId: string) {
    const expectedUpdatedAt = activities.find((activity) => activity.id === activityId)?.updatedAt;
    if (!expectedUpdatedAt) throw new Error("Actualiza el historial antes de eliminar el manejo.");
    setActivitySyncState("syncing");
    setSyncError(null);
    let refreshPaddocks = false;
    try {
      const result = await getOfflineOutbox().executeOrQueue({
        op: "delete",
        entity: "activity",
        payload: { id: activityId, updatedAt: expectedUpdatedAt },
        queuedAt: new Date().toISOString(),
      }, () => removeActivity(activityId, expectedUpdatedAt));
      setActivities((current) => current.filter((activity) => activity.id !== activityId));
      setManagedActivity(null);
      setActivitySyncState(result.status === "applied" ? "synced" : "offline");
      refreshPaddocks = result.status === "applied";
    } catch (error) {
      setActivitySyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
      throw error;
    }
    if (refreshPaddocks) await refreshPotrerosAfterActivity();
  }

  async function refreshPotrerosAfterActivity() {
    await synchronize();
    setStockingRefreshKey((value) => value + 1);
  }

  async function updatePotrero(potrero: Potrero) {
    setPaddockSyncState("syncing");
    setSyncError(null);
    try {
      const result = await getOfflineOutbox().executeOrQueue({
        op: "update",
        entity: "potrero",
        payload: potrero,
        queuedAt: new Date().toISOString(),
      }, () => persistPotrero(potrero));
      const saved = result.status === "applied" ? result.value : potrero;
      setPotreros((current) => current.map((item) => item.id === saved.id ? saved : item));
      setPaddockSyncState(result.status === "applied" ? "synced" : "offline");
      if (result.status === "applied") setStockingRefreshKey((value) => value + 1);
    } catch (error) {
      setPaddockSyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
      throw error;
    }
  }

  async function deleteSelectedPotrero(potreroId: string) {
    const expectedUpdatedAt = potreros.find((potrero) => potrero.id === potreroId)?.updatedAt;
    if (!expectedUpdatedAt) throw new Error("Actualiza los potreros antes de eliminar.");
    setPaddockSyncState("syncing");
    setSyncError(null);
    try {
      const result = await getOfflineOutbox().executeOrQueue({
        op: "delete",
        entity: "potrero",
        payload: { id: potreroId, updatedAt: expectedUpdatedAt },
        queuedAt: new Date().toISOString(),
      }, () => removePotrero(potreroId, expectedUpdatedAt));
      setPotreros((current) => current.filter((potrero) => potrero.id !== potreroId));
      setActivities((current) => current.filter((activity) => activity.potreroId !== potreroId));
      setSelectedId(null);
      setManageMode(null);
      setPaddockSyncState(result.status === "applied" ? "synced" : "offline");
      if (result.status === "applied") setStockingRefreshKey((value) => value + 1);
    } catch (error) {
      setPaddockSyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
      throw error;
    }
  }

  async function updateFundo(fundo: Fundo) {
    const expectedSnapshotToken = fundo.snapshotToken ?? null;
    if (!expectedSnapshotToken) throw new Error("Recarga el fundo antes de editarlo; falta su versión persistida.");
    setPaddockSyncState("syncing");
    try {
      const saved = await persistFundo({ ...fundo, snapshotToken: expectedSnapshotToken });
      setFundos((current) => current.map((item) => item.id === saved.id ? saved : item));
      setPaddockSyncState("synced");
    } catch (error) {
      setPaddockSyncState("offline");
      throw error;
    }
  }

  function startBoundaryEditing() {
    if (!selectedFundo) return;
    cancelSubdivision();
    cancelPotreroBoundaryEditing();
    cancelExclusionDrawing();
    setFieldLandmarkDraft(null);
    setDraftPoints([]);
    setSelectedId(null);
    setBoundaryDraft(cloneRing(selectedFundo.coordinates));
    setFieldBoundaryPaddockDrafts(boundaryDraftsFromPaddocks(visiblePotreros));
    setBoundaryEditing(true);
    window.setTimeout(() => document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }

  function startNewFundo(details: NewFundoDetails) {
    if (!canCreateFundo) return;
    cancelBoundaryEditing(false);
    cancelSubdivision();
    cancelPotreroBoundaryEditing();
    cancelExclusionDrawing();
    setFieldLandmarkDraft(null);
    setDraftPoints([]);
    setSelectedId(null);
    setPendingNewFundo({
      ...details,
      id: crypto.randomUUID(),
      previousSelectedId: selectedFundoId,
    });
    setSelectedFundoId(null);
    setBoundaryDraft([]);
    setFieldBoundaryPaddockDrafts({});
    setBoundaryEditing(true);
    setFundoCreateOpen(false);
    window.setTimeout(() => document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }

  async function saveBoundary() {
    if ((!selectedFundo && !pendingNewFundo) || boundaryDraft.length < 3) {
      throw new Error("El límite necesita al menos tres puntos.");
    }
    const area = calculateHectares(boundaryDraft);
    if (area <= 0) throw new Error("El límite dibujado no tiene una superficie válida.");

    const linkedPaddockUpdates = selectedFundo
      ? buildLinkedBoundaryPaddockUpdates(visiblePotreros, fieldBoundaryPaddockDrafts, fieldBoundaryPaddockChangedIds)
      : [];
    const validation = selectedFundo
      ? validateLinkedFundoBoundaryChange(
          boundaryDraft,
          selectedFundo.coordinates,
          visiblePotreros,
          fieldBoundaryPaddockDrafts,
          fieldBoundaryPaddockChangedIds,
        )
      : validateFundoBoundaryChange(boundaryDraft, [], []);
    if (selectedFundo && linkedPaddockUpdates.length > 0 && area < selectedFundo.areaHectares) {
      validation.warnings.push(
        `El nuevo límite reduce la superficie del fundo y ajustará ${linkedPaddockUpdates.length} potrero${linkedPaddockUpdates.length === 1 ? "" : "s"} pegado${linkedPaddockUpdates.length === 1 ? "" : "s"}.`,
      );
    }
    requireGeometryApproval(validation, "guardar el límite del fundo");
    if (pendingNewFundo) {
      setPaddockSyncState("syncing");
      try {
        const saved = await persistFundo({
          id: pendingNewFundo.id,
          name: pendingNewFundo.name,
          location: pendingNewFundo.location,
          coordinates: boundaryDraft,
          areaHectares: area,
          soilReport: null,
        });
        setFundos((current) => [...current, saved].sort((first, second) => first.name.localeCompare(second.name, "es-CL")));
        setOrganizationPlan((current) => current ? { ...current, fieldsUsed: current.fieldsUsed + 1 } : current);
        setSelectedFundoId(saved.id);
        setPendingNewFundo(null);
        setPaddockSyncState("synced");
      } catch (error) {
        setPaddockSyncState("offline");
        throw error;
      }
    } else if (selectedFundo) {
      const requestedFundo = { ...selectedFundo, coordinates: cloneRing(boundaryDraft), areaHectares: area };
      if (linkedPaddockUpdates.length === 0) {
        await updateFundo(requestedFundo);
      } else {
        if (!networkOnline || !window.navigator.onLine) {
          throw new Error("Conéctate a internet para guardar juntos el fundo y los potreros vinculados.");
        }
        setPaddockSyncState("syncing");
        try {
          const saved = await persistLinkedFieldBoundary(requestedFundo, linkedPaddockUpdates);
          setFundos((current) => current.map((item) => item.id === saved.fundo.id ? saved.fundo : item));
          const savedById = new Map(saved.potreros.map((potrero) => [potrero.id, potrero]));
          setPotreros((current) => current.map((potrero) => savedById.get(potrero.id) ?? potrero));
          setPaddockSyncState("synced");
          setStockingRefreshKey((value) => value + 1);
        } catch (error) {
          setPaddockSyncState(syncFailureState(error));
          throw error;
        }
      }
    }
    setBoundaryEditing(false);
    setBoundaryDraft([]);
    setFieldBoundaryPaddockDrafts({});
  }

  function cancelBoundaryEditing(restorePendingSelection = true) {
    if (pendingNewFundo) {
      if (restorePendingSelection) setSelectedFundoId(pendingNewFundo.previousSelectedId);
      setPendingNewFundo(null);
    }
    setBoundaryEditing(false);
    setBoundaryDraft([]);
    setFieldBoundaryPaddockDrafts({});
  }

  async function startSubdivision() {
    if (!selectedFundo) return;
    await beginSubdivision({ kind: "field", fieldId: selectedFundo.id });
  }

  async function startSelectedPotreroSubdivision() {
    if (!selectedFundo || !selectedPotrero) return;
    await beginSubdivision({
      kind: "paddock",
      fieldId: selectedFundo.id,
      paddockId: selectedPotrero.id,
      paddockName: selectedPotrero.name,
    });
  }

  async function beginSubdivision(scope: SubdivisionScope) {
    if (!canMutate) return;
    if (!networkOnline) {
      setSubdivisionError("Conéctate para iniciar una operación estructural. Ningún cambio se aplicará sin confirmación del servidor.");
      return;
    }
    if (!selectedFundo || selectedFundo.coordinates.length < 3) return;
    const parent = scope.kind === "paddock"
      ? visiblePotreros.find((potrero) => potrero.id === scope.paddockId)
      : null;
    if (scope.kind === "paddock" && !parent) return;

    const session: SubdivisionSaveSession = {
      id: subdivisionSaveSessionRef.current.id + 1,
      updatedAt: null,
      state: "loading",
    };
    subdivisionSaveSessionRef.current = session;
    subdivisionSaveSequenceRef.current += 1;
    cancelPotreroBoundaryEditing();
    setDraftPoints([]);
    if (scope.kind === "field") setSelectedId(null);
    cancelBoundaryEditing();
    setSubdivisionScope(scope);
    setSubdivisionError(null);
    setSubdivisionDraftState("loading");
    setSubdivisionRestored(false);
    setStaleSubdivisionDraft(null);
    setSubdivisionHistory([]);
    setSubdivisionLine([]);
    const basePolygons = scope.kind === "paddock"
      ? [parent!.coordinates]
      : visiblePotreros.length > 0
        ? visiblePotreros.map((potrero) => potrero.coordinates)
        : [selectedFundo.coordinates];
    const fallbackBaseSnapshotToken = fieldSnapshotToken(selectedFundo, visiblePotreros);
    setSubdivisionBaseSnapshotToken(fallbackBaseSnapshotToken);

    try {
      const { draft, baseSnapshotToken } = await fetchScopedSubdivisionDraft(scope);
      if (subdivisionSaveSessionRef.current !== session) return;
      setSubdivisionBaseSnapshotToken(baseSnapshotToken);
      const draftMatchesBase = draft?.baseSnapshotToken === baseSnapshotToken;
      if (draft && draftMatchesBase) {
        session.updatedAt = draft.updatedAt;
        setSubdivisionHistory(draft.history);
        setSubdivisionLine(draft.line);
        setSubdivisionStartCount(draft.history[0]?.length ?? 0);
        setSubdivisionStartSource("draft");
        setSubdivisionRestored(true);
        setSubdivisionDraftState("saved");
        return;
      }

      setSubdivisionHistory([basePolygons]);
      session.updatedAt = null;
      setSubdivisionLine([]);
      setSubdivisionStartCount(basePolygons.length);
      if (draft) {
        setStaleSubdivisionDraft(draft);
        setSubdivisionStartSource("stale-draft");
        setSubdivisionDraftState("stale");
        setSubdivisionError("Hay un borrador basado en una versión anterior. No se restauró; recarga el mapa o descártalo de forma explícita.");
      } else {
        setSubdivisionStartSource(scope.kind === "paddock" ? "paddock-boundary" : visiblePotreros.length > 0 ? "saved-paddocks" : "field-boundary");
        setSubdivisionDraftState("saved");
      }
    } catch (error) {
      if (subdivisionSaveSessionRef.current !== session) return;
      setSubdivisionHistory([basePolygons]);
      session.updatedAt = null;
      setSubdivisionLine([]);
      setSubdivisionStartCount(basePolygons.length);
      setSubdivisionStartSource(scope.kind === "paddock" ? "paddock-boundary" : visiblePotreros.length > 0 ? "saved-paddocks" : "field-boundary");
      setSubdivisionDraftState("offline");
      setSubdivisionError(syncFailureMessage(error));
    }
  }

  function applySubdivisionLine(line: Coordinate[] = subdivisionLine) {
    const result = subdividePolygons(subdivisionPolygons, line);
    if (result.error) {
      setSubdivisionLine(line);
      setSubdivisionError(result.error);
      return;
    }

    const smallestCreatedArea = Math.min(...result.createdPolygons.map(calculateHectares));
    if (smallestCreatedArea < MIN_PRACTICAL_PADDOCK_AREA_HECTARES) {
      const formattedArea = smallestCreatedArea.toLocaleString("es-CL", { maximumFractionDigits: 2 });
      const accepted = window.confirm(
        `Este corte creará un área de solo ${formattedArea} ha. Puede ser un fragmento accidental. ¿Aplicarlo de todos modos?`,
      );
      if (!accepted) {
        setSubdivisionLine(line);
        setSubdivisionError(`El corte no se aplicó porque creaba un área de ${formattedArea} ha. Ajusta sus puntos o aplícalo nuevamente para confirmarlo.`);
        return;
      }
    }

    setSubdivisionHistory((current) => [...current, result.polygons]);
    setSubdivisionLine([]);
    setSubdivisionError(null);
    setSubdivisionDraftState("saving");
  }

  function undoSubdivision() {
    setSubdivisionHistory((current) => current.length > 1 ? current.slice(0, -1) : current);
    setSubdivisionLine([]);
    setSubdivisionError(null);
    setSubdivisionDraftState("saving");
  }

  function restartSubdivisionFromBoundary() {
    if (!selectedFundo || !subdivisionScope) return;
    const boundary = subdivisionScope.kind === "paddock"
      ? visiblePotreros.find((potrero) => potrero.id === subdivisionScope.paddockId)?.coordinates
      : selectedFundo.coordinates;
    if (!boundary) return;
    const subject = subdivisionScope.kind === "paddock" ? "el borde del potrero" : "el límite del fundo";
    if (!window.confirm(`¿Reiniciar el trazado desde ${subject}? Los cortes del borrador se descartarán, pero ningún potrero cambiará hasta que el servidor confirme.`)) return;
    setSubdivisionHistory([[boundary]]);
    setSubdivisionLine([]);
    setSubdivisionError(null);
    setSubdivisionStartCount(1);
    setSubdivisionStartSource(subdivisionScope.kind === "paddock" ? "paddock-boundary" : "field-boundary");
    setSubdivisionRestored(false);
    setStaleSubdivisionDraft(null);
    setSubdivisionDraftState("saving");
  }

  function cancelSubdivision() {
    if (subdivisionScope && subdivisionBaseSnapshotToken && subdivisionHistory.length > 0) {
      void saveSubdivisionDraftNow(subdivisionScope, subdivisionBaseSnapshotToken, subdivisionHistory, subdivisionLine).catch(() => undefined);
    }
    clearSubdivisionEditor();
  }

  async function discardSubdivision() {
    if (!window.confirm("¿Descartar este borrador de subdivisión? Esta acción no se puede deshacer.")) return;
    const scope = subdivisionScope;
    const pendingSave = subdivisionSavePromiseRef.current;
    if (!scope) return;
    try {
      await pendingSave.catch(() => undefined);
      const expectedUpdatedAt = subdivisionSaveSessionRef.current.updatedAt ?? staleSubdivisionDraft?.updatedAt;
      if (!expectedUpdatedAt) {
        clearSubdivisionEditor();
        return;
      }
      await removeScopedSubdivisionDraft(scope, expectedUpdatedAt);
      clearSubdivisionEditor();
      setSubdivisionDraftState("saved");
    } catch (error) {
      setSubdivisionDraftState(isConflictError(error) ? "stale" : "offline");
      setSyncError(isConflictError(error) ? "El borrador cambió. Recarga antes de descartarlo." : syncFailureMessage(error));
    }
  }

  function clearSubdivisionEditor() {
    subdivisionSaveSequenceRef.current += 1;
    subdivisionSaveSessionRef.current = {
      id: subdivisionSaveSessionRef.current.id + 1,
      updatedAt: null,
      state: "saved",
    };
    setSubdivisionHistory([]);
    setSubdivisionScope(null);
    setSubdivisionBaseSnapshotToken(null);
    setSubdivisionLine([]);
    setSubdivisionError(null);
    setSubdivisionConfirmOpen(false);
    setPendingOperation(null);
    setOperationPreview(null);
    setSubdivisionRestored(false);
    setStaleSubdivisionDraft(null);
    setSubdivisionStartCount(0);
    setSubdivisionStartSource("field-boundary");
  }

  async function openSubdivisionConfirmation() {
    if (!selectedFundo || !subdivisionScope || subdivisionPolygons.length < 2) return;
    if (!structuralOperationsEnabled) {
      setSubdivisionError("Conéctate para previsualizar. Los cambios estructurales nunca se encolan ni se aplican localmente.");
      return;
    }
    setSubdivisionError(null);
    setPaddockSyncState("syncing");
    const kind: PaddockOperationKind = subdivisionScope.kind === "paddock" ? "split" : "redesign";
    const scopedPaddockId = subdivisionScope.kind === "paddock" ? subdivisionScope.paddockId : null;
    const parents = scopedPaddockId
      ? visiblePotreros.filter((potrero) => potrero.id === scopedPaddockId)
      : visiblePotreros;
    // Un split necesita su potrero de origen; un rediseño puede partir de cero
    // potreros cuando el fundo es nuevo y se subdivide desde su límite.
    if (scopedPaddockId && parents.length === 0) {
      setSubdivisionError("Recarga los potreros antes de preparar la operación.");
      return;
    }
    const proposedPaddockIds = subdivisionPolygons.map(() => crypto.randomUUID());
    const pending: PendingPaddockOperation = {
      operationId: crypto.randomUUID(),
      kind,
      parentPaddockIds: parents.map((potrero) => potrero.id),
      polygons: subdivisionPolygons,
      proposedPaddockIds,
      localPlan: null,
    };
    const defaultPrefix = kind === "split" ? parents[0].name : "Potrero";
    const defaultSector = kind === "split" ? parents[0].sector : selectedFundo.location || selectedFundo.name;
    await openOperationPreview(pending, defaultPrefix, defaultSector);
  }

  async function openMergeConfirmation() {
    if (!selectedFundo || !structuralOperationsEnabled) {
      setSyncError("Conéctate para previsualizar una fusión. Ningún cambio se aplicará localmente.");
      return;
    }
    const parents = visiblePotreros.filter((potrero) => selectedIds.includes(potrero.id));
    const proposedPaddockId = crypto.randomUUID();
    const localPlan = planMerge(parents.map(({ id, coordinates }) => ({ id, coordinates })), proposedPaddockId);
    const pending: PendingPaddockOperation = {
      operationId: crypto.randomUUID(),
      kind: "merge",
      parentPaddockIds: parents.map((potrero) => potrero.id),
      polygons: localPlan.children.map((child) => child.coordinates),
      proposedPaddockIds: [proposedPaddockId],
      localPlan,
    };
    const largestParent = [...parents].sort((first, second) => second.areaHectares - first.areaHectares)[0];
    await openOperationPreview(pending, "Potrero fusionado", largestParent?.sector ?? selectedFundo.name);
  }

  async function openOperationPreview(pending: PendingPaddockOperation, prefix: string, sector: string) {
    if (!selectedFundo) return;
    setPendingOperation(pending);
    const proposedPaddocks = buildProposedPaddocks(pending, prefix, sector, selectedFundo, visiblePotreros);
    const request: PaddockOperationRequest = {
      fieldId: selectedFundo.id,
      kind: pending.kind,
      parentPaddockIds: pending.parentPaddockIds,
      proposedPaddocks,
    };
    try {
      const remotePreview = !pending.localPlan || pending.localPlan.blockers.length === 0
        ? await fetchPaddockOperationPreview(request)
        : emptyOperationPreview(
            visiblePotreros.filter((potrero) => pending.parentPaddockIds.includes(potrero.id)),
            proposedPaddocks,
            fieldSnapshotToken(selectedFundo, visiblePotreros),
          );
      setOperationPreview(mergeOperationPreview(remotePreview, pending.localPlan));
      setSubdivisionConfirmOpen(true);
      setPaddockSyncState("synced");
    } catch (error) {
      setPaddockSyncState(syncFailureState(error));
      const message = isConflictError(error)
        ? "Los potreros cambiaron. Recarga el fundo antes de volver a previsualizar."
        : syncFailureMessage(error);
      setSubdivisionError(message);
      setSyncError(message);
    }
  }

  async function confirmSubdivision(prefix: string, sector: string) {
    if (!selectedFundo || !pendingOperation || !operationPreview) throw new Error("Actualiza la previsualización antes de confirmar.");
    if (!networkOnline) throw new Error("Sin conexión: la operación no se aplicó ni se encoló.");
    const proposedPaddocks = buildProposedPaddocks(pendingOperation, prefix, sector, selectedFundo, visiblePotreros);
    requireGeometryApproval(
      validateGeometryCollection(
        proposedPaddocks.map((potrero) => potrero.coordinates),
        pendingOperation.kind === "split" ? operationPreview.parents[0]?.coordinates ?? selectedFundo.coordinates : selectedFundo.coordinates,
        proposedPaddocks.map((potrero) => potrero.name),
      ),
      "aplicar esta operación estructural",
    );

    setPaddockSyncState("syncing");
    try {
      const request: PaddockOperationRequest = {
        fieldId: selectedFundo.id,
        kind: pendingOperation.kind,
        parentPaddockIds: pendingOperation.parentPaddockIds,
        proposedPaddocks,
      };
      const refreshedPreview = mergeOperationPreview(await fetchPaddockOperationPreview(request), pendingOperation.localPlan);
      if (refreshedPreview.requestHash !== operationPreview.requestHash) {
        setOperationPreview(refreshedPreview);
        throw new Error("La previsualización cambió. Revisa destinos, advertencias y bloqueos antes de confirmar nuevamente.");
      }
      if (!refreshedPreview.valid || refreshedPreview.blockers.length > 0) {
        setOperationPreview(refreshedPreview);
        throw new Error("La operación tiene bloqueos y no puede confirmarse.");
      }
      const result = await confirmPaddockOperation({
        ...request,
        operationId: pendingOperation.operationId,
        requestHash: refreshedPreview.requestHash,
        expectedSnapshotToken: refreshedPreview.snapshotToken,
      });
      const pendingSave = subdivisionSavePromiseRef.current;
      const completedScope = subdivisionScope;
      await pendingSave.catch(() => undefined);
      const completedDraftUpdatedAt = subdivisionSaveSessionRef.current.updatedAt;
      setPotreros((current) => [...current.filter((potrero) => potrero.fieldId !== selectedFundo.id), ...result.activePaddocks]);
      setArchivedPotreros((current) => reconcileArchivedPaddocks(current, result));
      setPaddockSyncState("synced");
      setSelectedId(null);
      setSelectedIds([]);
      setSelectionMode(false);
      clearSubdivisionEditor();
      if (completedScope && completedDraftUpdatedAt) try {
        await removeScopedSubdivisionDraft(completedScope, completedDraftUpdatedAt);
        setSubdivisionDraftState("saved");
      } catch {
        setSubdivisionDraftState("offline");
      }
    } catch (error) {
      const conflict = isConflictError(error);
      setPaddockSyncState(conflict ? "error" : syncFailureState(error));
      if (conflict) {
        const message = "Los datos cambiaron en el servidor. Recarga el fundo y vuelve a preparar la operación; no se aplicó ningún cambio local.";
        setSubdivisionError(message);
        setSyncError(message);
      }
      throw error;
    }
  }

  function toggleSelectedForMerge(potreroId: string) {
    setSelectedIds((current) => current.includes(potreroId)
      ? current.filter((id) => id !== potreroId)
      : [...current, potreroId]);
  }

  async function undoSelectedPaddockOperation() {
    const sourceOperationId = (selectedPotrero as Phase1Potrero | null)?.createdByOperationId;
    if (!sourceOperationId || !selectedFundo || !undoPreview?.canUndo || !networkOnline) return;
    if (!window.confirm("Se restaurarán los potreros anteriores y se archivarán los resultados de la operación. ¿Continuar?")) return;
    const request: PaddockOperationRequest = {
      fieldId: selectedFundo.id,
      kind: "undo",
      parentPaddockIds: [],
      proposedPaddocks: [],
      sourceOperationId,
    };
    setPaddockSyncState("syncing");
    try {
      const preview = await fetchPaddockOperationPreview(request);
      if (!preview.valid || preview.blockers.length > 0) {
        setUndoPreviewState({ sourceOperationId, preview: { canUndo: false, blockers: preview.blockers } });
        throw new Error(preview.blockers[0] ?? "La operación ya no se puede deshacer.");
      }
      const result = await confirmPaddockOperation({
        ...request,
        operationId: crypto.randomUUID(),
        requestHash: preview.requestHash,
        expectedSnapshotToken: preview.snapshotToken,
      });
      setPotreros((current) => [...current.filter((potrero) => potrero.fieldId !== selectedFundo.id), ...result.activePaddocks]);
      setArchivedPotreros((current) => reconcileArchivedPaddocks(current, result));
      setSelectedId(null);
      setUndoPreviewState(null);
      setPaddockSyncState("synced");
    } catch (error) {
      const conflict = isConflictError(error);
      setPaddockSyncState(conflict ? "error" : syncFailureState(error));
      setSyncError(conflict ? "Los datos cambiaron. Recarga antes de volver a deshacer; no se aplicó ningún cambio local." : syncFailureMessage(error));
      throw error;
    }
  }

  function startPotreroBoundaryEditing() {
    if (!selectedPotrero) return;
    cancelSubdivision();
    cancelBoundaryEditing();
    cancelExclusionDrawing();
    setFieldLandmarkDraft(null);
    setPotreroBoundaryEditingId(selectedPotrero.id);
    setPotreroBoundaryDrafts(Object.fromEntries(
      visiblePotreros.map((potrero) => [
        potrero.id,
        potrero.coordinates.map(([latitude, longitude]): Coordinate => [latitude, longitude]),
      ]),
    ));
    setPotreroBoundaryCapturedWithGps(false);
    window.setTimeout(() => document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }

  function cancelPotreroBoundaryEditing() {
    setPotreroBoundaryEditingId(null);
    setPotreroBoundaryDrafts({});
    setPotreroBoundaryCapturedWithGps(false);
  }

  async function savePotreroBoundary() {
    const editedPotrero = potreros.find((potrero) => potrero.id === potreroBoundaryEditingId);
    if (!selectedFundo) throw new Error("Selecciona un fundo antes de editar sus potreros.");
    if (!editedPotrero || potreroBoundaryDraft.length < 3) throw new Error("El potrero necesita al menos tres vértices.");
    const editedArea = calculateHectares(potreroBoundaryDraft);
    if (editedArea <= 0) throw new Error("El límite no tiene una superficie válida.");

    const changedIds = changedBoundaryDraftIds(potreroBoundaryDrafts, visiblePotreros);
    if (changedIds.length === 0) {
      cancelPotreroBoundaryEditing();
      return;
    }

    const updates = visiblePotreros.flatMap((potrero) => {
      if (!changedIds.includes(potrero.id)) return [];
      const coordinates = potreroBoundaryDrafts[potrero.id] ?? potrero.coordinates;
      const areaHectares = calculateHectares(coordinates);
      if (areaHectares <= 0) throw new Error(`El ajuste deja ${potrero.name} con una superficie inválida.`);
      return [{ ...potrero, coordinates, areaHectares }];
    });
    const updatesById = new Map(updates.map((potrero) => [potrero.id, potrero]));
    const finalPotreros = visiblePotreros.map((potrero) => updatesById.get(potrero.id) ?? potrero);
    const geometryValidation = mergeGeometryValidations(updates.map((potrero) => prefixGeometryValidation(
      validatePotreroGeometry(
        potrero.coordinates,
        finalPotreros.filter((sibling) => sibling.id !== potrero.id).map((sibling) => sibling.coordinates),
        selectedFundo.coordinates,
      ),
      potrero.name,
    )));
    requireGeometryApproval(geometryValidation, "guardar estos bordes");

    const source = potreroBoundaryCapturedWithGps ? "gps" : "map";
    const geometricUpdates = updates.map((potrero) => {
      const currentGeometry = potrero.geometry ?? { outer: potrero.coordinates, holes: [] };
      const geometry: PolygonRings = { outer: potrero.coordinates, holes: currentGeometry.holes };
      return {
        ...potrero,
        geometry,
        coordinates: geometry.outer,
        areaHectares: calculateGrossHectares(geometry),
        netAreaHectares: calculateHectares(geometry),
      };
    });
    const originalById = new Map(visiblePotreros.filter(({ id }) => updatesById.has(id)).map((potrero) => [potrero.id, potrero]));
    setPotreros((current) => current.map((potrero) => geometricUpdates.find(({ id }) => id === potrero.id) ?? potrero));
    setPaddockSyncState("syncing");
    try {
      const result = await queuePaddockGeometrySync({
        scope: offlineScope,
        fieldId: editedPotrero.fieldId,
        entityId: editedPotrero.id,
        updates: geometricUpdates,
        source,
      });
      setPaddockSyncState(result.queued ? "offline" : "synced");
      setStockingRefreshKey((value) => value + 1);
      cancelPotreroBoundaryEditing();
    } catch (error) {
      setPotreros((current) => current.map((potrero) => originalById.get(potrero.id) ?? potrero));
      setPaddockSyncState(error instanceof GeographicSyncConflictError ? "error" : "offline");
      throw error;
    }
  }

  function openExclusionSetup(scope: ExclusionScope) {
    if (!canMutate) return;
    cancelSubdivision();
    cancelBoundaryEditing();
    cancelPotreroBoundaryEditing();
    setDraftPoints([]);
    setExclusionError(null);
    setExclusionPreview(null);
    setExclusionSetupScope(scope);
  }

  function beginExclusionDrawing(kind: ExclusionKind) {
    if (!exclusionSetupScope) return;
    if (!networkOnline || !window.navigator.onLine) {
      setExclusionError("Sin conexión: las exclusiones no se aplican ni se encolan.");
      return;
    }
    setExclusionMode({ action: "create", scope: exclusionSetupScope, kind });
    setExclusionDraft([]);
    setExclusionPreview(null);
    setExclusionError(null);
    setExclusionSetupScope(null);
    window.setTimeout(() => document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }

  function startExclusionEditing(paddockId: string, exclusionIndex: number) {
    if (!canMutate) return;
    if (!networkOnline || !window.navigator.onLine) {
      setSyncError("Conéctate a internet para editar una exclusión.");
      return;
    }
    const paddock = visiblePotreros.find((candidate) => candidate.id === paddockId);
    const geometry = paddock ? paddockAreaMetrics(paddock).geometry : null;
    const exclusion = geometry?.holes[exclusionIndex];
    const kind = paddock?.holeKinds?.[exclusionIndex];
    if (!paddock || !exclusion || !kind) {
      setSyncError("La exclusión seleccionada ya no está disponible. Recarga el potrero.");
      return;
    }
    cancelSubdivision();
    cancelBoundaryEditing();
    cancelPotreroBoundaryEditing();
    setFieldLandmarkDraft(null);
    setDraftPoints([]);
    setSelectedId(paddock.id);
    setExclusionSetupScope(null);
    setExclusionMode({
      action: "edit",
      scope: {
        kind: "paddock",
        fieldId: paddock.fieldId,
        paddockId: paddock.id,
        paddockName: paddock.name,
      },
      kind,
      exclusionIndex,
    });
    setExclusionDraft(cloneRing(exclusion));
    setExclusionPreview(null);
    setExclusionError(null);
    setSyncError(null);
    window.setTimeout(() => document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }

  function previewExclusion() {
    if (!exclusionMode) return;
    const preview = exclusionMode.action === "edit"
      ? (() => {
          const paddock = visiblePotreros.find((candidate) => candidate.id === exclusionMode.scope.paddockId);
          return paddock
            ? buildExclusionEditPreview({
                paddock,
                exclusionIndex: exclusionMode.exclusionIndex,
                kind: exclusionMode.kind,
                exclusion: exclusionDraft,
              })
            : {
                operation: "edit" as const,
                scope: exclusionMode.scope,
                kind: exclusionMode.kind,
                exclusion: exclusionDraft,
                affected: [],
                blockers: ["El potrero seleccionado ya no está disponible. Recarga el fundo."],
                warnings: [],
                totalExcludedAreaHectares: 0,
              };
        })()
      : buildExclusionPreview({
          scope: exclusionMode.scope,
          kind: exclusionMode.kind,
          exclusion: exclusionDraft,
          paddocks: visiblePotreros,
        });
    setExclusionError(null);
    setExclusionPreview(preview);
  }

  function changeExclusionKind(kind: ExclusionKind) {
    setExclusionMode((current) => current ? { ...current, kind } : current);
    setExclusionPreview(null);
    setExclusionError(null);
  }

  function cancelExclusionDrawing() {
    setExclusionSetupScope(null);
    setExclusionMode(null);
    setExclusionDraft([]);
    setExclusionPreview(null);
    setExclusionError(null);
  }

  async function confirmExclusion() {
    if (!exclusionPreview || exclusionPreview.blockers.length > 0 || exclusionPreview.affected.length === 0) return;
    if (!networkOnline || !window.navigator.onLine) {
      setExclusionError("Sin conexión: las exclusiones no se aplican ni se encolan.");
      return;
    }
    setExclusionSaving(true);
    setExclusionError(null);
    setPaddockSyncState("syncing");
    try {
      const saved = await persistPotreroBoundaries(exclusionPreview.affected.map((item) => item.updatedPaddock));
      const savedById = new Map(saved.map((paddock) => [paddock.id, paddock]));
      setPotreros((current) => current.map((paddock) => savedById.get(paddock.id) ?? paddock));
      setPaddockSyncState("synced");
      setStockingRefreshKey((value) => value + 1);
      cancelExclusionDrawing();
    } catch (error) {
      setPaddockSyncState(syncFailureState(error));
      setExclusionError(syncFailureMessage(error));
    } finally {
      setExclusionSaving(false);
    }
  }

  async function removeSelectedExclusion(index: number) {
    if (!selectedPotrero || !canMutate) return;
    if (!networkOnline || !window.navigator.onLine) {
      setSyncError("Sin conexión: las exclusiones no se aplican ni se encolan.");
      return;
    }
    const kind = selectedPotrero.holeKinds?.[index] ?? "esta exclusión";
    if (!window.confirm(`¿Eliminar ${kind} de ${selectedPotrero.name}? La superficie útil se recalculará antes de guardar.`)) return;
    setPaddockSyncState("syncing");
    setSyncError(null);
    try {
      const updated = removePaddockExclusion(selectedPotrero, index);
      const [saved] = await persistPotreroBoundaries([updated]);
      setPotreros((current) => current.map((paddock) => paddock.id === saved.id ? saved : paddock));
      setPaddockSyncState("synced");
      setStockingRefreshKey((value) => value + 1);
    } catch (error) {
      setPaddockSyncState(syncFailureState(error));
      setSyncError(syncFailureMessage(error));
    }
  }

  async function saveRotationThresholds(request: PaddockRotationSettingsUpdateRequest) {
    try {
      await savePaddockRotationSettings(request);
      setRotationRefreshKey((value) => value + 1);
    } catch (error) {
      if (error instanceof PaddockRotationApiError && error.status === 409) {
        setRotationRefreshKey((value) => value + 1);
        throw new Error("La configuración cambió en otra sesión. Recargamos el cálculo; revisa los valores antes de reintentar.");
      }
      throw error;
    }
  }

  function openCellsDialog() {
    if (!selectedPotrero) return;
    setCellsDialogOpen(true);
    setCellBearingDegrees(90);
    setCellPreview(null);
    setCellError(null);
    const scopeKey = `${selectedPotrero.fieldId}:${selectedPotrero.id}`;
    setCellOperationIds((current) => current[scopeKey] ? current : {
      ...current,
      [scopeKey]: { create: crypto.randomUUID(), close: crypto.randomUUID() },
    });
  }

  async function previewSelectedPaddockCells(request: PaddockCellGenerationPlanRequest) {
    if (!canMutate || !networkOnline) return;
    setCellBusy(true);
    setCellError(null);
    try {
      setCellPreview(await fetchPaddockCellPreview(request));
    } catch (error) {
      setCellError(error instanceof Error ? error.message : "No fue posible preparar las franjas.");
    } finally {
      setCellBusy(false);
    }
  }

  async function confirmSelectedPaddockCells() {
    if (!selectedPotrero || !cellPreview || !canMutate || !networkOnline) return;
    const operationScopeKey = `${selectedPotrero.fieldId}:${selectedPotrero.id}`;
    const operationId = cellOperationIds[operationScopeKey]?.create;
    if (!operationId) return;
    setCellBusy(true);
    setCellError(null);
    try {
      const result = await confirmPaddockCellGeneration({
        fieldId: selectedPotrero.fieldId,
        paddockId: selectedPotrero.id,
        count: cellPreview.count,
        bearingDegrees: cellPreview.bearingDegrees,
        operationId,
        requestHash: cellPreview.requestHash,
        expectedSnapshotToken: cellPreview.snapshotToken,
      });
      const nextFieldCells: FieldActivePaddockCellListing = {
        fieldId: selectedPotrero.fieldId,
        snapshotToken: `field-active-cells-pending-refresh:${result.operationId}`,
        active: [...(fieldCells?.active ?? []).filter(({ paddockId }) => paddockId !== selectedPotrero.id), ...result.activeCells],
      };
      const nextListing: PaddockCellListing = {
        fieldId: selectedPotrero.fieldId,
        paddockId: selectedPotrero.id,
        snapshotToken: `paddock-cells-pending-refresh:${result.operationId}`,
        active: result.activeCells,
        history: [...result.closedCells, ...(selectedCellListing?.history ?? [])],
      };
      setFieldCells(nextFieldCells);
      setSelectedCellListing(nextListing);
      saveCachedSnapshot(fieldFeatureCacheKey("active-cells-v1", offlineScope, selectedPotrero.fieldId), nextFieldCells);
      saveCachedSnapshot(paddockCellsCacheKey(offlineScope, selectedPotrero.fieldId, selectedPotrero.id), nextListing);
      setCellPreview(null);
      setCellOperationIds((current) => ({
        ...current,
        [operationScopeKey]: { create: crypto.randomUUID(), close: current[operationScopeKey]?.close ?? crypto.randomUUID() },
      }));
      setCellsRefreshKey((value) => value + 1);
    } catch (error) {
      if (error instanceof PaddockCellApiError && error.status === 409) {
        setCellsRefreshKey((value) => value + 1);
        setCellError("Las franjas o el potrero cambiaron. Recargamos el estado; genera una nueva previsualización.");
        setCellPreview(null);
      } else {
        setCellError(error instanceof Error ? error.message : "No fue posible confirmar las franjas.");
      }
    } finally {
      setCellBusy(false);
    }
  }

  async function closeSelectedPaddockCells() {
    if (!selectedPotrero || !selectedCellListing || !canMutate || !networkOnline) return;
    const operationScopeKey = `${selectedPotrero.fieldId}:${selectedPotrero.id}`;
    const operationId = cellOperationIds[operationScopeKey]?.close;
    if (!operationId) return;
    setCellBusy(true);
    setCellError(null);
    try {
      const result = await closeActivePaddockCells({
        fieldId: selectedPotrero.fieldId,
        paddockId: selectedPotrero.id,
        operationId,
        expectedSnapshotToken: selectedCellListing.snapshotToken,
      });
      const nextFieldCells: FieldActivePaddockCellListing = {
        fieldId: selectedPotrero.fieldId,
        snapshotToken: `field-active-cells-pending-refresh:${result.operationId}`,
        active: (fieldCells?.active ?? []).filter(({ paddockId }) => paddockId !== selectedPotrero.id),
      };
      const nextListing: PaddockCellListing = {
        fieldId: selectedPotrero.fieldId,
        paddockId: selectedPotrero.id,
        snapshotToken: `paddock-cells-pending-refresh:${result.operationId}`,
        active: [],
        history: [...result.closedCells, ...(selectedCellListing?.history ?? [])],
      };
      setFieldCells(nextFieldCells);
      setSelectedCellListing(nextListing);
      saveCachedSnapshot(fieldFeatureCacheKey("active-cells-v1", offlineScope, selectedPotrero.fieldId), nextFieldCells);
      saveCachedSnapshot(paddockCellsCacheKey(offlineScope, selectedPotrero.fieldId, selectedPotrero.id), nextListing);
      setCellOperationIds((current) => ({
        ...current,
        [operationScopeKey]: { create: current[operationScopeKey]?.create ?? crypto.randomUUID(), close: crypto.randomUUID() },
      }));
      setCellsRefreshKey((value) => value + 1);
    } catch (error) {
      if (error instanceof PaddockCellApiError && error.status === 409) {
        setCellsRefreshKey((value) => value + 1);
        setCellError("Las franjas cambiaron antes del cierre. Recargamos el estado; confirma nuevamente.");
      } else {
        setCellError(error instanceof Error ? error.message : "No fue posible cerrar las franjas.");
      }
    } finally {
      setCellBusy(false);
    }
  }

  return (
    <AppShell activeSection="potreros" fieldName={selectedFundo?.name ?? pendingNewFundo?.name ?? (ready ? "Sin fundos" : "Cargando fundos…")} isDemo={isDemo} onRefresh={refreshModule} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> Gestión territorial
              </div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Fundos y potreros</h1>
              <p className="mt-1 max-w-xl text-sm text-ink-muted">Gestiona cada fundo por separado y registra lo que ocurre dentro de sus potreros.</p>
              {selectedFundo?.location && <p className="mt-1 text-[12px] font-bold text-ink-subtle">{selectedFundo.location}</p>}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-10 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-[12px] font-bold text-ink-muted shadow-sm">
                <CalendarDays size={15} className="text-accent" /> Temporada 2026–27
              </div>
              <SyncBadge state={syncState} />
              {canMutate && selectedFundo && (
                <button
                  className="flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[12px] font-black text-white shadow-lg shadow-ink/10"
                  data-hint="Baja al mapa para dibujar el potrero marcando sus esquinas. La superficie se calcula sola."
                  onClick={() => document.getElementById("mapa-fundo")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  type="button"
                >
                  <Plus size={16} /> Nuevo potrero en el mapa
                </button>
              )}
            </div>
          </div>

          {syncError && (
            <div aria-live="assertive" className="mt-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
              <CircleAlert className="mt-0.5 shrink-0" size={18} />
              <div>
                <p className="font-black">La sincronización requiere atención</p>
                <p className="mt-1 text-xs font-semibold">{syncError}</p>
              </div>
            </div>
          )}

          <FundoSelector
            canCreate={canCreateFundo}
            canEdit={canMutate}
            createDisabledReason={createFundoDisabledReason}
            fieldLimit={organizationPlan?.fieldLimit ?? null}
            fundos={fundos}
            onCreate={() => setFundoCreateOpen(true)}
            onEdit={() => { if (canMutate) setFundoEditOpen(true); }}
            onImport={() => setImportMapOpen(true)}
            onSelect={(fundoId) => {
              setMapFullscreen(false);
              setSelectedFundoId(fundoId);
              setSelectedId(null);
              setSelectedIds([]);
              setSelectionMode(false);
              setShowArchived(false);
              setArchivedPotreros([]);
              setDraftPoints([]);
              cancelBoundaryEditing(false);
              cancelSubdivision();
              cancelPotreroBoundaryEditing();
              cancelExclusionDrawing();
              setImportMapOpen(false);
              setCellsDialogOpen(false);
              setCellPreview(null);
              setCellBearingDegrees(null);
              setFieldLandmarkDraft(null);
            }}
            paddockCounts={paddockCounts}
            paddockLimit={organizationPlan?.paddockLimit ?? null}
            selectedId={selectedFundoId}
            totalPaddocks={potreros.length}
          />

          <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat helpText="Hectáreas que realmente se pueden pastorear: la superficie total menos las zonas excluidas como quebradas, bosque o caminos." icon={MapIcon} label="Superficie útil" value={`${(fieldStockingLoad?.effectiveGrazeableAreaHectares ?? totalUsefulHectares).toLocaleString("es-CL", { maximumFractionDigits: 1 })} ha`} detail={`${(fieldStockingLoad?.grossAreaHectares ?? totalHectares).toLocaleString("es-CL", { maximumFractionDigits: 1 })} ha totales`} tone="green" />
            <Stat help="potreroPotrero" icon={Sprout} label="Potreros" value={String(visiblePotreros.length)} detail={`${visiblePotreros.filter((item) => paddockAreaMetrics(item).geometry.holes.length > 0).length} con exclusiones`} />
            <Stat helpText="Animales que hoy están asignados a algún potrero de este fundo." icon={Beef} label="Animales" value={stockingLoadState === "loading" ? "…" : fieldStockingLoad?.animalCount.toLocaleString("es-CL") ?? "—"} detail={stockingLoadState === "offline" ? "Requiere conexión" : "Asignados a potreros"} />
            <Stat helpText="Cuántos animales hay por hectárea útil. Es la medida de si el campo está sobrecargado: demasiada carga agota la pradera." icon={TrendingUp} label="Carga animal" value={stockingLoadState === "loading" ? "…" : fieldStockingLoad?.animalsPerHectare === null || !fieldStockingLoad ? "—" : fieldStockingLoad.animalsPerHectare.toLocaleString("es-CL", { maximumFractionDigits: 2 })} detail="animales por ha útil" tone="amber" />
          </div>

          <RotationOverviewPanel
            canMutate={canMutate}
            loadState={rotationLoadState}
            networkOnline={networkOnline}
            onSaveSettings={saveRotationThresholds}
            snapshot={rotationSnapshot}
          />

          <FieldLandmarksPanel
            busy={fieldLandmarkBusy}
            canMutate={canMutate}
            draft={fieldLandmarkDraft}
            error={fieldLandmarkError}
            landmarks={fieldLandmarks?.active ?? []}
            loadState={fieldLandmarkLoadState}
            onArchive={archiveFieldLandmark}
            onCancel={() => { setFieldLandmarkDraft(null); setFieldLandmarkError(null); }}
            onEdit={(landmark) => { editFieldLandmark(landmark); focusMapEditor(); }}
            onStart={(geometryType) => { startFieldLandmark(geometryType); focusMapEditor(); }}
            paddocks={visiblePotreros}
          />

          <PaddockNdviPanel
            canRefresh={canMutate && networkOnline && !isDemo}
            error={ndviError}
            listing={ndviListing}
            loadState={ndviLoadState}
            onRefresh={refreshNdviOnDemand}
            refreshing={ndviRefreshing}
          />

          {(fieldCellsLoadState === "offline" || fieldCellsLoadState === "stale") && fieldCells && (
            <p className="mt-2 text-[12px] font-bold text-amber-800" role="status">Franjas del mapa cargadas desde la última copia local; se actualizarán al recuperar conexión.</p>
          )}

          {fieldHasExclusions && (
            <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900" role="status">
              <CircleAlert className="mt-0.5 shrink-0" size={17} />
              F1 mantiene bloqueados el rediseño del fundo y toda subdivisión o fusión que incluya potreros con exclusiones. Las exclusiones siguen visibles y editables por separado.
            </div>
          )}

          <div
            aria-label={mapFullscreen ? "Editor de mapa en pantalla completa" : undefined}
            aria-modal={mapFullscreen ? "true" : undefined}
            className={mapFullscreen
              ? "fixed inset-0 z-[2000] grid min-h-0 grid-rows-1 bg-ink p-2 sm:p-3"
              : "mt-5 grid items-stretch"}
            role={mapFullscreen ? "dialog" : undefined}
          >
            <section
              className={`min-h-0 overflow-hidden border bg-white shadow-[0_12px_45px_rgba(35,50,42,0.07)] ${
                mapFullscreen ? "rounded-[20px] border-white/15 p-1.5 sm:rounded-[24px] sm:p-2" : "rounded-[24px] border-line-steel p-2"
              }`}
              id="mapa-fundo"
            >
              <MapaPotreros
                activeCells={fieldCells?.active ?? []}
                boundaryDraft={boundaryDraft}
                boundaryEditing={boundaryEditing}
                boundaryPaddockDrafts={fieldBoundaryPaddockDrafts}
                boundaryValidation={boundaryValidation}
                canMutate={canMutate}
                cellBearingDraft={cellsDialogOpen && selectedPotrero && cellBearingDegrees !== null ? { paddockId: selectedPotrero.id, bearingDegrees: cellBearingDegrees } : null}
                cellPreview={cellPreview}
                draftPoints={draftPoints}
                exclusionDraft={exclusionDraft}
                exclusionMode={exclusionMode}
                draftValidation={draftValidation}
                fundo={selectedFundo}
                landmarks={fieldLandmarks?.active ?? []}
                landmarkBusy={fieldLandmarkBusy}
                landmarkDraft={fieldLandmarkDraft}
                landmarkError={fieldLandmarkError}
                fullscreen={mapFullscreen}
                networkOnline={networkOnline}
                onBoundaryCancel={cancelBoundaryEditing}
                onBoundaryDraftChange={(points, drafts) => {
                  setBoundaryDraft(cloneRing(points));
                  setFieldBoundaryPaddockDrafts(
                    drafts ? cloneBoundaryDrafts(drafts) : boundaryDraftsFromPaddocks(visiblePotreros),
                  );
                }}
                onBoundarySave={saveBoundary}
                onCellBearingChange={(bearing) => { setCellBearingDegrees(bearing); setCellPreview(null); }}
                onCreateSaveRequest={() => { void createPaddockFromDraft(); }}
                onDraftChange={setDraftPoints}
                onExclusionCancel={cancelExclusionDrawing}
                onExclusionDraftChange={(points) => { setExclusionDraft(points); setExclusionError(null); setExclusionPreview(null); }}
                onExclusionEdit={startExclusionEditing}
                onExclusionKindChange={changeExclusionKind}
                onExclusionPreview={previewExclusion}
                onFieldExclusionStart={() => {
                  if (selectedFundo) openExclusionSetup({ kind: "field", fieldId: selectedFundo.id, fieldName: selectedFundo.name });
                }}
                onLandmarkArchive={(landmark) => { void archiveFieldLandmark(landmark); }}
                onLandmarkDraftChange={(geometry) => setFieldLandmarkDraft((current) => current ? { ...current, geometry } : current)}
                onLandmarkDrawCancel={() => { setFieldLandmarkDraft(null); setFieldLandmarkError(null); }}
                onLandmarkEdit={editFieldLandmark}
                onLandmarkSave={saveFieldLandmarkDraft}
                onPaddockLandmarkStart={startFieldLandmark}
                onPotreroCellsOpen={openCellsDialog}
                onPotreroDelete={() => setManageMode("delete")}
                onPotreroEdit={() => setManageMode("edit")}
                onPotreroExclusionStart={() => {
                  if (selectedPotrero) openExclusionSetup({ kind: "paddock", fieldId: selectedPotrero.fieldId, paddockId: selectedPotrero.id, paddockName: selectedPotrero.name });
                }}
                onPotreroBoundaryEdit={startPotreroBoundaryEditing}
                onPotreroSubdivide={() => { void startSelectedPotreroSubdivision(); }}
                onPotreroUndo={() => { void undoSelectedPaddockOperation(); }}
                onFullscreenToggle={() => setMapFullscreen(!mapFullscreen)}
                onSelect={setSelectedId}
                onPotreroBoundaryCancel={cancelPotreroBoundaryEditing}
                onPotreroBoundaryDraftsChange={(drafts) => {
                  setPotreroBoundaryDrafts(cloneBoundaryDrafts(drafts));
                  setPotreroBoundaryCapturedWithGps(false);
                }}
                onPotreroGpsBoundaryDraftApply={(points) => {
                  if (!potreroBoundaryEditingId) return;
                  setPotreroBoundaryDrafts((current) => ({
                    ...cloneBoundaryDrafts(current),
                    [potreroBoundaryEditingId]: points.map(([latitude, longitude]): Coordinate => [latitude, longitude]),
                  }));
                  setPotreroBoundaryCapturedWithGps(true);
                }}
                onPotreroBoundarySave={savePotreroBoundary}
                onSubdivisionApply={applySubdivisionLine}
                onSubdivisionCancel={cancelSubdivision}
                onSubdivisionDiscard={() => { void discardSubdivision(); }}
                onSubdivisionLineChange={(points) => { setSubdivisionLine(points); setSubdivisionError(null); setSubdivisionDraftState("saving"); }}
                onSubdivisionRestart={restartSubdivisionFromBoundary}
                onSubdivisionSaveRequest={() => { void openSubdivisionConfirmation(); }}
                onSubdivisionStart={startSubdivision}
                onSubdivisionUndo={undoSubdivision}
                potreros={visiblePotreros}
                potreroBoundaryDraft={potreroBoundaryDraft}
                potreroBoundaryDrafts={potreroBoundaryDrafts}
                potreroBoundaryEditingId={potreroBoundaryEditingId}
                potreroBoundaryName={selectedPotrero?.name ?? null}
                potreroBoundaryValidation={potreroBoundaryValidation}
                potreroUndoPreview={undoPreview}
                selectedId={selectedId}
                selectedIds={selectedIds}
                selectedPotrero={selectedPotrero}
                selectedPotreroCanMutate={canMutate && !(selectedPotrero as Phase1Potrero | null)?.archivedAt}
                selectedPotreroCellCount={selectedPotrero
                  ? selectedCellListing?.paddockId === selectedPotrero.id
                    ? selectedCellListing.active.length
                    : fieldCells?.active.filter(({ paddockId }) => paddockId === selectedPotrero.id).length ?? 0
                  : 0}
                selectedPotreroOperationsEnabled={structuralOperationsEnabled && !(selectedPotrero as Phase1Potrero | null)?.archivedAt}
                selectedPotreroStockingLoad={selectedStockingLoad}
                rotationSnapshot={rotationSnapshot}
                ndviValues={ndviListing?.values ?? []}
                structuralOperationsEnabled={fieldStructuralOperationsEnabled}
                subdivisionCanUndo={subdivisionHistory.length > 1}
                subdivisionDraftState={subdivisionDraftState}
                subdivisionError={subdivisionError}
                subdivisionLine={subdivisionLine}
                subdivisionMode={subdivisionMode}
                subdivisionPolygons={subdivisionPolygons}
                subdivisionRestored={subdivisionRestored}
                subdivisionScope={subdivisionScope}
                subdivisionStartCount={subdivisionStartCount}
                subdivisionStartSource={subdivisionStartSource}
                subdivisionValidation={subdivisionValidation}
                stockingLoadsByPaddock={stockingLoadsByPaddock}
                thematicStorageScope={offlineScope}
              />
            </section>
          </div>

          {selectedPotrero && (
            <div className="mt-5">
              <HistorialPotrero
                activities={selectedActivities}
                canMutate={canMutate && !(selectedPotrero as Phase1Potrero).archivedAt}
                onClose={() => { setSelectedId(null); cancelPotreroBoundaryEditing(); }}
                onEditExclusion={(index) => startExclusionEditing(selectedPotrero.id, index)}
                onManageActivity={setManagedActivity}
                onRemoveExclusion={(index) => { void removeSelectedExclusion(index); }}
                onSave={saveActivity}
                potrero={selectedPotrero}
                networkOnline={networkOnline}
                ndvi={ndviListing?.values.find(({ paddockId }) => paddockId === selectedPotrero.id) ?? null}
                ndviLoadState={ndviLoadState}
                stockingLoad={selectedStockingLoad}
                stockingLoadState={stockingLoadState}
              />
            </div>
          )}

          <div className="mt-5 pb-8">
            <ListaPotreros
              archivedPotreros={archivedPotreros}
              canMutate={canMutate}
              onMerge={() => { void openMergeConfirmation(); }}
              onSelect={setSelectedId}
              onSelectionModeChange={(enabled) => { setSelectionMode(enabled); if (!enabled) setSelectedIds([]); }}
              onShowArchivedChange={setShowArchived}
              onToggleSelection={toggleSelectedForMerge}
              potreros={visiblePotreros}
              selectedId={selectedId}
              selectedIds={selectedIds}
              selectionMode={selectionMode}
              showArchived={showArchived}
              structuralOperationsEnabled={mergeStructuralOperationsEnabled}
              rotationSnapshot={rotationSnapshot}
            />
          </div>
        </div>
      </div>

      {canMutate && exclusionSetupScope && (
        <ExclusionSetupDialog
          networkOnline={networkOnline}
          onClose={() => setExclusionSetupScope(null)}
          onStart={beginExclusionDrawing}
          scope={exclusionSetupScope}
        />
      )}

      {cellsDialogOpen && selectedPotrero && (
        <PaddockCellsDialog
          bearingDegrees={cellBearingDegrees}
          busy={cellBusy}
          canMutate={canMutate && !(selectedPotrero as Phase1Potrero).archivedAt}
          error={cellError}
          listing={selectedCellListing?.paddockId === selectedPotrero.id ? selectedCellListing : null}
          networkOnline={networkOnline}
          onBearingChange={(bearing) => { setCellBearingDegrees(bearing); setCellPreview(null); }}
          onClose={() => { setCellsDialogOpen(false); setCellPreview(null); setCellBearingDegrees(null); setCellError(null); }}
          onCloseActive={closeSelectedPaddockCells}
          onConfirm={confirmSelectedPaddockCells}
          onPreview={previewSelectedPaddockCells}
          potrero={selectedPotrero}
          preview={cellPreview}
        />
      )}

      {selectedFundo && importMapOpen && (
        <ImportBoundariesDialog
          canMutate={canMutate}
          fundo={selectedFundo}
          key={selectedFundo.id}
          networkOnline={networkOnline}
          onClose={() => setImportMapOpen(false)}
          onPersistFieldBoundary={persistImportedFieldBoundary}
          onPersistLandmark={persistImportedLandmark}
          onPersistPaddock={persistImportedPaddock}
          paddocks={visiblePotreros}
          validateCommitPlan={reviewImportedCommitPlan}
        />
      )}

      {canMutate && exclusionPreview && (
        <ExclusionPreviewDialog
          error={exclusionError}
          onCancel={() => { setExclusionPreview(null); setExclusionError(null); }}
          onConfirm={() => { void confirmExclusion(); }}
          preview={exclusionPreview}
          saving={exclusionSaving}
        />
      )}

      {canMutate && selectedPotrero && manageMode && (
        <ManagePotreroDialog
          initialMode={manageMode}
          key={`${selectedPotrero.id}-${manageMode}`}
          onClose={() => setManageMode(null)}
          onDelete={deleteSelectedPotrero}
          onSave={updatePotrero}
          potrero={selectedPotrero}
        />
      )}

      {canMutate && selectedFundo && fundoEditOpen && (
        <ManageFundoDialog
          fundo={selectedFundo}
          key={selectedFundo.id}
          onClose={() => setFundoEditOpen(false)}
          onEditBoundary={startBoundaryEditing}
          onSave={updateFundo}
        />
      )}

      {canMutate && fundoCreateOpen && (
        <CreateFundoDialog
          onClose={() => setFundoCreateOpen(false)}
          onStart={startNewFundo}
        />
      )}

      {canMutate && managedActivity && (
        <ManageActivityDialog
          activity={managedActivity}
          key={managedActivity.id}
          onClose={() => setManagedActivity(null)}
          onDelete={deleteManagedActivity}
          onSave={updateActivity}
        />
      )}

      {selectedFundo && subdivisionConfirmOpen && pendingOperation && operationPreview && (
        <BulkSubdivisionDialog
          assignedLotCount={operationPreview.lotMoves.filter((move) => !move.destinationPaddockId).length}
          blockers={operationPreview.blockers}
          existingActivityCount={operationPreview.activityCount}
          existingPotreroCount={operationPreview.parents.length}
          fundo={selectedFundo}
          lotMoves={operationPreview.lotMoves}
          onClose={() => { setSubdivisionConfirmOpen(false); setOperationPreview(null); setPendingOperation(null); }}
          onConfirm={confirmSubdivision}
          operation={pendingOperation.kind}
          polygons={pendingOperation.polygons}
          sourcePaddockNames={operationPreview.parents.map((potrero) => potrero.name)}
          warnings={operationPreview.warnings}
        />
      )}
    </AppShell>
  );
}

function buildProposedPaddocks(
  pending: PendingPaddockOperation,
  prefix: string,
  sector: string,
  fundo: Fundo,
  currentPaddocks: Potrero[],
): Potrero[] {
  const sources = currentPaddocks.filter((potrero) => pending.parentPaddockIds.includes(potrero.id));
  const largestSource = [...sources].sort((first, second) => second.areaHectares - first.areaHectares)[0];
  const mergedSoil = weightedSoil(sources);
  return pending.polygons.map((coordinates, index) => ({
    id: pending.proposedPaddockIds[index],
    fieldId: fundo.id,
    name: pending.kind === "merge" ? prefix : `${prefix} ${index + 1}`,
    sector,
    areaHectares: calculateHectares(coordinates),
    coordinates,
    soil: pending.kind === "redesign"
      ? { ph: null, nitrogen: null, phosphorus: null, potassium: null }
      : pending.kind === "merge"
        ? mergedSoil
        : largestSource?.soil ?? { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    lastActivity: pending.kind === "split"
      ? `Creado · subdivisión de ${largestSource?.name ?? "potrero"}`
      : pending.kind === "merge"
        ? "Creado · fusión de potreros"
        : "Creado · rediseño del fundo",
    status: "Disponible",
  }));
}

function weightedSoil(sources: Potrero[]): Potrero["soil"] {
  const weightedValue = (key: keyof Potrero["soil"]) => {
    const samples = sources
      .map((source) => ({ value: source.soil[key], weight: source.areaHectares }))
      .filter((sample): sample is { value: number; weight: number } => sample.value !== null && sample.weight > 0);
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    return weight > 0 ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight : null;
  };
  return {
    ph: weightedValue("ph"),
    nitrogen: weightedValue("nitrogen"),
    phosphorus: weightedValue("phosphorus"),
    potassium: weightedValue("potassium"),
  };
}

function fieldSnapshotToken(fundo: Fundo, paddocks: Potrero[]) {
  const serverToken = (fundo as Phase1Fundo).snapshotToken;
  if (serverToken) return serverToken;
  return JSON.stringify({
    field: [fundo.id, fundo.coordinates],
    paddocks: paddocks.map((potrero) => [potrero.id, potrero.updatedAt ?? null, potrero.coordinates]),
  });
}

function reconcileArchivedPaddocks(current: Potrero[], result: PaddockOperationResult) {
  const activeIds = new Set(result.activePaddocks.map((potrero) => potrero.id));
  return [...new Map([...current, ...result.archivedPaddocks].map((potrero) => [potrero.id, potrero])).values()]
    .filter((potrero) => !activeIds.has(potrero.id))
    .sort((first, second) => POTRERO_NAME_COLLATOR.compare(first.name, second.name));
}

function emptyOperationPreview(parents: Potrero[], proposedPaddocks: Potrero[], snapshotToken: string): PaddockOperationPreview {
  return {
    requestHash: "local-validation-blocked",
    snapshotToken,
    parents,
    proposedPaddocks,
    lotMoves: [],
    activityCount: 0,
    warnings: [],
    blockers: [],
    valid: false,
  };
}

function mergeOperationPreview(remote: PaddockOperationPreview, local: GeometryOperationPlan | null): PaddockOperationPreview {
  if (!local) return remote;
  const blockers = uniqueMessages([...local.blockers, ...remote.blockers]);
  return {
    ...remote,
    warnings: uniqueMessages([...local.warnings, ...remote.warnings]),
    blockers,
    valid: remote.valid && blockers.length === 0,
  };
}

function uniqueMessages(messages: string[]) {
  return [...new Set(messages)];
}

function clonePolygonRings(geometry: PolygonRings): PolygonRings {
  return {
    outer: geometry.outer.map(([latitude, longitude]) => [latitude, longitude]),
    holes: geometry.holes.map((hole) => hole.map(([latitude, longitude]) => [latitude, longitude])),
  };
}

function sameImportedPotrero(existing: Potrero, requested: Potrero) {
  return JSON.stringify({
    fieldId: existing.fieldId,
    name: existing.name,
    sector: existing.sector,
    coordinates: existing.coordinates,
    geometry: existing.geometry ?? { outer: existing.coordinates, holes: [] },
    holeKinds: existing.holeKinds ?? [],
    soil: existing.soil,
    lastActivity: existing.lastActivity,
    status: existing.status,
  }) === JSON.stringify({
    fieldId: requested.fieldId,
    name: requested.name,
    sector: requested.sector,
    coordinates: requested.coordinates,
    geometry: requested.geometry ?? { outer: requested.coordinates, holes: [] },
    holeKinds: requested.holeKinds ?? [],
    soil: requested.soil,
    lastActivity: requested.lastActivity,
    status: requested.status,
  });
}

function isConflictError(error: unknown) {
  return (error instanceof PaddockOperationApiError || error instanceof SubdivisionDraftApiError) && error.status === 409
    || error instanceof Error && /\b409\b|conflict|cambiaron|desactualiz/i.test(error.message);
}

async function fetchPaddockOperationPreview(request: PaddockOperationRequest): Promise<PaddockOperationPreview> {
  const preview: ServerPaddockOperationPreview = await fetchServerPaddockOperationPreview(request);
  const destinationNames = new Map(preview.proposedPaddocks.map((potrero) => [potrero.id, potrero.name]));
  return {
    requestHash: preview.requestHash,
    snapshotToken: preview.snapshotToken,
    parents: preview.parents,
    proposedPaddocks: preview.proposedPaddocks,
    lotMoves: preview.lotMoves.map((move) => ({
      lotId: move.lotId,
      destinationPaddockId: move.toPaddockId,
      destinationPaddockName: move.toPaddockId ? destinationNames.get(move.toPaddockId) ?? null : null,
      overlapRatio: move.overlapRatio,
      warning: move.warning,
    })),
    activityCount: preview.activityCount,
    warnings: preview.warnings,
    blockers: preview.blockers,
    valid: preview.valid,
  };
}

async function fetchScopedSubdivisionDraft(scope: SubdivisionScope): Promise<{ draft: ScopedSubdivisionDraft | null; baseSnapshotToken: string }> {
  return fetchServerScopedSubdivisionDraft(scope.fieldId, scope.kind, subdivisionScopeId(scope));
}

async function persistScopedSubdivisionDraft(
  scope: SubdivisionScope,
  baseSnapshotToken: string,
  expectedUpdatedAt: string | null,
  history: Coordinate[][][],
  line: Coordinate[],
): Promise<ScopedSubdivisionDraft> {
  const scopeId = subdivisionScopeId(scope);
  return persistServerScopedSubdivisionDraft({
    id: `subdivision-draft:${scope.fieldId}:${scope.kind}:${scopeId}`,
    fieldId: scope.fieldId,
    scopeKind: scope.kind,
    scopeId,
    baseSnapshotToken,
    history,
    line,
    updatedAt: expectedUpdatedAt ?? "",
  }, expectedUpdatedAt);
}

async function removeScopedSubdivisionDraft(scope: SubdivisionScope, expectedUpdatedAt: string) {
  return removeServerScopedSubdivisionDraft(scope.fieldId, scope.kind, subdivisionScopeId(scope), expectedUpdatedAt);
}

function subdivisionScopeId(scope: SubdivisionScope) {
  return scope.kind === "field" ? scope.fieldId : scope.paddockId;
}

function validateGeometryCollection(polygons: Coordinate[][], fundo: Coordinate[], labels?: string[]): GeometryValidation {
  return validatePotreroGeometryCollection(polygons, fundo, labels);
}

function validateFundoBoundaryChange(candidate: Coordinate[], current: Coordinate[], potreros: Potrero[]): GeometryValidation {
  const boundaryValidation = validatePotreroGeometry(candidate, [], candidate);
  const impactWarnings = potreros.flatMap((potrero) => {
    const previousWarnings = new Set(validatePotreroGeometry(potrero.coordinates, [], current).warnings);
    return validatePotreroGeometry(potrero.coordinates, [], candidate).warnings
      .filter((warning) => !previousWarnings.has(warning))
      .map((warning) => `${potrero.name}: ${warning}`);
  });
  return mergeGeometryValidations([boundaryValidation, { errors: [], warnings: impactWarnings }]);
}

function validateLinkedFundoBoundaryChange(
  candidate: Coordinate[],
  current: Coordinate[],
  potreros: Potrero[],
  drafts: BoundaryDrafts,
  changedIds: string[],
): GeometryValidation {
  const updates = buildLinkedBoundaryPaddockUpdates(potreros, drafts, changedIds);
  const updatesById = new Map(updates.map((potrero) => [potrero.id, potrero]));
  const finalPotreros = potreros.map((potrero) => updatesById.get(potrero.id) ?? potrero);
  return mergeGeometryValidations([
    validateFundoBoundaryChange(candidate, current, finalPotreros),
    ...updates.map((potrero) => prefixGeometryValidation(validatePotreroGeometry(
      potrero.coordinates,
      finalPotreros.filter((sibling) => sibling.id !== potrero.id).map((sibling) => sibling.coordinates),
      candidate,
    ), potrero.name)),
  ]);
}

function buildLinkedBoundaryPaddockUpdates(
  potreros: Potrero[],
  drafts: BoundaryDrafts,
  changedIds: string[],
): Potrero[] {
  const changed = new Set(changedIds);
  return potreros.flatMap((potrero) => {
    if (!changed.has(potrero.id)) return [];
    const outer = drafts[potrero.id];
    if (!outer || outer.length < 3) return [];
    const currentGeometry = potrero.geometry ?? { outer: potrero.coordinates, holes: [] };
    const geometry: PolygonRings = { outer: cloneRing(outer), holes: currentGeometry.holes.map(cloneRing) };
    const grossAreaHectares = calculateGrossHectares(geometry);
    const netAreaHectares = calculateHectares(geometry);
    const currentManual = potrero.grazeableAreaHectares ?? null;
    const grazeableAreaHectares = currentManual !== null && currentManual > netAreaHectares
      ? netAreaHectares
      : currentManual;
    return [{
      ...potrero,
      coordinates: geometry.outer,
      geometry,
      areaHectares: grossAreaHectares,
      netAreaHectares,
      grazeableAreaHectares,
      effectiveGrazeableAreaHectares: grazeableAreaHectares ?? netAreaHectares,
    }];
  });
}

function boundaryDraftsFromPaddocks(potreros: Potrero[]): BoundaryDrafts {
  return Object.fromEntries(potreros.map((potrero) => [potrero.id, cloneRing(potrero.coordinates)]));
}

function cloneRing(ring: readonly Coordinate[]): Coordinate[] {
  return ring.map(([latitude, longitude]) => [latitude, longitude]);
}

function prefixGeometryValidation(validation: GeometryValidation, label: string): GeometryValidation {
  return {
    errors: validation.errors.map((message) => `${label}: ${message}`),
    warnings: validation.warnings.map((message) => `${label}: ${message}`),
  };
}

function mergeGeometryValidations(validations: GeometryValidation[]): GeometryValidation {
  return {
    errors: [...new Set(validations.flatMap((validation) => validation.errors))],
    warnings: [...new Set(validations.flatMap((validation) => validation.warnings))],
  };
}

function requireGeometryApproval(validation: GeometryValidation, action: string) {
  if (validation.errors.length > 0) {
    throw new Error(`No se puede ${action}:\n• ${validation.errors.join("\n• ")}`);
  }
  if (validation.warnings.length === 0) return;
  const confirmed = window.confirm(
    `Hay advertencias geométricas antes de ${action}:\n\n• ${validation.warnings.join("\n• ")}\n\n¿Deseas continuar de todos modos?`,
  );
  if (!confirmed) throw new Error("Guardado cancelado. Revisa las advertencias geométricas antes de continuar.");
}

function sortActivities(items: Activity[]) {
  return [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));
}

function landmarkListingFromSnapshot(fieldId: string, landmarks: FieldLandmark[]): FieldLandmarkListing {
  return {
    fieldId,
    active: landmarks.filter((landmark) => landmark.fieldId === fieldId && landmark.deletedAt === null),
    archived: landmarks.filter((landmark) => landmark.fieldId === fieldId && landmark.deletedAt !== null),
  };
}

/** Map-born paddocks need a free name up front; the operator renames it in the edit dialog. */
function nextAvailablePaddockName(paddocks: readonly Potrero[]): string {
  const used = new Set(paddocks.map((paddock) => paddock.name.trim().toLocaleLowerCase("es-CL")));
  for (let index = paddocks.length + 1; ; index += 1) {
    const candidate = `Potrero ${index}`;
    if (!used.has(candidate.toLocaleLowerCase("es-CL"))) return candidate;
  }
}

function SyncBadge({ state }: { state: SyncState }) {
  const options = {
    synced: {
      icon: Cloud,
      label: "Guardado en la nube",
      className: "border-line-steel bg-surface-alt text-accent",
    },
    syncing: {
      icon: RefreshCw,
      label: "Sincronizando",
      className: "border-line-steel bg-white text-ink-muted",
    },
    offline: {
      icon: CloudOff,
      label: "Sin conexión · guardado local",
      className: "border-warn-bar bg-surface-alt text-warn-ink",
    },
    error: {
      icon: CircleAlert,
      label: "Requiere atención",
      className: "border-red-200 bg-red-50 text-red-800",
    },
  } as const;

  const option = options[state];
  const Icon = option.icon;

  return (
    <div
      className={`flex h-10 items-center gap-2 rounded-xl border px-3 text-[12px] font-bold ${option.className}`}
      data-hint={HELP.sincronizacion}
    >
      <Icon size={15} className={state === "syncing" ? "animate-spin" : ""} /> {option.label}
    </div>
  );
}

function Stat({ help, helpText, icon: Icon, label, value, detail, tone = "default" }: { help?: HelpKey; helpText?: string; icon: LucideIcon; label: string; value: string; detail?: string; tone?: "default" | "green" | "amber" }) {
  const tones = {
    default: "bg-white text-accent",
    green: "bg-ink text-white",
    amber: "bg-surface-alt text-warn-ink",
  };

  return (
    <div className={`rounded-[18px] border border-line-steel p-4 shadow-[0_6px_24px_rgba(35,50,42,0.04)] ${tones[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] ${tone === "green" ? "text-white/50" : "text-ink-subtle"}`}>{label}<HelpTip help={help} label={label} text={helpText} tone={tone === "green" ? "inverse" : "muted"} /></p>
          <p className={`mt-2 text-2xl font-black tracking-[-0.045em] ${tone === "green" ? "text-white" : "text-ink"}`}>{value}</p>
          {detail && <p className={`mt-1 text-[12px] font-semibold ${tone === "green" ? "text-white/50" : "text-ink-subtle"}`}>{detail}</p>}
        </div>
        <span className={`grid size-9 place-items-center rounded-xl ${tone === "green" ? "bg-white/10" : tone === "amber" ? "bg-warn-bg" : "bg-surface-alt"}`}>
          <Icon size={17} />
        </span>
      </div>
    </div>
  );
}
