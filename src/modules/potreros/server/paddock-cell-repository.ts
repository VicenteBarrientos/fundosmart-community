import { getDb } from "@/db";
import { fields, paddockCellOperations, paddockCells, paddocks } from "@/db/schema";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type {
  FieldActivePaddockCellListing,
  PaddockCell,
  PaddockCellCloseRequest,
  PaddockCellGenerationCommitRequest,
  PaddockCellGenerationPlanRequest,
  PaddockCellGenerationPreview,
  PaddockCellListing,
  PaddockCellOperationKind,
  PaddockCellOperationRequest,
  PaddockCellOperationResult,
} from "../domain/cells-rotation";
import { decodeStoredPolygon, encodeStoredPolygon } from "../utils/polygon-rings";
import { generateStripCells } from "../utils/strips";

type CellScope = OrganizationFieldScope & Partial<Pick<AccessContext, "email">>;
type PaddockRow = typeof paddocks.$inferSelect;
type CellRow = typeof paddockCells.$inferSelect;

type CellState = {
  paddock: PaddockRow;
  activeRows: CellRow[];
  allRows: CellRow[];
};

type PreparedGeneration = {
  preview: PaddockCellGenerationPreview;
  state: CellState;
};

export async function hashPaddockCellGenerationRequest(
  request: PaddockCellGenerationPlanRequest,
): Promise<string> {
  return `paddock-cell-request:v1:${await sha256(canonicalJson(normalizeGenerationRequest(request)))}`;
}

export async function previewPaddockCellGeneration(
  request: PaddockCellGenerationPlanRequest,
  scope: CellScope,
): Promise<PaddockCellGenerationPreview> {
  return (await prepareGeneration(request, scope)).preview;
}

export async function listPaddockCells(
  fieldId: string,
  paddockId: string,
  scope: CellScope,
): Promise<PaddockCellListing> {
  const state = await readCellState(fieldId, paddockId, scope, false);
  return {
    fieldId,
    paddockId,
    snapshotToken: await cellSnapshotToken(state),
    active: state.activeRows.map(toCell),
    history: state.allRows.filter((row) => row.activeTo !== null).map(toCell),
  };
}

/**
 * Loads the active cell overlay for a whole field in one tenant-scoped query.
 * Per-paddock history intentionally remains behind listPaddockCells.
 */
export async function listFieldActivePaddockCells(
  fieldId: string,
  scope: CellScope,
): Promise<FieldActivePaddockCellListing> {
  const normalizedFieldId = fieldId?.trim();
  if (!normalizedFieldId) throw invalidCellOperation("Selecciona un fundo.");
  await assertFieldInScope(normalizedFieldId, scope);
  const rows = await getDb()
    .select({ cell: paddockCells })
    .from(paddockCells)
    .innerJoin(paddocks, and(eq(paddocks.id, paddockCells.paddockId), eq(paddocks.fieldId, paddockCells.fieldId)))
    .innerJoin(fields, eq(fields.id, paddockCells.fieldId))
    .where(and(
      eq(paddockCells.fieldId, normalizedFieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddockCells.activeTo),
      isNull(paddocks.archivedAt),
      isNull(paddocks.deletedAt),
    ))
    .orderBy(asc(paddocks.name), asc(paddockCells.cellIndex), asc(paddockCells.id));
  const activeRows = rows.map(({ cell }) => cell);
  return {
    fieldId: normalizedFieldId,
    snapshotToken: `field-active-cells-snapshot:v1:${await sha256(canonicalJson(activeRows.map(cellSnapshot)))}`,
    active: activeRows.map(toCell),
  };
}

