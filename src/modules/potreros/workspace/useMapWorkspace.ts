"use client";

import { useCallback, useEffect, useMemo, useReducer } from "react";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { createMapWorkspace, transitionMapWorkspace, type MapLayerDescriptor, type MapLayerStatus, type MapViewport, type MapWorkspace } from "../map-core/workspace.ts";

type MapWorkspaceContext = Readonly<{
  fieldId: string;
  viewport: MapViewport;
}>;

type NamedPaddock = Readonly<{ name: string }>;

/** @deprecated Prefer MapWorkspaceAction for new workspace responsibilities. */
export type MapWorkspaceFocusAction =
  | Readonly<MapWorkspaceContext & { type: "reset-field" }>
  | Readonly<MapWorkspaceContext & { type: "focus-paddock"; id: string }>
  | Readonly<MapWorkspaceContext & { type: "blur-paddock"; id: string }>;

export type MapWorkspaceAction =
  | MapWorkspaceFocusAction
  | Readonly<MapWorkspaceContext & { type: "set-search"; search: string }>
  | Readonly<MapWorkspaceContext & {
      type: "observe-viewport";
      expectedFieldId: string;
    }>
  | Readonly<MapWorkspaceContext & { type: "register-layer"; layer: MapLayerDescriptor }>
  | Readonly<MapWorkspaceContext & { type: "set-layer-visibility"; id: string; visible: boolean }>
  | Readonly<MapWorkspaceContext & { type: "set-layer-status"; id: string; status: MapLayerStatus; error?: string | null }>;

export type MapWorkspaceController = Readonly<{
  isPaddockFocused: (id: string) => boolean;
  focusPaddock: (id: string) => void;
  blurPaddock: (id: string) => void;
  viewport: MapViewport;
  observeViewport: (viewport: MapViewport) => void;
  search: string;
  setSearch: (search: string) => void;
  filterPaddocks: <Paddock extends NamedPaddock>(paddocks: readonly Paddock[]) => readonly Paddock[];
  layers: Readonly<Record<string, MapLayerDescriptor>>;
  registerLayer: (layer: MapLayerDescriptor) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerStatus: (id: string, status: MapLayerStatus, error?: string | null) => void;
}>;

/** @deprecated Prefer MapWorkspaceController for new workspace responsibilities. */
export type MapWorkspaceFocusController = Pick<
  MapWorkspaceController,
  "isPaddockFocused" | "focusPaddock" | "blurPaddock"
>;

export function createMapWorkspaceState(context: MapWorkspaceContext): MapWorkspace {
  return createMapWorkspace(context);
}

export function reduceMapWorkspace(
  workspace: MapWorkspace,
  action: MapWorkspaceAction,
): MapWorkspace {
  if (action.type === "observe-viewport" && workspace.fieldId !== action.expectedFieldId) {
    return workspace;
  }
  const current = workspaceForAction(workspace, action);
  if (action.type === "reset-field") return current;
  if (action.type === "set-search") {
    return transitionMapWorkspace(current, {
      type: "set-search",
      search: action.search,
    }).workspace;
  }
  if (action.type === "observe-viewport") {
    if (viewportsEqual(current.viewport, action.viewport)) return current;
    return transitionMapWorkspace(current, {
      type: "set-viewport",
      viewport: action.viewport,
    }).workspace;
  }
  if (action.type === "register-layer") {
    const res = transitionMapWorkspace(current, { type: "register-layer", layer: action.layer });
    return res.ok ? res.workspace : current;
  }
  if (action.type === "set-layer-visibility") {
    const res = transitionMapWorkspace(current, { type: "set-layer-visibility", id: action.id, visible: action.visible });
    return res.ok ? res.workspace : current;
  }
  if (action.type === "set-layer-status") {
    const res = transitionMapWorkspace(current, { type: "set-layer-status", id: action.id, status: action.status, error: action.error });
    return res.ok ? res.workspace : current;
  }
  if (action.type === "blur-paddock" && current.focusedPaddockId !== action.id) return current;
  return transitionMapWorkspace(current, {
    type: "focus-paddock",
    id: action.type === "focus-paddock" ? action.id : null,
  }).workspace;
}

export const createMapWorkspaceFocusState = createMapWorkspaceState;
export const reduceMapWorkspaceFocus = reduceMapWorkspace;

