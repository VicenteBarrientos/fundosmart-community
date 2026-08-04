"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Cloud,
  CloudOff,
  Droplets,
  Eye,
  EyeOff,
  Layers3,
  LocateFixed,
  LoaderCircle,
  Magnet,
  Maximize2,
  Minimize2,
  MousePointer2,
  Navigation,
  Palette,
  Pencil,
  PencilRuler,
  Redo2,
  RotateCcw,
  Ruler,
  ScissorsLineDashed,
  Tags,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { divIcon, type Layer as LeafletLayer } from "leaflet";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "../../../core/maps/leaflet-react";
import { shouldDegradeOnStatus } from "../../../core/maps/tile-policy.mjs";
import type { Coordinate, ExclusionKind, Fundo, PaddockStockingLoad, Potrero } from "../types";
import { useGpsBoundaryCapture, type UseGpsBoundaryCaptureResult } from "../hooks/useGpsBoundaryCapture";
import {
  activeBasemap as resolveActiveBasemap,
  arcgisBasemapKey,
  type BasemapDefinition,
  type BasemapId,
  type BasemapSurface,
} from "../workspace/map-preferences";
import {
  createTileUsageReporter,
  type TileUsageReporter,
} from "../workspace/tile-usage-reporter";
import { useMapViewPreferences } from "../workspace/useMapViewPreferences";
import { useMapWorkspace } from "../workspace/useMapWorkspace";
import type { PaddockCell, PaddockCellGenerationPreview, PaddockRotationSnapshot } from "../domain/cells-rotation";
import type { FieldLandmark, FieldLandmarkGeometryType, FieldLandmarkKind } from "../domain/field-landmarks";
import type { PaddockNdviListingItem } from "../domain/paddock-ndvi";
import { calculateHectares, calculatePathLengthMeters, calculatePerimeterMeters } from "../utils/geometry";
import {
  boundaryRingsEqual,
  changedBoundaryDraftIds,
  cloneBoundaryDrafts,
  edgeMidpoint,
  insertBoundaryVertex,
  insertLinkedFieldBoundaryVertex,
  insertVertex,
  moveBoundaryVertex,
  moveLinkedFieldBoundaryVertex,
  moveVertex,
  removeBoundaryVertex,
  removeLinkedFieldBoundaryVertex,
  removeVertex,
  type BoundaryDrafts,
} from "../utils/boundary-editor";
import { EXCLUSION_KIND_COLORS, EXCLUSION_KIND_LABELS, type ExclusionScope } from "../utils/exclusions";
import { paddockAreaMetrics, paddockGeometry } from "../utils/paddock-metrics";
import {
  PADDOCK_THEMATIC_MODE_LABELS,
  getPaddockLegend,
  getPaddockStyle,
  type PaddockThematicMode,
} from "../utils/paddock-style";
import { closestPointOnSegment, nearestSubdivisionBoundaryPoint } from "../utils/subdivide";
import { gpsBoundaryCoordinatesToDraft } from "../utils/gps-capture";
import {
  createMapEditCommandFacade,
  createMapEditTransaction,
  type MapAdapterDispatchResult,
  type MapEditCommandFacade,
  type MapInteractionAdapterLease,
} from "../map-core";
import { FIELD_LANDMARK_KIND_LABELS, type FieldLandmarkEditorDraft } from "./FieldLandmarksPanel";
import type { UndoPreview } from "./HistorialPotrero";
import { MapLandmarkForm } from "./MapLandmarkForm";
import { MapPotreroPanel } from "./MapPotreroPanel";
import {
  createLeafletCreatePaddockAdapter,
  type LeafletCreatePaddockAdapter,
} from "./map/leaflet-create-paddock-adapter";

type GeometryValidationFeedback = {
  errors: string[];
  warnings: string[];
};

export type SubdivisionScope =
  | { kind: "field"; fieldId: string }
  | { kind: "paddock"; fieldId: string; paddockId: string; paddockName: string };

export type ExclusionDrawMode =
  | { action: "create"; scope: ExclusionScope; kind: ExclusionKind }
  | {
      action: "edit";
      scope: Extract<ExclusionScope, { kind: "paddock" }>;
      kind: ExclusionKind;
      exclusionIndex: number;
    };

type MapaPotrerosProps = {
  potreros: Potrero[];
  fundo: Fundo | null;
  canMutate: boolean;
  structuralOperationsEnabled: boolean;
  networkOnline: boolean;
  fullscreen: boolean;
  boundaryEditing: boolean;
  boundaryDraft: Coordinate[];
  boundaryPaddockDrafts: BoundaryDrafts;
  draftPoints: Coordinate[];
  selectedId: string | null;
  selectedIds: string[];
  onDraftChange: (points: Coordinate[]) => void;
  onCreateSaveRequest: () => void;
  onSelect: (id: string | null) => void;
  onBoundaryDraftChange: (points: Coordinate[], paddockDrafts?: BoundaryDrafts) => void;
  onBoundarySave: () => Promise<void>;
  onBoundaryCancel: () => void;
  potreroBoundaryEditingId: string | null;
  potreroBoundaryDraft: Coordinate[];
  potreroBoundaryDrafts: BoundaryDrafts;
  potreroBoundaryName: string | null;
  onPotreroBoundaryDraftsChange: (drafts: BoundaryDrafts) => void;
  onPotreroGpsBoundaryDraftApply: (points: Coordinate[]) => void;
  onPotreroBoundarySave: () => Promise<void>;
  onPotreroBoundaryCancel: () => void;
  subdivisionMode: boolean;
  subdivisionScope: SubdivisionScope | null;
  subdivisionPolygons: Coordinate[][];
  subdivisionLine: Coordinate[];
  subdivisionCanUndo: boolean;
  subdivisionDraftState: "loading" | "saving" | "saved" | "offline" | "stale";
  subdivisionError: string | null;
  subdivisionRestored: boolean;
  subdivisionStartCount: number;
  subdivisionStartSource: "draft" | "saved-paddocks" | "field-boundary" | "paddock-boundary" | "stale-draft";
  boundaryValidation: GeometryValidationFeedback;
  draftValidation: GeometryValidationFeedback;
  potreroBoundaryValidation: GeometryValidationFeedback;
  subdivisionValidation: GeometryValidationFeedback;
  onSubdivisionStart: () => void;
  onSubdivisionLineChange: (points: Coordinate[]) => void;
  onSubdivisionApply: (points?: Coordinate[]) => void;
  onSubdivisionUndo: () => void;
  onSubdivisionCancel: () => void;
  onSubdivisionDiscard: () => void;
  onSubdivisionRestart: () => void;
  onSubdivisionSaveRequest: () => void;
  exclusionMode: ExclusionDrawMode | null;
  exclusionDraft: Coordinate[];
  stockingLoadsByPaddock: Record<string, PaddockStockingLoad>;
  onExclusionDraftChange: (points: Coordinate[]) => void;
  onExclusionEdit: (paddockId: string, exclusionIndex: number) => void;
  onExclusionKindChange: (kind: ExclusionKind) => void;
  onExclusionPreview: () => void;
  onExclusionCancel: () => void;
  onFieldExclusionStart: () => void;
  activeCells: PaddockCell[];
  cellBearingDraft: { paddockId: string; bearingDegrees: number } | null;
  cellPreview: PaddockCellGenerationPreview | null;
  onCellBearingChange: (bearingDegrees: number) => void;
  rotationSnapshot: PaddockRotationSnapshot | null;
  thematicStorageScope: string;
  landmarks: FieldLandmark[];
  landmarkDraft: FieldLandmarkEditorDraft | null;
  landmarkBusy: boolean;
  landmarkError: string | null;
  onLandmarkDraftChange: (geometry: Coordinate[]) => void;
  onLandmarkDrawCancel: () => void;
  onLandmarkSave: (values: Readonly<{ kind: FieldLandmarkKind; name: string; notes: string }>) => Promise<void>;
  onLandmarkEdit: (landmark: FieldLandmark) => void;
  onLandmarkArchive: (landmark: FieldLandmark) => void;
  onPaddockLandmarkStart: (geometryType: FieldLandmarkGeometryType) => void;
  selectedPotrero: Potrero | null;
  selectedPotreroCanMutate: boolean;
  selectedPotreroCellCount: number;
  selectedPotreroOperationsEnabled: boolean;
  selectedPotreroStockingLoad?: PaddockStockingLoad;
  onPotreroEdit: () => void;
  onPotreroDelete: () => void;
  onPotreroBoundaryEdit: () => void;
  onPotreroSubdivide: () => void;
  onPotreroExclusionStart: () => void;
  onPotreroCellsOpen: () => void;
  onPotreroUndo?: () => void;
  potreroUndoPreview?: UndoPreview | null;
  onFullscreenToggle: () => void;
  ndviValues: readonly PaddockNdviListingItem[];
};

const MAP_CENTER: Coordinate = [-40.6076, -73.2512];
const SNAP_THRESHOLD_PX = 12;
const ARCGIS_BASEMAP_TIMEOUT_MS = 12_000;
type EditableBoundaryKind = "new" | "fundo" | "potrero" | "exclusion";
type SelectedBoundaryVertex = { kind: EditableBoundaryKind; index: number };
type EditorSnapshot =
  | { kind: "new"; points: Coordinate[] }
  | { kind: "fundo"; points: Coordinate[]; drafts: BoundaryDrafts }
  | { kind: "exclusion"; points: Coordinate[]; exclusionKind: ExclusionKind }
  | { kind: "potrero"; drafts: BoundaryDrafts };
type CreatePaddockAdapterSession = {
  key: string;
  adapter: LeafletCreatePaddockAdapter;
  facade: MapEditCommandFacade;
  lease: MapInteractionAdapterLease;
};

const BOUNDARY_VERTEX_ICON = divIcon({
  className: "fundo-vertex-marker",
  html: "",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
const POTRERO_VERTEX_ICON = divIcon({
  className: "potrero-vertex-marker",
  html: "",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const SELECTED_BOUNDARY_VERTEX_ICON = divIcon({
  className: "boundary-vertex-marker-selected",
  html: '<span aria-hidden="true"></span>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});
const EDGE_INSERT_ICON = divIcon({
  className: "boundary-edge-insert-marker",
  html: '<span aria-hidden="true">+</span>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});
const SUBDIVISION_VERTEX_ICON = divIcon({
  className: "potrero-vertex-marker",
  html: "",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const CELL_BEARING_ICON = divIcon({
  className: "cell-bearing-marker",
  html: '<span aria-hidden="true" style="display:grid;width:44px;height:44px;place-items:center"><span style="display:grid;width:28px;height:28px;place-items:center;border-radius:999px;background:#f97316;color:white;border:3px solid white;box-shadow:0 3px 12px rgba(0,0,0,.3);font-weight:900">↗</span></span>',
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});
const ALWAYS_AVAILABLE_THEMATIC_MODES = ["status", "sector", "land_use", "ph", "rotation"] as const satisfies readonly PaddockThematicMode[];
const ALL_THEMATIC_MODES = [...ALWAYS_AVAILABLE_THEMATIC_MODES, "ndvi"] as const satisfies readonly PaddockThematicMode[];
const LANDMARK_SYMBOLS: Record<FieldLandmarkKind, string> = {
  bebedero: "💧",
  porton: "⇄",
  sala_ordena: "🥛",
  bodega: "▣",
  manga: "▥",
  cerco_electrico: "⚡",
  callejon: "↔",
  linea_agua: "≋",
  otro: "•",
};

type DrawingSnap = {
  point: Coordinate;
  kind: "vertex" | "edge" | "closing";
};

function DrawingEvents({
  enabled,
  points,
  snapPolygons,
  closeOnFirst = false,
  onChange,
  onClose,
  onHoverChange,
  onSnapChange,
}: {
  enabled: boolean;
  points: Coordinate[];
  snapPolygons: Coordinate[][];
  closeOnFirst?: boolean;
  onChange: (points: Coordinate[]) => void;
  onClose?: () => void;
  onHoverChange?: (point: Coordinate | null) => void;
  onSnapChange: (snap: DrawingSnap | null) => void;
}) {
  const map = useMap();
  const pendingClickRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (pendingClickRef.current !== null) window.clearTimeout(pendingClickRef.current);
  }, []);

  function snapFor(latlng: { lat: number; lng: number }): DrawingSnap | null {
    const raw: Coordinate = [latlng.lat, latlng.lng];
    const cursorPoint = map.latLngToContainerPoint(latlng);

    if (closeOnFirst && points.length >= 3) {
      const firstPoint = map.latLngToContainerPoint(points[0]);
      if (cursorPoint.distanceTo(firstPoint) <= SNAP_THRESHOLD_PX) {
        return { point: points[0], kind: "closing" };
      }
    }

    let nearestVertex: { point: Coordinate; distance: number } | null = null;
    for (const polygon of snapPolygons) {
      for (const vertex of polygon) {
        const distance = cursorPoint.distanceTo(map.latLngToContainerPoint(vertex));
        if (distance <= SNAP_THRESHOLD_PX && (!nearestVertex || distance < nearestVertex.distance)) {
          nearestVertex = { point: vertex, distance };
        }
      }
    }
    if (nearestVertex) return { point: nearestVertex.point, kind: "vertex" };

    let nearestEdge: { point: Coordinate; distance: number } | null = null;
    for (const polygon of snapPolygons) {
      if (polygon.length < 2) continue;
      for (let index = 0; index < polygon.length; index += 1) {
        const candidate = closestPointOnSegment(raw, polygon[index], polygon[(index + 1) % polygon.length]);
        const distance = cursorPoint.distanceTo(map.latLngToContainerPoint(candidate));
        if (distance <= SNAP_THRESHOLD_PX && (!nearestEdge || distance < nearestEdge.distance)) {
          nearestEdge = { point: candidate, distance };
        }
      }
    }
    return nearestEdge ? { point: nearestEdge.point, kind: "edge" } : null;
  }

  useMapEvents({
    mousemove(event) {
      if (!enabled) return;
      const snap = snapFor(event.latlng);
      onSnapChange(snap);
      onHoverChange?.(snap?.point ?? [event.latlng.lat, event.latlng.lng]);
    },
    mouseout() {
      if (!enabled) return;
      onSnapChange(null);
      onHoverChange?.(null);
    },
    click(event) {
      if (!enabled) return;
      const applyClick = () => {
        pendingClickRef.current = null;
        const snap = snapFor(event.latlng);
        if (snap?.kind === "closing") {
          onSnapChange(null);
          onHoverChange?.(null);
          onClose?.();
          return;
        }
        onChange([...points, snap?.point ?? [event.latlng.lat, event.latlng.lng]]);
      };
      if (!onClose) {
        applyClick();
        return;
      }
      if (pendingClickRef.current !== null) {
        window.clearTimeout(pendingClickRef.current);
        pendingClickRef.current = null;
        return;
      }
      pendingClickRef.current = window.setTimeout(applyClick, 280);
    },
    dblclick(event) {
      if (!enabled || !onClose || points.length < 3) return;
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();
      if (pendingClickRef.current !== null) window.clearTimeout(pendingClickRef.current);
      pendingClickRef.current = null;
      onSnapChange(null);
      onHoverChange?.(null);
      onClose();
    },
  });

  return null;
}

function DrawingInteractionController({ enabled }: { enabled: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!enabled) return;
    const restoreDoubleClickZoom = map.doubleClickZoom.enabled();
    map.doubleClickZoom.disable();
    return () => {
      if (restoreDoubleClickZoom) map.doubleClickZoom.enable();
    };
  }, [enabled, map]);

  return null;
}

function GpsMapFocus({ coordinate }: { coordinate: Coordinate | null }) {
  const map = useMap();
  const centeredRef = useRef(false);

  useEffect(() => {
    if (!coordinate) {
      centeredRef.current = false;
      return;
    }
    if (centeredRef.current) return;
    centeredRef.current = true;
    map.setView(coordinate, Math.max(map.getZoom(), 18), { animate: true });
  }, [coordinate, map]);

  return null;
}

function SubdivisionDrawingEvents({
  enabled,
  points,
  polygons,
  autoClose,
  onChange,
  onApply,
  onInteractionError,
}: {
  enabled: boolean;
  points: Coordinate[];
  polygons: Coordinate[][];
  autoClose: boolean;
  onChange: (points: Coordinate[]) => void;
  onApply: (points: Coordinate[]) => void;
  onInteractionError: (message: string | null) => void;
}) {
  const map = useMap();
  const [snapPoint, setSnapPoint] = useState<Coordinate | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => () => {
    if (moveFrameRef.current !== null) window.cancelAnimationFrame(moveFrameRef.current);
  }, []);

  useEffect(() => {
    const reset = window.requestAnimationFrame(() => setSnapPoint(null));
    return () => window.cancelAnimationFrame(reset);
  }, [enabled, polygons]);

  function snapFor(latlng: { lat: number; lng: number }) {
    const coordinate: Coordinate = [latlng.lat, latlng.lng];
    const cursorPoint = map.latLngToContainerPoint(latlng);
    const thresholdPoint = map.containerPointToLatLng([cursorPoint.x + SNAP_THRESHOLD_PX, cursorPoint.y]);
    const maximumDistanceMeters = map.distance(latlng, thresholdPoint);
    const nearest = nearestSubdivisionBoundaryPoint(coordinate, polygons, maximumDistanceMeters);
    if (!nearest) return null;
    const boundaryPoint = map.latLngToContainerPoint(nearest.point);
    return cursorPoint.distanceTo(boundaryPoint) <= SNAP_THRESHOLD_PX ? nearest.point : null;
  }

  function updateSnap(point: Coordinate | null) {
    setSnapPoint((current) => coordinatesMatch(current, point) ? current : point);
  }

  function clearPendingMove() {
    pendingMoveRef.current = null;
    if (moveFrameRef.current !== null) window.cancelAnimationFrame(moveFrameRef.current);
    moveFrameRef.current = null;
  }

  useMapEvents({
    mousemove(event) {
      if (!enabled) return;
      pendingMoveRef.current = event.latlng;
      if (moveFrameRef.current !== null) return;
      moveFrameRef.current = window.requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const pending = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (pending) updateSnap(snapFor(pending));
      });
    },
    mouseout() {
      if (!enabled) return;
      clearPendingMove();
      updateSnap(null);
    },
    click(event) {
      if (!enabled) return;
      clearPendingMove();
      const snappedPoint = snapFor(event.latlng);
      if (points.length === 0 && !snappedPoint) {
        onInteractionError("Acércate a un borde blanco para comenzar el cerco.");
        return;
      }

      const nextPoint: Coordinate = snappedPoint ?? [event.latlng.lat, event.latlng.lng];
      const firstPoint = points[0];
      const snapIsFarEnough = firstPoint
        ? map.latLngToContainerPoint(firstPoint).distanceTo(map.latLngToContainerPoint(snappedPoint ?? firstPoint)) >= 12
        : false;
      if (autoClose && snappedPoint && firstPoint && snapIsFarEnough) {
        onInteractionError(null);
        updateSnap(null);
        onApply([...points, snappedPoint]);
        return;
      }

      onInteractionError(null);
      onChange([...points, nextPoint]);
    },
  });

  return (
    <>
      {points.length > 0 && snapPoint && (
        <Polyline positions={[...points, snapPoint]} pathOptions={{ color: "#f97316", weight: 3, dashArray: "5 7", opacity: 0.8 }} />
      )}
      {enabled && snapPoint && (
        <CircleMarker center={snapPoint} radius={10} pathOptions={{ color: "#173b2d", fillColor: "#d9ff78", fillOpacity: 0.72, weight: 3 }}>
          <Tooltip permanent direction="top">Encajar en este cerco</Tooltip>
        </CircleMarker>
      )}
    </>
  );
}

function coordinatesMatch(first: Coordinate | null, second: Coordinate | null) {
  if (!first || !second) return first === second;
  return first[0] === second[0] && first[1] === second[1];
}

function MapFocus({ fundo, resetSignal, subdivisionMode }: { fundo: Fundo | null; resetSignal: number; subdivisionMode: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (fundo?.coordinates.length) {
      map.fitBounds(fundo.coordinates, {
        paddingTopLeft: [34, subdivisionMode ? 104 : 34],
        paddingBottomRight: [34, 34],
        animate: resetSignal > 0,
      });
    }
  }, [fundo, map, resetSignal, subdivisionMode]);

  return null;
}

function MapViewportObserver({
  onViewportChange,
}: {
  onViewportChange: (viewport: Readonly<{ center: Coordinate; zoom: number }>) => void;
}) {
  const map = useMap();
  const publishViewport = useCallback(() => {
    const center = map.getCenter();
    onViewportChange({
      center: [center.lat, center.lng],
      zoom: map.getZoom(),
    });
  }, [map, onViewportChange]);
  const viewportEventHandlers = useMemo(() => ({
    moveend: publishViewport,
    zoomend: publishViewport,
  }), [publishViewport]);

  useMapEvents(viewportEventHandlers);

  useEffect(() => {
    publishViewport();
  }, [publishViewport]);

  return null;
}

function MapLayoutObserver({ fullscreen }: { fullscreen: boolean }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const refresh = () => map.invalidateSize({ animate: false });
    const firstFrame = window.requestAnimationFrame(refresh);
    const settled = window.setTimeout(refresh, 220);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    observer?.observe(container);
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.clearTimeout(settled);
      observer?.disconnect();
    };
  }, [fullscreen, map]);

  return null;
}