export async function commitPaddockCellGeneration(
  request: PaddockCellGenerationCommitRequest,
  scope: CellScope,
): Promise<PaddockCellOperationResult> {
  const operationId = request.operationId?.trim();
  if (!operationId) throw invalidCellOperation("Falta el identificador estable de la operación.");
  const existing = await findCellOperation(operationId, scope);
  if (existing) return replayCellOperation(existing, request.requestHash);

  const prepared = await prepareGeneration(request, scope);
  if (prepared.preview.requestHash !== request.requestHash) {
    throw invalidCellOperation("El contenido cambió desde que se prepararon las franjas.");
  }
  if (prepared.preview.snapshotToken !== request.expectedSnapshotToken) {
    throwFieldScopeConflict("El potrero o sus celdas cambiaron desde la previsualización.");
  }

  const committedAt = new Date().toISOString();
  const closedCells = prepared.state.activeRows.map((row) => closeCell(row, operationId, committedAt));
  const activeCells = prepared.preview.cells.map((cell) => ({
    id: cellId(operationId, cell.index),
    fieldId: request.fieldId,
    paddockId: request.paddockId,
    name: cell.name,
    index: cell.index,
    coordinates: cell.coordinates,
    geometry: cell.geometry,
    areaSquareMeters: cell.areaSquareMeters,
    startDistanceMeters: cell.startDistanceMeters,
    endDistanceMeters: cell.endDistanceMeters,
    activeFrom: committedAt,
    activeTo: null,
    createdAt: committedAt,
    updatedAt: committedAt,
    version: 1,
    createdByOperationId: operationId,
    closedByOperationId: null,
  } satisfies PaddockCell));
  const result: PaddockCellOperationResult = {
    operationId,
    kind: "create",
    fieldId: request.fieldId,
    paddockId: request.paddockId,
    requestHash: request.requestHash,
    snapshotToken: request.expectedSnapshotToken,
    activeCells,
    closedCells,
    committedAt,
    idempotentReplay: false,
  };
  await commitCellOperation({
    kind: "create",
    operationId,
    request: storedGenerationRequest(request),
    requestHash: request.requestHash,
    snapshotToken: request.expectedSnapshotToken,
    result,
    state: prepared.state,
    activeCells,
    scope,
  });
  return result;
}

export async function closePaddockCells(
  request: PaddockCellCloseRequest,
  scope: CellScope,
): Promise<PaddockCellOperationResult> {
  const operationId = request.operationId?.trim();
  if (!operationId) throw invalidCellOperation("Falta el identificador estable del cierre.");
  const normalized = normalizeCloseRequest(request);
  const requestHash = `paddock-cell-close-request:v1:${await sha256(canonicalJson(normalized))}`;
  const existing = await findCellOperation(operationId, scope);
  if (existing) return replayCellOperation(existing, requestHash);

  const state = await readCellState(normalized.fieldId, normalized.paddockId, scope, true);
  const snapshotToken = await cellSnapshotToken(state);
  if (snapshotToken !== request.expectedSnapshotToken) {
    throwFieldScopeConflict("Las celdas cambiaron antes de confirmar el cierre.");
  }
  const committedAt = new Date().toISOString();
  const closedCells = state.activeRows.map((row) => closeCell(row, operationId, committedAt));
  const result: PaddockCellOperationResult = {
    operationId,
    kind: "close",
    fieldId: normalized.fieldId,
    paddockId: normalized.paddockId,
    requestHash,
    snapshotToken,
    activeCells: [],
    closedCells,
    committedAt,
    idempotentReplay: false,
  };
  await commitCellOperation({
    kind: "close",
    operationId,
    request: { ...normalized, operationId, expectedSnapshotToken: snapshotToken },
    requestHash,
    snapshotToken,
    result,
    state,
    activeCells: [],
    scope,
  });
  return result;
}

