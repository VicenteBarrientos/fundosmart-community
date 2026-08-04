import { getDb } from "@/db";
import { fieldLandmarkOperations, fieldLandmarks, fields } from "@/db/schema";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  SyncWriteAccessRevokedError,
  syncWriteAccessCondition,
} from "@/src/modules/sync/server/sync-write-access";
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  FieldLandmark,
  FieldLandmarkDeleteRequest,
  FieldLandmarkListing,
  FieldLandmarkOperationKind,
  FieldLandmarkOperationResult,
  FieldLandmarkUpsertRequest,
} from "../domain/field-landmarks";
import {
  FieldLandmarkValidationError,
  parseFieldLandmarkDeleteRequest,
  parseFieldLandmarkUpsertRequest,
} from "../utils/field-landmarks";

type LandmarkScope = OrganizationFieldScope & Partial<Pick<AccessContext, "email">>;
type LandmarkRow = typeof fieldLandmarks.$inferSelect;
type LandmarkOperationRow = typeof fieldLandmarkOperations.$inferSelect;
type ParsedUpsert = ReturnType<typeof parseFieldLandmarkUpsertRequest>;

export async function listFieldLandmarks(
  fieldId: string,
  scope: LandmarkScope,
): Promise<FieldLandmarkListing> {
  const normalizedFieldId = fieldId.trim();
  if (!normalizedFieldId) throw invalidLandmark("Selecciona un fundo.");
  await assertFieldInScope(normalizedFieldId, scope);
  const rows = await getDb()
    .select()
    .from(fieldLandmarks)
    .where(eq(fieldLandmarks.fieldId, normalizedFieldId))
    .orderBy(asc(fieldLandmarks.name), asc(fieldLandmarks.id));
  return {
    fieldId: normalizedFieldId,
    active: rows.filter((row) => row.deletedAt === null).map(toLandmark),
    archived: rows.filter((row) => row.deletedAt !== null).map(toLandmark),
  };
}

export async function upsertFieldLandmark(
  requestValue: unknown,
  scope: LandmarkScope,
  syncActor?: AccessContext,
): Promise<FieldLandmarkOperationResult> {
  const request = parseUpsert(requestValue);
  await assertFieldInScope(request.fieldId, scope);
  const requestHash = await hashUpsertRequest(request);
  const existingOperation = await findLandmarkOperation(request.operationId, scope);
  if (existingOperation) return replayLandmarkOperation(existingOperation, requestHash);

  const before = await findScopedLandmark(request.id, request.fieldId, scope);
  if (request.expectedVersion === null) {
    if (before || await landmarkIdExists(request.id)) {
      throwFieldScopeConflict("El hito ya existe o fue archivado y no puede recrearse.");
    }
  } else if (!before || before.deletedAt !== null || before.version !== request.expectedVersion) {
    throwFieldScopeConflict("El hito cambió desde la última carga o ya fue archivado.");
  }

  const kind: FieldLandmarkOperationKind = request.expectedVersion === null ? "create" : "update";
  const committedAt = new Date().toISOString();
  const landmark: FieldLandmark = {
    id: request.id,
    fieldId: request.fieldId,
    kind: request.kind,
    geometryType: request.geometryType,
    geometry: request.geometry,
    name: request.name,
    notes: request.notes,
    lengthMeters: request.lengthMeters,
    createdAt: before?.createdAt ?? committedAt,
    updatedAt: committedAt,
    deletedAt: null,
    version: (request.expectedVersion ?? 0) + 1,
    lastOperationId: request.operationId,
  };
  const storedRequest = upsertRequestWithoutLength(request);
  const result: FieldLandmarkOperationResult = {
    operationId: request.operationId,
    kind,
    requestHash,
    landmark,
    committedAt,
    idempotentReplay: false,
  };
  return await commitUpsert({ request: storedRequest, requestHash, result, before, scope, syncActor }) ?? result;
}

