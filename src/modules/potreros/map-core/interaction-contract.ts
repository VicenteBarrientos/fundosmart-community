import type { Coordinate } from "../types";

export const MAP_EDIT_OBJECTIVES = [
  "create-paddock",
] as const;

export type MapEditObjective = typeof MAP_EDIT_OBJECTIVES[number];

export type MapEditPhase =
  | "draft"
  | "validating"
  | "preview"
  | "saving"
  | "save-error"
  | "pending-sync"
  | "conflict"
  | "read-only"
  | "saved"
  | "cancelled";

export type MapDraftSource =
  | "canonical"
  | "manual"
  | "gps"
  | "import"
  | "suggestion"
  | "recovery";

/**
 * Draft shape supported by the first migrated slice. Multi-entity operations
 * receive their own draft contract when their slice is migrated.
 */
export type MapPolygonDraft = Readonly<{
  outer: readonly Coordinate[];
  holes: readonly (readonly Coordinate[])[];
}>;

export type MapRingTarget =
  | Readonly<{ kind: "outer" }>
  | Readonly<{ kind: "hole"; index: number }>;

export type MapEditValidation = Readonly<{
  errors: readonly string[];
  warnings: readonly string[];
}>;

export type MapEditPreview = Readonly<{
  affectedEntityIds: readonly string[];
  warnings: readonly string[];
  areaBeforeSquareMeters?: number;
  areaAfterSquareMeters?: number;
}>;

export type MapConflict = Readonly<{
  code: "stale-version" | "scope-changed" | "canonical-diverged" | "unknown";
  message: string;
  serverVersion?: string;
}>;

export type MapSaveFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  canonicalStateUnknown: boolean;
}>;

export type MapGestureCommand =
  | Readonly<{ type: "replace-draft"; draft: MapPolygonDraft; source: MapDraftSource }>
  | Readonly<{ type: "append-vertex"; target: MapRingTarget; coordinate: Coordinate; source: MapDraftSource }>
  | Readonly<{ type: "insert-vertex"; target: MapRingTarget; edgeIndex: number; coordinate: Coordinate; source: MapDraftSource }>
  | Readonly<{ type: "move-vertex"; target: MapRingTarget; vertexIndex: number; coordinate: Coordinate; source: MapDraftSource }>
  | Readonly<{ type: "remove-vertex"; target: MapRingTarget; vertexIndex: number; source: MapDraftSource }>
  | Readonly<{ type: "undo" }>
  | Readonly<{ type: "redo" }>;

export type MapLifecycleCommand =
  | Readonly<{ type: "validation-started" }>
  | Readonly<{ type: "validation-finished"; validation: MapEditValidation }>
  | Readonly<{ type: "validation-aborted"; message: string }>
  | Readonly<{ type: "preview-ready"; preview: MapEditPreview }>
  | Readonly<{ type: "save-started" }>
  | Readonly<{ type: "save-failed"; failure: MapSaveFailure }>
  | Readonly<{ type: "retry-save" }>
  | Readonly<{ type: "sync-deferred" }>
  | Readonly<{ type: "conflict-detected"; conflict: MapConflict }>
  | Readonly<{
      type: "conflict-resolved";
      canonicalDraft: MapPolygonDraft;
      resolvedDraft: MapPolygonDraft;
      canonicalVersion: string;
    }>
  | Readonly<{
      type: "canonical-reconciled";
      outcome: "applied";
      draft: MapPolygonDraft;
      canonicalVersion: string;
    }>
  | Readonly<{ type: "canonical-reconciled"; outcome: "not-applied" }>
  | Readonly<{ type: "canonical-reloaded"; draft: MapPolygonDraft; canonicalVersion: string }>
  | Readonly<{ type: "cancel" }>;

export type MapEditCommand = MapGestureCommand | MapLifecycleCommand;

export type MapAdapterSnapshot = Readonly<{
  transactionId: string;
  objective: MapEditObjective;
  phase: MapEditPhase;
  revision: number;
  draft: MapPolygonDraft;
}>;

export type MapAdapterDispatchResult =
  | Readonly<{ ok: true; snapshot: MapAdapterSnapshot }>
  | Readonly<{
      ok: false;
      snapshot: MapAdapterSnapshot;
      error: Readonly<{ code: string; message: string }>;
    }>;

export type MapInteractionCapabilities = Readonly<{
  moveVertex: boolean;
  insertVertex: boolean;
  removeVertex: boolean;
  holes: boolean;
  touch: boolean;
}>;

export type MapInteractionAdapterContext = Readonly<{
  read: () => MapAdapterSnapshot;
  dispatch: (command: MapGestureCommand) => MapAdapterDispatchResult;
}>;

export type MapInteractionAdapterLease = Readonly<{
  disconnect: () => void;
}>;

/**
 * Provider-neutral boundary between renderer gestures and FundoSmart commands.
 *
 * The context deliberately exposes neither an API client nor a persistence
 * gateway. An adapter can only read a normalized draft and dispatch gestures.
 */
export interface MapInteractionAdapter {
  readonly id: string;
  readonly renderer: string;
  readonly capabilities: MapInteractionCapabilities;
  connect(context: MapInteractionAdapterContext): MapInteractionAdapterLease;
}
