import { getDb } from "@/db";
import { paddockRotationSettingOperations, paddockRotationSettings } from "@/db/schema";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { and, eq, inArray } from "drizzle-orm";
import type {
  PaddockRotationEntry,
  PaddockRotationSettings,
  PaddockRotationSettingsOperationResult,
  PaddockRotationSettingsUpdateRequest,
  PaddockRotationSnapshot,
} from "../domain/cells-rotation";
import { buildRotationOverview, DEFAULT_LONG_REST_DAYS, DEFAULT_RECENT_DAYS } from "../utils/rotation";

type RotationScope = OrganizationFieldScope & Partial<Pick<AccessContext, "email">>;

type RotationQueryRow = {
  fieldId: string;
  recentDays: number;
  longRestDays: number;
  settingsVersion: number | null;
  settingsCreatedAt: string | null;
  settingsUpdatedAt: string | null;
  paddockId: string | null;
  paddockName: string | null;
  grazingDates: string | string[];
  assignedLotCount: number;
};

export async function getPaddockRotationSnapshot(
  fieldId: string,
  scope: RotationScope,
  referenceDate = new Date().toISOString().slice(0, 10),
): Promise<PaddockRotationSnapshot> {
  const normalizedFieldId = fieldId.trim();
  if (!normalizedFieldId) throw invalidRotation("Selecciona un fundo.");
  const normalizedReferenceDate = normalizeReferenceDate(referenceDate);
  const result = await getDb().$client.prepare(`
    WITH scoped_field AS (
      SELECT
        current_field.id AS field_id,
        COALESCE(settings.recent_days, ${DEFAULT_RECENT_DAYS}) AS recent_days,
        COALESCE(settings.long_rest_days, ${DEFAULT_LONG_REST_DAYS}) AS long_rest_days,
        settings.version AS settings_version,
        settings.created_at AS settings_created_at,
        settings.updated_at AS settings_updated_at
      FROM fields AS current_field
      LEFT JOIN paddock_rotation_settings AS settings ON settings.field_id = current_field.id
      WHERE current_field.id = ?
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    )
    SELECT
      scoped_field.field_id AS "fieldId",
      scoped_field.recent_days AS "recentDays",
      scoped_field.long_rest_days AS "longRestDays",
      scoped_field.settings_version AS "settingsVersion",
      scoped_field.settings_created_at AS "settingsCreatedAt",
      scoped_field.settings_updated_at AS "settingsUpdatedAt",
      paddock.id AS "paddockId",
      paddock.name AS "paddockName",
      COALESCE((
        SELECT json_group_array(grazing.occurred_at)
        FROM (
          SELECT activity.occurred_at
          FROM activities AS activity
          WHERE activity.paddock_id = paddock.id
            AND activity.type = 'grazing'
            AND activity.deleted_at IS NULL
          ORDER BY activity.occurred_at, activity.created_at, activity.id
        ) AS grazing
      ), '[]') AS "grazingDates",
      COALESCE((
        SELECT COUNT(*)
        FROM livestock_lots AS assigned_lot
        WHERE assigned_lot.field_id = scoped_field.field_id
          AND assigned_lot.paddock_id = paddock.id
          AND assigned_lot.status = 'active'
      ), 0) AS "assignedLotCount"
    FROM scoped_field
    LEFT JOIN potreros AS paddock
      ON paddock.field_id = scoped_field.field_id
      AND paddock.archived_at IS NULL
      AND paddock.deleted_at IS NULL
    ORDER BY paddock.name, paddock.id
  `).bind(normalizedFieldId, scope.organizationId, JSON.stringify(scope.fieldIds)).all<RotationQueryRow>();
  const rows = result.results;
  if (rows.length === 0) throwFieldScopeConflict("El fundo no existe o no está disponible.");

  const first = rows[0];
  const settings = settingsFromQuery(first);
  const inputs = rows.flatMap((row) => row.paddockId && row.paddockName ? [{
    id: row.paddockId,
    name: row.paddockName,
    grazingDates: parseStringArray(row.grazingDates),
    assignedLotCount: Number(row.assignedLotCount),
  }] : []);
  const overview = buildRotationOverview(inputs, {
    referenceDate: normalizedReferenceDate,
    recentDays: settings.recentDays,
    longRestDays: settings.longRestDays,
  });
  const paddocks = overview.paddocks.map(toRotationEntry);
  const byId = new Map(paddocks.map((paddock) => [paddock.paddockId, paddock]));
  const readyPaddocks = overview.readyPaddocks
    .map((paddock) => byId.get(paddock.paddockId))
    .filter((paddock): paddock is PaddockRotationEntry => Boolean(paddock));
  const snapshotInput = {
    fieldId: normalizedFieldId,
    referenceDate: normalizedReferenceDate,
    settings,
    paddocks: inputs,
  };
  return {
    fieldId: normalizedFieldId,
    referenceDate: normalizedReferenceDate,
    snapshotToken: `paddock-rotation-snapshot:v1:${await sha256(canonicalJson(snapshotInput))}`,
    settings,
    paddocks,
    readyPaddocks,
    banner: overview.summary,
    counts: overview.counts,
    sources: {
      grazingActivitiesOnly: true,
      activeAssignedLotsOnly: true,
      manualOverrideSupported: false,
    },
  };
}