export async function archiveFieldLandmark(
  requestValue: unknown,
  scope: LandmarkScope,
  syncActor?: AccessContext,
): Promise<FieldLandmarkOperationResult> {
  const request = parseDelete(requestValue);
  await assertFieldInScope(request.fieldId, scope);
  const requestHash = await hashDeleteRequest(request);
  const existingOperation = await findLandmarkOperation(request.operationId, scope);
  if (existingOperation) return replayLandmarkOperation(existingOperation, requestHash);

  const row = await findScopedLandmark(request.id, request.fieldId, scope);
  if (!row || row.deletedAt !== null || row.version !== request.expectedVersion) {
    throwFieldScopeConflict("El hito cambió desde la última carga o ya fue archivado.");
  }
  const before = toLandmark(row);
  const committedAt = new Date().toISOString();
  const landmark: FieldLandmark = {
    ...before,
    updatedAt: committedAt,
    deletedAt: committedAt,
    version: before.version + 1,
    lastOperationId: request.operationId,
  };
  const result: FieldLandmarkOperationResult = {
    operationId: request.operationId,
    kind: "delete",
    requestHash,
    landmark,
    committedAt,
    idempotentReplay: false,
  };
  return await commitDelete({ request, requestHash, result, before, scope, syncActor }) ?? result;
}