type MapLibreRuntime = {
  on: (event: string, listener: (event: unknown) => void) => void;
  off: (event: string, listener: (event: unknown) => void) => void;
};

type EsriVectorBasemapLayer = LeafletLayer & {
  _ready?: boolean;
  _maplibreGL?: { getMaplibreMap: () => MapLibreRuntime | null };
};

function ArcgisVectorBasemapLayer({
  styleName,
  token,
  onProviderFailure,
  onTileLoad,
}: {
  styleName: string;
  token: string;
  onProviderFailure: (status: number) => void;
  onTileLoad: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    let cancelled = false;
    let layer: EsriVectorBasemapLayer | null = null;
    let maplibre: MapLibreRuntime | null = null;
    let providerTimeout: number | null = null;

    function clearProviderTimeout() {
      if (providerTimeout === null) return;
      window.clearTimeout(providerTimeout);
      providerTimeout = null;
    }

    function armProviderTimeout() {
      clearProviderTimeout();
      providerTimeout = window.setTimeout(() => failProvider(504), ARCGIS_BASEMAP_TIMEOUT_MS);
    }

    function failProvider(status: number) {
      if (cancelled || !shouldDegradeOnStatus(status)) return;
      clearProviderTimeout();
      onProviderFailure(status);
    }

    function handleLayerError(event: unknown) {
      failProvider(providerErrorStatus(event) ?? 503);
    }

    function handleMaplibreError(event: unknown) {
      const status = providerErrorStatus(event);
      if (status !== null) failProvider(status);
      else armProviderTimeout();
    }

    function handleTileLoading() {
      onTileLoad();
      armProviderTimeout();
    }

    function handleSourceLoaded(event: unknown) {
      if (event && typeof event === "object" && "tile" in event && event.tile) {
        clearProviderTimeout();
      }
    }

    function attachMaplibreRuntime() {
      if (cancelled || !layer || maplibre) return;
      if (!map.hasLayer(layer)) layer.addTo(map);
      maplibre = layer._maplibreGL?.getMaplibreMap() ?? null;
      maplibre?.on("error", handleMaplibreError);
      maplibre?.on("tiledataloading", handleTileLoading);
      maplibre?.on("sourcedata", handleSourceLoaded);
    }

    async function mountLayer() {
      try {
        const { vectorBasemapLayer } = await import("esri-leaflet-vector");
        if (cancelled) return;
        layer = vectorBasemapLayer(styleName, { token }) as EsriVectorBasemapLayer;
        layer.on("load-error", handleLayerError);
        layer.on("ready", attachMaplibreRuntime);
        if (layer._ready) attachMaplibreRuntime();
      } catch {
        failProvider(503);
      }
    }

    armProviderTimeout();
    void mountLayer();
    return () => {
      cancelled = true;
      clearProviderTimeout();
      maplibre?.off("error", handleMaplibreError);
      maplibre?.off("tiledataloading", handleTileLoading);
      maplibre?.off("sourcedata", handleSourceLoaded);
      layer?.off("load-error", handleLayerError);
      layer?.off("ready", attachMaplibreRuntime);
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    };
  }, [map, onProviderFailure, onTileLoad, styleName, token]);

  return null;
}

function ActiveBasemapAttribution({
  activeBasemap,
  preferredBasemap,
  degraded,
}: {
  activeBasemap: BasemapDefinition;
  preferredBasemap: BasemapDefinition;
  degraded: boolean;
}) {
  const degradedLabel = degraded && preferredBasemap.id !== activeBasemap.id
    ? ` Respaldo activo para ${preferredBasemap.label}; la selección, la vista y el borrador se conservan.`
    : "";
  return (
    <p
      aria-live="polite"
      className="pointer-events-auto max-w-full rounded bg-chrome/95 px-2 py-1 text-[10px] leading-4 text-white/80 shadow-lg border border-line-strong"
      id="active-basemap-attribution"
      role="note"
    >
      <span className="font-black text-white">Atribución: </span>
      {activeBasemap.id === "osm" ? (
        <>
          ©{" "}
          <a
            className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            href="https://www.openstreetmap.org/copyright"
            rel="noreferrer"
            target="_blank"
          >
            OpenStreetMap
          </a>
          {" "}contributors.
        </>
      ) : (
        <>
          Powered by{" "}
          <a
            className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            href="https://www.esri.com"
            rel="noreferrer"
            target="_blank"
          >
            Esri
          </a>
          {activeBasemap.attribution.replace(/^Powered by Esri/u, "")}.
        </>
      )}
      {degradedLabel}
    </p>
  );
}

function providerErrorStatus(value: unknown, visited = new Set<object>()): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return normalizeProviderStatus(value);
  if (!value || typeof value !== "object" || visited.has(value)) return null;
  visited.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code"]) {
    const candidate = Number(record[key]);
    if (Number.isInteger(candidate) && candidate > 0) return normalizeProviderStatus(candidate);
  }
  for (const key of ["error", "value", "response"]) {
    const nested = providerErrorStatus(record[key], visited);
    if (nested !== null) return nested;
  }
  return null;
}

function normalizeProviderStatus(status: number): number {
  return status === 498 || status === 499 ? 401 : status;
}

