import {
  flushOfflineMutations,
  getActiveOfflineSession,
  getOfflineReadModel,
  offlinePartitionFromSession,
  pullOfflineChanges,
  putOfflineReadModel,
  readOfflineCursor,
  refreshOfflineSession,
  sendOrQueueSyncMutations,
  type OfflineSession,
} from "@/src/core/offline/mutation-queue";
import { createOfflineMutationId } from "@/src/modules/offline/domain/offline-rules.mjs";
import type { DomainEventRecord, SyncJsonValue, SyncMutationInput } from "@/src/modules/sync/domain/types";
import type {
  FieldLandmark,
  FieldLandmarkDeleteRequest,
  FieldLandmarkListing,
  FieldLandmarkOperationResult,
  FieldLandmarkUpsertRequest,
} from "../domain/field-landmarks";
import type { Potrero } from "../types";
import { calculatePathLengthMeters } from "../utils/geometry";
import {
  applyGeographicEvents,
  buildPaddockGeometryVersion,
  type GeographicOfflineSnapshot,
  type PaddockGeometrySyncPayload,
} from "./geographic-sync-rules.mjs";

const GEOGRAPHIC_READ_MODEL = "paddock-geography-v1";

export class GeographicSyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeographicSyncConflictError";
  }
}

export function createGeographicMutationId(): string {
  return createOfflineMutationId();
}

export async function getGeographicOfflineSession(scope: string): Promise<OfflineSession | null> {
  let session = await getActiveOfflineSession(scope);
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      session = await refreshOfflineSession(scope);
    } catch {
      // A still-valid signed session remains sufficient for the local partition.
    }
  }
  return session;
}

export async function readGeographicOfflineSnapshot(
  scope: string,
  fieldId: string,
): Promise<GeographicOfflineSnapshot | null> {
  const session = await getActiveOfflineSession(scope);
  if (!session) return null;
  const stored = await getOfflineReadModel<GeographicOfflineSnapshot>(offlinePartitionFromSession(session, fieldId), GEOGRAPHIC_READ_MODEL);
  return stored?.value?.fieldId === fieldId ? stored.value : null;
}

export async function seedGeographicOfflineSnapshot(input: {
  scope: string;
  fieldId: string;
  paddocks?: Potrero[];
  landmarks?: FieldLandmarkListing;
}): Promise<void> {
  const session = await getGeographicOfflineSession(input.scope);
  if (!session) return;
  const partition = offlinePartitionFromSession(session, input.fieldId);
  const cursor = await readOfflineCursor(partition, "domain-events");
  const stored = await getOfflineReadModel<GeographicOfflineSnapshot>(partition, GEOGRAPHIC_READ_MODEL);
  await putOfflineReadModel(partition, GEOGRAPHIC_READ_MODEL, {
    fieldId: input.fieldId,
    paddocks: input.paddocks?.filter(({ fieldId }) => fieldId === input.fieldId) ?? stored?.value.paddocks ?? [],
    landmarks: input.landmarks ? [...input.landmarks.active, ...input.landmarks.archived] : stored?.value.landmarks ?? [],
  } satisfies GeographicOfflineSnapshot, cursor);
}

export async function synchronizeGeographicOfflineSnapshot(input: {
  scope: string;
  fieldId: string;
}): Promise<{ snapshot: GeographicOfflineSnapshot | null; conflicts: number }> {
  const session = await getGeographicOfflineSession(input.scope);
  if (!session) return { snapshot: null, conflicts: 0 };
  const partition = offlinePartitionFromSession(session, input.fieldId);
  const flush = await flushOfflineMutations(input.scope);
  if (typeof navigator === "undefined" || !navigator.onLine) {
    return { snapshot: await readGeographicOfflineSnapshot(input.scope, input.fieldId), conflicts: flush.conflicts };
  }
  const cursor = await readOfflineCursor(partition, "domain-events");
  const result = await pullOfflineChanges<DomainEventRecord>({ scope: input.scope, partition, cursor, limit: 100 });
  const stored = await getOfflineReadModel<GeographicOfflineSnapshot>(partition, GEOGRAPHIC_READ_MODEL);
  const geographicEvents = result.events.filter(({ entity }) => entity === "paddock_geometry" || entity === "field_landmark");
  const snapshot = geographicEvents.length > 0
    ? applyGeographicEvents(stored?.value ?? { fieldId: input.fieldId, paddocks: [], landmarks: [] }, geographicEvents)
    : stored?.value ?? null;
  if (snapshot) await putOfflineReadModel(partition, GEOGRAPHIC_READ_MODEL, snapshot, result.nextCursor);
  return { snapshot, conflicts: flush.conflicts };
}