async function commitUpsert(input: {
  request: FieldLandmarkUpsertRequest;
  requestHash: string;
  result: FieldLandmarkOperationResult;
  before: LandmarkRow | null;
  scope: LandmarkScope;
  syncActor?: AccessContext;
}): Promise<FieldLandmarkOperationResult | null> {
  const client = getDb().$client;
  const { request, requestHash, result, scope } = input;
  const landmark = result.landmark;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const auditId = `audit-field-landmark-${request.operationId}`;
  const operationGuard = landmarkOperationGuard();
  const guardValues = () => landmarkOperationGuardValues(result, scope);
  const access = input.syncActor
    ? syncWriteAccessCondition(input.syncActor, request.fieldId)
    : { sql: "1 = 1", bindings: [] };
  const statements = [
    client.prepare(`
      INSERT INTO field_landmark_operations (
        id, organization_id, field_id, landmark_id, kind, request_hash,
        expected_version, request, result, actor, committed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${access.sql}
        AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ? AND current_field.organization_id = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM field_landmark_operations AS existing_operation
          WHERE existing_operation.id = ?
        )
        AND (
          (? IS NULL AND NOT EXISTS (
            SELECT 1 FROM field_landmarks AS existing_landmark
            WHERE existing_landmark.id = ?
          ))
          OR
          (? IS NOT NULL AND EXISTS (
            SELECT 1 FROM field_landmarks AS current_landmark
            WHERE current_landmark.id = ? AND current_landmark.field_id = ?
              AND current_landmark.deleted_at IS NULL AND current_landmark.version = ?
          ))
        )
    `).bind(
      request.operationId,
      scope.organizationId,
      request.fieldId,
      request.id,
      result.kind,
      requestHash,
      request.expectedVersion,
      JSON.stringify(request),
      JSON.stringify(result),
      scope.email ?? "unknown",
      result.committedAt,
      ...access.bindings,
      request.fieldId,
      scope.organizationId,
      fieldIdsJson,
      request.operationId,
      request.expectedVersion,
      request.id,
      request.expectedVersion,
      request.id,
      request.fieldId,
      request.expectedVersion,
    ),
    client.prepare(`
      INSERT INTO field_landmarks (
        id, field_id, kind, geometry_type, geometry, name, notes, length_meters,
        created_at, updated_at, deleted_at, version, last_operation_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?
      WHERE ? IS NULL AND ${operationGuard} AND ${access.sql}
    `).bind(
      landmark.id,
      landmark.fieldId,
      landmark.kind,
      landmark.geometryType,
      JSON.stringify(landmark.geometry),
      landmark.name,
      landmark.notes,
      landmark.lengthMeters,
      landmark.createdAt,
      landmark.updatedAt,
      request.operationId,
      request.expectedVersion,
      ...guardValues(),
      ...access.bindings,
    ),
    client.prepare(`
      UPDATE field_landmarks
      SET kind = ?, geometry_type = ?, geometry = ?, name = ?, notes = ?,
        length_meters = ?, updated_at = ?, version = version + 1, last_operation_id = ?
      WHERE id = ? AND field_id = ? AND version = ? AND ? IS NOT NULL
        AND deleted_at IS NULL AND ${operationGuard} AND ${access.sql}
    `).bind(
      landmark.kind,
      landmark.geometryType,
      JSON.stringify(landmark.geometry),
      landmark.name,
      landmark.notes,
      landmark.lengthMeters,
      landmark.updatedAt,
      request.operationId,
      landmark.id,
      landmark.fieldId,
      request.expectedVersion,
      request.expectedVersion,
      ...guardValues(),
      ...access.bindings,
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, occurred_at
      )
      SELECT ?, ?, ?, ?, ?, 'field_landmark', ?, ?, ?, ?
      WHERE ${operationGuard} AND ${access.sql}
    `).bind(
      auditId,
      scope.organizationId,
      landmark.fieldId,
      scope.email ?? "unknown",
      result.kind === "create" ? "paddock.landmark.created" : "paddock.landmark.updated",
      landmark.id,
      input.before ? JSON.stringify(toLandmark(input.before)) : null,
      JSON.stringify({ ...landmark, requestHash }),
      result.committedAt,
      ...guardValues(),
      ...access.bindings,
    ),
    client.prepare(`
      SELECT CASE
        WHEN NOT (${access.sql}) THEN 0
        WHEN ${operationGuard}
        AND EXISTS (
          SELECT 1 FROM field_landmarks AS saved
          WHERE saved.id = ? AND saved.field_id = ? AND saved.kind = ?
            AND saved.geometry_type = ? AND json(saved.geometry) = json(?)
            AND saved.name = ? AND saved.notes = ? AND saved.length_meters = ?
            AND saved.created_at = ? AND saved.updated_at = ? AND saved.deleted_at IS NULL
            AND saved.version = ? AND saved.last_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM audit_log AS operation_audit
          WHERE operation_audit.id = ? AND operation_audit.organization_id = ?
            AND operation_audit.field_id = ? AND operation_audit.entity_id = ?
        )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      ...access.bindings,
      ...guardValues(),
      landmark.id,
      landmark.fieldId,
      landmark.kind,
      landmark.geometryType,
      JSON.stringify(landmark.geometry),
      landmark.name,
      landmark.notes,
      landmark.lengthMeters,
      landmark.createdAt,
      landmark.updatedAt,
      landmark.version,
      landmark.lastOperationId,
      auditId,
      scope.organizationId,
      landmark.fieldId,
      landmark.id,
    ),
  ];
  return commitLandmarkBatch(statements, request.operationId, requestHash, scope, input.syncActor);
}

