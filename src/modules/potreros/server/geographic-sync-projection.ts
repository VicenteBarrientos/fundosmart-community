import type { AccessContext } from "@/src/modules/access/domain/types";
import { getDb } from "@/db";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { SyncJsonValue, SyncMutationInput } from "@/src/modules/sync/domain/types";
import { stableStringify } from "@/src/modules/sync/domain/sync-rules.mjs";
import type { FieldLandmark } from "../domain/field-landmarks";
import {
  buildPaddockGeometryVersion,
  decidePaddockGeometryLww,
  GEOGRAPHIC_LWW_MAX_FUTURE_SKEW_MS,
  parseFieldLandmarkPayload,
  parsePaddockGeometryPayload,
} from "../sync/geographic-sync-rules.mjs";
import type { Potrero } from "../types";
import { calculateGrossHectares, calculateNetHectares } from "../utils/geometry";
import {
  archiveFieldLandmark,
  listFieldLandmarks,
  upsertFieldLandmark,
} from "./field-landmark-repository";
import {
  listPotreros,
  readPaddockGeometrySyncMarker,
  updatePotreroBoundaries,
  type PaddockGeometryResolution,
  type PaddockGeometrySyncMarker,
} from "./potrero-repository";

export type GeographicProjectionResult =
  | {
      action: "applied";
      eventPayload: Record<string, SyncJsonValue>;
      eventType: string;
      serverVersion: string;
    }
  | { action: "conflict"; reason: string; serverVersion: string | null };

export async function applyGeographicSyncMutation(
  actor: AccessContext,
  mutation: SyncMutationInput,
): Promise<GeographicProjectionResult> {
  if (mutation.entity === "paddock_geometry") return applyPaddockGeometry(actor, mutation);
  if (mutation.entity === "field_landmark") return applyFieldLandmark(actor, mutation);
  throw new TypeError("La proyección geográfica no admite esta entidad.");
}

