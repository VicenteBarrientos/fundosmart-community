import { getDb } from "@/db";
import {
  activities,
  fields,
  livestockLots,
  paddockLineageEdges,
  paddockOperationLotMoves,
  paddockOperations,
  paddocks,
} from "@/db/schema";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import {
  PADDOCK_LIMIT_MESSAGE,
  getOrganizationPlanUsage,
  paddockLimitWouldBeExceeded,
} from "@/src/modules/access/server/organization-plan-repository";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type {
  PaddockOperationCommitRequest,
  PaddockOperationLineage,
  PaddockOperationLotMove,
  PaddockOperationPlanRequest,
  PaddockOperationPreview,
  PaddockOperationResult,
  PolygonRings,
  Potrero,
  SoilAnalysis,
} from "../types";
import { calculateGrossHectares, calculateNetHectares } from "../utils/geometry";
import { assertAlignedHoleKinds, decodeStoredPolygon, encodeStoredPolygon } from "../utils/polygon-rings";
import {
  chooseLotDestination,
  planMerge,
  planRedesign,
  planSplit,
  planUndo,
  type GeometryOperationPlan,
  type PaddockGeometry,
} from "../utils/paddock-operations";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

type PaddockRow = typeof paddocks.$inferSelect;
type ActivityRow = typeof activities.$inferSelect;
type LotRow = typeof livestockLots.$inferSelect;
type OperationScope = OrganizationFieldScope & Partial<Pick<AccessContext, "email">>;

type OperationSnapshot = {
  fieldId: string;
  field: Pick<typeof fields.$inferSelect, "id" | "name" | "location" | "areaHectares" | "coordinates" | "createdAt">;
  activePaddocks: Array<Pick<PaddockRow, "id" | "updatedAt" | "archivedAt" | "deletedAt">>;
  paddocks: Array<Pick<PaddockRow, "id" | "updatedAt" | "archivedAt" | "deletedAt">>;
  activities: Array<Pick<ActivityRow, "id" | "paddockId" | "updatedAt" | "deletedAt">>;
  lots: Array<Pick<LotRow, "id" | "paddockId" | "updatedAt">>;
};

type PreparedOperation = {
  preview: PaddockOperationPreview;
  snapshot: OperationSnapshot;
  activeBefore: PaddockRow[];
  parents: PaddockRow[];
  children: Potrero[];
};

type PreparedUndoOperation = {
  preview: PaddockOperationPreview;
  snapshot: OperationSnapshot;
  source: typeof paddockOperations.$inferSelect;
  activeBefore: PaddockRow[];
  originalParents: PaddockRow[];
  children: PaddockRow[];
};

export async function hashPaddockOperationRequest(request: PaddockOperationPlanRequest): Promise<string> {
  const normalized = {
    fieldId: request.fieldId.trim(),
    kind: request.kind,
    parentPaddockIds: [...new Set(request.parentPaddockIds.map((id) => id.trim()))].sort(),
    proposedPaddocks: request.proposedPaddocks.map(normalizeRequestedPaddock).sort((a, b) => a.id.localeCompare(b.id)),
    sourceOperationId: request.sourceOperationId?.trim() || null,
  };
  return `paddock-operation-request:v1:${await sha256(canonicalJson(normalized))}`;
}

export async function previewPaddockOperation(
  request: PaddockOperationPlanRequest,
  scope: OperationScope,
): Promise<PaddockOperationPreview> {
  if (request.kind === "undo") return (await prepareUndoOperation(request, scope)).preview;
  return (await prepareOperation(request, scope)).preview;
}