async function commitDelete(input: {
  request: FieldLandmarkDeleteRequest;
  requestHash: string;
  result: FieldLandmarkOperationResult;
  before: FieldLandmark;
  scope: LandmarkScope;
  syncActor?: AccessContext;
}): Promise<FieldLandmarkOperationResult | null> {
  const client = getDb().$client;
  const { request, requestHash, result, before, scope } = input;
  const landmark = result.landmark;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const auditId = `audit-field-landmark-${request.operationId}`;
  const operationGuard = landmarkOperationGuard();
  const guardValues = () => landmarkOperationGuardValues(result, scope);
  const access = input.syncActor
    ? syncWriteAccessCondition(input.syncActor, request.fieldId)
    : { sql: "1 = 1", bindings: [] };
  const statements = [
    client.prepare(`
      INSERT INTO field_landmark_operations (
        id, organization_id, field_id, landmark_id, kind, request_hash,
        expected_version, request, result, actor, committed_at
      )
      SELECT ?, ?, ?, ?, 'delete', ?, ?, ?, ?, ?, ?
      WHERE ${access.sql}
        AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ? AND current_field.organization_id = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM field_landmark_operations AS existing_operation
          WHERE existing_operation.id = ?
        )
        AND EXISTS (
          SELECT 1 FROM field_landmarks AS current_landmark
          WHERE current_landmark.id = ? AND current_landmark.field_id = ?
            AND current_landmark.deleted_at IS NULL AND current_landmark.version = ?
        )
    `).bind(
      request.operationId,
      scope.organizationId,
      request.fieldId,
      request.id,
      requestHash,
      request.expectedVersion,
      JSON.stringify(request),
      JSON.stringify(result),
      scope.email ?? "unknown",
      result.committedAt,
      ...access.bindings,
      request.fieldId,
      scope.organizationId,
      fieldIdsJson,
      request.operationId,
      request.id,
      request.fieldId,
      request.expectedVersion,
    ),
    client.prepare(`
      UPDATE field_landmarks
      SET deleted_at = ?, updated_at = ?, version = version + 1, last_operation_id = ?
      WHERE id = ? AND field_id = ? AND version = ? AND deleted_at IS NULL
        AND ${operationGuard} AND ${access.sql}
    `).bind(
      landmark.deletedAt,
      landmark.updatedAt,
      request.operationId,
      landmark.id,
      landmark.fieldId,
      request.expectedVersion,
      ...guardValues(),
      ...access.bindings,
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, occurred_at
      )
      SELECT ?, ?, ?, ?, 'paddock.landmark.deleted', 'field_landmark', ?, ?, ?, ?
      WHERE ${operationGuard} AND ${access.sql}
    `).bind(
      auditId,
      scope.organizationId,
      landmark.fieldId,
      scope.email ?? "unknown",
      landmark.id,
      JSON.stringify(before),
      JSON.stringify({ ...landmark, requestHash }),
      result.committedAt,
      ...guardValues(),
      ...access.bindings,
    ),
    client.prepare(`
      SELECT CASE
        WHEN NOT (${access.sql}) THEN 0
        WHEN ${operationGuard}
        AND EXISTS (
          SELECT 1 FROM field_landmarks AS saved
          WHERE saved.id = ? AND saved.field_id = ? AND saved.deleted_at = ?
            AND saved.updated_at = ? AND saved.version = ? AND saved.last_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM audit_log AS operation_audit
          WHERE operation_audit.id = ? AND operation_audit.organization_id = ?
            AND operation_audit.field_id = ? AND operation_audit.entity_id = ?
        )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      ...access.bindings,
      ...guardValues(),
      landmark.id,
      landmark.fieldId,
      landmark.deletedAt,
      landmark.updatedAt,
      landmark.version,
      landmark.lastOperationId,
      auditId,
      scope.organizationId,
      landmark.fieldId,
      landmark.id,
    ),
  ];
  return commitLandmarkBatch(statements, request.operationId, requestHash, scope, input.syncActor);
}

async function commitLandmarkBatch(
  statements: D1PreparedStatement[],
  operationId: string,
  requestHash: string,
  scope: LandmarkScope,
  syncActor?: AccessContext,
): Promise<FieldLandmarkOperationResult | null> {
  try {
    const results = await getDb().$client.batch(statements);
    const completion = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (syncActor && Number(completion?.complete) !== 1) throw new SyncWriteAccessRevokedError();
    return null;
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint|FOREIGN KEY constraint/i.test(cause.message)) {
      const raced = await findLandmarkOperation(operationId, scope);
      if (raced?.requestHash === requestHash) return { ...raced.result, idempotentReplay: true };
      throwFieldScopeConflict("El hito cambió antes de confirmar la operación.");
    }
    throw cause;
  }
}