async function prepareGeneration(
  request: PaddockCellGenerationPlanRequest,
  scope: CellScope,
): Promise<PreparedGeneration> {
  const normalized = normalizeGenerationRequest(request);
  const state = await readCellState(normalized.fieldId, normalized.paddockId, scope, true);
  const geometry = decodeStoredPolygon(state.paddock.coordinates);
  if (geometry.holes.length > 0) {
    throw invalidCellOperation("Las franjas temporales V1 no admiten potreros con exclusiones interiores.");
  }
  let generation;
  try {
    generation = generateStripCells({
      id: state.paddock.id,
      name: state.paddock.name,
      coordinates: geometry.outer,
    }, normalized.count, normalized.bearingDegrees);
  } catch (cause) {
    throw invalidCellOperation(cause instanceof Error ? cause.message : "No fue posible generar las franjas.");
  }
  const requestHash = await hashPaddockCellGenerationRequest(normalized);
  return {
    state,
    preview: {
      fieldId: normalized.fieldId,
      paddockId: normalized.paddockId,
      paddockName: state.paddock.name,
      count: generation.count,
      bearingDegrees: generation.bearingDegrees,
      stripWidthMeters: generation.stripWidthMeters,
      sourceAreaSquareMeters: generation.sourceAreaSquareMeters,
      cellsAreaSquareMeters: generation.cellsAreaSquareMeters,
      areaDeltaSquareMeters: generation.areaDeltaSquareMeters,
      areaToleranceSquareMeters: generation.areaToleranceSquareMeters,
      requestHash,
      snapshotToken: await cellSnapshotToken(state),
      cells: generation.cells.map((cell) => ({
        ...cell,
        geometry: encodeStoredPolygon({ outer: cell.coordinates, holes: [] }),
      })),
    },
  };
}

async function readCellState(
  fieldId: string,
  paddockId: string,
  scope: CellScope,
  requireActivePaddock: boolean,
): Promise<CellState> {
  await assertFieldInScope(fieldId, scope);
  const db = getDb();
  const [scoped] = await db
    .select({ paddock: paddocks })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(paddocks.id, paddockId),
      eq(paddocks.fieldId, fieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddocks.deletedAt),
      requireActivePaddock ? isNull(paddocks.archivedAt) : undefined,
    ))
    .limit(1);
  if (!scoped) throwFieldScopeConflict("El potrero no existe o no está disponible.");
  const allRows = await db
    .select()
    .from(paddockCells)
    .where(and(eq(paddockCells.fieldId, fieldId), eq(paddockCells.paddockId, paddockId)))
    .orderBy(desc(paddockCells.activeFrom), asc(paddockCells.cellIndex), asc(paddockCells.id));
  return {
    paddock: scoped.paddock,
    activeRows: allRows.filter((row) => row.activeTo === null).sort(compareCellRows),
    allRows,
  };
}