async function applyPaddockGeometry(
  actor: AccessContext,
  mutation: SyncMutationInput,
): Promise<GeographicProjectionResult> {
  const payload = parsePaddockGeometryPayload(mutation.payload);
  const committed = await readPaddockGeometrySyncMarker(mutation.id, mutation.fieldId, actor);
  if (committed) return appliedPaddockMarker(committed);
  const current = await listPotreros(actor, mutation.fieldId);
  const currentById = new Map(current.map((paddock) => [paddock.id, paddock]));
  const requested = payload.updates.map((update) => ({ update, paddock: currentById.get(update.id) ?? null }));
  if (requested.some(({ paddock }) => !paddock)) {
    return { action: "conflict", reason: "Uno de los potreros ya no está activo en este fundo.", serverVersion: null };
  }
  const currentVersion = buildPaddockGeometryVersion(requested.map(({ paddock }) => ({
    id: paddock!.id,
    expectedVersion: requiredPaddockVersion(paddock!),
  })));
  if (Date.parse(mutation.clientTs) > Date.now() + GEOGRAPHIC_LWW_MAX_FUTURE_SKEW_MS) {
    return {
      action: "conflict",
      reason: "client_ts excede la tolerancia de reloj de la política geográfica LWW v1.",
      serverVersion: currentVersion,
    };
  }
  let resolution: PaddockGeometryResolution = {
    policy: "paddock-geometry-lww-v1",
    disposition: "version-match",
    clientTs: mutation.clientTs,
    comparedClientTs: null,
    replacedVersion: currentVersion,
  };
  if (mutation.expectedVersion !== currentVersion) {
    if (requested.every(({ update, paddock }) => samePaddockGeometry(paddock!, update.geometry, update.holeKinds))) {
      return appliedPaddockProjection(payload, requested.map(({ paddock }) => paddock!), currentVersion, {
        ...resolution,
        disposition: "already-current",
      });
    }
    const latestAccepted = await readLatestAcceptedPaddockWrite(actor, mutation.fieldId, payload.updates.map(({ id }) => id));
    const decision = decidePaddockGeometryLww({
      clientTs: mutation.clientTs,
      nowIso: new Date().toISOString(),
      currentUpdatedAt: requested.map(({ paddock }) => requiredPaddockVersion(paddock!)).sort().at(-1)!,
      lastAcceptedClientTs: latestAccepted?.clientTs ?? null,
      acceptedProjectionMatchesCurrent: latestAccepted
        ? geometryVersionCoversCurrent(latestAccepted.serverVersion, requested.map(({ paddock }) => paddock!))
        : false,
    });
    if (decision.action === "conflict") {
      return { action: "conflict", reason: decision.reason, serverVersion: currentVersion };
    }
    resolution = { ...resolution, disposition: "newer-client", comparedClientTs: decision.comparedClientTs };
  }

  const updates = requested.map(({ update, paddock }) => {
    const netAreaHectares = calculateNetHectares(update.geometry);
    const currentGrazeable = paddock!.grazeableAreaHectares;
    return {
      ...paddock!,
      coordinates: update.geometry.outer,
      geometry: update.geometry,
      areaHectares: calculateGrossHectares(update.geometry),
      netAreaHectares,
      effectiveGrazeableAreaHectares: currentGrazeable === null || currentGrazeable === undefined
        ? netAreaHectares
        : Math.min(currentGrazeable, netAreaHectares),
      grazeableAreaHectares: currentGrazeable === null || currentGrazeable === undefined
        ? currentGrazeable
        : Math.min(currentGrazeable, netAreaHectares),
      holeKinds: update.holeKinds,
      updatedAt: requiredPaddockVersion(paddock!),
    } satisfies Potrero;
  });
  try {
    const saved = await updatePotreroBoundaries(updates, actor, {
      mutationId: mutation.id,
      actor,
      entityId: mutation.entityId,
      source: payload.source,
      capturedAt: payload.capturedAt,
      resolution,
    });
    const serverVersion = buildPaddockGeometryVersion(saved.map((paddock) => ({
      id: paddock.id,
      expectedVersion: requiredPaddockVersion(paddock),
    })));
    return appliedPaddockProjection(payload, saved, serverVersion, resolution);
  } catch (cause) {
    if (!(cause instanceof DomainRuleError)) throw cause;
    const racedMarker = await readPaddockGeometrySyncMarker(mutation.id, mutation.fieldId, actor);
    if (racedMarker) return appliedPaddockMarker(racedMarker);
    const latest = await listPotreros(actor, mutation.fieldId);
    const latestById = new Map(latest.map((paddock) => [paddock.id, paddock]));
    const complete = payload.updates.map(({ id }) => latestById.get(id)).filter((value): value is Potrero => Boolean(value));
    return {
      action: "conflict",
      reason: cause.message,
      serverVersion: complete.length === payload.updates.length
        ? buildPaddockGeometryVersion(complete.map((paddock) => ({ id: paddock.id, expectedVersion: requiredPaddockVersion(paddock) })))
        : null,
    };
  }
}

function appliedPaddockMarker(
  marker: PaddockGeometrySyncMarker,
): Extract<GeographicProjectionResult, { action: "applied" }> {
  const paddocks = marker.eventPayload.projection.paddocks;
  const serverVersion = buildPaddockGeometryVersion(paddocks.map((paddock) => ({
    id: paddock.id,
    expectedVersion: requiredPaddockVersion(paddock),
  })));
  return {
    action: "applied",
    eventType: "paddock_geometry.updated",
    serverVersion,
    eventPayload: jsonObject({
      ...marker.eventPayload,
      resolution: marker.eventPayload.resolution ?? {
        policy: "paddock-geometry-lww-v1",
        disposition: "version-match",
        clientTs: marker.eventPayload.capturedAt,
        comparedClientTs: null,
        replacedVersion: serverVersion,
      },
    }),
  };
}

