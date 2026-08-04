import { getDb } from "@/db";
import { fields, paddocks, scopedSubdivisionDrafts, subdivisionDrafts } from "@/db/schema";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ScopedSubdivisionDraft, SubdivisionDraft, SubdivisionScopeKind } from "../types";

type DraftResultRow = Omit<SubdivisionDraft, "history" | "line"> & {
  history: SubdivisionDraft["history"] | string;
  line: SubdivisionDraft["line"] | string;
};

function toSubdivisionDraft(row: DraftResultRow): SubdivisionDraft {
  return {
    fieldId: row.fieldId,
    history: typeof row.history === "string" ? JSON.parse(row.history) as SubdivisionDraft["history"] : row.history,
    line: typeof row.line === "string" ? JSON.parse(row.line) as SubdivisionDraft["line"] : row.line,
    updatedAt: row.updatedAt,
  };
}

type ScopedDraftResultRow = Omit<ScopedSubdivisionDraft, "history" | "line"> & {
  history: ScopedSubdivisionDraft["history"] | string;
  line: ScopedSubdivisionDraft["line"] | string;
};

function toScopedSubdivisionDraft(row: ScopedDraftResultRow): ScopedSubdivisionDraft {
  return {
    id: row.id,
    fieldId: row.fieldId,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    history: typeof row.history === "string" ? JSON.parse(row.history) as ScopedSubdivisionDraft["history"] : row.history,
    line: typeof row.line === "string" ? JSON.parse(row.line) as ScopedSubdivisionDraft["line"] : row.line,
    baseSnapshotToken: row.baseSnapshotToken,
    updatedAt: row.updatedAt,
  };
}

export async function subdivisionBaseSnapshotToken(
  fieldId: string,
  scopeKind: SubdivisionScopeKind,
  scopeId: string,
  scope: OrganizationFieldScope,
): Promise<string> {
  if (scope.fieldIds.length === 0) throwFieldScopeConflict("El fundo no está disponible.");
  const db = getDb();
  const [field] = await db.select().from(fields).where(and(
    eq(fields.id, fieldId),
    eq(fields.organizationId, scope.organizationId),
    inArray(fields.id, scope.fieldIds),
  )).limit(1);
  if (!field) throwFieldScopeConflict("El fundo no está disponible.");
  if (scopeKind === "field" && scopeId !== fieldId) throwFieldScopeConflict("El alcance del borrador no coincide con el fundo.");
  const rows = scopeKind === "field"
    ? await db.select().from(paddocks).where(and(eq(paddocks.fieldId, fieldId), isNull(paddocks.archivedAt), isNull(paddocks.deletedAt))).orderBy(asc(paddocks.id))
    : await db.select().from(paddocks).where(and(eq(paddocks.id, scopeId), eq(paddocks.fieldId, fieldId), isNull(paddocks.archivedAt), isNull(paddocks.deletedAt))).limit(1);
  if (scopeKind === "paddock" && rows.length !== 1) throwFieldScopeConflict("El potrero del borrador no está disponible.");
  const snapshot = {
    field: { id: field.id, name: field.name, location: field.location, areaHectares: field.areaHectares, coordinates: field.coordinates, createdAt: field.createdAt },
    paddocks: rows.map((row) => ({
      id: row.id, updatedAt: row.updatedAt, archivedAt: row.archivedAt, deletedAt: row.deletedAt, coordinates: row.coordinates,
    })),
  };
  return `subdivision-base-snapshot:v1:${await sha256(canonicalJson(snapshot))}`;
}