async function commitCellOperation(input: {
  kind: PaddockCellOperationKind;
  operationId: string;
  request: PaddockCellOperationRequest;
  requestHash: string;
  snapshotToken: string;
  result: PaddockCellOperationResult;
  state: CellState;
  activeCells: PaddockCell[];
  scope: CellScope;
}): Promise<void> {
  const client = getDb().$client;
  const fieldIdsJson = JSON.stringify(input.scope.fieldIds);
  const expectedPaddockJson = JSON.stringify(paddockSnapshot(input.state.paddock));
  const expectedActiveJson = JSON.stringify(input.state.activeRows.map(cellSnapshot));
  const expectedClosedJson = JSON.stringify(input.state.activeRows.map(({ id, version }) => ({ id, version })));
  const activeIdsJson = JSON.stringify(input.activeCells.map(({ id }) => id));
  const committedAt = input.result.committedAt;
  const auditId = `audit-paddock-cell-operation-${input.operationId}`;
  const operationGuard = `EXISTS (
    SELECT 1 FROM paddock_cell_operations AS committed
    WHERE committed.id = ? AND committed.organization_id = ?
      AND committed.field_id = ? AND committed.paddock_id = ?
      AND committed.kind = ? AND committed.request_hash = ?
  )`;
  const statements = [
    client.prepare(`
      INSERT INTO paddock_cell_operations (
        id, organization_id, field_id, paddock_id, kind, request_hash,
        snapshot_token, request, result, actor, committed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM potreros AS current_paddock
        INNER JOIN fields AS current_field ON current_field.id = current_paddock.field_id
        WHERE current_paddock.id = ? AND current_paddock.field_id = ?
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND current_paddock.name = CAST(json_extract(?, '$.name') AS TEXT)
          AND json(current_paddock.coordinates) = json(json_extract(?, '$.coordinates'))
          AND current_paddock.updated_at = CAST(json_extract(?, '$.updatedAt') AS TEXT)
          AND current_paddock.archived_at IS json_extract(?, '$.archivedAt')
          AND current_paddock.deleted_at IS json_extract(?, '$.deletedAt')
      )
        AND NOT EXISTS (SELECT 1 FROM paddock_cell_operations AS existing WHERE existing.id = ?)
        AND (
          SELECT COUNT(*) FROM paddock_cells AS current_cell
          WHERE current_cell.field_id = ? AND current_cell.paddock_id = ? AND current_cell.active_to IS NULL
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*)
          FROM json_each(?) AS expected
          INNER JOIN paddock_cells AS current_cell
            ON current_cell.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE current_cell.field_id = ? AND current_cell.paddock_id = ?
            AND current_cell.name = CAST(json_extract(expected.value, '$.name') AS TEXT)
            AND current_cell.cell_index = CAST(json_extract(expected.value, '$.cellIndex') AS INTEGER)
            AND json(current_cell.coordinates) = json(json_extract(expected.value, '$.coordinates'))
            AND current_cell.area_square_meters = CAST(json_extract(expected.value, '$.areaSquareMeters') AS REAL)
            AND current_cell.start_distance_meters = CAST(json_extract(expected.value, '$.startDistanceMeters') AS REAL)
            AND current_cell.end_distance_meters = CAST(json_extract(expected.value, '$.endDistanceMeters') AS REAL)
            AND current_cell.active_from = CAST(json_extract(expected.value, '$.activeFrom') AS TEXT)
            AND current_cell.active_to IS NULL
            AND current_cell.created_at = CAST(json_extract(expected.value, '$.createdAt') AS TEXT)
            AND current_cell.updated_at = CAST(json_extract(expected.value, '$.updatedAt') AS TEXT)
            AND current_cell.version = CAST(json_extract(expected.value, '$.version') AS INTEGER)
            AND current_cell.created_by_operation_id = CAST(json_extract(expected.value, '$.createdByOperationId') AS TEXT)
            AND current_cell.closed_by_operation_id IS NULL
        ) = json_array_length(?)
        AND NOT EXISTS (
          SELECT 1 FROM paddock_cells AS conflicting
          WHERE conflicting.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        )
    `).bind(
      input.operationId,
      input.scope.organizationId,
      input.result.fieldId,
      input.result.paddockId,
      input.kind,
      input.requestHash,
      input.snapshotToken,
      JSON.stringify(input.request),
      JSON.stringify(input.result),
      input.scope.email ?? "unknown",
      committedAt,
      input.result.paddockId,
      input.result.fieldId,
      input.scope.organizationId,
      fieldIdsJson,
      expectedPaddockJson,
      expectedPaddockJson,
      expectedPaddockJson,
      expectedPaddockJson,
      expectedPaddockJson,
      input.operationId,
      input.result.fieldId,
      input.result.paddockId,
      expectedActiveJson,
      expectedActiveJson,
      input.result.fieldId,
      input.result.paddockId,
      expectedActiveJson,
      activeIdsJson,
    ),
    client.prepare(`
      UPDATE paddock_cells
      SET active_to = ?, updated_at = ?, version = version + 1, closed_by_operation_id = ?
      WHERE field_id = ? AND paddock_id = ? AND active_to IS NULL
        AND ${operationGuard}
    `).bind(
      committedAt,
      committedAt,
      input.operationId,
      input.result.fieldId,
      input.result.paddockId,
      input.operationId,
      input.scope.organizationId,
      input.result.fieldId,
      input.result.paddockId,
      input.kind,
      input.requestHash,
    ),
    ...input.activeCells.map((cell) => client.prepare(`
      INSERT INTO paddock_cells (
        id, field_id, paddock_id, name, cell_index, coordinates,
        area_square_meters, start_distance_meters, end_distance_meters,
        active_from, active_to, created_at, updated_at, version,
        created_by_operation_id, closed_by_operation_id
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, NULL
      WHERE ${operationGuard}
    `).bind(
      cell.id,
      cell.fieldId,
      cell.paddockId,
      cell.name,
      cell.index,
      JSON.stringify(cell.geometry),
      cell.areaSquareMeters,
      cell.startDistanceMeters,
      cell.endDistanceMeters,
      cell.activeFrom,
      cell.createdAt,
      cell.updatedAt,
      input.operationId,
      input.operationId,
      input.scope.organizationId,
      input.result.fieldId,
      input.result.paddockId,
      input.kind,
      input.requestHash,
    )),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, occurred_at
      )
      SELECT ?, ?, ?, ?, ?, 'paddock_cell_operation', ?, ?, ?, ?
      WHERE ${operationGuard}
    `).bind(
      auditId,
      input.scope.organizationId,
      input.result.fieldId,
      input.scope.email ?? "unknown",
      input.kind === "create" ? "paddock.cells.created" : "paddock.cells.closed",
      input.operationId,
      JSON.stringify({ activeCellIds: input.state.activeRows.map(({ id }) => id) }),
      JSON.stringify({ activeCellIds: input.activeCells.map(({ id }) => id), requestHash: input.requestHash }),
      committedAt,
      input.operationId,
      input.scope.organizationId,
      input.result.fieldId,
      input.result.paddockId,
      input.kind,
      input.requestHash,
    ),
    client.prepare(`
      SELECT CASE WHEN
        ${operationGuard}
        AND (
          SELECT COUNT(*)
          FROM json_each(?) AS expected
          INNER JOIN paddock_cells AS closed_cell
            ON closed_cell.id = CAST(json_extract(expected.value, '$.id') AS TEXT)
          WHERE closed_cell.field_id = ? AND closed_cell.paddock_id = ?
            AND closed_cell.active_to = ? AND closed_cell.updated_at = ?
            AND closed_cell.version = CAST(json_extract(expected.value, '$.version') AS INTEGER) + 1
            AND closed_cell.closed_by_operation_id = ?
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM paddock_cells AS active_cell
          WHERE active_cell.field_id = ? AND active_cell.paddock_id = ? AND active_cell.active_to IS NULL
        ) = json_array_length(?)
        AND (
          SELECT COUNT(*) FROM paddock_cells AS active_cell
          WHERE active_cell.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            AND active_cell.field_id = ? AND active_cell.paddock_id = ?
            AND active_cell.active_to IS NULL AND active_cell.created_by_operation_id = ?
        ) = json_array_length(?)
        AND EXISTS (
          SELECT 1 FROM audit_log AS operation_audit
          WHERE operation_audit.id = ? AND operation_audit.organization_id = ?
            AND operation_audit.field_id = ? AND operation_audit.entity_id = ?
        )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      input.operationId,
      input.scope.organizationId,
      input.result.fieldId,
      input.result.paddockId,
      input.kind,
      input.requestHash,
      expectedClosedJson,
      input.result.fieldId,
      input.result.paddockId,
      committedAt,
      committedAt,
      input.operationId,
      expectedClosedJson,
      input.result.fieldId,
      input.result.paddockId,
      activeIdsJson,
      activeIdsJson,
      input.result.fieldId,
      input.result.paddockId,
      input.operationId,
      activeIdsJson,
      auditId,
      input.scope.organizationId,
      input.result.fieldId,
      input.operationId,
    ),
  ];

  try {
    await client.batch(statements);
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint|FOREIGN KEY constraint/i.test(cause.message)) {
      const raced = await findCellOperation(input.operationId, input.scope);
      if (raced?.requestHash === input.requestHash) return;
      throwFieldScopeConflict("El potrero o sus celdas cambiaron antes de confirmar la operación.");
    }
    throw cause;
  }
}