export async function getPaddockRotationSettings(
  fieldId: string,
  scope: RotationScope,
): Promise<PaddockRotationSettings> {
  const normalizedFieldId = fieldId.trim();
  await assertFieldInScope(normalizedFieldId, scope);
  const [row] = await getDb()
    .select()
    .from(paddockRotationSettings)
    .where(eq(paddockRotationSettings.fieldId, normalizedFieldId))
    .limit(1);
  return row ? {
    fieldId: row.fieldId,
    recentDays: row.recentDays,
    longRestDays: row.longRestDays,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } : defaultRotationSettings(normalizedFieldId);
}

export async function updatePaddockRotationSettings(
  request: PaddockRotationSettingsUpdateRequest,
  scope: RotationScope,
): Promise<PaddockRotationSettingsOperationResult> {
  const normalized = normalizeSettingsRequest(request);
  const requestHash = `paddock-rotation-settings-request:v1:${await sha256(canonicalJson({
    fieldId: normalized.fieldId,
    recentDays: normalized.recentDays,
    longRestDays: normalized.longRestDays,
    expectedVersion: normalized.expectedVersion,
  }))}`;
  const existingOperation = await findSettingsOperation(normalized.operationId, scope);
  if (existingOperation) {
    if (existingOperation.requestHash !== requestHash) {
      throwFieldScopeConflict("El identificador del cambio de umbrales ya fue usado con otro contenido.");
    }
    return {
      operationId: existingOperation.id,
      requestHash,
      settings: existingOperation.result,
      idempotentReplay: true,
    };
  }

  const before = await getPaddockRotationSettings(normalized.fieldId, scope);
  if (before.version !== normalized.expectedVersion) {
    throwFieldScopeConflict("Los umbrales cambiaron desde la última carga.");
  }
  const committedAt = new Date().toISOString();
  const settings: PaddockRotationSettings = {
    fieldId: normalized.fieldId,
    recentDays: normalized.recentDays,
    longRestDays: normalized.longRestDays,
    version: (normalized.expectedVersion ?? 0) + 1,
    createdAt: before.createdAt ?? committedAt,
    updatedAt: committedAt,
  };
  const client = getDb().$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const auditId = `audit-paddock-rotation-settings-${normalized.operationId}`;
  const operationGuard = `EXISTS (
    SELECT 1 FROM paddock_rotation_setting_operations AS committed
    WHERE committed.id = ? AND committed.organization_id = ?
      AND committed.field_id = ? AND committed.request_hash = ?
  )`;
  const statements = [
    client.prepare(`
      INSERT INTO paddock_rotation_setting_operations (
        id, organization_id, field_id, request_hash, expected_version, result, actor, committed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ? AND current_field.organization_id = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM paddock_rotation_setting_operations AS existing_operation
          WHERE existing_operation.id = ?
        )
        AND (
          (? IS NULL AND NOT EXISTS (
            SELECT 1 FROM paddock_rotation_settings AS current_settings
            WHERE current_settings.field_id = ?
          ))
          OR
          (? IS NOT NULL AND EXISTS (
            SELECT 1 FROM paddock_rotation_settings AS current_settings
            WHERE current_settings.field_id = ? AND current_settings.version = ?
          ))
        )
    `).bind(
      normalized.operationId,
      scope.organizationId,
      normalized.fieldId,
      requestHash,
      normalized.expectedVersion,
      JSON.stringify(settings),
      scope.email ?? "unknown",
      committedAt,
      normalized.fieldId,
      scope.organizationId,
      fieldIdsJson,
      normalized.operationId,
      normalized.expectedVersion,
      normalized.fieldId,
      normalized.expectedVersion,
      normalized.fieldId,
      normalized.expectedVersion,
    ),
    client.prepare(`
      INSERT INTO paddock_rotation_settings (
        field_id, recent_days, long_rest_days, created_at, updated_at, version
      )
      SELECT ?, ?, ?, ?, ?, 1
      WHERE ? IS NULL AND ${operationGuard}
    `).bind(
      normalized.fieldId,
      normalized.recentDays,
      normalized.longRestDays,
      settings.createdAt,
      settings.updatedAt,
      normalized.expectedVersion,
      normalized.operationId,
      scope.organizationId,
      normalized.fieldId,
      requestHash,
    ),
    client.prepare(`
      UPDATE paddock_rotation_settings
      SET recent_days = ?, long_rest_days = ?, updated_at = ?, version = version + 1
      WHERE field_id = ? AND version = ? AND ? IS NOT NULL
        AND ${operationGuard}
    `).bind(
      normalized.recentDays,
      normalized.longRestDays,
      settings.updatedAt,
      normalized.fieldId,
      normalized.expectedVersion,
      normalized.expectedVersion,
      normalized.operationId,
      scope.organizationId,
      normalized.fieldId,
      requestHash,
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, occurred_at
      )
      SELECT ?, ?, ?, ?, 'paddock.rotation.settings.updated',
        'paddock_rotation_settings', ?, ?, ?, ?
      WHERE ${operationGuard}
    `).bind(
      auditId,
      scope.organizationId,
      normalized.fieldId,
      scope.email ?? "unknown",
      normalized.fieldId,
      before.version === null ? null : JSON.stringify(before),
      JSON.stringify({ ...settings, requestHash }),
      committedAt,
      normalized.operationId,
      scope.organizationId,
      normalized.fieldId,
      requestHash,
    ),
    client.prepare(`
      SELECT CASE WHEN
        ${operationGuard}
        AND EXISTS (
          SELECT 1 FROM paddock_rotation_settings AS saved
          WHERE saved.field_id = ? AND saved.recent_days = ? AND saved.long_rest_days = ?
            AND saved.created_at = ? AND saved.updated_at = ? AND saved.version = ?
        )
        AND EXISTS (
          SELECT 1 FROM audit_log AS operation_audit
          WHERE operation_audit.id = ? AND operation_audit.organization_id = ?
            AND operation_audit.field_id = ? AND operation_audit.entity_id = ?
        )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      normalized.operationId,
      scope.organizationId,
      normalized.fieldId,
      requestHash,
      normalized.fieldId,
      normalized.recentDays,
      normalized.longRestDays,
      settings.createdAt,
      settings.updatedAt,
      settings.version,
      auditId,
      scope.organizationId,
      normalized.fieldId,
      normalized.fieldId,
    ),
  ];

  try {
    await client.batch(statements);
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint|FOREIGN KEY constraint/i.test(cause.message)) {
      const raced = await findSettingsOperation(normalized.operationId, scope);
      if (raced?.requestHash === requestHash) {
        return { operationId: raced.id, requestHash, settings: raced.result, idempotentReplay: true };
      }
      throwFieldScopeConflict("Los umbrales cambiaron antes de confirmar la operación.");
    }
    throw cause;
  }
  return { operationId: normalized.operationId, requestHash, settings, idempotentReplay: false };
}