export async function commitPaddockOperation(
  request: PaddockOperationCommitRequest,
  scope: OperationScope,
): Promise<PaddockOperationResult> {
  if (!request.operationId?.trim()) throw invalidOperation("Falta el identificador estable de la operación.");
  const existing = await findOperation(request.operationId.trim(), scope);
  if (existing) {
    if (existing.requestHash !== request.requestHash) {
      throw new DomainRuleError("El identificador de la operación ya fue usado con otro contenido.", "PADDOCK_OPERATION_ID_CONFLICT");
    }
    return { ...existing.result, idempotentReplay: true };
  }

  if (request.kind === "undo") return commitUndoPaddockOperation(request, scope);

  const prepared = await prepareOperation(request, scope);
  if (prepared.preview.requestHash !== request.requestHash) {
    throw invalidOperation("El contenido cambió desde que se preparó la operación.");
  }
  if (prepared.preview.snapshotToken !== request.expectedSnapshotToken) {
    throwFieldScopeConflict("Los potreros, manejos o lotes cambiaron desde la previsualización.");
  }
  if (!prepared.preview.valid) throw invalidOperation(prepared.preview.blockers.join(" "));
  const operationId = request.operationId.trim();
  const committedAt = new Date().toISOString();
  const archiveReason = request.kind;
  const archivedPaddocks = prepared.parents.map((row) => ({
    ...toPotrero(row),
    updatedAt: committedAt,
    archivedAt: committedAt,
    archiveReason,
    archivedByOperationId: operationId,
  }));
  const createdPaddocks = prepared.children.map((child) => ({
    ...child,
    updatedAt: committedAt,
    archivedAt: null,
    archiveReason: null,
    createdByOperationId: operationId,
    archivedByOperationId: null,
  }));
  const parentIdSet = new Set(prepared.parents.map((row) => row.id));
  const activePaddocks = [
    ...prepared.activeBefore.filter((row) => !parentIdSet.has(row.id)).map(toPotrero),
    ...createdPaddocks,
  ].sort((first, second) => first.id.localeCompare(second.id));
  const result: PaddockOperationResult = {
    operationId,
    fieldId: request.fieldId,
    kind: request.kind,
    requestHash: request.requestHash,
    sourceOperationId: null,
    activePaddocks,
    archivedPaddocks,
    lineageEdges: prepared.preview.lineageEdges,
    lotMoves: prepared.preview.lotMoves,
    committedAt,
    idempotentReplay: false,
  };

  const db = getDb();
  const client = db.$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const parentIdsJson = JSON.stringify(prepared.parents.map((row) => row.id));
  const childIdsJson = JSON.stringify(createdPaddocks.map((row) => row.id));
  const watchedIdsJson = parentIdsJson;
  const expectedPaddocksJson = JSON.stringify(prepared.snapshot.paddocks);
  const expectedFieldJson = JSON.stringify(prepared.snapshot.field);
  const expectedActivePaddocksJson = JSON.stringify(prepared.snapshot.activePaddocks);
  const expectedActivitiesJson = JSON.stringify(prepared.snapshot.activities);
  const expectedLotsJson = JSON.stringify(prepared.snapshot.lots);
  const statements = [
    client.prepare(`
      INSERT INTO paddock_operations (
        id, organization_id, field_id, kind, request_hash, snapshot_token,
        source_operation_id, request, result, actor, committed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ?
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND current_field.name = CAST(json_extract(?, '$.name') AS TEXT)
          AND current_field.location = CAST(json_extract(?, '$.location') AS TEXT)
          AND current_field.area_hectares = CAST(json_extract(?, '$.areaHectares') AS REAL)
          AND json(current_field.coordinates) = json(json_extract(?, '$.coordinates'))
          AND current_field.created_at = CAST(json_extract(?, '$.createdAt') AS TEXT)
      )
        AND EXISTS (
          SELECT 1 FROM organizations AS current_organization
          WHERE current_organization.id = ?
            AND (
              current_organization.paddock_limit IS NULL
              OR (
                (
                  SELECT COUNT(*)
                  FROM potreros AS active_paddock
                  INNER JOIN fields AS active_field ON active_field.id = active_paddock.field_id
                  WHERE active_field.organization_id = current_organization.id
                    AND active_paddock.archived_at IS NULL
                    AND active_paddock.deleted_at IS NULL
                )
                - json_array_length(?)
                + json_array_length(?)
              ) <= current_organization.paddock_limit
            )
        )
        AND NOT EXISTS (SELECT 1 FROM paddock_operations AS existing_operation WHERE existing_operation.id = ?)
        AND (
          SELECT COUNT(*) FROM potreros AS current_active
          WHERE current_active.field_id = ?
            AND current_active.archived_at IS NULL
            AND current_active.deleted_at IS NULL
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*)
          FROM json_each(?) AS expected
          INNER JOIN potreros AS current_active
            ON current_active.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current_active.field_id = ?
            AND current_active.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current_active.archived_at IS json_extract(expected.value, '$.archivedAt')
            AND current_active.deleted_at IS json_extract(expected.value, '$.deletedAt')
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*)
          FROM json_each(?) AS expected
          INNER JOIN potreros AS current_paddock
            ON current_paddock.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current_paddock.field_id = ?
            AND current_paddock.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current_paddock.archived_at IS json_extract(expected.value, '$.archivedAt')
            AND current_paddock.deleted_at IS json_extract(expected.value, '$.deletedAt')
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM activities AS current_activity
          WHERE current_activity.paddock_id IN (SELECT value FROM json_each(?))
            AND current_activity.deleted_at IS NULL
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*)
          FROM json_each(?) AS expected
          INNER JOIN activities AS current_activity
            ON current_activity.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current_activity.paddock_id = CAST(json_extract(expected.value, '$.paddockId') AS TEXT)
            AND current_activity.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current_activity.deleted_at IS json_extract(expected.value, '$.deletedAt')
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM livestock_lots AS current_lot
          WHERE current_lot.paddock_id IN (SELECT value FROM json_each(?))
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*)
          FROM json_each(?) AS expected
          INNER JOIN livestock_lots AS current_lot
            ON current_lot.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current_lot.paddock_id IS json_extract(expected.value, '$.paddockId')
            AND current_lot.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
        ) = json_array_length(?)
        AND NOT EXISTS (
          SELECT 1 FROM potreros AS conflicting_child
          WHERE conflicting_child.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      operationId,
      scope.organizationId,
      request.fieldId,
      request.kind,
      request.requestHash,
      request.expectedSnapshotToken,
      JSON.stringify(operationRequestForStorage(request)),
      JSON.stringify(result),
      scope.email ?? "unknown",
      committedAt,
      request.fieldId,
      scope.organizationId,
      fieldIdsJson,
      expectedFieldJson,
      expectedFieldJson,
      expectedFieldJson,
      expectedFieldJson,
      expectedFieldJson,
      scope.organizationId,
      parentIdsJson,
      childIdsJson,
      operationId,
      request.fieldId,
      expectedActivePaddocksJson,
      expectedActivePaddocksJson,
      request.fieldId,
      expectedActivePaddocksJson,
      expectedPaddocksJson,
      request.fieldId,
      expectedPaddocksJson,
      watchedIdsJson,
      expectedActivitiesJson,
      expectedActivitiesJson,
      expectedActivitiesJson,
      watchedIdsJson,
      expectedLotsJson,
      expectedLotsJson,
      expectedLotsJson,
      childIdsJson,
    ),
    client.prepare(`
      UPDATE potreros
      SET archived_at = ?, archive_reason = ?, archived_by_operation_id = ?, updated_at = ?
      WHERE field_id = ?
        AND id IN (SELECT value FROM json_each(?))
        AND archived_at IS NULL
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM paddock_operations AS committed
          WHERE committed.id = ? AND committed.organization_id = ? AND committed.field_id = ? AND committed.request_hash = ?
        )
    `).bind(committedAt, archiveReason, operationId, committedAt, request.fieldId, parentIdsJson, operationId, scope.organizationId, request.fieldId, request.requestHash),
    ...createdPaddocks.map((child) => client.prepare(`
      INSERT INTO potreros (
        id, field_id, name, sector, area_hectares, coordinates,
        grazeable_area_hectares, land_use, hole_kinds,
        soil_ph, soil_nitrogen, soil_phosphorus, soil_potassium,
        last_activity, status, created_at, updated_at, created_by_operation_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM paddock_operations AS committed
        WHERE committed.id = ? AND committed.organization_id = ? AND committed.field_id = ? AND committed.request_hash = ?
      )
    `).bind(
      child.id,
      child.fieldId,
      child.name,
      child.sector,
      child.areaHectares,
      JSON.stringify(child.geometry ?? encodeStoredPolygon(child.coordinates)),
      child.grazeableAreaHectares ?? null,
      child.landUse ?? "pradera_permanente",
      JSON.stringify(child.holeKinds ?? []),
      child.soil.ph,
      child.soil.nitrogen,
      child.soil.phosphorus,
      child.soil.potassium,
      child.lastActivity,
      child.status,
      committedAt,
      committedAt,
      operationId,
      operationId,
      scope.organizationId,
      request.fieldId,
      request.requestHash,
    )),
    ...prepared.preview.lineageEdges.map((edge) => client.prepare(`
      INSERT INTO paddock_lineage_edges (
        id, operation_id, parent_paddock_id, child_paddock_id,
        overlap_square_meters, parent_overlap_ratio, child_overlap_ratio, is_primary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      lineageId(operationId, edge.parentPaddockId, edge.childPaddockId),
      operationId,
      edge.parentPaddockId,
      edge.childPaddockId,
      edge.overlapSquareMeters,
      edge.parentOverlapRatio,
      edge.childOverlapRatio,
      edge.isPrimary ? 1 : 0,
      committedAt,
    )),
    ...prepared.preview.lotMoves.flatMap((move) => [
      client.prepare(`
        UPDATE livestock_lots
        SET paddock_id = ?, updated_at = ?
        WHERE id = ? AND field_id = ? AND paddock_id IS ?
          AND EXISTS (
            SELECT 1 FROM paddock_operations AS committed
            WHERE committed.id = ? AND committed.organization_id = ? AND committed.field_id = ? AND committed.request_hash = ?
          )
      `).bind(move.toPaddockId, committedAt, move.lotId, request.fieldId, move.fromPaddockId, operationId, scope.organizationId, request.fieldId, request.requestHash),
      client.prepare(`
        INSERT INTO paddock_operation_lot_moves (
          id, operation_id, lot_id, from_paddock_id, to_paddock_id,
          overlap_square_meters, overlap_ratio, reason, warning, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        lotMoveId(operationId, move.lotId),
        operationId,
        move.lotId,
        move.fromPaddockId,
        move.toPaddockId,
        move.overlapSquareMeters,
        move.overlapRatio,
        move.reason,
        move.warning,
        committedAt,
      ),
    ]),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at
      )
      SELECT ?, ?, ?, ?, ?, 'paddock_operation', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM paddock_operations AS committed
        WHERE committed.id = ? AND committed.organization_id = ? AND committed.field_id = ? AND committed.request_hash = ?
      )
    `).bind(
      `audit-paddock-operation-${operationId}`,
      scope.organizationId,
      request.fieldId,
      scope.email ?? "unknown",
      `paddock.operation.${request.kind}.committed`,
      operationId,
      JSON.stringify({ paddockIds: prepared.parents.map((row) => row.id), activityCount: prepared.preview.activityCount }),
      JSON.stringify({ paddockIds: activePaddocks.map((row) => row.id), lotMoves: prepared.preview.lotMoves, warnings: prepared.preview.warnings }),
      committedAt,
      operationId,
      scope.organizationId,
      request.fieldId,
      request.requestHash,
    ),
    client.prepare(`
      SELECT CASE WHEN
        EXISTS (
          SELECT 1 FROM paddock_operations
          WHERE id = ? AND organization_id = ? AND field_id = ? AND request_hash = ?
        )
        AND (SELECT COUNT(*) FROM potreros WHERE id IN (SELECT value FROM json_each(?)) AND archived_by_operation_id = ? AND archived_at = ?) = json_array_length(?)
        AND (SELECT COUNT(*) FROM potreros WHERE id IN (SELECT value FROM json_each(?)) AND created_by_operation_id = ? AND archived_at IS NULL AND deleted_at IS NULL) = json_array_length(?)
        AND (SELECT COUNT(*) FROM paddock_lineage_edges WHERE operation_id = ?) = ?
        AND (SELECT COUNT(*) FROM paddock_operation_lot_moves WHERE operation_id = ?) = ?
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND organization_id = ? AND field_id = ?)
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      operationId,
      scope.organizationId,
      request.fieldId,
      request.requestHash,
      parentIdsJson,
      operationId,
      committedAt,
      parentIdsJson,
      childIdsJson,
      operationId,
      childIdsJson,
      operationId,
      prepared.preview.lineageEdges.length,
      operationId,
      prepared.preview.lotMoves.length,
      `audit-paddock-operation-${operationId}`,
      scope.organizationId,
      request.fieldId,
    ),
  ];

  try {
    await client.batch(statements);
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint|FOREIGN KEY constraint/i.test(cause.message)) {
      const raced = await findOperation(operationId, scope);
      if (raced?.requestHash === request.requestHash) return { ...raced.result, idempotentReplay: true };
      if (await paddockLimitWouldBeExceeded(
        scope.organizationId,
        prepared.children.length - prepared.parents.length,
      )) {
        throw new DomainRuleError(PADDOCK_LIMIT_MESSAGE, "PLAN_PADDOCK_LIMIT_REACHED");
      }
      throwFieldScopeConflict("Los potreros, manejos o lotes cambiaron antes de confirmar la operación.");
    }
    throw cause;
  }
  return result;
}

export async function getPaddockOperation(
  operationId: string,
  scope: OperationScope,
): Promise<PaddockOperationResult | null> {
  const operation = await findOperation(operationId, scope);
  return operation ? operation.result : null;
}

export async function commitLegacyPaddockRedesign(
  fieldId: string,
  proposedPaddocks: Potrero[],
  scope: OperationScope,
): Promise<Potrero[]> {
  await assertFieldInScope(fieldId, scope);
  const active = await getDb()
    .select({ id: paddocks.id })
    .from(paddocks)
    .where(and(eq(paddocks.fieldId, fieldId), isNull(paddocks.archivedAt), isNull(paddocks.deletedAt)))
    .orderBy(asc(paddocks.id));
  const planRequest: PaddockOperationPlanRequest = {
    fieldId,
    kind: "redesign",
    parentPaddockIds: active.map(({ id }) => id),
    proposedPaddocks,
    sourceOperationId: null,
  };
  const preview = await previewPaddockOperation(planRequest, scope);
  const operationId = `legacy-redesign-${preview.requestHash.slice(-48)}`;
  const result = await commitPaddockOperation({
    ...planRequest,
    operationId,
    requestHash: preview.requestHash,
    expectedSnapshotToken: preview.snapshotToken,
  }, scope);
  return result.activePaddocks;
}

async function prepareOperation(request: PaddockOperationPlanRequest, scope: OperationScope): Promise<PreparedOperation> {
  await assertFieldInScope(request.fieldId, scope);
  if (request.kind === "undo") throw invalidOperation("La reversión necesita una operación de origen.");
  const db = getDb();
  const [field] = await db
    .select()
    .from(fields)
    .where(and(eq(fields.id, request.fieldId), eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
    .limit(1);
  if (!field) throwFieldScopeConflict("El fundo ya no está disponible.");
  const activeRows = await db
    .select()
    .from(paddocks)
    .where(and(eq(paddocks.fieldId, request.fieldId), isNull(paddocks.archivedAt), isNull(paddocks.deletedAt)))
    .orderBy(asc(paddocks.id));
  const parentIds = [...new Set(request.parentPaddockIds.map((id) => id.trim()).filter(Boolean))].sort();
  const activeById = new Map(activeRows.map((row) => [row.id, row]));
  const parents = parentIds.map((id) => activeById.get(id)).filter((row): row is PaddockRow => Boolean(row));
  const extraBlockers: string[] = [];
  const planUsage = await getOrganizationPlanUsage(scope.organizationId);
  if (
    planUsage.paddockLimit !== null
    && planUsage.paddocksUsed - parents.length + request.proposedPaddocks.length > planUsage.paddockLimit
  ) {
    extraBlockers.push(PADDOCK_LIMIT_MESSAGE);
  }
  try {
    const parentHasHoles = parents.some((parent) => paddockRings(parent).holes.length > 0);
    const proposedHasHoles = request.proposedPaddocks.some((child) => paddockRings(child).holes.length > 0);
    if (parentHasHoles || proposedHasHoles) {
      extraBlockers.push("Las operaciones split, merge y rediseño con exclusiones están bloqueadas hasta soportar clipping de anillos interiores.");
    }
  } catch (cause) {
    throw invalidOperation(cause instanceof Error ? cause.message : "La geometría de un potrero no es válida.");
  }
  if (parents.length !== parentIds.length) extraBlockers.push("Uno o más potreros de origen ya no están activos.");
  if (request.kind === "redesign" && canonicalJson(parentIds) !== canonicalJson(activeRows.map((row) => row.id).sort())) {
    extraBlockers.push("El rediseño debe incluir exactamente todos los potreros activos del fundo.");
  }
  if (request.proposedPaddocks.some((child) => child.fieldId !== request.fieldId)) {
    extraBlockers.push("Todos los potreros resultantes deben pertenecer al fundo autorizado.");
  }
  const proposedIds = request.proposedPaddocks.map((child) => child.id.trim());
  if (new Set(proposedIds).size !== proposedIds.length || proposedIds.some((id) => !id)) {
    extraBlockers.push("Los identificadores de los potreros resultantes deben ser únicos.");
  }
  if (request.kind === "merge" && request.proposedPaddocks.length !== 1) {
    extraBlockers.push("Una fusión debe proponer exactamente un potrero resultante.");
  }
  if (request.kind === "split" && parents.length !== 1) {
    extraBlockers.push("Una división debe seleccionar exactamente un potrero de origen.");
  }
  const conflictingRows = proposedIds.length === 0 ? [] : await db
    .select({ id: paddocks.id })
    .from(paddocks)
    .where(inArray(paddocks.id, proposedIds));
  if (conflictingRows.length > 0) extraBlockers.push("Un identificador de potrero resultante ya existe.");

  const parentGeometry = parents.map(toGeometry);
  let geometryPlan: GeometryOperationPlan;
  if (request.kind === "split") {
    geometryPlan = planSplit(parentGeometry[0] ?? { id: "missing-parent", coordinates: [] }, request.proposedPaddocks.map(toGeometry));
  } else if (request.kind === "merge") {
    geometryPlan = planMerge(parentGeometry, request.proposedPaddocks[0]?.id ?? "missing-child");
  } else {
    geometryPlan = planRedesign(parentGeometry, request.proposedPaddocks.map(toGeometry));
  }
  const children = buildChildren(request, parents, geometryPlan);
  if (children.some((child) => child.grazeableAreaHectares !== null && (
    !Number.isFinite(child.grazeableAreaHectares) || child.grazeableAreaHectares! < 0 || child.grazeableAreaHectares! > child.areaHectares
  ))) {
    extraBlockers.push("La superficie pastoreable resultante debe estar entre 0 y la superficie neta del potrero.");
  }
  const childGeometry = geometryPlan.children;
  const parentById = new Map(parentGeometry.map((parent) => [parent.id, parent]));
  const lots = parentIds.length === 0 ? [] : await db
    .select()
    .from(livestockLots)
    .where(and(eq(livestockLots.fieldId, request.fieldId), inArray(livestockLots.paddockId, parentIds)));
  const lotMoves = lots.map((lot) => {
    const parent = lot.paddockId ? parentById.get(lot.paddockId) : undefined;
    const decision = chooseLotDestination(parent ?? { id: lot.paddockId ?? "missing", coordinates: [] }, childGeometry, { lotId: lot.id });
    return {
      lotId: lot.id,
      fromPaddockId: lot.paddockId,
      toPaddockId: decision.destinationPaddockId,
      overlapSquareMeters: decision.overlapSquareMeters,
      overlapRatio: decision.overlapRatio,
      reason: decision.reason,
      warning: decision.warning,
    } satisfies PaddockOperationLotMove;
  });
  const activityRows = parentIds.length === 0 ? [] : await db
    .select()
    .from(activities)
    .where(and(inArray(activities.paddockId, parentIds), isNull(activities.deletedAt)))
    .orderBy(asc(activities.id));
  const snapshot: OperationSnapshot = {
    fieldId: request.fieldId,
    field: {
      id: field.id,
      name: field.name,
      location: field.location,
      areaHectares: field.areaHectares,
      coordinates: field.coordinates,
      createdAt: field.createdAt,
    },
    activePaddocks: activeRows.map(({ id, updatedAt, archivedAt, deletedAt }) => ({ id, updatedAt, archivedAt, deletedAt })),
    paddocks: parents.map(({ id, updatedAt, archivedAt, deletedAt }) => ({ id, updatedAt, archivedAt, deletedAt })),
    activities: activityRows.map(({ id, paddockId, updatedAt, deletedAt }) => ({ id, paddockId, updatedAt, deletedAt })),
    lots: lots.map(({ id, paddockId, updatedAt }) => ({ id, paddockId, updatedAt })),
  };
  const requestHash = await hashPaddockOperationRequest(request);
  const snapshotToken = `paddock-operation-snapshot:v1:${await sha256(canonicalJson(snapshot))}`;
  const warnings = [...geometryPlan.warnings, ...lotMoves.flatMap((move) => move.warning ? [move.warning] : [])];
  const blockers = [...extraBlockers, ...geometryPlan.blockers];
  const preview: PaddockOperationPreview = {
    fieldId: request.fieldId,
    kind: request.kind,
    requestHash,
    snapshotToken,
    sourceOperationId: null,
    parents: parents.map(toPotrero),
    proposedPaddocks: children,
    lineageEdges: geometryPlan.lineageEdges.map((edge) => ({ ...edge })) as PaddockOperationLineage[],
    lotMoves,
    activityCount: activityRows.length,
    areaBeforeSquareMeters: geometryPlan.areaBeforeSquareMeters,
    areaAfterSquareMeters: geometryPlan.areaAfterSquareMeters,
    areaDeltaSquareMeters: geometryPlan.areaDeltaSquareMeters,
    areaDeltaRatio: geometryPlan.areaDeltaRatio,
    warnings,
    blockers,
    valid: blockers.length === 0 && geometryPlan.valid,
  };
  return { preview, snapshot, activeBefore: activeRows, parents, children };
}

async function prepareUndoOperation(
  request: PaddockOperationPlanRequest,
  scope: OperationScope,
): Promise<PreparedUndoOperation> {
  await assertFieldInScope(request.fieldId, scope);
  const sourceOperationId = request.sourceOperationId?.trim();
  if (!sourceOperationId) throw invalidOperation("Falta la operación de origen que quieres revertir.");
  const source = await findOperation(sourceOperationId, scope);
  if (!source || source.fieldId !== request.fieldId) {
    throw invalidOperation("La operación de origen no existe en el fundo autorizado.");
  }

  const db = getDb();
  const [field] = await db.select().from(fields).where(and(
    eq(fields.id, request.fieldId),
    eq(fields.organizationId, scope.organizationId),
    inArray(fields.id, scope.fieldIds),
  )).limit(1);
  if (!field) throwFieldScopeConflict("El fundo ya no está disponible.");

  const edges = await db.select().from(paddockLineageEdges)
    .where(eq(paddockLineageEdges.operationId, sourceOperationId));
  const parentIds = [...new Set(edges.map((edge) => edge.parentPaddockId))].sort();
  const childIds = [...new Set(edges.map((edge) => edge.childPaddockId))].sort();
  const involvedIds = [...new Set([...parentIds, ...childIds])];
  const involved = involvedIds.length === 0 ? [] : await db.select().from(paddocks)
    .where(and(eq(paddocks.fieldId, request.fieldId), inArray(paddocks.id, involvedIds)))
    .orderBy(asc(paddocks.id));
  const byId = new Map(involved.map((row) => [row.id, row]));
  const originalParents = parentIds.map((id) => byId.get(id)).filter((row): row is PaddockRow => Boolean(row));
  const children = childIds.map((id) => byId.get(id)).filter((row): row is PaddockRow => Boolean(row));
  const activityRows = childIds.length === 0 ? [] : await db.select().from(activities)
    .where(and(inArray(activities.paddockId, childIds), isNull(activities.deletedAt)))
    .orderBy(asc(activities.id));
  const descendantCounts = childIds.length === 0 ? [] : await db
    .select({ paddockId: paddockLineageEdges.parentPaddockId, count: sql<number>`count(*)` })
    .from(paddockLineageEdges)
    .innerJoin(paddockOperations, eq(paddockOperations.id, paddockLineageEdges.operationId))
    .where(and(
      inArray(paddockLineageEdges.parentPaddockId, childIds),
      ne(paddockLineageEdges.operationId, sourceOperationId),
      isNull(paddockOperations.revertedAt),
    ))
    .groupBy(paddockLineageEdges.parentPaddockId);
  const descendantByChild = new Map(descendantCounts.map((row) => [row.paddockId, Number(row.count)]));
  const originalMoves = await db.select().from(paddockOperationLotMoves)
    .where(eq(paddockOperationLotMoves.operationId, sourceOperationId))
    .orderBy(asc(paddockOperationLotMoves.lotId));
  const currentLots = await db.select().from(livestockLots)
    .where(eq(livestockLots.fieldId, request.fieldId))
    .orderBy(asc(livestockLots.id));
  const undoPlan = planUndo({
    operationId: sourceOperationId,
    children: childIds.map((paddockId) => {
      const child = byId.get(paddockId);
      return {
        paddockId,
        exists: Boolean(child && !child.deletedAt && !child.archivedAt),
        ownActivityCount: activityRows.filter((activity) => activity.paddockId === paddockId).length,
        descendantOperationCount: descendantByChild.get(paddockId) ?? 0,
      };
    }),
    originalLotMoves: originalMoves.map((move) => ({ lotId: move.lotId, fromPaddockId: move.fromPaddockId, toPaddockId: move.toPaddockId })),
    currentLots: currentLots.map((lot) => ({ lotId: lot.id, paddockId: lot.paddockId })),
  });
  const blockers = [...undoPlan.blockers];
  const planUsage = await getOrganizationPlanUsage(scope.organizationId);
  if (
    planUsage.paddockLimit !== null
    && planUsage.paddocksUsed - children.length + originalParents.length > planUsage.paddockLimit
  ) {
    blockers.push(PADDOCK_LIMIT_MESSAGE);
  }
  if (source.kind === "undo") blockers.push("Una reversión no puede revertirse como operación de origen.");
  if (source.revertedAt) blockers.push("La operación ya fue revertida.");
  if (parentIds.length === 0 || childIds.length === 0) blockers.push("La operación de origen no tiene un linaje reversible.");
  if (originalParents.length !== parentIds.length) blockers.push("Falta uno de los potreros originales.");
  if (children.length !== childIds.length) blockers.push("Falta uno de los potreros creados por la operación.");
  if (request.parentPaddockIds.length > 0 || request.proposedPaddocks.length > 0) {
    blockers.push("La reversión no acepta potreros adicionales.");
  }
  originalParents.forEach((parent) => {
    if (parent.deletedAt || !parent.archivedAt || parent.archivedByOperationId !== sourceOperationId) {
      blockers.push(`El potrero original ${parent.id} cambió después de la operación.`);
    }
  });

  const reverseMoves = undoPlan.reverseLotMoves.map((move) => {
    const original = originalMoves.find((candidate) => candidate.lotId === move.lotId);
    return {
      lotId: move.lotId,
      fromPaddockId: move.fromPaddockId,
      toPaddockId: move.toPaddockId,
      overlapSquareMeters: original?.overlapSquareMeters ?? 0,
      overlapRatio: original?.overlapRatio ?? 0,
      reason: "undo",
      warning: null,
    } satisfies PaddockOperationLotMove;
  });
  const activeRows = await db.select().from(paddocks)
    .where(and(eq(paddocks.fieldId, request.fieldId), isNull(paddocks.archivedAt), isNull(paddocks.deletedAt)))
    .orderBy(asc(paddocks.id));
  const snapshot: OperationSnapshot = {
    fieldId: request.fieldId,
    field: { id: field.id, name: field.name, location: field.location, areaHectares: field.areaHectares, coordinates: field.coordinates, createdAt: field.createdAt },
    activePaddocks: activeRows.map(({ id, updatedAt, archivedAt, deletedAt }) => ({ id, updatedAt, archivedAt, deletedAt })),
    paddocks: involved.map(({ id, updatedAt, archivedAt, deletedAt }) => ({ id, updatedAt, archivedAt, deletedAt })),
    activities: activityRows.map(({ id, paddockId, updatedAt, deletedAt }) => ({ id, paddockId, updatedAt, deletedAt })),
    lots: currentLots.map(({ id, paddockId, updatedAt }) => ({ id, paddockId, updatedAt })),
  };
  const requestHash = await hashPaddockOperationRequest(request);
  const snapshotToken = `paddock-operation-snapshot:v1:${await sha256(canonicalJson(snapshot))}`;
  const areaBeforeSquareMeters = children.reduce((sum, row) => sum + calculateGrossHectares(toGeometry(row).coordinates) * 10_000, 0);
  const areaAfterSquareMeters = originalParents.reduce((sum, row) => sum + calculateGrossHectares(toGeometry(row).coordinates) * 10_000, 0);
  const areaDeltaSquareMeters = areaAfterSquareMeters - areaBeforeSquareMeters;
  const preview: PaddockOperationPreview = {
    fieldId: request.fieldId,
    kind: "undo",
    requestHash,
    snapshotToken,
    sourceOperationId,
    parents: children.map(toPotrero),
    proposedPaddocks: originalParents.map(toPotrero),
    lineageEdges: edges.map((edge) => ({
      parentPaddockId: edge.parentPaddockId,
      childPaddockId: edge.childPaddockId,
      overlapSquareMeters: edge.overlapSquareMeters,
      parentOverlapRatio: edge.parentOverlapRatio,
      childOverlapRatio: edge.childOverlapRatio,
      isPrimary: edge.isPrimary,
    })),
    lotMoves: reverseMoves,
    activityCount: activityRows.length,
    areaBeforeSquareMeters,
    areaAfterSquareMeters,
    areaDeltaSquareMeters,
    areaDeltaRatio: areaBeforeSquareMeters > 0 ? Math.abs(areaDeltaSquareMeters) / areaBeforeSquareMeters : 0,
    warnings: [],
    blockers: [...new Set(blockers)],
    valid: blockers.length === 0 && undoPlan.canUndo,
  };
  return { preview, snapshot, source, activeBefore: activeRows, originalParents, children };
}

async function commitUndoPaddockOperation(
  request: PaddockOperationCommitRequest,
  scope: OperationScope,
): Promise<PaddockOperationResult> {
  const prepared = await prepareUndoOperation(request, scope);
  if (prepared.preview.requestHash !== request.requestHash) throw invalidOperation("El contenido cambió desde que se preparó la reversión.");
  if (prepared.preview.snapshotToken !== request.expectedSnapshotToken) {
    throwFieldScopeConflict("Los potreros, manejos o lotes cambiaron desde la previsualización.");
  }
  if (!prepared.preview.valid) throw invalidOperation(prepared.preview.blockers.join(" "));

  const operationId = request.operationId.trim();
  const committedAt = new Date().toISOString();
  const restoredPaddocks = prepared.originalParents.map((row) => ({
    ...toPotrero(row), updatedAt: committedAt, archivedAt: null, archiveReason: null, archivedByOperationId: null,
  }));
  const childIdSet = new Set(prepared.children.map((row) => row.id));
  const activePaddocks = [
    ...prepared.activeBefore.filter((row) => !childIdSet.has(row.id)).map(toPotrero),
    ...restoredPaddocks,
  ].sort((first, second) => first.id.localeCompare(second.id));
  const archivedPaddocks = prepared.children.map((row) => ({
    ...toPotrero(row), updatedAt: committedAt, archivedAt: committedAt, archiveReason: "undo" as const, archivedByOperationId: operationId,
  }));
  const result: PaddockOperationResult = {
    operationId,
    fieldId: request.fieldId,
    kind: "undo",
    requestHash: request.requestHash,
    sourceOperationId: prepared.source.id,
    activePaddocks,
    archivedPaddocks,
    lineageEdges: prepared.preview.lineageEdges,
    lotMoves: prepared.preview.lotMoves,
    committedAt,
    idempotentReplay: false,
  };
  const client = getDb().$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const expectedFieldJson = JSON.stringify(prepared.snapshot.field);
  const expectedActiveJson = JSON.stringify(prepared.snapshot.activePaddocks);
  const expectedPaddocksJson = JSON.stringify(prepared.snapshot.paddocks);
  const expectedActivitiesJson = JSON.stringify(prepared.snapshot.activities);
  const expectedLotsJson = JSON.stringify(prepared.snapshot.lots);
  const childIdsJson = JSON.stringify(prepared.children.map((row) => row.id));
  const parentIdsJson = JSON.stringify(prepared.originalParents.map((row) => row.id));
  const statements = [
    client.prepare(`
      INSERT INTO paddock_operations (
        id, organization_id, field_id, kind, request_hash, snapshot_token,
        source_operation_id, request, result, actor, committed_at
      )
      SELECT ?, ?, ?, 'undo', ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ? AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND current_field.name = CAST(json_extract(?, '$.name') AS TEXT)
          AND current_field.location = CAST(json_extract(?, '$.location') AS TEXT)
          AND current_field.area_hectares = CAST(json_extract(?, '$.areaHectares') AS REAL)
          AND json(current_field.coordinates) = json(json_extract(?, '$.coordinates'))
          AND current_field.created_at = CAST(json_extract(?, '$.createdAt') AS TEXT)
      )
        AND EXISTS (
          SELECT 1 FROM organizations AS current_organization
          WHERE current_organization.id = ?
            AND (
              current_organization.paddock_limit IS NULL
              OR (
                (
                  SELECT COUNT(*)
                  FROM potreros AS active_paddock
                  INNER JOIN fields AS active_field ON active_field.id = active_paddock.field_id
                  WHERE active_field.organization_id = current_organization.id
                    AND active_paddock.archived_at IS NULL
                    AND active_paddock.deleted_at IS NULL
                )
                - json_array_length(?)
                + json_array_length(?)
              ) <= current_organization.paddock_limit
            )
        )
        AND EXISTS (
          SELECT 1 FROM paddock_operations AS source
          WHERE source.id = ? AND source.organization_id = ? AND source.field_id = ?
            AND source.reverted_at IS NULL AND source.kind <> 'undo'
        )
        AND NOT EXISTS (SELECT 1 FROM paddock_operations WHERE id = ?)
        AND (SELECT COUNT(*) FROM potreros WHERE field_id = ? AND archived_at IS NULL AND deleted_at IS NULL) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM json_each(?) AS expected
          INNER JOIN potreros AS current ON current.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current.field_id = ? AND current.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current.archived_at IS json_extract(expected.value, '$.archivedAt')
            AND current.deleted_at IS json_extract(expected.value, '$.deletedAt')
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM json_each(?) AS expected
          INNER JOIN potreros AS current ON current.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current.field_id = ? AND current.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current.archived_at IS json_extract(expected.value, '$.archivedAt')
            AND current.deleted_at IS json_extract(expected.value, '$.deletedAt')
        ) = json_array_length(?)
        AND (SELECT COUNT(*) FROM activities WHERE paddock_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM json_each(?) AS expected
          INNER JOIN activities AS current ON current.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current.paddock_id = CAST(json_extract(expected.value, '$.paddockId') AS TEXT)
            AND current.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current.deleted_at IS json_extract(expected.value, '$.deletedAt')
        ) = json_array_length(?)
        AND (SELECT COUNT(*) FROM livestock_lots WHERE field_id = ?) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM json_each(?) AS expected
          INNER JOIN livestock_lots AS current ON current.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current.field_id = ? AND current.paddock_id IS json_extract(expected.value, '$.paddockId')
            AND current.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
        ) = json_array_length(?)
    `).bind(
      operationId, scope.organizationId, request.fieldId, request.requestHash, request.expectedSnapshotToken,
      prepared.source.id, JSON.stringify(operationRequestForStorage(request)), JSON.stringify(result), scope.email ?? "unknown", committedAt,
      request.fieldId, scope.organizationId, fieldIdsJson,
      expectedFieldJson, expectedFieldJson, expectedFieldJson, expectedFieldJson, expectedFieldJson,
      scope.organizationId, childIdsJson, parentIdsJson,
      prepared.source.id, scope.organizationId, request.fieldId, operationId,
      request.fieldId, expectedActiveJson,
      expectedActiveJson, request.fieldId, expectedActiveJson,
      expectedPaddocksJson, request.fieldId, expectedPaddocksJson,
      childIdsJson, expectedActivitiesJson,
      expectedActivitiesJson, expectedActivitiesJson,
      request.fieldId, expectedLotsJson,
      expectedLotsJson, request.fieldId, expectedLotsJson,
    ),
    client.prepare(`
      UPDATE paddock_operations SET reverted_at = ?, reverted_by_operation_id = ?
      WHERE id = ? AND organization_id = ? AND field_id = ? AND reverted_at IS NULL
        AND EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND request_hash = ?)
    `).bind(committedAt, operationId, prepared.source.id, scope.organizationId, request.fieldId, operationId, request.requestHash),
    client.prepare(`
      UPDATE potreros SET archived_at = ?, archive_reason = 'undo', archived_by_operation_id = ?, updated_at = ?
      WHERE field_id = ? AND id IN (SELECT value FROM json_each(?))
        AND archived_at IS NULL AND deleted_at IS NULL AND created_by_operation_id = ?
        AND EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND request_hash = ?)
    `).bind(committedAt, operationId, committedAt, request.fieldId, childIdsJson, prepared.source.id, operationId, request.requestHash),
    client.prepare(`
      UPDATE potreros SET archived_at = NULL, archive_reason = NULL, archived_by_operation_id = NULL, updated_at = ?
      WHERE field_id = ? AND id IN (SELECT value FROM json_each(?))
        AND archived_by_operation_id = ? AND archived_at IS NOT NULL AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND request_hash = ?)
    `).bind(committedAt, request.fieldId, parentIdsJson, prepared.source.id, operationId, request.requestHash),
    ...prepared.preview.lotMoves.flatMap((move) => [
      client.prepare(`
        UPDATE livestock_lots SET paddock_id = ?, updated_at = ?
        WHERE id = ? AND field_id = ? AND paddock_id IS ?
          AND EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND request_hash = ?)
      `).bind(move.toPaddockId, committedAt, move.lotId, request.fieldId, move.fromPaddockId, operationId, request.requestHash),
      client.prepare(`
        INSERT INTO paddock_operation_lot_moves (
          id, operation_id, lot_id, from_paddock_id, to_paddock_id,
          overlap_square_meters, overlap_ratio, reason, warning, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'undo', NULL, ?)
      `).bind(lotMoveId(operationId, move.lotId), operationId, move.lotId, move.fromPaddockId, move.toPaddockId, move.overlapSquareMeters, move.overlapRatio, committedAt),
    ]),
    client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
      SELECT ?, ?, ?, ?, 'paddock.operation.undo.committed', 'paddock_operation', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND request_hash = ?)
    `).bind(
      `audit-paddock-operation-${operationId}`, scope.organizationId, request.fieldId, scope.email ?? "unknown", operationId,
      JSON.stringify({ sourceOperationId: prepared.source.id, childPaddockIds: prepared.children.map((row) => row.id) }),
      JSON.stringify({ restoredPaddockIds: prepared.originalParents.map((row) => row.id), lotMoves: prepared.preview.lotMoves }),
      committedAt, operationId, request.requestHash,
    ),
    client.prepare(`
      SELECT CASE WHEN
        EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND source_operation_id = ? AND request_hash = ?)
        AND EXISTS (SELECT 1 FROM paddock_operations WHERE id = ? AND reverted_by_operation_id = ? AND reverted_at = ?)
        AND (SELECT COUNT(*) FROM potreros WHERE id IN (SELECT value FROM json_each(?)) AND archived_by_operation_id = ? AND archived_at = ?) = json_array_length(?)
        AND (SELECT COUNT(*) FROM potreros WHERE id IN (SELECT value FROM json_each(?)) AND archived_at IS NULL AND archived_by_operation_id IS NULL) = json_array_length(?)
        AND (SELECT COUNT(*) FROM paddock_operation_lot_moves WHERE operation_id = ?) = ?
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND organization_id = ? AND field_id = ?)
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      operationId, prepared.source.id, request.requestHash,
      prepared.source.id, operationId, committedAt,
      childIdsJson, operationId, committedAt, childIdsJson,
      parentIdsJson, parentIdsJson,
      operationId, prepared.preview.lotMoves.length,
      `audit-paddock-operation-${operationId}`, scope.organizationId, request.fieldId,
    ),
  ];
  try {
    await client.batch(statements);
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint|FOREIGN KEY constraint/i.test(cause.message)) {
      const raced = await findOperation(operationId, scope);
      if (raced?.requestHash === request.requestHash) return { ...raced.result, idempotentReplay: true };
      if (await paddockLimitWouldBeExceeded(
        scope.organizationId,
        prepared.originalParents.length - prepared.children.length,
      )) {
        throw new DomainRuleError(PADDOCK_LIMIT_MESSAGE, "PLAN_PADDOCK_LIMIT_REACHED");
      }
      throwFieldScopeConflict("La operación cambió y ya no se puede revertir.");
    }
    throw cause;
  }
  return result;
}

function buildChildren(
  request: PaddockOperationPlanRequest,
  parents: PaddockRow[],
  plan: GeometryOperationPlan,
): Potrero[] {
  const requestedById = new Map(request.proposedPaddocks.map((child) => [child.id, child]));
  const primaryParentByChildId = plan.primaryParentByChildId;
  return plan.children.map((geometry) => {
    const requested = requestedById.get(geometry.id);
    const primary = parents.find((parent) => parent.id === primaryParentByChildId[geometry.id]) ?? parents[0];
    const inheritedSoil = primary ? soilFromRow(primary) : emptySoil();
    const metadata = request.kind === "split" && primary
      ? {
          sector: primary.sector,
          soil: inheritedSoil,
          status: primary.status,
          lastActivity: primary.lastActivity,
          landUse: primary.landUse,
          grazeableAreaHectares: primary.grazeableAreaHectares,
        }
      : request.kind === "merge"
        ? mergeMetadata(parents)
        : {
            sector: requested?.sector || primary?.sector || "Sin sector",
            soil: requested?.soil ?? inheritedSoil,
            status: requested?.status ?? primary?.status ?? "Disponible" as Potrero["status"],
            lastActivity: requested?.lastActivity ?? primary?.lastActivity ?? "Creado · ahora",
            landUse: requested?.landUse ?? primary?.landUse ?? "pradera_permanente" as const,
            grazeableAreaHectares: requested?.grazeableAreaHectares ?? null,
          };
    const grossAreaHectares = calculateGrossHectares(geometry.coordinates);
    const requestedGrazeable = request.kind === "split" && primary && metadata.grazeableAreaHectares !== null
      ? Number((metadata.grazeableAreaHectares * grossAreaHectares / Math.max(rowGrossAreaHectares(primary), Number.EPSILON)).toFixed(2))
      : metadata.grazeableAreaHectares;
    return {
      id: geometry.id,
      fieldId: request.fieldId,
      name: requested?.name.trim() || `Potrero ${geometry.id}`,
      sector: metadata.sector,
      areaHectares: grossAreaHectares,
      coordinates: geometry.coordinates,
      geometry: encodeStoredPolygon(geometry.coordinates),
      netAreaHectares: grossAreaHectares,
      grazeableAreaHectares: requestedGrazeable,
      effectiveGrazeableAreaHectares: requestedGrazeable ?? grossAreaHectares,
      landUse: metadata.landUse,
      holeKinds: [],
      soil: metadata.soil,
      lastActivity: metadata.lastActivity,
      status: metadata.status,
      archivedAt: null,
      archiveReason: null,
      createdByOperationId: null,
      archivedByOperationId: null,
    };
  });
}

function mergeMetadata(parents: PaddockRow[]) {
  const largest = [...parents].sort((a, b) => rowGrossAreaHectares(b) - rowGrossAreaHectares(a) || a.id.localeCompare(b.id))[0];
  const totalArea = parents.reduce((sum, parent) => sum + rowGrossAreaHectares(parent), 0);
  const weighted = (key: "soilPh" | "soilNitrogen" | "soilPhosphorus" | "soilPotassium") => {
    const values = parents.filter((parent) => parent[key] !== null);
    const denominator = values.reduce((sum, parent) => sum + rowGrossAreaHectares(parent), 0);
    if (denominator <= 0) return null;
    return values.reduce((sum, parent) => sum + Number(parent[key]) * rowGrossAreaHectares(parent), 0) / denominator;
  };
  return {
    sector: largest?.sector ?? "Sin sector",
    soil: { ph: weighted("soilPh"), nitrogen: weighted("soilNitrogen"), phosphorus: weighted("soilPhosphorus"), potassium: weighted("soilPotassium") },
    status: parents.some((parent) => parent.status === "En pastoreo") ? "En pastoreo" as const : largest?.status ?? "Disponible" as const,
    lastActivity: largest?.lastActivity ?? "Creado · ahora",
    landUse: largest?.landUse ?? "pradera_permanente" as const,
    grazeableAreaHectares: parents.some((parent) => parent.grazeableAreaHectares !== null)
      ? parents.reduce((sum, parent) => sum + (parent.grazeableAreaHectares ?? calculateNetHectares(paddockRings(parent))), 0)
      : null,
    totalArea,
  };
}

function paddockRings(value: Pick<Potrero, "coordinates" | "geometry"> | PaddockRow): PolygonRings {
  if ("geometry" in value && value.geometry) return decodeStoredPolygon(value.geometry);
  return decodeStoredPolygon(value.coordinates);
}

function rowGrossAreaHectares(row: PaddockRow): number {
  return calculateGrossHectares(paddockRings(row));
}

function toGeometry(value: Pick<Potrero, "id" | "coordinates" | "geometry"> | PaddockRow): PaddockGeometry {
  return { id: value.id, coordinates: paddockRings(value).outer };
}

function toPotrero(row: PaddockRow): Potrero {
  const geometry = decodeStoredPolygon(row.coordinates);
  assertAlignedHoleKinds(geometry.holes, row.holeKinds);
  const grossAreaHectares = calculateGrossHectares(geometry);
  const netAreaHectares = calculateNetHectares(geometry);
  return {
    id: row.id,
    fieldId: row.fieldId,
    name: row.name,
    sector: row.sector,
    areaHectares: grossAreaHectares,
    coordinates: geometry.outer,
    geometry,
    netAreaHectares,
    grazeableAreaHectares: row.grazeableAreaHectares,
    effectiveGrazeableAreaHectares: row.grazeableAreaHectares ?? netAreaHectares,
    landUse: row.landUse,
    holeKinds: row.holeKinds,
    soil: soilFromRow(row),
    lastActivity: row.lastActivity,
    status: row.status,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
    createdByOperationId: row.createdByOperationId,
    archivedByOperationId: row.archivedByOperationId,
  };
}

function soilFromRow(row: PaddockRow): SoilAnalysis {
  return { ph: row.soilPh, nitrogen: row.soilNitrogen, phosphorus: row.soilPhosphorus, potassium: row.soilPotassium };
}

function emptySoil(): SoilAnalysis {
  return { ph: null, nitrogen: null, phosphorus: null, potassium: null };
}

function normalizeRequestedPaddock(paddock: Potrero) {
  return {
    id: paddock.id.trim(),
    fieldId: paddock.fieldId.trim(),
    name: paddock.name.trim(),
    sector: paddock.sector.trim(),
    coordinates: paddock.coordinates,
    geometry: paddock.geometry ?? null,
    grazeableAreaHectares: paddock.grazeableAreaHectares ?? null,
    landUse: paddock.landUse ?? "pradera_permanente",
    holeKinds: paddock.holeKinds ?? [],
    soil: paddock.soil,
    lastActivity: paddock.lastActivity,
    status: paddock.status,
  };
}

function operationRequestForStorage(request: PaddockOperationPlanRequest): PaddockOperationPlanRequest {
  return {
    fieldId: request.fieldId,
    kind: request.kind,
    parentPaddockIds: [...request.parentPaddockIds],
    proposedPaddocks: request.proposedPaddocks.map((paddock) => ({ ...paddock })),
    sourceOperationId: request.sourceOperationId ?? null,
  };
}

async function findOperation(operationId: string, scope: OrganizationFieldScope) {
  const [row] = await getDb()
    .select()
    .from(paddockOperations)
    .where(and(
      eq(paddockOperations.id, operationId),
      eq(paddockOperations.organizationId, scope.organizationId),
      inArray(paddockOperations.fieldId, scope.fieldIds),
    ))
    .limit(1);
  return row ?? null;
}

function lineageId(operationId: string, parentId: string, childId: string) {
  return `${operationId}:lineage:${parentId}:${childId}`;
}

function lotMoveId(operationId: string, lotId: string) {
  return `${operationId}:lot:${lotId}`;
}

function invalidOperation(message: string): DomainRuleError {
  return new DomainRuleError(message || "La operación geométrica no es válida.", "PADDOCK_OPERATION_INVALID");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