export function filterMapWorkspacePaddocks<Paddock extends NamedPaddock>(
  paddocks: readonly Paddock[],
  search: string,
): readonly Paddock[] {
  if (!search) return paddocks;
  const normalizedSearch = search.toLowerCase();
  return paddocks.filter((paddock) => paddock.name.toLowerCase().includes(normalizedSearch));
}

export function selectMapWorkspaceViewport(
  workspace: MapWorkspace,
  context: MapWorkspaceContext,
): MapViewport {
  if (workspace.fieldId === context.fieldId) return workspace.viewport;
  return createMapWorkspaceState(context).viewport;
}

export function useMapWorkspace(context: MapWorkspaceContext): MapWorkspaceController {
  const fieldId = context.fieldId;
  const latitude = context.viewport.center[0];
  const longitude = context.viewport.center[1];
  const zoom = context.viewport.zoom;
  const actionContext = useMemo<MapWorkspaceContext>(() => ({
    fieldId,
    viewport: { center: [latitude, longitude], zoom },
  }), [fieldId, latitude, longitude, zoom]);
  const [workspace, dispatch] = useReducer(
    reduceMapWorkspace,
    actionContext,
    createMapWorkspaceState,
  );
  const viewport = useMemo(
    () => selectMapWorkspaceViewport(workspace, actionContext),
    [actionContext, workspace],
  );

  useEffect(() => {
    dispatch({ type: "reset-field", ...actionContext });
  }, [actionContext]);

  const focusedPaddockId = workspace.fieldId === actionContext.fieldId
    ? workspace.focusedPaddockId
    : null;
  const isPaddockFocused = useCallback(
    (id: string) => focusedPaddockId === id,
    [focusedPaddockId],
  );
  const focusPaddock = useCallback((id: string) => {
    dispatch({ type: "focus-paddock", id, ...actionContext });
  }, [actionContext]);
  const blurPaddock = useCallback((id: string) => {
    dispatch({ type: "blur-paddock", id, ...actionContext });
  }, [actionContext]);
  const observedWorkspaceFieldId = workspace.fieldId;
  const observeViewport = useCallback((viewport: MapViewport) => {
    dispatch({
      type: "observe-viewport",
      expectedFieldId: observedWorkspaceFieldId,
      fieldId,
      viewport,
    });
  }, [fieldId, observedWorkspaceFieldId]);
  const setSearch = useCallback((search: string) => {
    dispatch({ type: "set-search", search, ...actionContext });
  }, [actionContext]);
  const filterPaddocks = useCallback(
    <Paddock extends NamedPaddock>(paddocks: readonly Paddock[]) => (
      filterMapWorkspacePaddocks(paddocks, workspace.search)
    ),
    [workspace.search],
  );

  const registerLayer = useCallback((layer: MapLayerDescriptor) => {
    dispatch({ type: "register-layer", layer, ...actionContext });
  }, [actionContext]);

  const setLayerVisibility = useCallback((id: string, visible: boolean) => {
    dispatch({ type: "set-layer-visibility", id, visible, ...actionContext });
  }, [actionContext]);

  const setLayerStatus = useCallback((id: string, status: MapLayerStatus, error?: string | null) => {
    dispatch({ type: "set-layer-status", id, status, error, ...actionContext });
  }, [actionContext]);

  return useMemo(() => ({
    isPaddockFocused,
    focusPaddock,
    blurPaddock,
    viewport,
    observeViewport,
    search: workspace.search,
    setSearch,
    filterPaddocks,
    layers: workspace.layers,
    registerLayer,
    setLayerVisibility,
    setLayerStatus,
  }), [
    blurPaddock,
    filterPaddocks,
    focusPaddock,
    isPaddockFocused,
    observeViewport,
    registerLayer,
    setLayerStatus,
    setLayerVisibility,
    setSearch,
    viewport,
    workspace.layers,
    workspace.search,
  ]);
}

function workspaceForAction(
  workspace: MapWorkspace,
  context: MapWorkspaceContext,
): MapWorkspace {
  if (workspace.fieldId === context.fieldId) return workspace;
  const next = createMapWorkspace({ fieldId: context.fieldId, viewport: context.viewport });
  if (!workspace.search) return next;
  return transitionMapWorkspace(next, {
    type: "set-search",
    search: workspace.search,
  }).workspace;
}

function viewportsEqual(left: MapViewport, right: MapViewport): boolean {
  return left.zoom === right.zoom
    && left.center[0] === right.center[0]
    && left.center[1] === right.center[1];
}