async function findSettingsOperation(operationId: string, scope: RotationScope) {
  const [row] = await getDb()
    .select()
    .from(paddockRotationSettingOperations)
    .where(and(
      eq(paddockRotationSettingOperations.id, operationId),
      eq(paddockRotationSettingOperations.organizationId, scope.organizationId),
      inArray(paddockRotationSettingOperations.fieldId, scope.fieldIds),
    ))
    .limit(1);
  return row ?? null;
}

function toRotationEntry(evaluation: ReturnType<typeof buildRotationOverview>["paddocks"][number]): PaddockRotationEntry {
  return {
    ...evaluation,
    effectiveStatus: evaluation.assignedLotCount > 0 ? "occupied" : "rest",
    statusSource: evaluation.assignedLotCount > 0
      ? "assigned_lots"
      : evaluation.lastGrazingAt ? "grazing_history" : "no_grazing_history",
    manualOverride: null,
  };
}

function settingsFromQuery(row: RotationQueryRow): PaddockRotationSettings {
  return {
    fieldId: row.fieldId,
    recentDays: Number(row.recentDays),
    longRestDays: Number(row.longRestDays),
    version: row.settingsVersion === null ? null : Number(row.settingsVersion),
    createdAt: row.settingsCreatedAt,
    updatedAt: row.settingsUpdatedAt,
  };
}

function defaultRotationSettings(fieldId: string): PaddockRotationSettings {
  return {
    fieldId,
    recentDays: DEFAULT_RECENT_DAYS,
    longRestDays: DEFAULT_LONG_REST_DAYS,
    version: null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeSettingsRequest(request: PaddockRotationSettingsUpdateRequest): PaddockRotationSettingsUpdateRequest {
  const fieldId = request.fieldId?.trim();
  const operationId = request.operationId?.trim();
  if (!fieldId) throw invalidRotation("Selecciona un fundo.");
  if (!operationId) throw invalidRotation("Falta el identificador estable del cambio.");
  if (
    !Number.isInteger(request.recentDays)
    || !Number.isInteger(request.longRestDays)
    || request.recentDays < 0
    || request.recentDays >= request.longRestDays
  ) {
    throw invalidRotation("Los umbrales deben ser días enteros y cumplir 0 ≤ reciente < descanso largo.");
  }
  if (request.expectedVersion !== null && (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1)) {
    throw invalidRotation("La versión esperada de los umbrales no es válida.");
  }
  return { ...request, fieldId, operationId };
}

function normalizeReferenceDate(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (!match) throw invalidRotation("La fecha de referencia no es válida.");
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const normalized = new Date(timestamp).toISOString().slice(0, 10);
  if (normalized !== trimmed) throw invalidRotation("La fecha de referencia no es válida.");
  return normalized;
}

function parseStringArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function invalidRotation(message: string): DomainRuleError {
  return new DomainRuleError(message || "La configuración de rotación no es válida.", "PADDOCK_ROTATION_INVALID");
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