export async function queuePaddockGeometrySync(input: {
  scope: string;
  fieldId: string;
  entityId: string;
  updates: Potrero[];
  source: "map" | "gps";
}): Promise<{ mutationId: string; queued: boolean }> {
  const session = await requireSession(input.scope);
  const mutationId = createGeographicMutationId();
  const capturedAt = new Date().toISOString();
  const updates = input.updates.map((paddock) => {
    if (paddock.fieldId !== input.fieldId || !paddock.updatedAt) throw new Error("Cada potrero necesita fundo y versión vigentes.");
    return {
      id: paddock.id,
      expectedVersion: paddock.updatedAt,
      geometry: paddock.geometry ?? { outer: paddock.coordinates, holes: [] },
      holeKinds: paddock.holeKinds ?? [],
    };
  });
  const payload: PaddockGeometrySyncPayload = { capturedAt, source: input.source, updates };
  const mutation: SyncMutationInput = {
    id: mutationId,
    fieldId: input.fieldId,
    entity: "paddock_geometry",
    entityId: input.entityId,
    op: "update",
    payload: jsonObject(payload),
    clientTs: capturedAt,
    expectedVersion: buildPaddockGeometryVersion(updates),
  };
  const [result] = await sendOrQueueSyncMutations({
    scope: input.scope,
    partition: offlinePartitionFromSession(session, input.fieldId),
    mutations: [mutation],
    label: input.source === "gps" ? "Límite de potrero GPS" : "Geometría de potrero",
  });
  await assertNoImmediateConflict(result?.response, mutationId);
  return { mutationId, queued: result?.queued ?? true };
}

export async function queueFieldLandmarkUpsert(input: {
  scope: string;
  request: FieldLandmarkUpsertRequest;
  current: FieldLandmark | null;
}): Promise<{ result: FieldLandmarkOperationResult; queued: boolean }> {
  const session = await requireSession(input.scope);
  const request = input.request;
  const now = new Date().toISOString();
  const mutation: SyncMutationInput = {
    id: request.operationId,
    fieldId: request.fieldId,
    entity: "field_landmark",
    entityId: request.id,
    op: request.expectedVersion === null ? "create" : "update",
    payload: jsonObject({
      action: "upsert",
      kind: request.kind,
      geometryType: request.geometryType,
      geometry: request.geometry,
      name: request.name,
      notes: request.notes,
    }),
    clientTs: now,
    expectedVersion: request.expectedVersion === null ? null : String(request.expectedVersion),
  };
  const [queued] = await sendOrQueueSyncMutations({
    scope: input.scope,
    partition: offlinePartitionFromSession(session, request.fieldId),
    mutations: [mutation],
    label: request.expectedVersion === null ? "Nuevo hito GPS" : "Edición de hito GPS",
  });
  await assertNoImmediateConflict(queued?.response, mutation.id);
  const landmark: FieldLandmark = {
    id: request.id,
    fieldId: request.fieldId,
    kind: request.kind,
    geometryType: request.geometryType,
    geometry: request.geometry,
    name: request.name,
    notes: request.notes,
    lengthMeters: request.geometryType === "line" ? calculatePathLengthMeters(request.geometry) : 0,
    createdAt: input.current?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
    version: (request.expectedVersion ?? 0) + 1,
    lastOperationId: mutation.id,
  };
  return {
    queued: queued?.queued ?? true,
    result: {
      operationId: mutation.id,
      kind: request.expectedVersion === null ? "create" : "update",
      requestHash: `sync:${mutation.id}`,
      landmark,
      committedAt: now,
      idempotentReplay: false,
    },
  };
}

export async function queueFieldLandmarkArchive(input: {
  scope: string;
  request: FieldLandmarkDeleteRequest;
  current: FieldLandmark;
}): Promise<{ result: FieldLandmarkOperationResult; queued: boolean }> {
  const session = await requireSession(input.scope);
  const { request } = input;
  const now = new Date().toISOString();
  const mutation: SyncMutationInput = {
    id: request.operationId,
    fieldId: request.fieldId,
    entity: "field_landmark",
    entityId: request.id,
    op: "update",
    payload: { action: "archive" },
    clientTs: now,
    expectedVersion: String(request.expectedVersion),
  };
  const [queued] = await sendOrQueueSyncMutations({
    scope: input.scope,
    partition: offlinePartitionFromSession(session, request.fieldId),
    mutations: [mutation],
    label: "Archivo de hito GPS",
  });
  await assertNoImmediateConflict(queued?.response, mutation.id);
  const landmark: FieldLandmark = {
    ...input.current,
    updatedAt: now,
    deletedAt: now,
    version: request.expectedVersion + 1,
    lastOperationId: mutation.id,
  };
  return {
    queued: queued?.queued ?? true,
    result: {
      operationId: mutation.id,
      kind: "delete",
      requestHash: `sync:${mutation.id}`,
      landmark,
      committedAt: now,
      idempotentReplay: false,
    },
  };
}

async function requireSession(scope: string): Promise<OfflineSession> {
  const session = await getGeographicOfflineSession(scope);
  if (!session) throw new Error("La sesión offline expiró. Conéctate antes de registrar otra geometría.");
  return session;
}

async function assertNoImmediateConflict(response: Response | undefined, mutationId: string): Promise<void> {
  if (!response) return;
  const body = await response.clone().json().catch(() => null) as {
    results?: Array<{ id?: unknown; status?: unknown; conflictReason?: unknown }>;
  } | null;
  const result = body?.results?.find(({ id }) => id === mutationId);
  if (result?.status === "conflict" || result?.status === "rejected") {
    throw new GeographicSyncConflictError(
      typeof result.conflictReason === "string" && result.conflictReason.trim()
        ? result.conflictReason
        : "La geometría cambió y requiere revisión.",
    );
  }
}

function jsonObject(value: unknown): Record<string, SyncJsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, SyncJsonValue>;
}