async function readScopedDraftRow(
  fieldId: string,
  scopeKind: SubdivisionScopeKind,
  scopeId: string,
  scope: OrganizationFieldScope,
): Promise<ScopedSubdivisionDraft | null> {
  if (scope.fieldIds.length === 0) return null;
  const [row] = await getDb().select({ draft: scopedSubdivisionDrafts })
    .from(scopedSubdivisionDrafts)
    .innerJoin(fields, eq(fields.id, scopedSubdivisionDrafts.fieldId))
    .where(and(
      eq(scopedSubdivisionDrafts.fieldId, fieldId),
      eq(scopedSubdivisionDrafts.scopeKind, scopeKind),
      eq(scopedSubdivisionDrafts.scopeId, scopeId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    )).limit(1);
  return row?.draft ? toScopedSubdivisionDraft(row.draft) : null;
}

export async function getScopedSubdivisionDraft(
  fieldId: string,
  scopeKind: SubdivisionScopeKind,
  scopeId: string,
  scope: OrganizationFieldScope,
): Promise<ScopedSubdivisionDraft | null> {
  const currentToken = await subdivisionBaseSnapshotToken(fieldId, scopeKind, scopeId, scope);
  const scoped = await readScopedDraftRow(fieldId, scopeKind, scopeId, scope);
  if (scoped) return scoped;
  if (scopeKind !== "field" || scopeId !== fieldId) return null;
  const legacy = await getSubdivisionDraft(fieldId, scope);
  return legacy ? {
    ...legacy,
    id: scopedDraftId(fieldId, scopeKind, scopeId),
    scopeKind,
    scopeId,
    baseSnapshotToken: currentToken,
  } : null;
}

export async function upsertScopedSubdivisionDraft(
  draft: ScopedSubdivisionDraft,
  expectedUpdatedAt: string | null | undefined,
  scope: OrganizationFieldScope,
): Promise<ScopedSubdivisionDraft> {
  const currentToken = await subdivisionBaseSnapshotToken(draft.fieldId, draft.scopeKind, draft.scopeId, scope);
  if (draft.baseSnapshotToken !== currentToken) {
    throwFieldScopeConflict("Los límites cambiaron desde que comenzaste el borrador.");
  }
  const existing = await readScopedDraftRow(draft.fieldId, draft.scopeKind, draft.scopeId, scope);
  if (existing && expectedUpdatedAt !== existing.updatedAt) throwFieldScopeConflict("El borrador cambió desde la última carga.");
  if (!existing && expectedUpdatedAt) {
    const legacy = draft.scopeKind === "field" && draft.scopeId === draft.fieldId
      ? await getSubdivisionDraft(draft.fieldId, scope)
      : null;
    if (!legacy || legacy.updatedAt !== expectedUpdatedAt) throwFieldScopeConflict("El borrador cambió desde la última carga.");
  }
  const updatedAt = new Date().toISOString();
  const id = draft.id?.trim() || scopedDraftId(draft.fieldId, draft.scopeKind, draft.scopeId);
  const client = getDb().$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const mutation = existing
    ? client.prepare(`
      UPDATE paddock_subdivision_drafts
      SET history = ?, line = ?, base_snapshot_token = ?, updated_at = ?
      WHERE id = ? AND field_id = ? AND scope_kind = ? AND scope_id = ?
        AND updated_at = ? AND base_snapshot_token = ?
        AND EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ? AND id IN (SELECT value FROM json_each(?)))
    `).bind(
      JSON.stringify(draft.history), JSON.stringify(draft.line), currentToken, updatedAt,
      existing.id, draft.fieldId, draft.scopeKind, draft.scopeId, existing.updatedAt, existing.baseSnapshotToken,
      draft.fieldId, scope.organizationId, fieldIdsJson,
    )
    : client.prepare(`
      INSERT INTO paddock_subdivision_drafts
        (id, field_id, scope_kind, scope_id, history, line, base_snapshot_token, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ? AND id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (
          SELECT 1 FROM paddock_subdivision_drafts WHERE field_id = ? AND scope_kind = ? AND scope_id = ?
        )
    `).bind(
      id, draft.fieldId, draft.scopeKind, draft.scopeId, JSON.stringify(draft.history), JSON.stringify(draft.line), currentToken, updatedAt,
      draft.fieldId, scope.organizationId, fieldIdsJson, draft.fieldId, draft.scopeKind, draft.scopeId,
    );
  const select = client.prepare(`
    SELECT id, field_id AS "fieldId", scope_kind AS "scopeKind", scope_id AS "scopeId",
      history, line, base_snapshot_token AS "baseSnapshotToken", updated_at AS "updatedAt"
    FROM paddock_subdivision_drafts
    WHERE id = ? AND field_id = ? AND scope_kind = ? AND scope_id = ? AND updated_at = ?
  `).bind(id, draft.fieldId, draft.scopeKind, draft.scopeId, updatedAt);
  const [mutationResult, selectResult] = await client.batch([mutation, select]);
  if (mutationResult.meta.changes !== 1) throwFieldScopeConflict("El borrador cambió antes de guardarse.");
  const saved = selectResult.results[0] as ScopedDraftResultRow | undefined;
  if (!saved) throwFieldScopeConflict("El borrador no pudo guardarse.");
  return toScopedSubdivisionDraft(saved);
}

export async function deleteScopedSubdivisionDraft(
  fieldId: string,
  scopeKind: SubdivisionScopeKind,
  scopeId: string,
  expectedUpdatedAt: string,
  scope: OrganizationFieldScope,
): Promise<boolean> {
  const existing = await readScopedDraftRow(fieldId, scopeKind, scopeId, scope);
  if (!existing) return false;
  if (existing.updatedAt !== expectedUpdatedAt) throwFieldScopeConflict("El borrador cambió desde la última carga.");
  const [result] = await getDb().$client.batch([getDb().$client.prepare(`
    DELETE FROM paddock_subdivision_drafts
    WHERE id = ? AND field_id = ? AND scope_kind = ? AND scope_id = ? AND updated_at = ?
      AND EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ? AND id IN (SELECT value FROM json_each(?)))
  `).bind(existing.id, fieldId, scopeKind, scopeId, expectedUpdatedAt, fieldId, scope.organizationId, JSON.stringify(scope.fieldIds))]);
  if (result.meta.changes !== 1) throwFieldScopeConflict("El borrador cambió antes de eliminarse.");
  return true;
}

export async function getSubdivisionDraft(
  fieldId: string,
  scope: OrganizationFieldScope,
): Promise<SubdivisionDraft | null> {
  if (scope.fieldIds.length === 0) return null;
  const [row] = await getDb()
    .select({ draft: subdivisionDrafts })
    .from(subdivisionDrafts)
    .innerJoin(fields, eq(fields.id, subdivisionDrafts.fieldId))
    .where(and(
      eq(subdivisionDrafts.fieldId, fieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  const draft = row?.draft;
  return draft ? toSubdivisionDraft(draft) : null;
}

export async function upsertSubdivisionDraft(
  draft: SubdivisionDraft,
  scope: OrganizationFieldScope,
): Promise<SubdivisionDraft> {
  if (scope.fieldIds.length === 0) throwFieldScopeConflict("El fundo no está disponible.");
  const db = getDb();
  const existing = await getSubdivisionDraft(draft.fieldId, scope);
  const client = db.$client;
  const updatedAt = new Date().toISOString();
  const historyJson = JSON.stringify(draft.history);
  const lineJson = JSON.stringify(draft.line);
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const mutation = existing
    ? client.prepare(`
      UPDATE subdivision_drafts
      SET history = ?, line = ?, updated_at = ?
      WHERE field_id = ?
        AND json(history) = json(?)
        AND json(line) = json(?)
        AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM fields
          WHERE id = subdivision_drafts.field_id
            AND organization_id = ?
            AND id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      historyJson,
      lineJson,
      updatedAt,
      draft.fieldId,
      JSON.stringify(existing.history),
      JSON.stringify(existing.line),
      existing.updatedAt,
      scope.organizationId,
      fieldIdsJson,
    )
    : client.prepare(`
      INSERT INTO subdivision_drafts (field_id, history, line, updated_at)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM fields
        WHERE id = ?
          AND organization_id = ?
          AND id IN (SELECT value FROM json_each(?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM subdivision_drafts AS concurrent_draft WHERE concurrent_draft.field_id = ?
        )
    `).bind(
      draft.fieldId,
      historyJson,
      lineJson,
      updatedAt,
      draft.fieldId,
      scope.organizationId,
      fieldIdsJson,
      draft.fieldId,
    );
  const selectSaved = client.prepare(`
    SELECT
      saved_draft.field_id AS "fieldId",
      saved_draft.history,
      saved_draft.line,
      saved_draft.updated_at AS "updatedAt"
    FROM subdivision_drafts AS saved_draft
    INNER JOIN fields AS current_field ON current_field.id = saved_draft.field_id
    WHERE saved_draft.field_id = ?
      AND saved_draft.updated_at = ?
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
  `).bind(draft.fieldId, updatedAt, scope.organizationId, fieldIdsJson);
  const [mutationResult, savedResult] = await client.batch([mutation, selectSaved]);
  if (mutationResult.meta.changes !== 1) throwFieldScopeConflict("El fundo ya no está disponible.");
  const saved = savedResult.results[0] as DraftResultRow | undefined;
  if (!saved) throwFieldScopeConflict("El fundo ya no está disponible.");
  return toSubdivisionDraft(saved);
}

export async function deleteSubdivisionDraft(
  fieldId: string,
  scope: OrganizationFieldScope,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const existing = await getSubdivisionDraft(fieldId, scope);
  if (!existing) return false;
  const [result] = await db.$client.batch([db.$client.prepare(`
    DELETE FROM subdivision_drafts
    WHERE field_id = ?
      AND json(history) = json(?)
      AND json(line) = json(?)
      AND updated_at = ?
      AND EXISTS (
        SELECT 1
        FROM fields
        WHERE id = subdivision_drafts.field_id
          AND organization_id = ?
          AND id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    fieldId,
    JSON.stringify(existing.history),
    JSON.stringify(existing.line),
    existing.updatedAt,
    scope.organizationId,
    JSON.stringify(scope.fieldIds),
  )]);
  return result.meta.changes > 0;
}

function scopedDraftId(fieldId: string, scopeKind: SubdivisionScopeKind, scopeId: string) {
  return `subdivision-draft:${fieldId}:${scopeKind}:${scopeId}`;
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
