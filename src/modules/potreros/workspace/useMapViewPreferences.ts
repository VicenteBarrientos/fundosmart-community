"use client";

import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  BASEMAPS,
  DEFAULT_BASEMAP_ID,
  DEFAULT_LABELS_ENABLED,
  DEFAULT_PADDOCK_FILLS_ENABLED,
  PADDOCK_LABEL_MIN_ZOOM,
  basemapById,
  loadMapPreferences,
  saveMapPreferences,
  type BasemapId,
  type MapPreferences,
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
} from "./map-preferences.ts";

export type MapViewPreferencesState = Readonly<MapPreferences & {
  hydrated: boolean;
}>;

export type MapViewPreferencesAction =
  | Readonly<{ type: "hydrate"; preferences: MapPreferences }>
  | Readonly<{ type: "select-basemap"; basemapId: BasemapId }>
  | Readonly<{ type: "toggle-labels" }>
  | Readonly<{ type: "toggle-paddock-fills" }>;

export type MapViewPreferencesController = Readonly<{
  activeBasemap: ReturnType<typeof basemapById>;
  basemaps: typeof BASEMAPS;
  labelsEnabled: boolean;
  paddockFillsEnabled: boolean;
  selectBasemap: (basemapId: BasemapId) => void;
  showPaddockLabelsAtZoom: (zoom: number) => boolean;
  toggleLabels: () => void;
  togglePaddockFills: () => void;
}>;

export function createMapViewPreferencesState(): MapViewPreferencesState {
  return freezeState({
    basemapId: DEFAULT_BASEMAP_ID,
    labelsEnabled: DEFAULT_LABELS_ENABLED,
    paddockFillsEnabled: DEFAULT_PADDOCK_FILLS_ENABLED,
    hydrated: false,
  });
}

export function reduceMapViewPreferences(
  state: MapViewPreferencesState,
  action: MapViewPreferencesAction,
): MapViewPreferencesState {
  if (action.type === "hydrate") {
    return replaceState(state, {
      ...action.preferences,
      hydrated: true,
    });
  }
  if (action.type === "select-basemap") {
    return replaceState(state, { ...state, basemapId: action.basemapId });
  }
  if (action.type === "toggle-labels") {
    return replaceState(state, { ...state, labelsEnabled: !state.labelsEnabled });
  }
  if (action.type === "toggle-paddock-fills") {
    return replaceState(state, {
      ...state,
      paddockFillsEnabled: !state.paddockFillsEnabled,
    });
  }
  return state;
}

export function persistableMapViewPreferences(
  state: MapViewPreferencesState,
): MapPreferences | null {
  if (!state.hydrated) return null;
  return Object.freeze({
    basemapId: state.basemapId,
    labelsEnabled: state.labelsEnabled,
    paddockFillsEnabled: state.paddockFillsEnabled,
  });
}

export function shouldShowPaddockLabels(
  state: MapViewPreferencesState,
  zoom: number,
): boolean {
  return state.hydrated
    && state.labelsEnabled
    && zoom >= PADDOCK_LABEL_MIN_ZOOM;
}

export function useMapViewPreferences(): MapViewPreferencesController {
  const [state, dispatch] = useReducer(
    reduceMapViewPreferences,
    undefined,
    createMapViewPreferencesState,
  );

  useEffect(() => {
    const hydratePreferences = window.setTimeout(() => {
      dispatch({ type: "hydrate", preferences: loadMapPreferences() });
    }, 0);
    return () => window.clearTimeout(hydratePreferences);
  }, []);

  useEffect(() => {
    const preferences = persistableMapViewPreferences(state);
    if (preferences) saveMapPreferences(preferences);
  }, [state]);

  const selectBasemap = useCallback((basemapId: BasemapId) => {
    dispatch({ type: "select-basemap", basemapId });
  }, []);
  const toggleLabels = useCallback(() => {
    dispatch({ type: "toggle-labels" });
  }, []);
  const togglePaddockFills = useCallback(() => {
    dispatch({ type: "toggle-paddock-fills" });
  }, []);
  const showPaddockLabelsAtZoom = useCallback(
    (zoom: number) => shouldShowPaddockLabels(state, zoom),
    [state],
  );
  const activeBasemap = useMemo(
    () => basemapById(state.basemapId),
    [state.basemapId],
  );

  return useMemo(() => ({
    activeBasemap,
    basemaps: BASEMAPS,
    labelsEnabled: state.labelsEnabled,
    paddockFillsEnabled: state.paddockFillsEnabled,
    selectBasemap,
    showPaddockLabelsAtZoom,
    toggleLabels,
    togglePaddockFills,
  }), [
    activeBasemap,
    selectBasemap,
    showPaddockLabelsAtZoom,
    state.labelsEnabled,
    state.paddockFillsEnabled,
    toggleLabels,
    togglePaddockFills,
  ]);
}

function replaceState(
  current: MapViewPreferencesState,
  next: MapViewPreferencesState,
): MapViewPreferencesState {
  if (
    current.basemapId === next.basemapId
    && current.labelsEnabled === next.labelsEnabled
    && current.paddockFillsEnabled === next.paddockFillsEnabled
    && current.hydrated === next.hydrated
  ) {
    return current;
  }
  return freezeState(next);
}

function freezeState(state: MapViewPreferencesState): MapViewPreferencesState {
  return Object.freeze({ ...state });
}