async function findCellOperation(operationId: string, scope: CellScope) {
  const [row] = await getDb()
    .select()
    .from(paddockCellOperations)
    .where(and(
      eq(paddockCellOperations.id, operationId),
      eq(paddockCellOperations.organizationId, scope.organizationId),
      inArray(paddockCellOperations.fieldId, scope.fieldIds),
    ))
    .limit(1);
  return row ?? null;
}

function replayCellOperation(
  existing: typeof paddockCellOperations.$inferSelect,
  requestHash: string,
): PaddockCellOperationResult {
  if (existing.requestHash !== requestHash) {
    throwFieldScopeConflict("El identificador de la operación ya fue usado con otro contenido.");
  }
  return { ...existing.result, idempotentReplay: true };
}

function toCell(row: CellRow): PaddockCell {
  const geometry = decodeStoredPolygon(row.coordinates);
  return {
    id: row.id,
    fieldId: row.fieldId,
    paddockId: row.paddockId,
    name: row.name,
    index: row.cellIndex,
    coordinates: geometry.outer,
    geometry,
    areaSquareMeters: row.areaSquareMeters,
    startDistanceMeters: row.startDistanceMeters,
    endDistanceMeters: row.endDistanceMeters,
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    createdByOperationId: row.createdByOperationId,
    closedByOperationId: row.closedByOperationId,
  };
}