async function applyFieldLandmark(
  actor: AccessContext,
  mutation: SyncMutationInput,
): Promise<GeographicProjectionResult> {
  const payload = parseFieldLandmarkPayload(mutation.payload);
  try {
    const result = payload.action === "archive"
      ? await archiveFieldLandmark({
          id: mutation.entityId,
          fieldId: mutation.fieldId,
          operationId: mutation.id,
          expectedVersion: Number(mutation.expectedVersion),
        }, actor, actor)
      : await upsertFieldLandmark({
          id: mutation.entityId,
          fieldId: mutation.fieldId,
          operationId: mutation.id,
          expectedVersion: mutation.op === "create" ? null : Number(mutation.expectedVersion),
          kind: payload.kind,
          geometryType: payload.geometryType,
          geometry: payload.geometry,
          name: payload.name,
          notes: payload.notes,
        }, actor, actor);
    return appliedLandmarkProjection(payload.action, result.landmark);
  } catch (cause) {
    if (!(cause instanceof DomainRuleError)) throw cause;
    const listing = await listFieldLandmarks(mutation.fieldId, actor);
    const current = [...listing.active, ...listing.archived].find(({ id }) => id === mutation.entityId) ?? null;
    return {
      action: "conflict",
      reason: cause.message,
      serverVersion: current ? String(current.version) : null,
    };
  }
}

function appliedPaddockProjection(
  payload: ReturnType<typeof parsePaddockGeometryPayload>,
  paddocks: Potrero[],
  serverVersion: string,
  resolution: PaddockGeometryResolution,
): Extract<GeographicProjectionResult, { action: "applied" }> {
  return {
    action: "applied",
    eventType: "paddock_geometry.updated",
    serverVersion,
    eventPayload: jsonObject({
      projection: { kind: "paddock_geometry", paddocks },
      source: payload.source,
      capturedAt: payload.capturedAt,
      resolution,
    }),
  };
}

async function readLatestAcceptedPaddockWrite(
  actor: AccessContext,
  fieldId: string,
  paddockIds: string[],
): Promise<{ clientTs: string; serverVersion: string } | null> {
  const row = await getDb().$client.prepare(`
    SELECT client_ts AS "clientTs", server_version AS "serverVersion"
    FROM sync_mutations
    WHERE organization_id = ?
      AND field_id = ?
      AND entity = 'paddock_geometry'
      AND status = 'applied'
      AND server_version IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM json_each(sync_mutations.payload, '$.updates') AS candidate
        INNER JOIN json_each(?) AS requested
          ON CAST(json_extract(candidate.value, '$.id') AS TEXT) = CAST(requested.value AS TEXT)
      )
    ORDER BY client_ts DESC, id DESC
    LIMIT 1
  `).bind(actor.organizationId, fieldId, JSON.stringify(paddockIds))
    .first<{ clientTs: string; serverVersion: string }>();
  return row ?? null;
}

function geometryVersionCoversCurrent(serverVersion: string, paddocks: Potrero[]): boolean {
  const prefix = "paddock-geometry-v1:";
  if (!serverVersion.startsWith(prefix)) return false;
  try {
    const entries = JSON.parse(serverVersion.slice(prefix.length)) as Array<{ id?: unknown; expectedVersion?: unknown }>;
    const versions = new Map(entries.map((entry) => [entry.id, entry.expectedVersion]));
    return paddocks.every((paddock) => versions.get(paddock.id) === requiredPaddockVersion(paddock));
  } catch {
    return false;
  }
}

function appliedLandmarkProjection(
  action: "upsert" | "archive",
  landmark: FieldLandmark,
): Extract<GeographicProjectionResult, { action: "applied" }> {
  return {
    action: "applied",
    eventType: `field_landmark.${action === "archive" ? "archived" : landmark.version === 1 ? "created" : "updated"}`,
    serverVersion: String(landmark.version),
    eventPayload: jsonObject({ projection: { kind: "field_landmark", action, landmark } }),
  };
}

function requiredPaddockVersion(paddock: Potrero): string {
  if (!paddock.updatedAt) throw new TypeError("El potrero no expone una versión sincronizable.");
  return paddock.updatedAt;
}

function samePaddockGeometry(
  paddock: Potrero,
  geometry: ReturnType<typeof parsePaddockGeometryPayload>["updates"][number]["geometry"],
  holeKinds: ReturnType<typeof parsePaddockGeometryPayload>["updates"][number]["holeKinds"],
): boolean {
  const currentGeometry = paddock.geometry ?? { outer: paddock.coordinates, holes: [] };
  return stableStringify(currentGeometry) === stableStringify(geometry)
    && stableStringify(paddock.holeKinds ?? []) === stableStringify(holeKinds);
}

function jsonObject(value: unknown): Record<string, SyncJsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, SyncJsonValue>;
}
