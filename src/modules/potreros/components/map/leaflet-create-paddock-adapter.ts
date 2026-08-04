import type { Coordinate } from "../../types";
import type {
  MapAdapterDispatchResult,
  MapDraftSource,
  MapGestureCommand,
  MapInteractionAdapter,
  MapInteractionAdapterContext,
  MapInteractionAdapterLease,
} from "../../map-core";

export const LEAFLET_CREATE_PADDOCK_ADAPTER_ID = "leaflet-current-v1";

export type LeafletCreatePaddockAdapter = MapInteractionAdapter & Readonly<{
  replaceDraft: (points: readonly Coordinate[], source?: MapDraftSource) => MapAdapterDispatchResult;
  appendVertex: (coordinate: Coordinate, source?: MapDraftSource) => MapAdapterDispatchResult;
  insertVertex: (edgeIndex: number, coordinate: Coordinate, source?: MapDraftSource) => MapAdapterDispatchResult;
  moveVertex: (vertexIndex: number, coordinate: Coordinate, source?: MapDraftSource) => MapAdapterDispatchResult;
  removeVertex: (vertexIndex: number, source?: MapDraftSource) => MapAdapterDispatchResult;
  undo: () => MapAdapterDispatchResult;
  redo: () => MapAdapterDispatchResult;
}>;

/**
 * Gesture-only port for the current Leaflet create-paddock renderer.
 *
 * Leaflet keeps ownership of hit testing and snap resolution. This adapter
 * receives the resolved coordinates and can only dispatch normalized edit
 * commands; it deliberately has no save or persistence capability.
 */
export function createLeafletCreatePaddockAdapter(): LeafletCreatePaddockAdapter {
  let activeContext: MapInteractionAdapterContext | null = null;
  let connectionVersion = 0;

  function context(): MapInteractionAdapterContext {
    if (!activeContext) throw new Error("El adapter de creación no está conectado.");
    if (activeContext.read().objective !== "create-paddock") {
      throw new Error("El adapter Leaflet sólo admite la creación de potreros.");
    }
    return activeContext;
  }

  function dispatch(command: MapGestureCommand): MapAdapterDispatchResult {
    return context().dispatch(command);
  }

  return {
    id: LEAFLET_CREATE_PADDOCK_ADAPTER_ID,
    renderer: "leaflet",
    capabilities: {
      moveVertex: true,
      insertVertex: true,
      removeVertex: true,
      holes: false,
      touch: true,
    },
    connect(nextContext) {
      if (nextContext.read().objective !== "create-paddock") {
        throw new Error("El adapter Leaflet sólo admite la creación de potreros.");
      }
      activeContext = nextContext;
      connectionVersion += 1;
      const leaseVersion = connectionVersion;
      return {
        disconnect() {
          if (leaseVersion !== connectionVersion) return;
          activeContext = null;
        },
      } satisfies MapInteractionAdapterLease;
    },
    replaceDraft(points, source = "manual") {
      return dispatch({
        type: "replace-draft",
        draft: {
          outer: points.map(cloneCoordinate),
          holes: [],
        },
        source,
      });
    },
    appendVertex(coordinate, source = "manual") {
      return dispatch({
        type: "append-vertex",
        target: { kind: "outer" },
        coordinate: cloneCoordinate(coordinate),
        source,
      });
    },
    insertVertex(edgeIndex, coordinate, source = "manual") {
      return dispatch({
        type: "insert-vertex",
        target: { kind: "outer" },
        edgeIndex,
        coordinate: cloneCoordinate(coordinate),
        source,
      });
    },
    moveVertex(vertexIndex, coordinate, source = "manual") {
      return dispatch({
        type: "move-vertex",
        target: { kind: "outer" },
        vertexIndex,
        coordinate: cloneCoordinate(coordinate),
        source,
      });
    },
    removeVertex(vertexIndex, source = "manual") {
      return dispatch({
        type: "remove-vertex",
        target: { kind: "outer" },
        vertexIndex,
        source,
      });
    },
    undo() {
      return dispatch({ type: "undo" });
    },
    redo() {
      return dispatch({ type: "redo" });
    },
  };
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}