function closeCell(row: CellRow, operationId: string, committedAt: string): PaddockCell {
  return {
    ...toCell(row),
    activeTo: committedAt,
    updatedAt: committedAt,
    version: row.version + 1,
    closedByOperationId: operationId,
  };
}

function normalizeGenerationRequest(request: PaddockCellGenerationPlanRequest): PaddockCellGenerationPlanRequest {
  const normalized = {
    fieldId: request.fieldId?.trim(),
    paddockId: request.paddockId?.trim(),
    count: request.count,
    bearingDegrees: request.bearingDegrees,
  };
  if (!normalized.fieldId) throw invalidCellOperation("Selecciona un fundo.");
  if (!normalized.paddockId) throw invalidCellOperation("Selecciona un potrero.");
  return normalized;
}

function normalizeCloseRequest(request: PaddockCellCloseRequest) {
  const fieldId = request.fieldId?.trim();
  const paddockId = request.paddockId?.trim();
  if (!fieldId) throw invalidCellOperation("Selecciona un fundo.");
  if (!paddockId) throw invalidCellOperation("Selecciona un potrero.");
  return { fieldId, paddockId };
}

function storedGenerationRequest(request: PaddockCellGenerationCommitRequest): PaddockCellGenerationCommitRequest {
  return {
    ...normalizeGenerationRequest(request),
    operationId: request.operationId.trim(),
    requestHash: request.requestHash,
    expectedSnapshotToken: request.expectedSnapshotToken,
  };
}

function paddockSnapshot(row: PaddockRow) {
  return {
    id: row.id,
    fieldId: row.fieldId,
    name: row.name,
    coordinates: row.coordinates,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
  };
}

function cellSnapshot(row: CellRow) {
  return {
    id: row.id,
    fieldId: row.fieldId,
    paddockId: row.paddockId,
    name: row.name,
    cellIndex: row.cellIndex,
    coordinates: row.coordinates,
    areaSquareMeters: row.areaSquareMeters,
    startDistanceMeters: row.startDistanceMeters,
    endDistanceMeters: row.endDistanceMeters,
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    createdByOperationId: row.createdByOperationId,
    closedByOperationId: row.closedByOperationId,
  };
}

async function cellSnapshotToken(state: CellState): Promise<string> {
  return `paddock-cell-snapshot:v1:${await sha256(canonicalJson({
    paddock: paddockSnapshot(state.paddock),
    activeCells: state.activeRows.map(cellSnapshot),
  }))}`;
}

function compareCellRows(first: CellRow, second: CellRow): number {
  return first.cellIndex - second.cellIndex || first.id.localeCompare(second.id);
}

function cellId(operationId: string, index: number): string {
  return `${operationId}:cell:${index}`;
}

function invalidCellOperation(message: string): DomainRuleError {
  return new DomainRuleError(message || "La operación de celdas no es válida.", "PADDOCK_CELL_INVALID");
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
