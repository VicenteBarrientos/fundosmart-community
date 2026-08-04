import type { DomainEventRecord } from "../../sync/domain/types";
import type { FieldLandmark, FieldLandmarkKind } from "../domain/field-landmarks";
import type { ExclusionKind, PolygonRings, Potrero } from "../types";

export type PaddockGeometrySyncUpdate = {
  id: string;
  expectedVersion: string;
  geometry: PolygonRings;
  holeKinds: ExclusionKind[];
};

export type PaddockGeometrySyncPayload = {
  capturedAt: string;
  source: "map" | "gps";
  updates: PaddockGeometrySyncUpdate[];
};

export type FieldLandmarkSyncPayload =
  | { action: "archive" }
  | {
      action: "upsert";
      kind: FieldLandmarkKind;
      geometryType: "point" | "line";
      geometry: [number, number][];
      name: string;
      notes: string;
    };

export type GeographicOfflineSnapshot = {
  fieldId: string;
  paddocks: Potrero[];
  landmarks: FieldLandmark[];
};

export const GEOGRAPHIC_SYNC_ENTITIES: ReadonlySet<string>;
export const GEOGRAPHIC_LWW_MAX_FUTURE_SKEW_MS: number;
export function isGeographicSyncEntity(entity: unknown): entity is "paddock_geometry" | "field_landmark";
export function validateGeographicSyncMutation(value: unknown): string | null;
export function parsePaddockGeometryPayload(value: unknown): PaddockGeometrySyncPayload;
export function parseFieldLandmarkPayload(value: unknown): FieldLandmarkSyncPayload;
export function buildPaddockGeometryVersion(updates: Array<Pick<PaddockGeometrySyncUpdate, "id" | "expectedVersion">>): string;
export function decidePaddockGeometryLww(input: {
  clientTs: string;
  nowIso: string;
  currentUpdatedAt: string;
  lastAcceptedClientTs?: string | null;
  acceptedProjectionMatchesCurrent?: boolean;
}):
  | { action: "apply"; reason: null; comparedClientTs: string }
  | { action: "conflict"; reason: string; comparedClientTs: string | null };
export function applyGeographicEvents(snapshot: GeographicOfflineSnapshot | null | undefined, events: DomainEventRecord[]): GeographicOfflineSnapshot;