export function MapaPotreros({
  potreros,
  fundo,
  canMutate,
  structuralOperationsEnabled,
  networkOnline,
  fullscreen,
  boundaryDraft,
  boundaryEditing,
  boundaryPaddockDrafts,
  draftPoints,
  selectedId,
  selectedIds,
  onDraftChange,
  onCreateSaveRequest,
  onSelect,
  onBoundaryDraftChange,
  onBoundarySave,
  onBoundaryCancel,
  potreroBoundaryEditingId,
  potreroBoundaryDraft,
  potreroBoundaryDrafts,
  potreroBoundaryName,
  onPotreroBoundaryDraftsChange,
  onPotreroGpsBoundaryDraftApply,
  onPotreroBoundarySave,
  onPotreroBoundaryCancel,
  subdivisionMode,
  subdivisionScope,
  subdivisionPolygons,
  subdivisionLine,
  subdivisionCanUndo,
  subdivisionDraftState,
  subdivisionError,
  subdivisionRestored,
  subdivisionStartCount,
  subdivisionStartSource,
  boundaryValidation,
  draftValidation,
  potreroBoundaryValidation,
  subdivisionValidation,
  onSubdivisionStart,
  onSubdivisionLineChange,
  onSubdivisionApply,
  onSubdivisionUndo,
  onSubdivisionCancel,
  onSubdivisionDiscard,
  onSubdivisionRestart,
  onSubdivisionSaveRequest,
  exclusionMode,
  exclusionDraft,
  stockingLoadsByPaddock,
  onExclusionDraftChange,
  onExclusionEdit,
  onExclusionKindChange,
  onExclusionPreview,
  onExclusionCancel,
  onFieldExclusionStart,
  activeCells,
  cellBearingDraft,
  cellPreview,
  onCellBearingChange,
  rotationSnapshot,
  thematicStorageScope,
  landmarks,
  landmarkDraft,
  landmarkBusy,
  landmarkError,
  onLandmarkDraftChange,
  onLandmarkDrawCancel,
  onLandmarkSave,
  onLandmarkEdit,
  onLandmarkArchive,
  onPaddockLandmarkStart,
  selectedPotrero,
  selectedPotreroCanMutate,
  selectedPotreroCellCount,
  selectedPotreroOperationsEnabled,
  selectedPotreroStockingLoad,
  onPotreroEdit,
  onPotreroDelete,
  onPotreroBoundaryEdit,
  onPotreroSubdivide,
  onPotreroExclusionStart,
  onPotreroCellsOpen,
  onPotreroUndo,
  potreroUndoPreview,
  onFullscreenToggle,
  ndviValues,
}: MapaPotrerosProps) {
  const [drawing, setDrawing] = useState(false);
  const [redrawingBoundaryRequested, setRedrawingBoundary] = useState(false);
  const [savingBoundary, setSavingBoundary] = useState(false);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [savingPotreroBoundary, setSavingPotreroBoundary] = useState(false);
  const [potreroBoundaryError, setPotreroBoundaryError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [autoCloseSubdivision, setAutoCloseSubdivision] = useState(true);
  const [subdivisionInteractionError, setSubdivisionInteractionError] = useState<string | null>(null);
  const [drawingSnap, setDrawingSnap] = useState<DrawingSnap | null>(null);
  const [exclusionSnap, setExclusionSnap] = useState<DrawingSnap | null>(null);
  const [measurementMode, setMeasurementMode] = useState(false);
  const [measurementPoints, setMeasurementPoints] = useState<Coordinate[]>([]);
  const [measurementHover, setMeasurementHover] = useState<Coordinate | null>(null);
  const [measurementSnap, setMeasurementSnap] = useState<DrawingSnap | null>(null);
  const [measurementClosed, setMeasurementClosed] = useState(false);
  const {
    activeBasemap: preferredBasemap,
    basemaps,
    labelsEnabled,
    paddockFillsEnabled,
    selectBasemap,
    showPaddockLabelsAtZoom,
    toggleLabels,
    togglePaddockFills,
  } = useMapViewPreferences();
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);
  const [unavailableBasemapId, setUnavailableBasemapId] = useState<BasemapId | null>(null);
  const basemapToggleRef = useRef<HTMLButtonElement | null>(null);
  const basemapMenuRef = useRef<HTMLDivElement | null>(null);
  const tileUsageReporterRef = useRef<TileUsageReporter | null>(null);
  const mapWorkspace = useMapWorkspace({
    fieldId: fundo?.id ?? "new-field",
    viewport: { center: fundo?.coordinates[0] ?? MAP_CENTER, zoom: 14 },
  });
  const [thematicMode, setThematicMode] = useState<PaddockThematicMode>("status");
  const [thematicPreferenceScope, setThematicPreferenceScope] = useState<string | null>(null);
  const [landmarksVisible, setLandmarksVisible] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedBoundaryVertex, setSelectedBoundaryVertex] = useState<SelectedBoundaryVertex | null>(null);
  const [insertingBoundaryVertex, setInsertingBoundaryVertex] = useState(false);
  const [editorInteractionError, setEditorInteractionError] = useState<string | null>(null);
  const [editorHistoryState, setEditorHistoryState] = useState({ undo: 0, redo: 0 });
  const editorUndoRef = useRef<EditorSnapshot[]>([]);
  const editorRedoRef = useRef<EditorSnapshot[]>([]);
  const createPaddockSessionRef = useRef<CreatePaddockAdapterSession | null>(null);
  const createPaddockDraftPublisherRef = useRef(onDraftChange);
  const gpsBoundaryContext = useMemo(
    () => potreroBoundaryEditingId
      ? {
          fundo: fundo?.coordinates,
          siblings: potreros
            .filter((potrero) => potrero.id !== potreroBoundaryEditingId)
            .map((potrero) => potrero.coordinates),
        }
      : {},
    [fundo?.coordinates, potreroBoundaryEditingId, potreros],
  );
  const gpsCapture = useGpsBoundaryCapture(gpsBoundaryContext);
  const cancelGpsCapture = gpsCapture.cancel;
  const gpsTarget = boundaryEditing
    ? `field:${fundo?.id ?? "new"}`
    : potreroBoundaryEditingId
      ? `paddock:${potreroBoundaryEditingId}`
      : null;
  const previousGpsTargetRef = useRef<string | null>(gpsTarget);
  const previousGpsFundoRef = useRef<string | null | undefined>(fundo?.id);
  const redrawingBoundary = redrawingBoundaryRequested || (boundaryEditing && !fundo);
  const visibleBoundary = boundaryEditing ? boundaryDraft : fundo?.coordinates ?? [];
  const boundaryArea = calculateHectares(boundaryDraft);
  const potreroBoundaryArea = calculateHectares(potreroBoundaryDraft);
  const editedExclusionPaddock = exclusionMode?.action === "edit"
    ? potreros.find((potrero) => potrero.id === exclusionMode.scope.paddockId) ?? null
    : null;
  const originalEditedExclusion = exclusionMode?.action === "edit" && editedExclusionPaddock
    ? paddockGeometry(editedExclusionPaddock).holes[exclusionMode.exclusionIndex] ?? []
    : [];
  const originalEditedExclusionKind = exclusionMode?.action === "edit" && editedExclusionPaddock
    ? editedExclusionPaddock.holeKinds?.[exclusionMode.exclusionIndex] ?? null
    : null;
  const activeEditorKind: EditableBoundaryKind = boundaryEditing
    ? "fundo"
    : potreroBoundaryEditingId
      ? "potrero"
      : exclusionMode?.action === "edit"
        ? "exclusion"
        : "new";
  const activeEditableRing = activeEditorKind === "fundo"
    ? boundaryDraft
    : activeEditorKind === "potrero"
      ? potreroBoundaryDraft
      : activeEditorKind === "exclusion"
        ? exclusionDraft
        : draftPoints;
  const editorSessionKey = activeEditorKind === "fundo"
    ? `fundo:${fundo?.id ?? "none"}`
    : activeEditorKind === "potrero"
      ? `potrero:${potreroBoundaryEditingId}`
      : activeEditorKind === "exclusion"
        ? `exclusion:${exclusionMode?.scope.kind === "paddock" ? exclusionMode.scope.paddockId : "none"}:${exclusionMode?.action === "edit" ? exclusionMode.exclusionIndex : "none"}`
        : `nuevo:${fundo?.id ?? "none"}:${selectedId ?? "none"}`;
  const changedPotreroBoundaryIds = useMemo(
    () => changedBoundaryDraftIds(potreroBoundaryDrafts, potreros),
    [potreroBoundaryDrafts, potreros],
  );
  const changedFieldBoundaryPaddockIds = useMemo(
    () => changedBoundaryDraftIds(boundaryPaddockDrafts, potreros),
    [boundaryPaddockDrafts, potreros],
  );
  const editorDirty = activeEditorKind === "fundo"
    ? !boundaryRingsEqual(boundaryDraft, fundo?.coordinates ?? []) || changedFieldBoundaryPaddockIds.length > 0
    : activeEditorKind === "potrero"
      ? changedPotreroBoundaryIds.length > 0
      : activeEditorKind === "exclusion"
        ? !boundaryRingsEqual(exclusionDraft, originalEditedExclusion)
          || exclusionMode?.kind !== originalEditedExclusionKind
        : draftPoints.length > 0;
  const linkedPaddockChangeCount = Math.max(0, changedPotreroBoundaryIds.length - 1);
  const linkedFieldPaddockChangeCount = changedFieldBoundaryPaddockIds.length;
  const canUndoEditor = editorHistoryState.undo > 0;
  const canRedoEditor = editorHistoryState.redo > 0;
  const snapPolygons = useMemo(
    () => [
      ...potreros.map((potrero) => potrero.coordinates),
      ...(fundo?.coordinates.length ? [fundo.coordinates] : []),
    ],
    [fundo, potreros],
  );
  const measurementPreview = measurementClosed || !measurementHover
    ? measurementPoints
    : [...measurementPoints, measurementHover];
  const measurementMeters = measurementClosed
    ? calculatePerimeterMeters(measurementPoints)
    : calculatePathLengthMeters(measurementPreview);
  const measurementArea = measurementClosed ? calculateHectares(measurementPoints) : 0;
  const showPaddockLabels = showPaddockLabelsAtZoom(mapWorkspace.viewport.zoom);
  const rotationByPaddock = useMemo(
    () => new Map((rotationSnapshot?.paddocks ?? []).map((entry) => [entry.paddockId, entry])),
    [rotationSnapshot],
  );
  const ndviByPaddock = useMemo(() => new Map(ndviValues.map((item) => [item.paddockId, item])), [ndviValues]);
  const hasKnownNdvi = useMemo(() => ndviValues.some(({ value }) => value?.status === "ok"
    && value.meanNdvi !== null
    && value.observedAt !== null
    && Number.isFinite(new Date(value.observedAt).getTime())), [ndviValues]);
  const activeThematicMode = thematicMode === "ndvi" && !hasKnownNdvi ? "status" : thematicMode;
  const landmarkEditingId = landmarkDraft?.id ?? null;
  const thematicLegend = useMemo(() => getPaddockLegend(activeThematicMode, {
    sectors: potreros.map((potrero) => potrero.sector),
    rotationThresholds: rotationSnapshot ? {
      recentDays: rotationSnapshot.settings.recentDays,
      longRestDays: rotationSnapshot.settings.longRestDays,
    } : undefined,
  }), [activeThematicMode, potreros, rotationSnapshot]);
  const bearingPaddock = cellBearingDraft ? potreros.find(({ id }) => id === cellBearingDraft.paddockId) : null;
  const bearingGuide = bearingPaddock && cellBearingDraft
    ? buildBearingGuide(paddockGeometry(bearingPaddock).outer, cellBearingDraft.bearingDegrees)
    : null;
  const drawingInteractionActive = drawing
    || redrawingBoundary
    || subdivisionMode
    || measurementMode
    || Boolean(exclusionMode)
    || Boolean(landmarkDraft)
    || gpsCapture.mode === "boundary";
  const gpsLocationUnavailableReason = gpsUnavailableReason(gpsCapture);
  const basemapSurface: BasemapSurface = boundaryEditing
    || Boolean(potreroBoundaryEditingId)
    || subdivisionMode
    || Boolean(exclusionMode)
    || Boolean(landmarkDraft)
    || drawing
    || redrawingBoundary
    || draftPoints.length > 0
    || gpsCapture.mode === "boundary"
    ? "editar"
    : "operar";
  const basemapResolution = resolveActiveBasemap({
    basemapId: preferredBasemap.id,
    surface: basemapSurface,
    providerHealthy: networkOnline && unavailableBasemapId !== preferredBasemap.id,
  });
  const activeBasemap = basemapResolution.basemap;
  const arcgisToken = arcgisBasemapKey();
  const recordBasemapTile = useCallback(() => {
    tileUsageReporterRef.current?.recordTile();
  }, []);
  const handleProviderFailure = useCallback((status: number) => {
    if (!shouldDegradeOnStatus(status)) return;
    setUnavailableBasemapId(preferredBasemap.id);
  }, [preferredBasemap.id]);
  const selectPreferredBasemap = useCallback((basemapId: BasemapId) => {
    setUnavailableBasemapId(null);
    selectBasemap(basemapId);
    setBasemapMenuOpen(false);
  }, [selectBasemap]);
  const osmTileEventHandlers = useMemo(
    () => ({ tileload: recordBasemapTile }),
    [recordBasemapTile],
  );

  useEffect(() => {
    const reporter = createTileUsageReporter();
    tileUsageReporterRef.current = reporter;
    function flushPendingUsage() {
      void reporter.flush();
    }
    window.addEventListener("pagehide", flushPendingUsage);
    return () => {
      window.removeEventListener("pagehide", flushPendingUsage);
      if (tileUsageReporterRef.current === reporter) tileUsageReporterRef.current = null;
      void reporter.dispose();
    };
  }, []);

  useEffect(() => {
    void tileUsageReporterRef.current?.setContext({
      basemapId: preferredBasemap.id,
      surface: basemapSurface,
      degraded: basemapResolution.degraded,
    });
  }, [basemapResolution.degraded, basemapSurface, preferredBasemap.id]);

  useEffect(() => {
    if (!networkOnline) return;
    const retryAfterReconnect = window.setTimeout(() => {
      setUnavailableBasemapId(null);
    }, 0);
    return () => window.clearTimeout(retryAfterReconnect);
  }, [networkOnline]);

  function createPaddockAdapterSession(): CreatePaddockAdapterSession {
    const current = createPaddockSessionRef.current;
    if (current?.key === editorSessionKey) return current;
    current?.lease.disconnect();

    const adapter = createLeafletCreatePaddockAdapter();
    const transaction = createMapEditTransaction({
      id: `map-edit:${editorSessionKey}`,
      fieldId: fundo?.id ?? "new-field",
      objective: "create-paddock",
      adapterId: adapter.id,
      initialDraft: { outer: cloneRing(draftPoints), holes: [] },
      source: "manual",
      historyLimit: 50,
    });
    const facade = createMapEditCommandFacade(transaction, (next) => {
      createPaddockDraftPublisherRef.current(cloneRing(next.draft.outer));
      setEditorHistoryState({
        undo: next.history.past.length,
        redo: next.history.future.length,
      });
    });
    const connection = facade.connectAdapter(adapter);
    if (!connection.ok) throw new Error(connection.error.message);
    const session = { key: editorSessionKey, adapter, facade, lease: connection.lease };
    createPaddockSessionRef.current = session;
    return session;
  }

  function applyCreatePaddockAdapterResult(result: MapAdapterDispatchResult): boolean {
    if (result.ok) {
      setEditorInteractionError(null);
      return true;
    }
    if (result.error.code === "history-empty") {
      setEditorInteractionError(null);
      return false;
    }
    createPaddockDraftPublisherRef.current(cloneRing(result.snapshot.draft.outer));
    setEditorInteractionError(result.error.message);
    return false;
  }

  function currentEditorSnapshot(): EditorSnapshot {
    if (activeEditorKind === "fundo") {
      return { kind: "fundo", points: cloneRing(boundaryDraft), drafts: cloneBoundaryDrafts(boundaryPaddockDrafts) };
    }
    if (activeEditorKind === "potrero") return { kind: "potrero", drafts: cloneBoundaryDrafts(potreroBoundaryDrafts) };
    if (activeEditorKind === "exclusion") {
      return {
        kind: "exclusion",
        points: cloneRing(exclusionDraft),
        exclusionKind: exclusionMode?.kind ?? "construccion",
      };
    }
    return { kind: "new", points: cloneRing(draftPoints) };
  }

  function applyEditorSnapshot(snapshot: EditorSnapshot) {
    if (snapshot.kind === "fundo") {
      onBoundaryDraftChange(cloneRing(snapshot.points), cloneBoundaryDrafts(snapshot.drafts));
    }
    else if (snapshot.kind === "potrero") onPotreroBoundaryDraftsChange(cloneBoundaryDrafts(snapshot.drafts));
    else if (snapshot.kind === "exclusion") {
      onExclusionDraftChange(cloneRing(snapshot.points));
      onExclusionKindChange(snapshot.exclusionKind);
    }
    else onDraftChange(cloneRing(snapshot.points));
  }

  function recordEditorChange() {
    editorUndoRef.current = [...editorUndoRef.current.slice(-49), currentEditorSnapshot()];
    editorRedoRef.current = [];
    setEditorHistoryState({ undo: editorUndoRef.current.length, redo: 0 });
  }

  function commitEditorSnapshot(snapshot: EditorSnapshot) {
    const current = currentEditorSnapshot();
    if (editorSnapshotsEqual(current, snapshot)) return;
    if (activeEditorKind === "new" && snapshot.kind === "new") {
      applyCreatePaddockAdapterResult(
        createPaddockAdapterSession().adapter.replaceDraft(snapshot.points),
      );
      return;
    }
    recordEditorChange();
    applyEditorSnapshot(snapshot);
    setEditorInteractionError(null);
  }

  function undoEditorChange() {
    if (activeEditorKind === "new") {
      const applied = applyCreatePaddockAdapterResult(createPaddockAdapterSession().adapter.undo());
      if (!applied) return;
      setSelectedBoundaryVertex(null);
      return;
    }
    const previous = editorUndoRef.current.at(-1);
    if (!previous) return;
    editorUndoRef.current = editorUndoRef.current.slice(0, -1);
    editorRedoRef.current = [...editorRedoRef.current.slice(-49), currentEditorSnapshot()];
    applyEditorSnapshot(previous);
    setSelectedBoundaryVertex(null);
    setEditorInteractionError(null);
    setEditorHistoryState({ undo: editorUndoRef.current.length, redo: editorRedoRef.current.length });
  }

  function redoEditorChange() {
    if (activeEditorKind === "new") {
      const applied = applyCreatePaddockAdapterResult(createPaddockAdapterSession().adapter.redo());
      if (!applied) return;
      setSelectedBoundaryVertex(null);
      return;
    }
    const next = editorRedoRef.current.at(-1);
    if (!next) return;
    editorRedoRef.current = editorRedoRef.current.slice(0, -1);
    editorUndoRef.current = [...editorUndoRef.current.slice(-49), currentEditorSnapshot()];
    applyEditorSnapshot(next);
    setSelectedBoundaryVertex(null);
    setEditorInteractionError(null);
    setEditorHistoryState({ undo: editorUndoRef.current.length, redo: editorRedoRef.current.length });
  }

  function moveEditableVertex(kind: EditableBoundaryKind, index: number, replacement: Coordinate) {
    if (kind === "fundo") {
      const result = moveLinkedFieldBoundaryVertex(
        boundaryDraft,
        boundaryPaddockDrafts,
        index,
        replacement,
      );
      commitEditorSnapshot({ kind: "fundo", points: result.boundary, drafts: result.drafts });
    } else if (kind === "potrero" && potreroBoundaryEditingId) {
      const result = moveBoundaryVertex(potreroBoundaryDrafts, potreroBoundaryEditingId, index, replacement);
      commitEditorSnapshot({ kind: "potrero", drafts: result.drafts });
    } else if (kind === "exclusion") {
      commitEditorSnapshot({
        kind: "exclusion",
        points: moveVertex(exclusionDraft, index, replacement),
        exclusionKind: exclusionMode?.kind ?? "construccion",
      });
    } else {
      applyCreatePaddockAdapterResult(
        createPaddockAdapterSession().adapter.moveVertex(index, replacement),
      );
    }
  }

  function insertEditableVertex(edgeIndex: number) {
    const point = edgeMidpoint(activeEditableRing[edgeIndex], activeEditableRing[(edgeIndex + 1) % activeEditableRing.length]);
    const nextIndex = edgeIndex + 1;
    if (activeEditorKind === "fundo") {
      const result = insertLinkedFieldBoundaryVertex(
        boundaryDraft,
        boundaryPaddockDrafts,
        edgeIndex,
        point,
      );
      commitEditorSnapshot({ kind: "fundo", points: result.boundary, drafts: result.drafts });
    } else if (activeEditorKind === "potrero" && potreroBoundaryEditingId) {
      const result = insertBoundaryVertex(potreroBoundaryDrafts, potreroBoundaryEditingId, edgeIndex, point);
      commitEditorSnapshot({ kind: "potrero", drafts: result.drafts });
    } else if (activeEditorKind === "exclusion") {
      commitEditorSnapshot({
        kind: "exclusion",
        points: insertVertex(exclusionDraft, edgeIndex, point),
        exclusionKind: exclusionMode?.kind ?? "construccion",
      });
    } else {
      const applied = applyCreatePaddockAdapterResult(
        createPaddockAdapterSession().adapter.insertVertex(edgeIndex, point),
      );
      if (!applied) return;
    }
    setSelectedBoundaryVertex({ kind: activeEditorKind, index: nextIndex });
  }

  function removeSelectedEditableVertex() {
    if (!selectedBoundaryVertex || selectedBoundaryVertex.kind !== activeEditorKind) return;
    const index = selectedBoundaryVertex.index;
    if (activeEditableRing.length <= 3) {
      setEditorInteractionError("El límite necesita al menos tres vértices.");
      return;
    }
    if (activeEditorKind === "fundo") {
      const result = removeLinkedFieldBoundaryVertex(boundaryDraft, boundaryPaddockDrafts, index);
      commitEditorSnapshot({ kind: "fundo", points: result.boundary, drafts: result.drafts });
    } else if (activeEditorKind === "potrero" && potreroBoundaryEditingId) {
      const result = removeBoundaryVertex(potreroBoundaryDrafts, potreroBoundaryEditingId, index);
      if (!result.ok) {
        setEditorInteractionError(result.message);
        return;
      }
      commitEditorSnapshot({ kind: "potrero", drafts: result.drafts });
    } else if (activeEditorKind === "exclusion") {
      commitEditorSnapshot({
        kind: "exclusion",
        points: removeVertex(exclusionDraft, index),
        exclusionKind: exclusionMode?.kind ?? "construccion",
      });
    } else {
      const applied = applyCreatePaddockAdapterResult(
        createPaddockAdapterSession().adapter.removeVertex(index),
      );
      if (!applied) return;
    }
    setSelectedBoundaryVertex(null);
  }

  useEffect(() => {
    if (previousGpsTargetRef.current !== gpsTarget) cancelGpsCapture();
    previousGpsTargetRef.current = gpsTarget;
  }, [cancelGpsCapture, gpsTarget]);

  useEffect(() => {
    if (previousGpsFundoRef.current !== fundo?.id) cancelGpsCapture();
    previousGpsFundoRef.current = fundo?.id;
  }, [cancelGpsCapture, fundo?.id]);

  useEffect(() => {
    const createSession = createPaddockSessionRef.current;
    if (createSession && createSession.key !== editorSessionKey) {
      createSession.lease.disconnect();
      createPaddockSessionRef.current = null;
    }
    editorUndoRef.current = [];
    editorRedoRef.current = [];
    const reset = window.setTimeout(() => {
      setSelectedBoundaryVertex(null);
      setInsertingBoundaryVertex(false);
      setEditorInteractionError(null);
      setEditorHistoryState({ undo: 0, redo: 0 });
    }, 0);
    return () => window.clearTimeout(reset);
  }, [editorSessionKey]);

  useEffect(() => {
    createPaddockDraftPublisherRef.current = onDraftChange;
  }, [onDraftChange]);

  useEffect(() => {
    const session = createPaddockSessionRef.current;
    if (
      !session
      || session.key !== editorSessionKey
      || boundaryRingsEqual(draftPoints, session.facade.read().draft.outer)
    ) {
      return;
    }

    session.lease.disconnect();
    createPaddockSessionRef.current = null;
    editorUndoRef.current = [];
    editorRedoRef.current = [];
    setSelectedBoundaryVertex(null);
    setInsertingBoundaryVertex(false);
    setEditorInteractionError(null);
    setEditorHistoryState({ undo: 0, redo: 0 });
  }, [draftPoints, editorSessionKey]);

  useEffect(() => () => {
    createPaddockSessionRef.current?.lease.disconnect();
    createPaddockSessionRef.current = null;
  }, []);

  const toggleFullscreenMap = useCallback(() => {
    setBasemapMenuOpen(false);
    onFullscreenToggle();
  }, [onFullscreenToggle]);

  useEffect(() => {
    if (!canMutate) return;
    function handleEditorKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (subdivisionMode || exclusionMode?.action === "create" || landmarkDraft || measurementMode) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoEditorChange();
        else undoEditorChange();
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedBoundaryVertex?.kind === activeEditorKind) {
        event.preventDefault();
        removeSelectedEditableVertex();
        return;
      }
      if (event.key !== "Escape") return;
      if (selectedBoundaryVertex) {
        event.preventDefault();
        setSelectedBoundaryVertex(null);
      } else if (insertingBoundaryVertex) {
        event.preventDefault();
        setInsertingBoundaryVertex(false);
      } else if (drawing || redrawingBoundary) {
        event.preventDefault();
        setDrawing(false);
        setRedrawingBoundary(false);
      } else if (fullscreen) {
        event.preventDefault();
        toggleFullscreenMap();
      }
    }
    window.addEventListener("keydown", handleEditorKeyDown);
    return () => window.removeEventListener("keydown", handleEditorKeyDown);
  });

  useEffect(() => {
    const hydratePreference = window.setTimeout(() => {
      const raw = window.localStorage.getItem(thematicPreferenceKey(thematicStorageScope));
      if (raw) {
        try {
          const stored = JSON.parse(raw) as { version?: number; mode?: unknown };
          if (stored.version === 1 && ALL_THEMATIC_MODES.includes(stored.mode as typeof ALL_THEMATIC_MODES[number])) {
            setThematicMode(stored.mode as PaddockThematicMode);
          }
        } catch {
          window.localStorage.removeItem(thematicPreferenceKey(thematicStorageScope));
        }
      }
      setThematicPreferenceScope(thematicStorageScope);
    }, 0);
    return () => window.clearTimeout(hydratePreference);
  }, [thematicStorageScope]);

  useEffect(() => {
    if (thematicPreferenceScope !== thematicStorageScope) return;
    window.localStorage.setItem(thematicPreferenceKey(thematicStorageScope), JSON.stringify({ version: 1, mode: thematicMode }));
  }, [thematicMode, thematicPreferenceScope, thematicStorageScope]);

  useEffect(() => {
    if (!basemapMenuOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      basemapMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
        ?.focus();
    });
    function handleBasemapMenuKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setBasemapMenuOpen(false);
        basemapToggleRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(
        basemapMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
      );
      if (buttons.length === 0) return;
      event.preventDefault();
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + buttons.length) % buttons.length
            : (currentIndex - 1 + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    }
    window.addEventListener("keydown", handleBasemapMenuKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleBasemapMenuKeyDown);
    };
  }, [basemapMenuOpen]);

  useEffect(() => {
    const reset = window.setTimeout(() => {
      if (boundaryEditing || subdivisionMode || potreroBoundaryEditingId || exclusionMode || landmarkEditingId) setDrawing(false);
      else setRedrawingBoundary(false);
      if (boundaryEditing || subdivisionMode || potreroBoundaryEditingId || exclusionMode || landmarkEditingId) setMeasurementMode(false);
      setBoundaryError(null);
      setPotreroBoundaryError(null);
      setSubdivisionInteractionError(null);
      setDrawingSnap(null);
      setExclusionSnap(null);
      setMeasurementSnap(null);
      setMeasurementHover(null);
      setMeasurementPoints([]);
      setMeasurementClosed(false);
      setSelectedBoundaryVertex(null);
      setInsertingBoundaryVertex(false);
      setEditorInteractionError(null);
    }, 0);
    return () => window.clearTimeout(reset);
  }, [boundaryEditing, exclusionMode, fundo?.id, landmarkEditingId, potreroBoundaryEditingId, subdivisionMode]);

  useEffect(() => {
    if (!landmarkDraft) return;
    const draft = landmarkDraft;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if ((event.key === "Backspace" || event.key === "Delete") && draft.geometry.length > 0) {
        event.preventDefault();
        onLandmarkDraftChange(draft.geometry.slice(0, -1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        onLandmarkDrawCancel();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [landmarkDraft, onLandmarkDraftChange, onLandmarkDrawCancel]);

  useEffect(() => {
    if (!exclusionMode || exclusionMode.action !== "create") return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Enter" && exclusionDraft.length >= 3) {
        event.preventDefault();
        onExclusionPreview();
      } else if ((event.key === "Backspace" || event.key === "Delete") && exclusionDraft.length > 0) {
        event.preventDefault();
        onExclusionDraftChange(exclusionDraft.slice(0, -1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        onExclusionCancel();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exclusionDraft, exclusionMode, onExclusionCancel, onExclusionDraftChange, onExclusionPreview]);

  useEffect(() => {
    if (!subdivisionMode || subdivisionDraftState === "stale") return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Enter" && subdivisionLine.length >= 2) {
        event.preventDefault();
        onSubdivisionApply();
      } else if ((event.key === "Backspace" || event.key === "Delete") && subdivisionLine.length > 0) {
        event.preventDefault();
        onSubdivisionLineChange(subdivisionLine.slice(0, -1));
      } else if (event.key === "Escape" && subdivisionLine.length > 0) {
        event.preventDefault();
        onSubdivisionLineChange([]);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSubdivisionApply, onSubdivisionLineChange, subdivisionDraftState, subdivisionLine, subdivisionMode]);

  useEffect(() => {
    if (!measurementMode) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Enter" && measurementPoints.length >= 3) {
        event.preventDefault();
        setMeasurementClosed(true);
        setMeasurementHover(null);
      } else if ((event.key === "Backspace" || event.key === "Delete") && measurementPoints.length > 0) {
        event.preventDefault();
        setMeasurementPoints((current) => current.slice(0, -1));
        setMeasurementClosed(false);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setMeasurementMode(false);
        setMeasurementPoints([]);
        setMeasurementClosed(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [measurementMode, measurementPoints.length]);

  function toggleMeasurement() {
    setDrawing(false);
    setDrawingSnap(null);
    setMeasurementMode((current) => {
      if (current) {
        setMeasurementPoints([]);
        setMeasurementClosed(false);
        setMeasurementHover(null);
        setMeasurementSnap(null);
      }
      return !current;
    });
  }

  function startGpsBoundaryCapture() {
    if (!boundaryEditing && !potreroBoundaryEditingId) return;
    setDrawing(false);
    setDrawingSnap(null);
    setMeasurementMode(false);
    setMeasurementPoints([]);
    setMeasurementHover(null);
    setMeasurementSnap(null);
    setMeasurementClosed(false);
    setRedrawingBoundary(false);
    gpsCapture.start("boundary");
  }

  function finishGpsBoundaryCapture() {
    const completed = gpsCapture.stop();
    if (!completed) return;
    const nextDraft = gpsBoundaryCoordinatesToDraft(completed.coordinates);
    if (boundaryEditing) {
      commitEditorSnapshot({
        kind: "fundo",
        points: nextDraft,
        drafts: Object.fromEntries(potreros.map((potrero) => [potrero.id, cloneRing(potrero.coordinates)])),
      });
    } else if (potreroBoundaryEditingId) {
      recordEditorChange();
      onPotreroGpsBoundaryDraftApply(nextDraft);
    }
    setRedrawingBoundary(false);
    setSelectedBoundaryVertex(null);
  }

  function toggleGpsLocation() {
    if (gpsCapture.mode === "location") {
      gpsCapture.cancel();
      return;
    }
    if (gpsCapture.mode === "boundary") return;
    gpsCapture.start("location");
  }

  async function saveEditedBoundary() {
    setSavingBoundary(true);
    setBoundaryError(null);
    try {
      await onBoundarySave();
      setRedrawingBoundary(false);
      if (fullscreen) toggleFullscreenMap();
    } catch (cause) {
      setBoundaryError(cause instanceof Error ? cause.message : "No fue posible guardar el límite.");
    } finally {
      setSavingBoundary(false);
    }
  }

  async function saveEditedPotreroBoundary() {
    setSavingPotreroBoundary(true);
    setPotreroBoundaryError(null);
    try {
      await onPotreroBoundarySave();
      if (fullscreen) toggleFullscreenMap();
    } catch (cause) {
      setPotreroBoundaryError(cause instanceof Error ? cause.message : "No fue posible guardar los bordes.");
    } finally {
      setSavingPotreroBoundary(false);
    }
  }

  function cancelBoundaryEditor(cancel: () => void) {
    if (editorDirty && !window.confirm("¿Descartar los cambios sin guardar del límite?")) return;
    gpsCapture.cancel();
    cancel();
    if (fullscreen) toggleFullscreenMap();
  }

  const filterPaddocks = mapWorkspace.filterPaddocks;
  const filteredPotreros = useMemo(
    () => filterPaddocks(potreros),
    [filterPaddocks, potreros],
  );

  return (
    <div
      aria-label="Dashboard de comandos del mapa"
      className={`map-command-dashboard relative overflow-hidden bg-line-steel ${fullscreen ? "h-full min-h-0 rounded-[16px] sm:rounded-[20px]" : "h-[720px] rounded-[22px] sm:h-[590px]"}`}
      role="region"
    >
      <style>{`
        .leaflet-top.leaflet-left {
          top: 70px !important;
          transition: left 0.3s ease;
          left: ${sidebarCollapsed ? "16px" : "calc(min(360px, 100vw - 4.5rem) + 16px)"} !important;
        }
      `}</style>
      <MapContainer
        center={fundo?.coordinates[0] ?? MAP_CENTER}
        zoom={14}
        zoomControl
        className={`h-full w-full ${drawing || redrawingBoundary || insertingBoundaryVertex || subdivisionMode || measurementMode || exclusionMode || landmarkDraft ? "cursor-crosshair" : ""}`}
      >
        {activeBasemap.id === "osm" && activeBasemap.url ? (
          <TileLayer
            attribution={activeBasemap.attribution}
            eventHandlers={osmTileEventHandlers}
            key={`${activeBasemap.id}:${basemapResolution.degraded ? "fallback" : "preferred"}`}
            maxNativeZoom={activeBasemap.maxNativeZoom}
            maxZoom={23}
            url={activeBasemap.url}
          />
        ) : activeBasemap.styleName && arcgisToken ? (
          <ArcgisVectorBasemapLayer
            key={activeBasemap.styleName}
            onProviderFailure={handleProviderFailure}
            onTileLoad={recordBasemapTile}
            styleName={activeBasemap.styleName}
            token={arcgisToken}
          />
        ) : null}

        {gpsCapture.mode === "boundary" && gpsCapture.trace.length > 1 && (
          <Polyline
            interactive={false}
            positions={gpsCapture.trace}
            pathOptions={{ color: "#2563eb", dashArray: "7 5", opacity: 0.95, weight: 5 }}
          />
        )}

        {gpsCapture.currentFix && (
          <>
            <Circle
              center={gpsCapture.currentFix.coordinate}
              interactive={false}
              pathOptions={{ color: "#2563eb", fillColor: "#60a5fa", fillOpacity: 0.12, opacity: 0.72, weight: 2 }}
              radius={gpsCapture.currentFix.accuracyMeters}
            />
            <CircleMarker
              center={gpsCapture.currentFix.coordinate}
              pathOptions={{ color: "#ffffff", fillColor: "#2563eb", fillOpacity: 1, weight: 3 }}
              radius={8}
            >
              <Tooltip direction="top">
                GPS · precisión {Math.round(gpsCapture.currentFix.accuracyMeters)} m
              </Tooltip>
            </CircleMarker>
          </>
        )}

        {visibleBoundary.length >= 3 && (
          <Polygon
            positions={visibleBoundary}
            pathOptions={{
              color: boundaryEditing ? "#facc15" : "#d9ff78",
              fillColor: boundaryEditing ? "#facc15" : "#173b2d",
              fillOpacity: boundaryEditing ? 0.12 : paddockFillsEnabled ? 0.08 : 0,
              weight: 4,
              dashArray: boundaryEditing ? undefined : "10 7",
            }}
          />
        )}

        {boundaryEditing && boundaryDraft.map((point, index) => (
          <Marker
            draggable={gpsCapture.mode !== "boundary"}
            eventHandlers={{
              click(event) {
                event.originalEvent.stopPropagation();
                setSelectedBoundaryVertex({ kind: "fundo", index });
                setEditorInteractionError(null);
              },
              dragend(event) {
                const position = event.target.getLatLng();
                gpsCapture.cancel();
                moveEditableVertex("fundo", index, [position.lat, position.lng]);
              },
            }}
            icon={selectedBoundaryVertex?.kind === "fundo" && selectedBoundaryVertex.index === index ? SELECTED_BOUNDARY_VERTEX_ICON : BOUNDARY_VERTEX_ICON}
            key={`${index}-${point[0]}-${point[1]}`}
            position={point}
          >
            <Tooltip direction="top">{selectedBoundaryVertex?.kind === "fundo" && selectedBoundaryVertex.index === index ? "Vértice seleccionado" : "Arrastra o toca para seleccionar"}</Tooltip>
          </Marker>
        ))}

        {!subdivisionMode && potreros.filter((potrero) => potrero.id !== potreroBoundaryEditingId).map((potrero) => {
          const selected = selectedId === potrero.id || selectedIds.includes(potrero.id);
          const storedGeometry = paddockGeometry(potrero);
          const geometry = boundaryEditing && boundaryPaddockDrafts[potrero.id]
            ? { ...storedGeometry, outer: boundaryPaddockDrafts[potrero.id] }
            : potreroBoundaryEditingId && potreroBoundaryDrafts[potrero.id]
              ? { ...storedGeometry, outer: potreroBoundaryDrafts[potrero.id] }
              : storedGeometry;
          const editingExclusionIndex = exclusionMode?.action === "edit"
            && exclusionMode.scope.paddockId === potrero.id
            ? exclusionMode.exclusionIndex
            : null;
          const visibleHoles = editingExclusionIndex === null
            ? geometry.holes
            : geometry.holes.filter((_, index) => index !== editingExclusionIndex);
          const metrics = paddockAreaMetrics(potrero);
          const load = stockingLoadsByPaddock[potrero.id];
          const rotation = rotationByPaddock.get(potrero.id);
          const style = getPaddockStyle(potrero, activeThematicMode, {
            selected,
            focused: mapWorkspace.isPaddockFocused(potrero.id),
            sectors: potreros.map((item) => item.sector),
            rotationSnapshot: rotation ? {
              grazingDates: rotation.lastGrazingAt ? [rotation.lastGrazingAt] : [],
              assignedLotCount: rotation.assignedLotCount,
            } : null,
            rotationReferenceDate: rotationSnapshot?.referenceDate,
            rotationThresholds: rotationSnapshot ? {
              recentDays: rotationSnapshot.settings.recentDays,
              longRestDays: rotationSnapshot.settings.longRestDays,
            } : undefined,
            ndviSnapshot: ndviByPaddock.get(potrero.id)?.value ?? null,
          });
          return (
            <Fragment key={potrero.id}>
              <Polygon
                positions={[geometry.outer, ...visibleHoles]}
                pathOptions={{
                  ...style.pathOptions,
                  fillOpacity: paddockFillsEnabled ? style.pathOptions.fillOpacity : 0,
                }}
                eventHandlers={{
                  click: () => {
                    if (!potreroBoundaryEditingId && !boundaryEditing && !drawing && !measurementMode && !exclusionMode && !landmarkDraft) onSelect(selected ? null : potrero.id);
                  },
                  mouseover: () => mapWorkspace.focusPaddock(potrero.id),
                  mouseout: () => mapWorkspace.blurPaddock(potrero.id),
                }}
              >
                {showPaddockLabels && (
                  <Tooltip permanent direction="center" className="map-label">
                    <PaddockTooltip potrero={potrero} metrics={metrics} load={load} thematicDetail={style.detail} />
                  </Tooltip>
                )}
                {!showPaddockLabels && (
                  <Tooltip direction="center" className="map-label">
                    <PaddockTooltip potrero={potrero} metrics={metrics} load={load} thematicDetail={style.detail} />
                  </Tooltip>
                )}
              </Polygon>
              {geometry.holes.map((hole, index) => {
                if (index === editingExclusionIndex) return null;
                const kind = potrero.holeKinds?.[index] ?? "construccion";
                const editable = canMutate
                  && networkOnline
                  && !boundaryEditing
                  && !potreroBoundaryEditingId
                  && !drawing
                  && !measurementMode
                  && !exclusionMode
                  && !landmarkDraft;
                return (
                  <Polygon
                    interactive={editable}
                    key={`${potrero.id}-exclusion-${index}-${editable ? "editable" : "readonly"}`}
                    positions={hole}
                    pathOptions={{ color: EXCLUSION_KIND_COLORS[kind], fillColor: EXCLUSION_KIND_COLORS[kind], fillOpacity: paddockFillsEnabled ? 0.28 : 0, weight: 2.5, dashArray: "5 5" }}
                    eventHandlers={{
                      click(event) {
                        if (!editable) return;
                        event.originalEvent.stopPropagation();
                        onExclusionEdit(potrero.id, index);
                      },
                    }}
                  >
                    <Tooltip direction="top">
                      {EXCLUSION_KIND_LABELS[kind]} · no pastoreable{editable ? " · clic para editar" : ""}
                    </Tooltip>
                  </Polygon>
                );
              })}
            </Fragment>
          );
        })}

        {landmarksVisible && !subdivisionMode && landmarks.map((landmark) => landmark.geometryType === "point" ? (
          <Marker icon={fieldLandmarkIcon(landmark.kind)} key={`landmark-${landmark.id}`} position={landmark.geometry[0]}>
            <Tooltip direction="top">
              <strong>{landmark.name}</strong><br />
              {FIELD_LANDMARK_KIND_LABELS[landmark.kind]}{landmark.notes ? <><br />{landmark.notes}</> : null}
            </Tooltip>
          </Marker>
        ) : (
          <Polyline key={`landmark-${landmark.id}`} pathOptions={{ color: landmark.kind === "cerco_electrico" ? "#dc7b00" : "#19784b", dashArray: landmark.kind === "cerco_electrico" ? "8 5" : undefined, opacity: 0.95, weight: 4 }} positions={landmark.geometry}>
            <Tooltip direction="top">
              <strong>{landmark.name}</strong><br />
              {FIELD_LANDMARK_KIND_LABELS[landmark.kind]} · {formatMeasurement(landmark.lengthMeters)}{landmark.notes ? <><br />{landmark.notes}</> : null}
            </Tooltip>
          </Polyline>
        ))}

        {!subdivisionMode && activeCells.map((cell) => (
          <Polygon
            interactive={false}
            key={`active-cell-${cell.id}`}
            positions={cell.coordinates}
            pathOptions={{ color: "#f97316", dashArray: "8 6", fillColor: "#fb923c", fillOpacity: paddockFillsEnabled ? 0.04 : 0, opacity: 0.95, weight: 3 }}
          >
            <Tooltip direction="center">{cell.name} · franja activa</Tooltip>
          </Polygon>
        ))}

        {!subdivisionMode && cellPreview?.cells.map((cell, index) => (
          <Polygon
            interactive={false}
            key={`preview-cell-${cell.id}`}
            positions={cell.coordinates}
            pathOptions={{ color: "#ea580c", dashArray: "5 4", fillColor: index % 2 === 0 ? "#fb923c" : "#fdba74", fillOpacity: 0.2, opacity: 1, weight: 3.5 }}
          >
            <Tooltip direction="center">{cell.name} · previsualización</Tooltip>
          </Polygon>
        ))}

        {!subdivisionMode && bearingGuide && cellBearingDraft && (
          <>
            <Polyline interactive={false} positions={[bearingGuide.center, bearingGuide.end]} pathOptions={{ color: "#f97316", dashArray: "7 5", opacity: 1, weight: 4 }} />
            <CircleMarker center={bearingGuide.center} interactive={false} pathOptions={{ color: "#ffffff", fillColor: "#f97316", fillOpacity: 1, weight: 2 }} radius={6} />
            <Marker
              draggable
              eventHandlers={{
                dragend(event) {
                  const position = event.target.getLatLng();
                  onCellBearingChange(bearingFromCoordinates(bearingGuide.center, [position.lat, position.lng]));
                },
              }}
              icon={CELL_BEARING_ICON}
              position={bearingGuide.end}
            >
              <Tooltip direction="top">Arrastra para orientar · {Math.round(cellBearingDraft.bearingDegrees)}°</Tooltip>
            </Marker>
          </>
        )}

        {subdivisionMode && subdivisionScope?.kind === "paddock" && potreros
          .filter((potrero) => potrero.id !== subdivisionScope.paddockId)
          .map((potrero) => (
            <Polygon
              interactive={false}
              key={`subdivision-context-${potrero.id}`}
              positions={[paddockGeometry(potrero).outer, ...paddockGeometry(potrero).holes]}
              pathOptions={{
                color: "#d7ddd8",
                fillColor: "#52625a",
                fillOpacity: 0.1,
                opacity: 0.45,
                weight: 1.5,
              }}
            >
              <Tooltip direction="center" className="map-label">
                {potrero.name} · fuera de la operación
              </Tooltip>
            </Polygon>
          ))}

        {potreroBoundaryEditingId && potreroBoundaryDraft.length >= 3 && (
          <Polygon
            positions={potreroBoundaryDraft}
            pathOptions={{ color: "#facc15", fillColor: "#c8ec74", fillOpacity: 0.38, weight: 4 }}
          >
            {showPaddockLabels && (
              <Tooltip permanent direction="center" className="map-label">
                {potreroBoundaryName} · {potreroBoundaryArea.toLocaleString("es-CL")} ha
              </Tooltip>
            )}
          </Polygon>
        )}

        {potreroBoundaryEditingId && potreroBoundaryDraft.map((point, index) => (
          <Marker
            draggable={gpsCapture.mode !== "boundary"}
            eventHandlers={{
              click(event) {
                event.originalEvent.stopPropagation();
                setSelectedBoundaryVertex({ kind: "potrero", index });
                setEditorInteractionError(null);
              },
              dragend(event) {
                const position = event.target.getLatLng();
                gpsCapture.cancel();
                moveEditableVertex("potrero", index, [position.lat, position.lng]);
              },
            }}
            icon={selectedBoundaryVertex?.kind === "potrero" && selectedBoundaryVertex.index === index ? SELECTED_BOUNDARY_VERTEX_ICON : POTRERO_VERTEX_ICON}
            key={`potrero-boundary-${index}-${point[0]}-${point[1]}`}
            position={point}
          >
            <Tooltip direction="top">{selectedBoundaryVertex?.kind === "potrero" && selectedBoundaryVertex.index === index ? "Vértice seleccionado" : "Arrastra o toca para seleccionar"}</Tooltip>
          </Marker>
        ))}

        {subdivisionMode && subdivisionPolygons.map((polygon, index) => (
          <Polygon
            key={`subdivision-${index}`}
            positions={polygon}
            pathOptions={{
              color: "#ffffff",
              fillColor: index % 2 === 0 ? "#28a66a" : "#78a933",
              fillOpacity: 0.28,
              weight: 2.5,
            }}
          >
            {showPaddockLabels && (
              <Tooltip permanent direction="center" className="map-label">
                Área {index + 1} · {calculateHectares(polygon).toLocaleString("es-CL")} ha
              </Tooltip>
            )}
          </Polygon>
        ))}

        {subdivisionLine.length > 1 && (
          <Polyline positions={subdivisionLine} pathOptions={{ color: "#f97316", weight: 4 }} />
        )}

        {subdivisionLine.map((point, index) => (
          <Marker
            draggable
            eventHandlers={{
              dragend(event) {
                const position = event.target.getLatLng();
                onSubdivisionLineChange(subdivisionLine.map((coordinate, coordinateIndex) => coordinateIndex === index ? [position.lat, position.lng] : coordinate));
              },
            }}
            icon={SUBDIVISION_VERTEX_ICON}
            key={`subdivision-line-${point[0]}-${point[1]}-${index}`}
            position={point}
          />
        ))}

        {drawingSnap && (drawing || redrawingBoundary) && (
          <CircleMarker center={drawingSnap.point} radius={9} pathOptions={{ color: "#173b2d", fillColor: "#d9ff78", fillOpacity: 0.78, weight: 3 }}>
            <Tooltip permanent direction="top">{drawingSnap.kind === "vertex" ? "Vértice exacto" : "Encajar en borde"}</Tooltip>
          </CircleMarker>
        )}

        {draftPoints.length > 1 && (
          <Polyline
            positions={draftPoints.length > 2 ? [...draftPoints, draftPoints[0]] : draftPoints}
            pathOptions={{ color: "#d9ff78", weight: 3, dashArray: "8 7" }}
          />
        )}

        {draftPoints.map((point, index) => (
          <Marker
            draggable={!drawing && !boundaryEditing && !potreroBoundaryEditingId}
            eventHandlers={{
              click(event) {
                event.originalEvent.stopPropagation();
                if (drawing) {
                  if (index === 0 && draftPoints.length >= 3) {
                    setDrawing(false);
                    setDrawingSnap(null);
                  }
                  return;
                }
                setSelectedBoundaryVertex({ kind: "new", index });
                setEditorInteractionError(null);
              },
              dragend(event) {
                const position = event.target.getLatLng();
                moveEditableVertex("new", index, [position.lat, position.lng]);
              },
            }}
            icon={selectedBoundaryVertex?.kind === "new" && selectedBoundaryVertex.index === index ? SELECTED_BOUNDARY_VERTEX_ICON : POTRERO_VERTEX_ICON}
            key={`${point[0]}-${point[1]}-${index}`}
            position={point}
          >
            <Tooltip direction="top">{drawing ? `Punto ${index + 1}` : selectedBoundaryVertex?.kind === "new" && selectedBoundaryVertex.index === index ? "Vértice seleccionado" : "Arrastra o toca para seleccionar"}</Tooltip>
          </Marker>
        ))}

        {insertingBoundaryVertex
          && !drawing
          && !redrawingBoundary
          && !subdivisionMode
          && (!exclusionMode || exclusionMode.action === "edit")
          && !landmarkDraft
          && activeEditableRing.length >= 2
          && activeEditableRing.map((point, index) => (
            <Marker
              eventHandlers={{
                click(event) {
                  event.originalEvent.stopPropagation();
                  insertEditableVertex(index);
                },
              }}
              icon={EDGE_INSERT_ICON}
              key={`insert-${activeEditorKind}-${index}-${point[0]}-${point[1]}`}
              position={edgeMidpoint(point, activeEditableRing[(index + 1) % activeEditableRing.length])}
            >
              <Tooltip direction="top">Agregar vértice en este tramo</Tooltip>
            </Marker>
          ))}

        {exclusionMode && exclusionDraft.length >= 3 && (
          <Polygon
            positions={exclusionDraft}
            pathOptions={{ color: EXCLUSION_KIND_COLORS[exclusionMode.kind], fillColor: EXCLUSION_KIND_COLORS[exclusionMode.kind], fillOpacity: 0.34, weight: 3, dashArray: "7 5" }}
          >
            <Tooltip permanent direction="center">{EXCLUSION_KIND_LABELS[exclusionMode.kind]} · vista previa</Tooltip>
          </Polygon>
        )}

        {exclusionDraft.length > 1 && exclusionDraft.length < 3 && (
          <Polyline positions={exclusionDraft} pathOptions={{ color: exclusionMode ? EXCLUSION_KIND_COLORS[exclusionMode.kind] : "#ef4444", weight: 3, dashArray: "7 5" }} />
        )}

        {exclusionMode?.action === "edit" && exclusionDraft.map((point, index) => (
          <Marker
            draggable
            eventHandlers={{
              click(event) {
                event.originalEvent.stopPropagation();
                setSelectedBoundaryVertex({ kind: "exclusion", index });
                setEditorInteractionError(null);
              },
              dragend(event) {
                const position = event.target.getLatLng();
                moveEditableVertex("exclusion", index, [position.lat, position.lng]);
              },
            }}
            icon={selectedBoundaryVertex?.kind === "exclusion" && selectedBoundaryVertex.index === index ? SELECTED_BOUNDARY_VERTEX_ICON : POTRERO_VERTEX_ICON}
            key={`exclusion-edit-${point[0]}-${point[1]}-${index}`}
            position={point}
          >
            <Tooltip direction="top">
              {selectedBoundaryVertex?.kind === "exclusion" && selectedBoundaryVertex.index === index
                ? "Vértice seleccionado"
                : "Arrastra o toca para seleccionar"}
            </Tooltip>
          </Marker>
        ))}

        {exclusionMode?.action !== "edit" && exclusionDraft.map((point, index) => (
          <CircleMarker center={point} key={`exclusion-draft-${point[0]}-${point[1]}-${index}`} radius={6} pathOptions={{ color: "#ffffff", fillColor: exclusionMode ? EXCLUSION_KIND_COLORS[exclusionMode.kind] : "#ef4444", fillOpacity: 1, weight: 2 }} />
        ))}

        {exclusionMode?.action === "create" && exclusionSnap && (
          <CircleMarker center={exclusionSnap.point} radius={9} pathOptions={{ color: "#ffffff", fillColor: EXCLUSION_KIND_COLORS[exclusionMode.kind], fillOpacity: 0.9, weight: 3 }}>
            <Tooltip permanent direction="top">{exclusionSnap.kind === "closing" ? "Cerrar exclusión" : "Punto de exclusión"}</Tooltip>
          </CircleMarker>
        )}

        {landmarkDraft?.geometryType === "line" && landmarkDraft.geometry.length > 1 && (
          <Polyline positions={landmarkDraft.geometry} pathOptions={{ color: "#f97316", dashArray: "7 5", opacity: 1, weight: 4 }} />
        )}
        {landmarkDraft?.geometry.map((point, index) => (
          <CircleMarker center={point} key={`landmark-draft-${point[0]}-${point[1]}-${index}`} radius={landmarkDraft.geometryType === "point" ? 9 : 6} pathOptions={{ color: "#ffffff", fillColor: "#f97316", fillOpacity: 1, weight: 3 }}>
            {landmarkDraft.geometryType === "point" && <Tooltip permanent direction="top">Hito nuevo</Tooltip>}
          </CircleMarker>
        ))}

        {measurementClosed && measurementPoints.length >= 3 && (
          <Polygon
            positions={measurementPoints}
            pathOptions={{ color: "#38bdf8", fillColor: "#38bdf8", fillOpacity: 0.12, weight: 3, dashArray: "7 6" }}
          />
        )}

        {!measurementClosed && measurementPreview.length > 1 && (
          <Polyline positions={measurementPreview} pathOptions={{ color: "#38bdf8", weight: 4, dashArray: "7 6" }} />
        )}

        {measurementPoints.map((point, index) => (
          <CircleMarker
            center={point}
            key={`measurement-${point[0]}-${point[1]}-${index}`}
            radius={index === 0 ? 7 : 5}
            pathOptions={{ color: "#082f49", fillColor: "#7dd3fc", fillOpacity: 1, weight: 2 }}
          />
        ))}

        {measurementMode && measurementSnap && !measurementClosed && (
          <CircleMarker center={measurementSnap.point} radius={9} pathOptions={{ color: "#082f49", fillColor: "#7dd3fc", fillOpacity: 0.82, weight: 3 }}>
            <Tooltip permanent direction="top">
              {measurementSnap.kind === "closing" ? "Cerrar medición" : measurementSnap.kind === "vertex" ? "Vértice exacto" : "Encajar en borde"}
            </Tooltip>
          </CircleMarker>
        )}

        <DrawingEvents
          closeOnFirst
          enabled={drawing && !boundaryEditing && !subdivisionMode && !potreroBoundaryEditingId && !measurementMode && !landmarkDraft}
          onChange={(points) => commitEditorSnapshot({ kind: "new", points })}
          onClose={() => { setDrawing(false); setDrawingSnap(null); }}
          onSnapChange={setDrawingSnap}
          points={draftPoints}
          snapPolygons={snapPolygons}
        />
        <DrawingEvents
          closeOnFirst
          enabled={exclusionMode?.action === "create" && !landmarkDraft}
          onChange={onExclusionDraftChange}
          onClose={onExclusionPreview}
          onSnapChange={setExclusionSnap}
          points={exclusionDraft}
          snapPolygons={[]}
        />
        <SubdivisionDrawingEvents
          autoClose={autoCloseSubdivision}
          enabled={subdivisionMode && subdivisionDraftState !== "stale" && !landmarkDraft}
          onApply={onSubdivisionApply}
          onChange={onSubdivisionLineChange}
          onInteractionError={setSubdivisionInteractionError}
          points={subdivisionLine}
          polygons={subdivisionPolygons}
        />
        <DrawingEvents
          closeOnFirst
          enabled={boundaryEditing && redrawingBoundary && !landmarkDraft}
          onChange={(points) => commitEditorSnapshot({
            kind: "fundo",
            points,
            drafts: Object.fromEntries(potreros.map((potrero) => [potrero.id, cloneRing(potrero.coordinates)])),
          })}
          onClose={() => { setRedrawingBoundary(false); setDrawingSnap(null); }}
          onSnapChange={setDrawingSnap}
          points={boundaryDraft}
          snapPolygons={snapPolygons}
        />
        <DrawingEvents
          closeOnFirst
          enabled={measurementMode && !measurementClosed && !landmarkDraft}
          onChange={(points) => { setMeasurementPoints(points); setMeasurementClosed(false); }}
          onClose={() => { setMeasurementClosed(true); setMeasurementHover(null); setMeasurementSnap(null); }}
          onHoverChange={setMeasurementHover}
          onSnapChange={setMeasurementSnap}
          points={measurementPoints}
          snapPolygons={snapPolygons}
        />
        <DrawingEvents
          enabled={Boolean(landmarkDraft)}
          onChange={(points) => onLandmarkDraftChange(landmarkDraft?.geometryType === "point" ? points.slice(-1) : points)}
          onSnapChange={() => undefined}
          points={landmarkDraft?.geometry ?? []}
          snapPolygons={[]}
        />
        <MapFocus fundo={fundo} resetSignal={resetSignal} subdivisionMode={subdivisionMode} />
        <GpsMapFocus coordinate={gpsCapture.currentFix?.coordinate ?? null} />
        <DrawingInteractionController enabled={drawingInteractionActive} />
        <MapViewportObserver onViewportChange={mapWorkspace.observeViewport} />
        <MapLayoutObserver fullscreen={fullscreen} />
      </MapContainer>

      {/* 1. Left Collapsible Sidebar */}
      <div className="pointer-events-none absolute left-4 top-4 bottom-4 z-[600] flex">
        <div
          className={`flex h-full flex-col rounded bg-chrome text-white border border-line-strong transition-all duration-300 ${
            sidebarCollapsed
              ? "pointer-events-none invisible w-0 overflow-hidden border-none opacity-0 mr-0"
              : "pointer-events-auto w-[min(360px,calc(100vw-4.5rem))] opacity-100 mr-2"
          }`}
        >
          <div className="w-[min(360px,calc(100vw-4.5rem))] flex flex-col h-full">
          {/* Sidebar Header */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 p-3">
            <span className="truncate text-[12px] font-black uppercase tracking-wider text-white/90">
              {fundo?.name ?? "FundoSmart"}
            </span>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="grid size-11 shrink-0 place-items-center rounded bg-white/5 hover:bg-white/15 text-white/80 hover:text-white transition"
              title="Contraer barra lateral"
              type="button"
            >
              <ChevronLeft size={16} />
            </button>
          </div>

          {/* Sidebar Body */}
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {/* General Actions & Directory (only if NOT in active edit mode) */}
            {!boundaryEditing && !potreroBoundaryEditingId && !subdivisionMode && !exclusionMode && !measurementMode && !drawing && draftPoints.length === 0 ? (
              <>
                <div className="space-y-2">
                  <span className="block text-[10px] font-black uppercase tracking-widest text-white/40">Acciones del mapa</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {canMutate && (
                      <>
                        <button
                          className="flex min-h-9 items-center justify-center gap-2 rounded bg-white/5 border border-white/10 px-3 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-white/10 transition"
                          onClick={() => { setMeasurementMode(false); setInsertingBoundaryVertex(false); setSelectedBoundaryVertex(null); setDrawingSnap(null); setDrawing(true); }}
                          type="button"
                        >
                          <Pencil size={13} />
                          <span>Dibujar</span>
                        </button>
                        <button
                          className="flex min-h-9 items-center justify-center gap-2 rounded bg-white/5 border border-white/10 px-3 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-white/10 transition disabled:opacity-40"
                          disabled={!structuralOperationsEnabled}
                          onClick={() => { setMeasurementMode(false); setMeasurementPoints([]); onSubdivisionStart(); }}
                          type="button"
                        >
                          <ScissorsLineDashed size={13} />
                          <span>Subdividir</span>
                        </button>
                        <button
                          className="flex min-h-9 items-center justify-center gap-2 rounded bg-white/5 border border-white/10 px-3 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-white/10 transition disabled:opacity-40 col-span-2"
                          disabled={!networkOnline || !fundo || potreros.length === 0}
                          onClick={onFieldExclusionStart}
                          type="button"
                        >
                          <Droplets size={13} />
                          <span>Dibujar exclusión</span>
                        </button>
                      </>
                    )}
                    <button
                      className="flex min-h-9 items-center justify-center gap-2 rounded bg-white/5 border border-white/10 px-3 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-white/10 transition col-span-2"
                      onClick={toggleMeasurement}
                      type="button"
                    >
                      <Ruler size={13} />
                      <span> Medir</span>
                    </button>
                  </div>
                </div>

                {/* Searchable Paddock directory list (only when no paddock is selected) */}
                {!selectedPotrero && (
                  <div className="space-y-2 border-t border-white/10 pt-3">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-white/40">Directorio de Potreros ({potreros.length})</span>
                    <input
                      type="text"
                      placeholder="Buscar potrero..."
                      className="w-full rounded bg-white/5 border border-white/10 px-2.5 py-1.5 text-[11px] font-bold text-white placeholder-white/30 outline-none focus:ring-1 focus:ring-accent"
                      onChange={(event) => mapWorkspace.setSearch(event.target.value)}
                      value={mapWorkspace.search}
                    />
                    <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                      {filteredPotreros.map(potrero => (
                        <button
                          key={potrero.id}
                          className="flex w-full items-center justify-between rounded bg-white/5 p-2 text-[11px] font-bold hover:bg-white/10 text-white/90 text-left transition border border-white/5"
                          onClick={() => onSelect(potrero.id)}
                          type="button"
                        >
                          <span>{potrero.name}</span>
                          <span className="font-mono text-white/40">{calculateHectares(potrero.coordinates).toLocaleString("es-CL")} ha</span>
                        </button>
                      ))}
                      {filteredPotreros.length === 0 && (
                        <span className="block text-[11px] italic text-white/40 py-2 text-center">No se encontraron potreros.</span>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              (boundaryEditing || potreroBoundaryEditingId || subdivisionMode || exclusionMode || measurementMode || drawing || draftPoints.length > 0) && (
                <div className="flex flex-col items-center justify-center h-40 text-center space-y-2 border border-white/5 bg-white/5 rounded p-4">
                  <PencilRuler className="text-hivis animate-pulse" size={24} />
                  <span className="text-[12px] font-bold text-white/70">Edición en curso</span>
                  <span className="text-[10px] text-white/45">Usa los controles superiores o el botón de abajo para salir.</span>
                  <button
                    onClick={() => {
                      setDrawing(false);
                      commitEditorSnapshot({ kind: "new", points: [] });
                      setSelectedBoundaryVertex(null);
                      setInsertingBoundaryVertex(false);
                      if (boundaryEditing) cancelBoundaryEditor(onBoundaryCancel);
                      if (potreroBoundaryEditingId) cancelBoundaryEditor(onPotreroBoundaryCancel);
                      if (subdivisionMode) onSubdivisionCancel();
                      if (exclusionMode) onExclusionCancel();
                      if (measurementMode) toggleMeasurement();
                    }}
                    className="mt-1 flex min-h-7 items-center gap-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/15 px-3 text-[10px] font-bold uppercase tracking-wider text-white transition"
                    type="button"
                  >
                    <X size={12} />
                    <span>Cancelar edición</span>
                  </button>
                </div>
              )
            )}

            {/* Map Selection panel */}
            {!boundaryEditing && !potreroBoundaryEditingId && !subdivisionMode && !exclusionMode && !measurementMode && (
              <MapPotreroPanel
                activeCellCount={selectedPotreroCellCount}
                canMutate={selectedPotreroCanMutate}
                landmarkBusy={landmarkBusy}
                landmarks={landmarks}
                networkOnline={networkOnline}
                onAddLandmark={onPaddockLandmarkStart}
                onArchiveLandmark={onLandmarkArchive}
                onDelete={onPotreroDelete}
                onDrawExclusion={onPotreroExclusionStart}
                onEdit={onPotreroEdit}
                onEditBoundary={onPotreroBoundaryEdit}
                onEditLandmark={onLandmarkEdit}
                onManageCells={onPotreroCellsOpen}
                onSelect={onSelect}
                onSubdivide={onPotreroSubdivide}
                onUndo={onPotreroUndo}
                potreros={potreros}
                selectedPotrero={selectedPotrero}
                stockingLoad={selectedPotreroStockingLoad}
                structuralOperationsEnabled={selectedPotreroOperationsEnabled}
                undoPreview={potreroUndoPreview}
              />
            )}
          </div>
        </div>
      </div>

        {/* Sidebar Expand Button (when collapsed) */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="pointer-events-auto ml-2 flex h-11 w-11 items-center justify-center rounded bg-chrome text-white border border-line-strong hover:bg-chrome-2 shadow-lg transition"
            title="Expandir barra lateral"
            type="button"
          >
            <ChevronRight size={16} />
          </button>
        )}
      </div>

      {/* 2. Top-Right Settings Toolbar */}
      <div className="pointer-events-none absolute right-4 top-4 z-[500] flex max-w-[calc(100%-2rem)] flex-col items-end gap-1.5">
        <div
          aria-label="Controles de vista del mapa"
          className="pointer-events-auto flex w-full flex-wrap items-center justify-end gap-1 rounded bg-chrome p-1 text-white border border-line-strong shadow-lg"
          id="map-view-controls"
          role="toolbar"
        >
          <button
            aria-label="Mostrar solo bordes de los potreros"
            aria-pressed={!paddockFillsEnabled}
            className={`flex h-11 min-w-11 items-center justify-center gap-1.5 rounded px-2 text-[10px] font-bold uppercase tracking-wider transition border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${!paddockFillsEnabled ? "bg-accent border-accent text-white" : "bg-white/5 border-white/5 text-white/70 hover:bg-white/10 hover:text-white"}`}
            data-map-help={paddockFillsEnabled ? "Oculta los colores para ver la imagen satelital sin tintes." : "La imagen está sin tintes; vuelve a mostrar los colores temáticos."}
            onClick={togglePaddockFills}
            type="button"
          >
            {!paddockFillsEnabled ? <EyeOff aria-hidden="true" size={13} /> : <Eye aria-hidden="true" size={13} />}
            <span>Solo bordes</span>
          </button>

          <label className={`flex min-h-11 items-center gap-1.5 rounded bg-white/5 px-2 text-[10px] font-bold uppercase tracking-wider text-white transition border border-white/5 focus-within:ring-2 focus-within:ring-accent ${paddockFillsEnabled ? "hover:bg-white/10 cursor-pointer" : "opacity-50 cursor-not-allowed"}`} data-map-help={paddockFillsEnabled ? "Cambia el tema de color de los potreros." : "Desactiva Solo bordes para elegir un tema de color."}>
            <Palette aria-hidden="true" size={13} />
            <select
              aria-label="Tema de color de los potreros"
              className="min-h-11 max-w-28 bg-transparent text-[10px] font-black text-white outline-none cursor-pointer text-ink text-[11px]"
              disabled={!paddockFillsEnabled}
              onChange={(event) => setThematicMode(event.target.value as PaddockThematicMode)}
              value={activeThematicMode}
            >
              {ALWAYS_AVAILABLE_THEMATIC_MODES.map((mode) => <option className="text-ink text-[11px]" key={mode} value={mode}>{PADDOCK_THEMATIC_MODE_LABELS[mode]}</option>)}
              <option disabled={!hasKnownNdvi} value="ndvi">{hasKnownNdvi ? "NDVI" : "NDVI · sin datos"}</option>
            </select>
          </label>

          <button
            aria-pressed={landmarksVisible}
              className={`flex h-11 min-w-11 items-center justify-center gap-1.5 rounded px-2 text-[10px] font-bold uppercase tracking-wider transition border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${landmarksVisible ? "bg-accent border-accent text-white" : "bg-white/5 border-white/5 text-white/70 hover:bg-white/10 hover:text-white"}`}
            data-map-help="Muestra u oculta hitos e infraestructura."
            onClick={() => setLandmarksVisible((visible) => !visible)}
            type="button"
          >
            {landmarksVisible ? <Eye aria-hidden="true" size={13} /> : <EyeOff aria-hidden="true" size={13} />}
            <span>Hitos</span>
          </button>

          <div className="relative">
            <button
              aria-controls="map-basemap-menu"
              aria-describedby="active-basemap-attribution"
              aria-expanded={basemapMenuOpen}
              aria-haspopup="menu"
              aria-label={`Mapa base preferido: ${preferredBasemap.label}. En pantalla: ${activeBasemap.label}. Cambiar mapa base`}
              className="flex h-11 min-w-11 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 px-2 text-[10px] font-bold uppercase tracking-wider text-white transition border border-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              data-map-help="Cambia entre OpenStreetMap, Satélite, Topográfico y Relieve."
              onClick={() => setBasemapMenuOpen((open) => !open)}
              ref={basemapToggleRef}
              type="button"
            >
              <Layers3 aria-hidden="true" size={13} />
              <span>{preferredBasemap.label}{basemapResolution.degraded ? " · OSM" : ""}</span>
            </button>
            {basemapMenuOpen && (
              <div
                aria-label="Elegir mapa base"
                className="absolute right-0 top-[calc(100%+6px)] w-60 overflow-hidden rounded bg-chrome p-1 border border-line-strong shadow-2xl z-[600]"
                id="map-basemap-menu"
                ref={basemapMenuRef}
                role="menu"
              >
                {basemaps.map((basemap) => (
                  <button
                    aria-checked={basemap.id === preferredBasemap.id}
                    className={`flex min-h-11 w-full items-center justify-between gap-2 rounded px-2 py-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${basemap.id === preferredBasemap.id ? "bg-accent text-white" : "hover:bg-white/10 text-white/80"}`}
                    key={basemap.id}
                    onClick={() => selectPreferredBasemap(basemap.id)}
                    role="menuitemradio"
                    type="button"
                  >
                    <span>
                      <span className="block text-[10px] font-black uppercase tracking-wider">{basemap.label}</span>
                      <span className="block text-[9px] text-white/70">{basemap.description}</span>
                    </span>
                    {basemap.id === preferredBasemap.id && <Check aria-hidden="true" className="shrink-0 text-white" size={12} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            aria-pressed={labelsEnabled}
            aria-label={`${labelsEnabled ? "Ocultar" : "Mostrar"} etiquetas de potreros`}
            className={`flex h-11 min-w-11 items-center justify-center gap-1.5 rounded px-2 text-[10px] font-bold uppercase tracking-wider transition border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${labelsEnabled ? "bg-accent border-accent text-white" : "bg-white/5 border-white/5 text-white/70 hover:bg-white/10 hover:text-white"}`}
            data-map-help="Muestra u oculta nombres de potreros."
            onClick={toggleLabels}
            type="button"
          >
            <Tags aria-hidden="true" size={13} />
            <span>Etiquetas</span>
          </button>

          <button
            aria-label={gpsCapture.mode === "location" ? "Detener mi ubicación" : "Mostrar mi ubicación"}
            aria-pressed={gpsCapture.mode === "location"}
            className={`flex h-11 min-w-11 items-center justify-center gap-1.5 rounded px-2 text-[10px] font-bold uppercase tracking-wider transition border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${gpsCapture.mode === "location" ? "bg-blue-600 border-blue-600 text-white" : "bg-white/5 border-white/5 text-white/70 hover:bg-white/10 hover:text-white"}`}
            data-map-help={gpsLocationUnavailableReason ?? "Centra el mapa en tu ubicación GPS."}
            disabled={gpsCapture.mode === "boundary" || Boolean(gpsLocationUnavailableReason)}
            onClick={toggleGpsLocation}
            type="button"
          >
            <Navigation aria-hidden="true" size={13} />
            <span>Mi ubicación</span>
          </button>

          <button
            aria-label="Volver a la vista inicial"
            className="flex h-11 min-w-11 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 px-2 text-[10px] font-bold uppercase tracking-wider text-white transition border border-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            data-map-help="Vuelve a ver el fundo completo."
            onClick={() => setResetSignal((value) => value + 1)}
            type="button"
          >
            <LocateFixed size={13} />
            <span>Recentrar</span>
          </button>

          <button
            aria-label={fullscreen ? "Salir de pantalla completa" : "Abrir mapa en pantalla completa"}
            className="flex h-11 min-w-11 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 px-2 text-[10px] font-bold uppercase tracking-wider text-white transition border border-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            data-map-help={fullscreen ? "Vuelve a la vista normal de página." : "Usa todo el espacio de la pantalla."}
            onClick={toggleFullscreenMap}
            type="button"
          >
            {fullscreen ? <Minimize2 aria-hidden="true" size={13} /> : <Maximize2 aria-hidden="true" size={13} />}
            <span>{fullscreen ? "Salir" : "Completa"}</span>
          </button>
        </div>
        <ActiveBasemapAttribution
          activeBasemap={activeBasemap}
          degraded={basemapResolution.degraded}
          preferredBasemap={preferredBasemap}
        />
      </div>

      {/* 3. Top-Center Contextual Active Editor HUD */}
      {(boundaryEditing || potreroBoundaryEditingId || subdivisionMode || exclusionMode || landmarkDraft || measurementMode || drawing || draftPoints.length > 0) && (
        <div
          className="pointer-events-none absolute right-0 top-4 z-[500] flex justify-center px-4 transition-[left] duration-300"
          style={{ left: sidebarCollapsed ? 0 : "min(376px, calc(100% - 4.5rem))" }}
        >
          <div
            aria-label="Controles de edición activa"
            className="pointer-events-auto flex max-w-full flex-col items-center gap-1.5 rounded bg-chrome px-2 py-1.5 text-white shadow-xl border border-line-strong border-b-2 border-b-hivis"
            role="toolbar"
          >
            {boundaryEditing ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex min-h-8 items-center gap-1.5 rounded bg-amber-500/20 border border-hivis px-2 text-[10px] font-black uppercase text-hivis">
                    <PencilRuler className="shrink-0" size={13} />
                    <span>Límite del fundo · {boundaryArea.toLocaleString("es-CL")} ha</span>
                  </span>
                  <span className={`flex min-h-8 items-center rounded px-2.5 text-[10px] font-bold uppercase tracking-wider ${editorDirty ? "bg-amber-100/10 text-amber-300 border border-amber-500/20" : "bg-white/5 text-white/50 border border-white/5"}`}>
                    {editorDirty ? "Cambios sin guardar" : "Sin cambios"}
                  </span>
                  {linkedFieldPaddockChangeCount > 0 && (
                    <span className="flex min-h-8 items-center rounded bg-sky-500/10 border border-sky-500/20 px-2.5 text-[10px] font-bold uppercase text-sky-300">
                      También ajusta {linkedFieldPaddockChangeCount} potrero{linkedFieldPaddockChangeCount === 1 ? "" : "s"}
                    </span>
                  )}
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-accent hover:bg-accent-strong px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-40" data-map-help="Guarda en el servidor la forma actual del límite del fundo." disabled={!editorDirty || savingBoundary || gpsCapture.mode === "boundary" || boundaryDraft.length < 3 || boundaryArea <= 0 || boundaryValidation.errors.length > 0} onClick={saveEditedBoundary} type="button">
                    {savingBoundary ? <LoaderCircle className="animate-spin" size={12} /> : <Check size={12} />}
                    <span>{linkedFieldPaddockChangeCount > 0 ? "Guardar fundo y potreros" : "Guardar límite del fundo"}</span>
                  </button>
                  <button aria-pressed={insertingBoundaryVertex} className={`flex min-h-8 items-center gap-1.5 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider transition ${insertingBoundaryVertex ? "bg-hivis text-ink border-hivis" : "bg-white/5 hover:bg-white/10 text-white border-white/10 border"}`} data-map-help="Activa puntos intermedios sobre cada lado para sumar un nuevo vértice." disabled={gpsCapture.mode === "boundary" || redrawingBoundary || boundaryDraft.length < 2} onClick={() => { setInsertingBoundaryVertex((active) => !active); setSelectedBoundaryVertex(null); }} type="button">
                    <CirclePlus size={12} />
                    <span>Agregar punto</span>
                  </button>
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition disabled:opacity-30" data-map-help="Elimina el vértice seleccionado sin dejar el polígono con menos de tres puntos." disabled={gpsCapture.mode === "boundary" || selectedBoundaryVertex?.kind !== "fundo" || boundaryDraft.length <= 3} onClick={removeSelectedEditableVertex} type="button">
                    <Trash2 size={12} />
                    <span>Eliminar punto</span>
                  </button>
                  <button aria-label="Deshacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" data-map-help="Vuelve al cambio anterior del límite." disabled={!canUndoEditor || gpsCapture.mode === "boundary"} onClick={undoEditorChange} type="button">
                    <Undo2 size={13} />
                    <span>Deshacer</span>
                  </button>
                  <button aria-label="Rehacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" data-map-help="Recupera el último cambio que deshiciste." disabled={!canRedoEditor || gpsCapture.mode === "boundary"} onClick={redoEditorChange} type="button">
                    <Redo2 size={13} />
                    <span>Rehacer</span>
                  </button>
                  <button className={`min-h-8 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider transition border ${redrawingBoundary ? "bg-white text-ink border-white" : "bg-white/5 hover:bg-white/10 border-white/10"}`} data-map-help="Borra el trazado temporal para dibujar nuevamente todo el límite." disabled={gpsCapture.mode === "boundary"} onClick={() => { gpsCapture.cancel(); setRedrawingBoundary(true); setInsertingBoundaryVertex(false); setSelectedBoundaryVertex(null); setDrawingSnap(null); commitEditorSnapshot({ kind: "fundo", points: [], drafts: Object.fromEntries(potreros.map((potrero) => [potrero.id, cloneRing(potrero.coordinates)])) }); }} type="button">
                    <span>Redibujar todo</span>
                  </button>
                  <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-35" data-map-help="Descarta los cambios locales y recupera el límite y los potreros guardados." disabled={gpsCapture.mode === "boundary" || !editorDirty} onClick={() => { gpsCapture.cancel(); commitEditorSnapshot({ kind: "fundo", points: cloneRing(fundo?.coordinates ?? []), drafts: Object.fromEntries(potreros.map((potrero) => [potrero.id, cloneRing(potrero.coordinates)])) }); setRedrawingBoundary(false); setSelectedBoundaryVertex(null); }} type="button">
                    <span>Restablecer</span>
                  </button>
                  <GpsBoundaryControls capture={gpsCapture} onFinish={finishGpsBoundaryCapture} onStart={startGpsBoundaryCapture} />
                  <button aria-label="Cancelar" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition" disabled={savingBoundary} onClick={() => cancelBoundaryEditor(onBoundaryCancel)} type="button">
                    <X size={13} />
                    <span>Cancelar</span>
                  </button>
                </div>
                <GeometryFeedback error={editorInteractionError ?? boundaryError} validation={boundaryValidation} wide />
              </div>
            ) : potreroBoundaryEditingId ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex min-h-8 items-center gap-1.5 rounded bg-amber-500/20 border border-hivis px-2 text-[10px] font-black uppercase text-hivis">
                    <PencilRuler className="shrink-0" size={13} />
                    <span>{potreroBoundaryName} · {potreroBoundaryArea.toLocaleString("es-CL")} ha</span>
                  </span>
                  <span className={`flex min-h-8 items-center rounded px-2.5 text-[10px] font-bold uppercase tracking-wider ${editorDirty ? "bg-amber-100/10 text-amber-300 border border-amber-500/20" : "bg-white/5 text-white/50 border border-white/5"}`}>
                    {editorDirty ? "Cambios sin guardar" : "Sin cambios"}
                  </span>
                  {linkedPaddockChangeCount > 0 && (
                    <span className="flex min-h-8 items-center rounded bg-sky-500/10 border border-sky-500/20 px-2.5 text-[10px] font-bold uppercase text-sky-300">
                      También ajusta {linkedPaddockChangeCount} vecino{linkedPaddockChangeCount === 1 ? "" : "s"}
                    </span>
                  )}
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-accent hover:bg-accent-strong px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-40" data-map-help="Guarda el borde editado y los ajustes necesarios en potreros vecinos." disabled={!editorDirty || savingPotreroBoundary || gpsCapture.mode === "boundary" || potreroBoundaryDraft.length < 3 || potreroBoundaryArea <= 0 || potreroBoundaryValidation.errors.length > 0} onClick={saveEditedPotreroBoundary} type="button">
                    {savingPotreroBoundary ? <LoaderCircle className="animate-spin" size={12} /> : <Check size={12} />}
                    <span>Guardar potrero</span>
                  </button>
                  <button aria-pressed={insertingBoundaryVertex} className={`flex min-h-8 items-center gap-1.5 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider transition ${insertingBoundaryVertex ? "bg-hivis text-ink border-hivis" : "bg-white/5 hover:bg-white/10 text-white border-white/10 border"}`} data-map-help="Muestra puntos sobre cada lado para agregar un nuevo vértice." disabled={gpsCapture.mode === "boundary" || potreroBoundaryDraft.length < 2} onClick={() => { setInsertingBoundaryVertex((active) => !active); setSelectedBoundaryVertex(null); }} type="button">
                    <CirclePlus size={12} />
                    <span>Agregar punto</span>
                  </button>
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition disabled:opacity-30" data-map-help="Elimina el vértice seleccionado y mantiene unidos los bordes compartidos." disabled={gpsCapture.mode === "boundary" || selectedBoundaryVertex?.kind !== "potrero" || potreroBoundaryDraft.length <= 3} onClick={removeSelectedEditableVertex} type="button">
                    <Trash2 size={12} />
                    <span>Eliminar punto</span>
                  </button>
                  <button aria-label="Deshacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" data-map-help="Vuelve al cambio anterior del borde." disabled={!canUndoEditor || gpsCapture.mode === "boundary"} onClick={undoEditorChange} type="button">
                    <Undo2 size={13} />
                    <span>Deshacer</span>
                  </button>
                  <button aria-label="Rehacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" data-map-help="Recupera el último cambio que deshiciste." disabled={!canRedoEditor || gpsCapture.mode === "boundary"} onClick={redoEditorChange} type="button">
                    <Redo2 size={13} />
                    <span>Rehacer</span>
                  </button>
                  <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-35" data-map-help="Descarta los cambios locales y recupera todos los bordes guardados." disabled={gpsCapture.mode === "boundary" || !editorDirty} onClick={() => { gpsCapture.cancel(); commitEditorSnapshot({ kind: "potrero", drafts: Object.fromEntries(potreros.map((potrero) => [potrero.id, cloneRing(potrero.coordinates)])) }); setSelectedBoundaryVertex(null); }} type="button">
                    <span>Restablecer</span>
                  </button>
                  <GpsBoundaryControls capture={gpsCapture} onFinish={finishGpsBoundaryCapture} onStart={startGpsBoundaryCapture} />
                  <button aria-label="Cancelar" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition" disabled={savingPotreroBoundary} onClick={() => cancelBoundaryEditor(onPotreroBoundaryCancel)} type="button">
                    <X size={13} />
                    <span>Cancelar</span>
                  </button>
                </div>
                <GeometryFeedback error={editorInteractionError ?? potreroBoundaryError} validation={potreroBoundaryValidation} wide />
              </div>
            ) : subdivisionMode ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex min-h-8 items-center gap-1.5 rounded bg-amber-500/20 border border-hivis px-2 text-[10px] font-black uppercase text-hivis">
                    <ScissorsLineDashed size={13} />
                    <span>{subdivisionScope?.kind === "paddock" ? subdivisionScope.paddockName : `${subdivisionPolygons.length} áreas`}</span>
                  </span>
                  <span className={`flex min-h-8 items-center gap-1.5 rounded border px-2 text-[10px] font-bold uppercase tracking-wider ${subdivisionDraftState === "offline" || subdivisionDraftState === "stale" ? "bg-amber-100/10 text-amber-300 border-amber-500/20" : "bg-white/5 border-white/10 text-white/70"}`}>
                    {subdivisionDraftState === "saving" || subdivisionDraftState === "loading"
                      ? <LoaderCircle className="animate-spin" size={11} />
                      : subdivisionDraftState === "offline" || subdivisionDraftState === "stale"
                        ? <CloudOff size={11} />
                        : <Cloud size={11} />}
                    <span>{subdivisionDraftState === "saving" || subdivisionDraftState === "loading" ? "Guardando" : subdivisionDraftState === "offline" ? "Sin conexión" : subdivisionDraftState === "stale" ? "Borrador desactualizado" : "Guardado"}</span>
                  </span>
                  <button aria-pressed={autoCloseSubdivision} className={`flex min-h-8 items-center gap-1.5 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider transition ${autoCloseSubdivision ? "bg-accent border-accent text-white" : "bg-white/5 border-white/10 text-white border"}`} onClick={() => setAutoCloseSubdivision((value) => !value)} type="button">
                    <Magnet size={12} />
                    <span>Cierre auto</span>
                  </button>
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-white hover:bg-white/90 text-ink px-2.5 text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-35" disabled={subdivisionDraftState === "stale" || subdivisionLine.length < 2} onClick={() => onSubdivisionApply()} type="button">
                    <Check size={12} />
                    <span>Aplicar</span>
                  </button>
                  <button aria-label="Quitar último punto" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-30" disabled={subdivisionDraftState === "stale" || subdivisionLine.length === 0} onClick={() => onSubdivisionLineChange(subdivisionLine.slice(0, -1))} type="button">
                    <Undo2 size={13} />
                    <span>Quitar punto</span>
                  </button>
                  <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-30" disabled={subdivisionDraftState === "stale" || !subdivisionCanUndo} onClick={onSubdivisionUndo} type="button">
                    <span>Deshacer corte</span>
                  </button>
                  <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition" onClick={onSubdivisionCancel} type="button">
                    <span>Salir</span>
                  </button>
                  <button aria-label="Reiniciar" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition disabled:opacity-30" disabled={subdivisionDraftState === "stale"} onClick={onSubdivisionRestart} type="button">
                    <RotateCcw size={13} />
                    <span>Reiniciar</span>
                  </button>
                  <button aria-label="Descartar borrador" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition" onClick={onSubdivisionDiscard} type="button">
                    <Trash2 size={13} />
                    <span>Descartar</span>
                  </button>
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-accent hover:bg-accent-strong px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-40" disabled={!structuralOperationsEnabled || subdivisionDraftState === "stale" || subdivisionPolygons.length < 2 || subdivisionValidation.errors.length > 0} onClick={onSubdivisionSaveRequest} type="button">
                    <ScissorsLineDashed size={12} />
                    <span>Crear {subdivisionPolygons.length} potreros</span>
                  </button>
                </div>
                {subdivisionRestored && (
                  <span className="block text-[9px] text-sky-300 font-bold uppercase tracking-wider">
                    Borrador recuperado (cargados {subdivisionStartCount} de {subdivisionStartSource})
                  </span>
                )}
                <GeometryFeedback error={subdivisionError ?? subdivisionInteractionError} validation={subdivisionValidation} wide />
              </div>
            ) : exclusionMode ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex min-h-8 items-center gap-1.5 rounded bg-amber-500/20 border border-hivis px-2 text-[10px] font-black uppercase text-hivis">
                    <Droplets size={13} />
                    <span>
                      {exclusionMode.action === "edit" ? "Editando" : EXCLUSION_KIND_LABELS[exclusionMode.kind]}
                      {" · "}
                      {exclusionMode.scope.kind === "field" ? exclusionMode.scope.fieldName : exclusionMode.scope.paddockName}
                    </span>
                  </span>
                  {exclusionMode.action === "edit" && (
                    <>
                      <select
                        aria-label="Tipo de exclusión"
                        className="min-h-8 rounded border border-white/15 bg-white/10 px-2 text-[10px] font-bold uppercase text-white outline-none"
                        onChange={(event) => commitEditorSnapshot({
                          kind: "exclusion",
                          points: cloneRing(exclusionDraft),
                          exclusionKind: event.target.value as ExclusionKind,
                        })}
                        value={exclusionMode.kind}
                      >
                        {Object.entries(EXCLUSION_KIND_LABELS).map(([kind, label]) => (
                          <option className="bg-chrome text-white" key={kind} value={kind}>{label}</option>
                        ))}
                      </select>
                      <span className={`flex min-h-8 items-center rounded px-2.5 text-[10px] font-bold uppercase tracking-wider ${editorDirty ? "bg-amber-100/10 text-amber-300 border border-amber-500/20" : "bg-white/5 text-white/50 border border-white/5"}`}>
                        {editorDirty ? "Cambios sin guardar" : "Sin cambios"}
                      </span>
                    </>
                  )}
                  <button className="flex min-h-8 items-center gap-1.5 rounded bg-white hover:bg-white/90 text-ink px-2.5 text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-35" disabled={exclusionDraft.length < 3 || (exclusionMode.action === "edit" && !editorDirty)} onClick={onExclusionPreview} type="button">
                    <Check size={12} />
                    <span>{exclusionMode.action === "edit" ? "Revisar cambios" : "Revisar"}</span>
                  </button>
                  {exclusionMode.action === "edit" ? (
                    <>
                      <button aria-pressed={insertingBoundaryVertex} className={`flex min-h-8 items-center gap-1.5 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider transition ${insertingBoundaryVertex ? "bg-hivis text-ink border-hivis" : "bg-white/5 hover:bg-white/10 text-white border-white/10 border"}`} disabled={exclusionDraft.length < 2} onClick={() => { setInsertingBoundaryVertex((active) => !active); setSelectedBoundaryVertex(null); }} type="button">
                        <CirclePlus size={12} />
                        <span>Agregar punto</span>
                      </button>
                      <button className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition disabled:opacity-30" disabled={selectedBoundaryVertex?.kind !== "exclusion" || exclusionDraft.length <= 3} onClick={removeSelectedEditableVertex} type="button">
                        <Trash2 size={12} />
                        <span>Eliminar punto</span>
                      </button>
                      <button aria-label="Deshacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" disabled={!canUndoEditor} onClick={undoEditorChange} type="button">
                        <Undo2 size={13} />
                        <span>Deshacer</span>
                      </button>
                      <button aria-label="Rehacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" disabled={!canRedoEditor} onClick={redoEditorChange} type="button">
                        <Redo2 size={13} />
                        <span>Rehacer</span>
                      </button>
                      <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-35" disabled={!editorDirty} onClick={() => { commitEditorSnapshot({ kind: "exclusion", points: cloneRing(originalEditedExclusion), exclusionKind: originalEditedExclusionKind ?? exclusionMode.kind }); setSelectedBoundaryVertex(null); }} type="button">
                        <span>Restablecer</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button aria-label="Quitar punto" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-30" disabled={exclusionDraft.length === 0} onClick={() => onExclusionDraftChange(exclusionDraft.slice(0, -1))} type="button">
                        <Undo2 size={13} />
                        <span>Quitar punto</span>
                      </button>
                      <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/75 transition" onClick={() => onExclusionDraftChange([])} type="button">
                        <span>Limpiar</span>
                      </button>
                    </>
                  )}
                  <button aria-label="Cancelar" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/75 transition" onClick={onExclusionCancel} type="button">
                    <X size={12} />
                    <span>Cancelar</span>
                  </button>
                </div>
                {editorInteractionError && <span className="text-[10px] font-semibold text-red-300">{editorInteractionError}</span>}
              </div>
            ) : landmarkDraft ? (
              <MapLandmarkForm
                busy={landmarkBusy}
                draft={landmarkDraft}
                error={landmarkError}
                key={`${landmarkDraft.id}:${landmarkDraft.expectedVersion ?? "new"}`}
                networkOnline={networkOnline}
                onCancel={onLandmarkDrawCancel}
                onGeometryChange={onLandmarkDraftChange}
                onSave={onLandmarkSave}
                paddockName={selectedPotrero?.name ?? null}
                selected={landmarks.find(({ id }) => id === landmarkDraft.id) ?? null}
              />
            ) : measurementMode ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="flex min-h-8 items-center gap-1.5 rounded bg-sky-500/20 border border-sky-500/30 px-2 text-[10px] font-black uppercase text-sky-300">
                  <Ruler size={13} />
                  <span>{formatMeasurement(measurementMeters)}</span>
                </span>
                {measurementClosed && measurementArea > 0 && (
                  <span className="flex min-h-8 items-center rounded bg-white/10 px-2 text-[10px] font-mono font-bold text-white/95">
                    {measurementArea.toLocaleString("es-CL")} ha
                  </span>
                )}
                <button className="min-h-8 rounded bg-white hover:bg-white/90 text-ink px-2.5 text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-35" disabled={measurementPoints.length < 3 || measurementClosed} onClick={() => { setMeasurementClosed(true); setMeasurementHover(null); setMeasurementSnap(null); }} type="button">
                  Cerrar área
                </button>
                <button aria-label="Quitar punto" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-30" disabled={measurementPoints.length === 0} onClick={() => { setMeasurementPoints((current) => current.slice(0, -1)); setMeasurementClosed(false); }} type="button">
                  <Undo2 size={12} />
                  <span>Quitar punto</span>
                </button>
                <button className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition" onClick={() => { setMeasurementPoints([]); setMeasurementClosed(false); setMeasurementHover(null); }} type="button">
                  Limpiar
                </button>
                <button aria-label="Salir" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition" onClick={toggleMeasurement} type="button">
                  <X size={12} />
                  <span>Salir</span>
                </button>
              </div>
            ) : (
              (drawing || draftPoints.length > 0) && (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="flex min-h-8 items-center rounded bg-amber-500/20 border border-hivis px-2 text-[10px] font-black uppercase text-hivis">
                      {draftPoints.length === 0 ? "Dibujando potrero" : `${areaHectaresLabel(draftPoints)} · sin guardar`}
                    </span>
                    <button className="flex min-h-8 items-center gap-1.5 rounded bg-accent hover:bg-accent-strong px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-40" data-map-help="Guarda el nuevo potrero con el trazado actual." disabled={drawing || draftPoints.length < 3 || calculateHectares(draftPoints) <= 0 || draftValidation.errors.length > 0} onClick={onCreateSaveRequest} type="button">
                      <Check size={12} />
                      <span>Guardar potrero</span>
                    </button>
                    <button aria-pressed={insertingBoundaryVertex} className={`flex min-h-8 items-center gap-1.5 rounded px-2.5 text-[10px] font-bold uppercase tracking-wider transition ${insertingBoundaryVertex ? "bg-hivis text-ink border-hivis" : "bg-white/5 hover:bg-white/10 text-white border border-white/10"}`} data-map-help="Muestra puntos sobre cada lado para agregar un nuevo vértice." disabled={drawing || draftPoints.length < 2} onClick={() => { setInsertingBoundaryVertex((active) => !active); setSelectedBoundaryVertex(null); }} type="button">
                      <CirclePlus size={12} />
                      <span>Agregar punto</span>
                    </button>
                    <button className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition disabled:opacity-30" data-map-help="Elimina el vértice seleccionado sin dejar el potrero con menos de tres puntos." disabled={drawing || selectedBoundaryVertex?.kind !== "new" || draftPoints.length <= 3} onClick={removeSelectedEditableVertex} type="button">
                      <Trash2 size={12} />
                      <span>Eliminar punto</span>
                    </button>
                    <button aria-label="Deshacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" data-map-help="Vuelve al cambio anterior del dibujo." disabled={!canUndoEditor} onClick={undoEditorChange} type="button">
                      <Undo2 size={13} />
                      <span>Deshacer</span>
                    </button>
                    <button aria-label="Rehacer cambio" className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2 text-white transition disabled:opacity-30" data-map-help="Recupera el último cambio que deshiciste." disabled={!canRedoEditor} onClick={redoEditorChange} type="button">
                      <Redo2 size={13} />
                      <span>Rehacer</span>
                    </button>
                    <button className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition" data-map-help="Borra todos los puntos del nuevo potrero." onClick={() => { commitEditorSnapshot({ kind: "new", points: [] }); setSelectedBoundaryVertex(null); setInsertingBoundaryVertex(false); }} type="button">
                      <Trash2 size={12} />
                      <span>Limpiar</span>
                    </button>
                    <button aria-label="Cancelar" className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition" onClick={() => { setDrawing(false); commitEditorSnapshot({ kind: "new", points: [] }); setSelectedBoundaryVertex(null); setInsertingBoundaryVertex(false); }} type="button">
                      <X size={13} />
                      <span>Cancelar</span>
                    </button>
                  </div>
                  {draftPoints.length > 0 && <GeometryFeedback error={editorInteractionError} validation={draftValidation} wide />}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {(gpsCapture.mode === "location" || (!gpsTarget && (gpsCapture.error || gpsLocationUnavailableReason))) && (
        <div className="pointer-events-auto absolute bottom-16 left-4 z-[500] max-w-[min(22rem,calc(100%-2rem))] rounded bg-chrome text-white border border-line-strong p-3 text-[11px] font-bold shadow-lg" role="status">
          {gpsCapture.mode === "location" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {gpsCapture.currentFix
                  ? `Mi ubicación · precisión ${Math.round(gpsCapture.currentFix.accuracyMeters)} m`
                  : "Buscando mi ubicación…"}
              </span>
              <span className="text-white/50">{wakeLockLabel(gpsCapture.wakeLockStatus)}</span>
              <button className="min-h-8 rounded bg-blue-600 px-3 text-[10px] font-bold uppercase tracking-wider text-white" onClick={gpsCapture.cancel} type="button">Detener</button>
            </div>
          ) : (
            <p role={gpsCapture.error ? "alert" : undefined}>{gpsCapture.error?.message ?? gpsLocationUnavailableReason}</p>
          )}
        </div>
      )}

      {paddockFillsEnabled && (
        <aside aria-label={`Leyenda temática: ${thematicLegend.title}`} className="pointer-events-auto absolute bottom-4 right-4 z-[500] max-h-48 w-48 overflow-y-auto rounded bg-chrome border border-line-strong p-3 text-white shadow-lg max-sm:hidden">
          <p className="text-[10px] font-black uppercase tracking-[0.13em] text-white/40">{thematicLegend.title}</p>
          <ul className="mt-2 space-y-1.5">
            {thematicLegend.entries.map((entry) => (
              <li className="flex items-center gap-2 text-[11px] font-bold" key={entry.key}>
                <span
                  aria-hidden="true"
                  className={`size-3.5 shrink-0 rounded-sm border ${entry.hasData ? "border-white/20" : "border-dashed border-white/10"}`}
                  style={{ backgroundColor: entry.color }}
                />
                <span>{entry.label}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <div className={`pointer-events-none absolute bottom-4 left-4 z-[500] flex items-center gap-2 rounded bg-chrome/90 px-3 py-2 text-[11px] font-semibold text-white shadow border border-line-strong ${fullscreen ? "max-sm:bottom-[5.25rem]" : ""}`}>
        {boundaryEditing || potreroBoundaryEditingId ? <PencilRuler size={13} className="text-hivis" /> : subdivisionMode ? <ScissorsLineDashed size={13} className="text-warn-ink" /> : exclusionMode ? <Droplets size={13} className="text-sky-300" /> : landmarkDraft ? <LocateFixed size={13} className="text-orange-300" /> : measurementMode ? <Ruler size={13} className="text-sky-300" /> : drawing ? <MousePointer2 size={13} className="text-white" /> : <RotateCcw size={13} className="text-white/70" />}
        {boundaryEditing
          ? redrawingBoundary
            ? boundaryDraft.length < 3
              ? `Marca ${3 - boundaryDraft.length} punto${3 - boundaryDraft.length === 1 ? "" : "s"} más para el nuevo límite`
              : "Continúa marcando o guarda el límite"
            : insertingBoundaryVertex
              ? "Toca un botón + para agregar un vértice al tramo"
              : selectedBoundaryVertex?.kind === "fundo"
                ? "Arrastra el punto seleccionado o elimínalo"
                : "Arrastra un punto o selecciona para editar"
          : potreroBoundaryEditingId
          ? insertingBoundaryVertex
            ? "Toca un botón +; los bordes compartidos se actualizarán juntos"
            : selectedBoundaryVertex?.kind === "potrero"
              ? "Arrastra el punto seleccionado o elimínalo"
              : "Selecciona un punto para editar"
          : subdivisionMode
          ? subdivisionLine.length === 0
            ? "Haz clic cerca de un borde blanco para comenzar"
            : autoCloseSubdivision
              ? "Sigue el cerco; al tocar otro borde se dividirá automáticamente"
              : subdivisionLine.length < 2
                ? "Agrega otro punto para completar la línea"
                : "Presiona Enter o Aplicar división cuando el cerco esté listo"
          : exclusionMode
          ? exclusionMode.action === "edit"
            ? editorDirty
              ? "Arrastra los puntos o cambia el tipo; luego revisa los cambios"
              : "Selecciona y arrastra un punto para editar la exclusión"
            : exclusionDraft.length < 3
              ? `Marca ${3 - exclusionDraft.length} punto${3 - exclusionDraft.length === 1 ? "" : "s"} más para la exclusión`
              : "Presiona Enter o Revisar antes de confirmar"
          : landmarkDraft
          ? landmarkDraft.geometryType === "point"
            ? landmarkDraft.geometry.length === 0 ? "Marca la ubicación del hito" : "Completa los datos y guarda"
            : landmarkDraft.geometry.length < 2 ? `Marca ${2 - landmarkDraft.geometry.length} punto${landmarkDraft.geometry.length === 1 ? "" : "s"} más` : "Completa los datos y guarda"
          : measurementMode
          ? measurementClosed
            ? `${formatMeasurement(measurementMeters)} · ${measurementArea.toLocaleString("es-CL")} ha; limpia para reiniciar`
            : measurementPoints.length < 2
              ? "Marca puntos para medir distancia"
              : measurementPoints.length < 3
                ? `${formatMeasurement(measurementMeters)} acumulados`
                : "Usa Cerrar área para calcular hectáreas"
          : drawing
          ? draftPoints.length < 3
            ? `Marca ${3 - draftPoints.length} punto${3 - draftPoints.length === 1 ? "" : "s"} más`
            : "Puedes seguir marcando o terminar"
          : insertingBoundaryVertex
            ? "Toca un botón + para agregar un vértice"
            : draftPoints.length > 0
              ? "Ajusta los puntos y usa Guardar potrero"
              : "Selecciona un potrero del directorio para editarlo o agregarle hitos"}
      </div>
    </div>
  );
}

function GpsBoundaryControls({
  capture,
  onFinish,
  onStart,
}: {
  capture: UseGpsBoundaryCaptureResult;
  onFinish: () => void;
  onStart: () => void;
}) {
  const capturing = capture.mode === "boundary";
  const disabledReason = gpsUnavailableReason(capture);

  return (
    <>
      {capturing ? (
        <>
          <span className="flex min-h-11 items-center gap-2 rounded-xl bg-blue-100 px-3 text-[12px] font-black text-blue-950" role="status">
            <Navigation className="animate-pulse" size={14} />
            GPS · {capture.acceptedFixes.length} aceptados · {capture.accuracyMeters === null ? "buscando" : `${Math.round(capture.accuracyMeters)} m`}
          </span>
          <button
            className="flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 text-[12px] font-black text-ink disabled:opacity-35"
            data-map-help="Convierte el recorrido GPS aceptado en el nuevo borde editable."
            disabled={capture.acceptedFixes.length < 3}
            onClick={onFinish}
            type="button"
          >
            <Check size={14} /> Finalizar recorrido
          </button>
          <button className="min-h-11 rounded-xl px-3 text-[12px] font-black text-white/75 hover:bg-white/10" data-map-help="Detiene la captura GPS y elimina el recorrido temporal." onClick={capture.cancel} type="button">
            Cancelar captura
          </button>
          <span className="flex min-h-11 items-center rounded-xl bg-white/10 px-3 text-[12px] font-bold text-white/75">
            {gpsDecisionLabel(capture)} · {wakeLockLabel(capture.wakeLockStatus)}
          </span>
        </>
      ) : (
        <button
          className="flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-3 text-[12px] font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
          data-map-help={disabledReason ?? "Registra el borde mientras caminas con el GPS del dispositivo."}
          disabled={Boolean(disabledReason)}
          onClick={onStart}
          type="button"
        >
          <Navigation size={14} /> Caminar el borde
        </button>
      )}
      {capture.error && <p className="basis-full px-3 py-1 text-[12px] font-bold text-red-200" role="alert">{capture.error.message}</p>}
      {capture.result && (
        <div className="basis-full px-3 py-1 text-[12px] font-bold text-white/80" role="status">
          GPS aplicado al borrador: {capture.result.rawVertexCount} puntos capturados → {capture.result.simplifiedVertexCount} vértices simplificados. {capture.result.valid ? "Validación correcta." : "Requiere corrección antes de guardar."}
          <GeometryFeedback validation={capture.result.validation} wide />
        </div>
      )}
    </>
  );
}

function GeometryFeedback({
  validation,
  error,
  wide = false,
}: {
  validation: GeometryValidationFeedback;
  error?: string | null;
  wide?: boolean;
}) {
  if (!error && validation.errors.length === 0 && validation.warnings.length === 0) return null;
  return (
    <div className={`${wide ? "border-t border-white/10" : "basis-full"} w-full space-y-1 px-3 py-2 text-[12px] font-bold`}>
      {error && <p className="text-red-200">{error}</p>}
      {validation.errors.map((message) => <p className="text-red-200" key={`error-${message}`}>Error: {message}</p>)}
      {validation.warnings.map((message) => <p className="text-amber-200" key={`warning-${message}`}>Advertencia: {message}</p>)}
    </div>
  );
}

function gpsUnavailableReason(capture: UseGpsBoundaryCaptureResult) {
  if (capture.permission === "denied") return "Activa el permiso de ubicación del navegador.";
  if (capture.availability === "checking") return "Comprobando disponibilidad del GPS…";
  if (capture.availability === "insecure_context") return "La ubicación requiere HTTPS.";
  if (capture.availability === "unsupported") return "Este navegador no ofrece geolocalización.";
  return null;
}

function gpsDecisionLabel(capture: UseGpsBoundaryCaptureResult) {
  if (!capture.lastDecision) return "Esperando una posición precisa";
  if (capture.lastDecision.reason === "low_accuracy") return "Último punto omitido: precisión ≥15 m";
  if (capture.lastDecision.reason === "too_close") return "Último punto omitido: distancia <8 m";
  if (capture.lastDecision.reason === "invalid_sample") return "Última posición inválida";
  return "Último punto aceptado";
}

function wakeLockLabel(status: UseGpsBoundaryCaptureResult["wakeLockStatus"]) {
  if (status === "active") return "pantalla activa";
  if (status === "requesting") return "activando pantalla";
  if (status === "unsupported") return "bloqueo de pantalla no soportado";
  if (status === "unavailable") return "pantalla sin bloqueo";
  return "pantalla normal";
}

function cloneRing(points: readonly Coordinate[]): Coordinate[] {
  return points.map(([latitude, longitude]) => [latitude, longitude]);
}

function editorSnapshotsEqual(first: EditorSnapshot, second: EditorSnapshot): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === "potrero" && second.kind === "potrero") {
    return boundaryDraftCollectionsEqual(first.drafts, second.drafts);
  }
  if (first.kind === "fundo" && second.kind === "fundo") {
    return boundaryRingsEqual(first.points, second.points)
      && boundaryDraftCollectionsEqual(first.drafts, second.drafts);
  }
  if (first.kind === "exclusion" && second.kind === "exclusion") {
    return first.exclusionKind === second.exclusionKind
      && boundaryRingsEqual(first.points, second.points);
  }
  if (first.kind === "potrero" || second.kind === "potrero" || first.kind === "fundo" || second.kind === "fundo") {
    return false;
  }
  return boundaryRingsEqual(first.points, second.points);
}

function boundaryDraftCollectionsEqual(first: BoundaryDrafts, second: BoundaryDrafts): boolean {
  const firstIds = Object.keys(first).sort();
  const secondIds = Object.keys(second).sort();
  return firstIds.length === secondIds.length
    && firstIds.every((id, index) => id === secondIds[index] && boundaryRingsEqual(first[id], second[id]));
}

function areaHectaresLabel(points: Coordinate[]) {
  return `${calculateHectares(points).toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha`;
}

function formatMeasurement(meters: number) {
  if (meters >= 1_000) return `${(meters / 1_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
  return `${meters.toLocaleString("es-CL", { maximumFractionDigits: meters < 10 ? 1 : 0 })} m`;
}

function fieldLandmarkIcon(kind: FieldLandmarkKind) {
  return divIcon({
    className: "field-landmark-marker",
    html: `<span aria-hidden="true" style="display:grid;width:34px;height:34px;place-items:center;border-radius:999px;background:#173b2d;color:white;border:3px solid white;box-shadow:0 3px 12px rgba(0,0,0,.3);font-size:16px;font-weight:900">${LANDMARK_SYMBOLS[kind]}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function PaddockTooltip({ potrero, metrics, load, thematicDetail }: { potrero: Potrero; metrics: ReturnType<typeof paddockAreaMetrics>; load?: PaddockStockingLoad; thematicDetail: string }) {
  return (
    <>
      <strong>{potrero.name}</strong>
      <span className="map-label-secondary">
        <br />
        {thematicDetail}<br />
        Total {metrics.grossAreaHectares.toLocaleString("es-CL")} ha · útil {metrics.effectiveGrazeableAreaHectares.toLocaleString("es-CL")} ha<br />
        {load ? `${load.animalCount.toLocaleString("es-CL")} animales · ${load.animalsPerHectare === null ? "—" : load.animalsPerHectare.toLocaleString("es-CL", { maximumFractionDigits: 2 })} anim/ha` : "Carga animal no disponible"}
      </span>
    </>
  );
}

function thematicPreferenceKey(scope: string) {
  return `fundosmart:${scope}:map-thematic-mode:v1`;
}

function buildBearingGuide(coordinates: Coordinate[], bearingDegrees: number) {
  const latitude = coordinates.reduce((sum, coordinate) => sum + coordinate[0], 0) / coordinates.length;
  const longitude = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  const latitudeSpan = Math.max(...coordinates.map(([value]) => value)) - Math.min(...coordinates.map(([value]) => value));
  const longitudeSpan = Math.max(...coordinates.map(([, value]) => value)) - Math.min(...coordinates.map(([, value]) => value));
  const distance = Math.max(latitudeSpan, longitudeSpan, 0.00025) * 0.42;
  const radians = bearingDegrees * Math.PI / 180;
  return {
    center: [latitude, longitude] as Coordinate,
    end: [latitude + Math.cos(radians) * distance, longitude + Math.sin(radians) * distance] as Coordinate,
  };
}

function bearingFromCoordinates(start: Coordinate, end: Coordinate) {
  const latitudeScale = Math.max(Math.cos(start[0] * Math.PI / 180), 0.01);
  const north = end[0] - start[0];
  const east = (end[1] - start[1]) * latitudeScale;
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}