async function findScopedLandmark(
  landmarkId: string,
  fieldId: string,
  scope: LandmarkScope,
): Promise<LandmarkRow | null> {
  const [row] = await getDb()
    .select({ landmark: fieldLandmarks })
    .from(fieldLandmarks)
    .innerJoin(fields, eq(fields.id, fieldLandmarks.fieldId))
    .where(and(
      eq(fieldLandmarks.id, landmarkId),
      eq(fieldLandmarks.fieldId, fieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  return row?.landmark ?? null;
}

async function landmarkIdExists(landmarkId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: fieldLandmarks.id })
    .from(fieldLandmarks)
    .where(eq(fieldLandmarks.id, landmarkId))
    .limit(1);
  return Boolean(row);
}

async function findLandmarkOperation(
  operationId: string,
  scope: LandmarkScope,
): Promise<LandmarkOperationRow | null> {
  const [row] = await getDb()
    .select()
    .from(fieldLandmarkOperations)
    .where(and(
      eq(fieldLandmarkOperations.id, operationId),
      eq(fieldLandmarkOperations.organizationId, scope.organizationId),
      inArray(fieldLandmarkOperations.fieldId, scope.fieldIds),
    ))
    .limit(1);
  return row ?? null;
}

function replayLandmarkOperation(
  operation: LandmarkOperationRow,
  requestHash: string,
): FieldLandmarkOperationResult {
  if (operation.requestHash !== requestHash) {
    throwFieldScopeConflict("El identificador de la operación ya fue usado con otro contenido.");
  }
  return { ...operation.result, idempotentReplay: true };
}

function landmarkOperationGuard(): string {
  return `EXISTS (
    SELECT 1 FROM field_landmark_operations AS committed
    WHERE committed.id = ? AND committed.organization_id = ?
      AND committed.field_id = ? AND committed.landmark_id = ?
      AND committed.kind = ? AND committed.request_hash = ?
  )`;
}

function landmarkOperationGuardValues(
  result: FieldLandmarkOperationResult,
  scope: LandmarkScope,
): unknown[] {
  return [
    result.operationId,
    scope.organizationId,
    result.landmark.fieldId,
    result.landmark.id,
    result.kind,
    result.requestHash,
  ];
}

function toLandmark(row: LandmarkRow): FieldLandmark {
  return {
    id: row.id,
    fieldId: row.fieldId,
    kind: row.kind,
    geometryType: row.geometryType,
    geometry: row.geometry,
    name: row.name,
    notes: row.notes,
    lengthMeters: row.lengthMeters,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    version: row.version,
    lastOperationId: row.lastOperationId,
  };
}

function parseUpsert(value: unknown): ParsedUpsert {
  try {
    return parseFieldLandmarkUpsertRequest(value);
  } catch (cause) {
    if (cause instanceof FieldLandmarkValidationError) throw invalidLandmark(cause.message);
    throw cause;
  }
}

function parseDelete(value: unknown): FieldLandmarkDeleteRequest {
  try {
    return parseFieldLandmarkDeleteRequest(value);
  } catch (cause) {
    if (cause instanceof FieldLandmarkValidationError) throw invalidLandmark(cause.message);
    throw cause;
  }
}

function upsertRequestWithoutLength(request: ParsedUpsert): FieldLandmarkUpsertRequest {
  return {
    id: request.id,
    fieldId: request.fieldId,
    kind: request.kind,
    geometryType: request.geometryType,
    geometry: request.geometry,
    name: request.name,
    notes: request.notes,
    operationId: request.operationId,
    expectedVersion: request.expectedVersion,
  };
}

async function hashUpsertRequest(request: ParsedUpsert): Promise<string> {
  return `field-landmark-upsert:v1:${await sha256(canonicalJson({
    ...upsertRequestWithoutLength(request),
    operationId: undefined,
  }))}`;
}

async function hashDeleteRequest(request: FieldLandmarkDeleteRequest): Promise<string> {
  return `field-landmark-delete:v1:${await sha256(canonicalJson({
    fieldId: request.fieldId,
    id: request.id,
    expectedVersion: request.expectedVersion,
  }))}`;
}

function invalidLandmark(message: string): DomainRuleError {
  return new DomainRuleError(message || "El hito no es válido.", "FIELD_LANDMARK_INVALID");
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
