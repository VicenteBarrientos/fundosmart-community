import { getDb } from "@/db";
import { activities, fields, livestockLots, paddocks } from "@/db/schema";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import {
  PADDOCK_LIMIT_MESSAGE,
  paddockLimitWouldBeExceeded,
} from "@/src/modules/access/server/organization-plan-repository";
import {
  SyncWriteAccessRevokedError,
  syncWriteAccessCondition,
} from "@/src/modules/sync/server/sync-write-access";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Activity, Fundo, PolygonRings, Potrero } from "../types";
import { calculateGrossHectares, calculateNetHectares } from "../utils/geometry";
import { assertAlignedHoleKinds, decodeStoredPolygon, encodeStoredPolygon, PolygonRingsError } from "../utils/polygon-rings";
import { toFundo } from "./fundo-repository";
import { commitLegacyPaddockRedesign } from "./paddock-operation-repository";

type PaddockRow = typeof paddocks.$inferSelect;
type PaddockResultRow = Omit<PaddockRow, "coordinates" | "holeKinds"> & {
  coordinates: PaddockRow["coordinates"] | string;
  holeKinds: PaddockRow["holeKinds"] | string;
};

type ReplacementSnapshot = {
  field: typeof fields.$inferSelect;
  paddocks: Array<typeof paddocks.$inferSelect>;
  activities: Array<typeof activities.$inferSelect>;
  lots: Array<typeof livestockLots.$inferSelect>;
};

export type PotreroReplacementPreview = {
  snapshotToken: string;
  fundo: Fundo;
  potreros: Potrero[];
  activities: Activity[];
  assignedLotCount: number;
};

export type LinkedFieldBoundaryResult = {
  fundo: Fundo;
  potreros: Potrero[];
};

export type PaddockGeometrySyncMarker = {
  mutationId: string;
  eventPayload: {
    projection: { kind: "paddock_geometry"; paddocks: Potrero[] };
    source: "map" | "gps";
    capturedAt: string;
    resolution?: PaddockGeometryResolution;
  };
};

export type PaddockGeometryResolution = {
  policy: "paddock-geometry-lww-v1";
  disposition: "version-match" | "newer-client" | "already-current";
  clientTs: string;
  comparedClientTs: string | null;
  replacedVersion: string;
};

type PaddockGeometrySyncMarkerInput = {
  mutationId: string;
  actor: AccessContext;
  entityId: string;
  source: "map" | "gps";
  capturedAt: string;
  resolution: PaddockGeometryResolution;
};

function toPotrero(row: PaddockResultRow): Potrero {
  const geometry = decodeStoredPolygon(row.coordinates);
  const holeKinds = typeof row.holeKinds === "string" ? JSON.parse(row.holeKinds) as PaddockRow["holeKinds"] : row.holeKinds;
  assertAlignedHoleKinds(geometry.holes, holeKinds);
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
    holeKinds,
    soil: {
      ph: row.soilPh,
      nitrogen: row.soilNitrogen,
      phosphorus: row.soilPhosphorus,
      potassium: row.soilPotassium,
    },
    lastActivity: row.lastActivity,
    status: row.status,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
    createdByOperationId: row.createdByOperationId,
    archivedByOperationId: row.archivedByOperationId,
  };
}

function toRow(potrero: Potrero, existing?: PaddockRow): typeof paddocks.$inferInsert {
  let geometry: PolygonRings;
  try {
    const requestedGeometry = potrero.geometry ?? potrero.coordinates;
    geometry = encodeStoredPolygon(decodeStoredPolygon(requestedGeometry));
  } catch (cause) {
    const message = cause instanceof PolygonRingsError ? cause.message : "La geometría del potrero no es válida.";
    throwFieldScopeConflict(message);
  }
  const existingGeometry = existing ? decodeStoredPolygon(existing.coordinates) : null;
  if (!potrero.geometry && existingGeometry && existingGeometry.holes.length > 0) {
    throwFieldScopeConflict("La edición debe incluir la geometría canónica para no perder sus exclusiones.");
  }
  const existingHoleKinds = existing?.holeKinds ?? [];
  const holeKinds = potrero.holeKinds ?? (existingGeometry?.holes.length === geometry.holes.length ? existingHoleKinds : []);
  try {
    assertAlignedHoleKinds(geometry.holes, holeKinds);
  } catch (cause) {
    throwFieldScopeConflict(cause instanceof Error ? cause.message : "Los tipos de exclusión no son válidos.");
  }
  const grossAreaHectares = calculateGrossHectares(geometry);
  const netAreaHectares = calculateNetHectares(geometry);
  const grazeableAreaHectares = potrero.grazeableAreaHectares === undefined
    ? existing?.grazeableAreaHectares ?? null
    : potrero.grazeableAreaHectares;
  if (
    grazeableAreaHectares !== null
    && (!Number.isFinite(grazeableAreaHectares) || grazeableAreaHectares < 0 || grazeableAreaHectares > netAreaHectares)
  ) {
    throwFieldScopeConflict("La superficie pastoreable debe estar entre 0 y la superficie neta del potrero.");
  }
  return {
    id: potrero.id,
    fieldId: potrero.fieldId,
    name: potrero.name,
    sector: potrero.sector,
    areaHectares: grossAreaHectares,
    coordinates: geometry,
    grazeableAreaHectares,
    landUse: potrero.landUse ?? existing?.landUse ?? "pradera_permanente",
    holeKinds,
    soilPh: potrero.soil.ph,
    soilNitrogen: potrero.soil.nitrogen,
    soilPhosphorus: potrero.soil.phosphorus,
    soilPotassium: potrero.soil.potassium,
    lastActivity: potrero.lastActivity,
    status: potrero.status,
    updatedAt: new Date().toISOString(),
  };
}

function samePotreroPayload(row: PaddockResultRow, values: typeof paddocks.$inferInsert): boolean {
  return JSON.stringify([
    row.fieldId,
    row.name,
    row.sector,
    row.areaHectares,
    row.coordinates,
    row.soilPh,
    row.soilNitrogen,
    row.soilPhosphorus,
    row.soilPotassium,
    row.lastActivity,
    row.status,
    row.grazeableAreaHectares,
    row.landUse,
    row.holeKinds,
  ]) === JSON.stringify([
    values.fieldId,
    values.name,
    values.sector,
    values.areaHectares,
    values.coordinates,
    values.soilPh,
    values.soilNitrogen,
    values.soilPhosphorus,
    values.soilPotassium,
    values.lastActivity,
    values.status,
    values.grazeableAreaHectares,
    values.landUse,
    values.holeKinds,
  ]);
}

function toReplacementActivity(row: typeof activities.$inferSelect): Activity {
  return {
    id: row.id,
    potreroId: row.paddockId,
    type: row.type,
    occurredAt: row.occurredAt,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    costClp: row.costClp,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function readReplacementSnapshot(
  fundoId: string,
  scope: OrganizationFieldScope,
): Promise<ReplacementSnapshot> {
  const db = getDb();
  const [field] = await db
    .select()
    .from(fields)
    .where(and(
      eq(fields.id, fundoId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!field) throwFieldScopeConflict("El fundo ya no está disponible para reemplazar sus potreros.");

  const paddockRows = await db
    .select()
    .from(paddocks)
    .where(and(eq(paddocks.fieldId, fundoId), isNull(paddocks.deletedAt), isNull(paddocks.archivedAt)))
    .orderBy(asc(paddocks.id));
  const activityRows = await db
    .select({ activity: activities })
    .from(activities)
    .innerJoin(paddocks, eq(paddocks.id, activities.paddockId))
    .where(and(
      eq(paddocks.fieldId, fundoId),
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
      isNull(activities.deletedAt),
    ))
    .orderBy(asc(activities.id));
  const lotRows = await db
    .select({ lot: livestockLots })
    .from(livestockLots)
    .innerJoin(paddocks, eq(paddocks.id, livestockLots.paddockId))
    .where(and(eq(paddocks.fieldId, fundoId), isNull(paddocks.deletedAt), isNull(paddocks.archivedAt)))
    .orderBy(asc(livestockLots.id));

  return {
    field,
    paddocks: paddockRows,
    activities: activityRows.map(({ activity }) => activity),
    lots: lotRows.map(({ lot }) => lot),
  };
}

async function replacementSnapshotToken(snapshot: ReplacementSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `paddock-replacement:v1:${hex}`;
}

export async function getPotreroReplacementPreview(
  fundoId: string,
  scope: OrganizationFieldScope,
): Promise<PotreroReplacementPreview> {
  await assertFieldInScope(fundoId, scope);
  const snapshot = await readReplacementSnapshot(fundoId, scope);
  return {
    snapshotToken: await replacementSnapshotToken(snapshot),
    fundo: await toFundo(snapshot.field),
    potreros: snapshot.paddocks.map(toPotrero),
    activities: snapshot.activities.map(toReplacementActivity),
    assignedLotCount: snapshot.lots.length,
  };
}

export async function listPotreros(scope: OrganizationFieldScope, fundoId?: string): Promise<Potrero[]> {
  if (scope.fieldIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ paddock: paddocks })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      fundoId ? eq(paddocks.fieldId, fundoId) : undefined,
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
    ))
    .orderBy(asc(paddocks.fieldId), asc(paddocks.name));
  return rows.map(({ paddock }) => toPotrero(paddock));
}

export async function listArchivedPotreros(scope: OrganizationFieldScope, fundoId: string): Promise<Potrero[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ paddock: paddocks })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(paddocks.fieldId, fundoId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddocks.deletedAt),
      isNotNull(paddocks.archivedAt),
    ))
    .orderBy(asc(paddocks.archivedAt), asc(paddocks.name));
  return rows.map(({ paddock }) => toPotrero(paddock));
}

export async function upsertPotrero(potrero: Potrero, scope: OrganizationFieldScope): Promise<Potrero> {
  await assertFieldInScope(potrero.fieldId, scope);
  const db = getDb();
  const [existing] = await db
    .select()
    .from(paddocks)
    .where(eq(paddocks.id, potrero.id))
    .limit(1);
  if (existing) {
    await assertFieldInScope(existing.fieldId, scope, "El identificador del potrero no está disponible.");
    if (existing.deletedAt) {
      throwFieldScopeConflict("El potrero fue eliminado y no puede volver a crearse con el mismo identificador.");
    }
    if (existing.archivedAt) {
      throwFieldScopeConflict("El potrero fue archivado y no puede volver a activarse mediante una edición normal.");
    }
    if (potrero.updatedAt && potrero.updatedAt !== existing.updatedAt) {
      throwFieldScopeConflict("El potrero cambió desde la última carga.");
    }
  }
  const values = toRow(potrero, existing);
  if (existing) {
    if (!potrero.updatedAt && samePotreroPayload(existing, values)) return toPotrero(existing);
    if (!potrero.updatedAt) {
      throwFieldScopeConflict("El potrero cambió desde la última carga.");
    }
  }

  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const coordinatesJson = JSON.stringify(values.coordinates);
  const client = db.$client;
  const mutation = existing
    ? client.prepare(`
      UPDATE potreros
      SET field_id = ?, name = ?, sector = ?, area_hectares = ?, coordinates = ?,
        grazeable_area_hectares = ?, land_use = ?, hole_kinds = ?,
        soil_ph = ?, soil_nitrogen = ?, soil_phosphorus = ?, soil_potassium = ?,
        last_activity = ?, status = ?, updated_at = ?
      WHERE id = ?
        AND field_id = ?
        AND name = ?
        AND sector = ?
        AND area_hectares = ?
        AND coordinates = ?
        AND grazeable_area_hectares IS ?
        AND land_use = ?
        AND json(hole_kinds) = json(?)
        AND soil_ph IS ?
        AND soil_nitrogen IS ?
        AND soil_phosphorus IS ?
        AND soil_potassium IS ?
        AND last_activity = ?
        AND status = ?
        AND created_at = ?
        AND updated_at = ?
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM fields AS source_field
          WHERE source_field.id = potreros.field_id
            AND source_field.organization_id = ?
            AND source_field.id IN (SELECT value FROM json_each(?))
        )
        AND EXISTS (
          SELECT 1 FROM fields AS target_field
          WHERE target_field.id = ?
            AND target_field.organization_id = ?
            AND target_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      values.fieldId,
      values.name,
      values.sector,
      values.areaHectares,
      coordinatesJson,
      values.grazeableAreaHectares,
      values.landUse,
      JSON.stringify(values.holeKinds),
      values.soilPh,
      values.soilNitrogen,
      values.soilPhosphorus,
      values.soilPotassium,
      values.lastActivity,
      values.status,
      values.updatedAt,
      existing.id,
      existing.fieldId,
      existing.name,
      existing.sector,
      existing.areaHectares,
      JSON.stringify(existing.coordinates),
      existing.grazeableAreaHectares,
      existing.landUse,
      JSON.stringify(existing.holeKinds),
      existing.soilPh,
      existing.soilNitrogen,
      existing.soilPhosphorus,
      existing.soilPotassium,
      existing.lastActivity,
      existing.status,
      existing.createdAt,
      existing.updatedAt,
      scope.organizationId,
      fieldIdsJson,
      values.fieldId,
      scope.organizationId,
      fieldIdsJson,
    )
    : client.prepare(`
      INSERT INTO potreros (
        id, field_id, name, sector, area_hectares, coordinates,
        grazeable_area_hectares, land_use, hole_kinds,
        soil_ph, soil_nitrogen, soil_phosphorus, soil_potassium,
        last_activity, status, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM potreros AS conflicting_paddock WHERE conflicting_paddock.id = ?
      )
        AND EXISTS (
          SELECT 1 FROM fields AS target_field
          WHERE target_field.id = ?
            AND target_field.organization_id = ?
            AND target_field.id IN (SELECT value FROM json_each(?))
        )
        AND EXISTS (
          SELECT 1 FROM organizations AS current_organization
          WHERE current_organization.id = ?
            AND (
              current_organization.paddock_limit IS NULL
              OR (
                SELECT COUNT(*)
                FROM potreros AS active_paddock
                INNER JOIN fields AS active_field ON active_field.id = active_paddock.field_id
                WHERE active_field.organization_id = current_organization.id
                  AND active_paddock.archived_at IS NULL
                  AND active_paddock.deleted_at IS NULL
              ) < current_organization.paddock_limit
            )
        )
    `).bind(
      values.id,
      values.fieldId,
      values.name,
      values.sector,
      values.areaHectares,
      coordinatesJson,
      values.grazeableAreaHectares,
      values.landUse,
      JSON.stringify(values.holeKinds),
      values.soilPh,
      values.soilNitrogen,
      values.soilPhosphorus,
      values.soilPotassium,
      values.lastActivity,
      values.status,
      values.updatedAt,
      values.id,
      values.fieldId,
      scope.organizationId,
      fieldIdsJson,
      scope.organizationId,
    );
  const selectSaved = client.prepare(`
    SELECT
      paddock.id,
      paddock.field_id AS "fieldId",
      paddock.name,
      paddock.sector,
      paddock.area_hectares AS "areaHectares",
      paddock.coordinates,
      paddock.grazeable_area_hectares AS "grazeableAreaHectares",
      paddock.land_use AS "landUse",
      paddock.hole_kinds AS "holeKinds",
      paddock.soil_ph AS "soilPh",
      paddock.soil_nitrogen AS "soilNitrogen",
      paddock.soil_phosphorus AS "soilPhosphorus",
      paddock.soil_potassium AS "soilPotassium",
      paddock.last_activity AS "lastActivity",
      paddock.status,
      paddock.created_at AS "createdAt",
      paddock.updated_at AS "updatedAt"
    FROM potreros AS paddock
    INNER JOIN fields AS current_field ON current_field.id = paddock.field_id
    WHERE paddock.id = ?
      AND paddock.field_id = ?
      AND paddock.deleted_at IS NULL
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
  `).bind(values.id, values.fieldId, scope.organizationId, fieldIdsJson);
  const [mutationResult, savedResult] = await client.batch([mutation, selectSaved]);
  if (mutationResult.meta.changes !== 1) {
    if (!existing && await paddockLimitWouldBeExceeded(scope.organizationId, 1)) {
      throw new DomainRuleError(PADDOCK_LIMIT_MESSAGE, "PLAN_PADDOCK_LIMIT_REACHED");
    }
    throwFieldScopeConflict("El identificador del potrero no está disponible.");
  }
  const saved = savedResult.results[0] as PaddockResultRow | undefined;
  if (!saved) throwFieldScopeConflict("El identificador del potrero no está disponible.");
  return toPotrero(saved);
}

export async function deletePotrero(
  potreroId: string,
  scope: OrganizationFieldScope,
  expectedUpdatedAt: string,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existing] = await db
    .select({ paddock: paddocks })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      eq(paddocks.id, potreroId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!existing) return false;
  if (existing.paddock.deletedAt || existing.paddock.archivedAt) return true;
  if (existing.paddock.updatedAt !== expectedUpdatedAt) {
    throwFieldScopeConflict("El potrero cambió desde la última carga.");
  }

  const client = db.$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const archivedAt = new Date().toISOString();
  const paddock = existing.paddock;
  const [result] = await client.batch([client.prepare(`
    UPDATE potreros
    SET archived_at = ?, archive_reason = 'manual', archived_by_operation_id = NULL, updated_at = ?
    WHERE id = ?
      AND field_id = ?
      AND name = ?
      AND sector = ?
      AND area_hectares = ?
      AND coordinates = ?
      AND grazeable_area_hectares IS ?
      AND land_use = ?
      AND json(hole_kinds) = json(?)
      AND soil_ph IS ?
      AND soil_nitrogen IS ?
      AND soil_phosphorus IS ?
      AND soil_potassium IS ?
      AND last_activity = ?
      AND status = ?
      AND created_at = ?
      AND updated_at = ?
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = potreros.field_id
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    archivedAt,
    archivedAt,
    paddock.id,
    paddock.fieldId,
    paddock.name,
    paddock.sector,
    paddock.areaHectares,
    JSON.stringify(paddock.coordinates),
    paddock.grazeableAreaHectares,
    paddock.landUse,
    JSON.stringify(paddock.holeKinds),
    paddock.soilPh,
    paddock.soilNitrogen,
    paddock.soilPhosphorus,
    paddock.soilPotassium,
    paddock.lastActivity,
    paddock.status,
    paddock.createdAt,
    paddock.updatedAt,
    scope.organizationId,
    fieldIdsJson,
  )]);

  return result.meta.changes > 0;
}

export async function replacePotrerosForFundo(
  fundoId: string,
  replacements: Potrero[],
  scope: OrganizationFieldScope,
  expectedSnapshotToken: string,
): Promise<Potrero[]> {
  await assertFieldInScope(fundoId, scope);
  if (replacements.some((potrero) => potrero.fieldId !== fundoId)) {
    throwFieldScopeConflict("Una subdivisión no pertenece al fundo autorizado.");
  }
  const snapshot = await readReplacementSnapshot(fundoId, scope);
  if (await replacementSnapshotToken(snapshot) !== expectedSnapshotToken) {
    throwFieldScopeConflict("Los potreros o sus dependencias cambiaron desde la confirmación.");
  }
  return commitLegacyPaddockRedesign(fundoId, replacements, scope);
}

export async function updatePotreroBoundaries(
  updates: Potrero[],
  scope: OrganizationFieldScope,
  syncMarker?: PaddockGeometrySyncMarkerInput,
): Promise<Potrero[]> {
  if (updates.length === 0) return [];
  const db = getDb();
  const requestedIds = [...new Set(updates.map((potrero) => potrero.id))];
  if (requestedIds.length !== updates.length || scope.fieldIds.length === 0) {
    throwFieldScopeConflict("Uno de los potreros no está disponible.");
  }
  const scoped = await db
    .select({ paddock: paddocks })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      inArray(paddocks.id, requestedIds),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
    ));
  if (scoped.length !== requestedIds.length) {
    throwFieldScopeConflict("Uno de los potreros no está disponible.");
  }
  const requestedById = new Map(updates.map((potrero) => [potrero.id, potrero]));
  if (scoped.some(({ paddock }) => requestedById.get(paddock.id)?.updatedAt !== paddock.updatedAt)) {
    throwFieldScopeConflict("Uno de los potreros cambió desde la última carga.");
  }
  const client = db.$client;
  const updatedAt = new Date().toISOString();
  const snapshotsById = new Map(scoped.map(({ paddock }) => [paddock.id, paddock]));
  const requested = JSON.stringify(updates.map((potrero) => {
    const existing = snapshotsById.get(potrero.id)!;
    const existingPotrero = toPotrero(existing);
    const values = toRow({
      ...existingPotrero,
      ...potrero,
      geometry: potrero.geometry,
      soil: potrero.soil ?? existingPotrero.soil,
    }, existing);
    return {
      id: potrero.id,
      areaHectares: values.areaHectares,
      coordinates: values.coordinates,
      grazeableAreaHectares: values.grazeableAreaHectares,
      landUse: values.landUse,
      holeKinds: values.holeKinds,
      expected: existing,
    };
  }));
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const syncAccess = syncMarker
    ? syncWriteAccessCondition(syncMarker.actor, updates[0]!.fieldId)
    : null;
  const mutation = client.prepare(`
      UPDATE potreros
      SET
        area_hectares = (
          SELECT CAST(json_extract(request.value, '$.areaHectares') AS REAL)
          FROM json_each(input.payload) AS request
          WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
        ),
        coordinates = (
          SELECT json_extract(request.value, '$.coordinates')
          FROM json_each(input.payload) AS request
          WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
        ),
        grazeable_area_hectares = (
          SELECT json_extract(request.value, '$.grazeableAreaHectares')
          FROM json_each(input.payload) AS request
          WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
        ),
        land_use = (
          SELECT CAST(json_extract(request.value, '$.landUse') AS TEXT)
          FROM json_each(input.payload) AS request
          WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
        ),
        hole_kinds = (
          SELECT json_extract(request.value, '$.holeKinds')
          FROM json_each(input.payload) AS request
          WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
        ),
        updated_at = ?
      FROM (SELECT ? AS payload) AS input
      WHERE id IN (
        SELECT CAST(json_extract(request.value, '$.id') AS TEXT)
        FROM json_each(input.payload) AS request
      )
        AND (
          SELECT COUNT(*)
          FROM json_each(input.payload) AS request
          INNER JOIN potreros AS candidate
            ON candidate.id = CAST(json_extract(request.value, '$.id') AS TEXT)
          INNER JOIN fields AS scoped_field ON scoped_field.id = candidate.field_id
          WHERE scoped_field.organization_id = ?
            AND scoped_field.id IN (SELECT value FROM json_each(?))
            AND candidate.field_id = CAST(json_extract(request.value, '$.expected.fieldId') AS TEXT)
            AND candidate.deleted_at IS NULL
            AND candidate.archived_at IS NULL
            AND candidate.name = CAST(json_extract(request.value, '$.expected.name') AS TEXT)
            AND candidate.sector = CAST(json_extract(request.value, '$.expected.sector') AS TEXT)
            AND candidate.area_hectares = CAST(json_extract(request.value, '$.expected.areaHectares') AS REAL)
            AND json(candidate.coordinates) = json(json_extract(request.value, '$.expected.coordinates'))
            AND candidate.grazeable_area_hectares IS json_extract(request.value, '$.expected.grazeableAreaHectares')
            AND candidate.land_use = CAST(json_extract(request.value, '$.expected.landUse') AS TEXT)
            AND json(candidate.hole_kinds) = json(json_extract(request.value, '$.expected.holeKinds'))
            AND candidate.soil_ph IS json_extract(request.value, '$.expected.soilPh')
            AND candidate.soil_nitrogen IS json_extract(request.value, '$.expected.soilNitrogen')
            AND candidate.soil_phosphorus IS json_extract(request.value, '$.expected.soilPhosphorus')
            AND candidate.soil_potassium IS json_extract(request.value, '$.expected.soilPotassium')
            AND candidate.last_activity = CAST(json_extract(request.value, '$.expected.lastActivity') AS TEXT)
            AND candidate.status = CAST(json_extract(request.value, '$.expected.status') AS TEXT)
            AND candidate.created_at = CAST(json_extract(request.value, '$.expected.createdAt') AS TEXT)
            AND candidate.updated_at = CAST(json_extract(request.value, '$.expected.updatedAt') AS TEXT)
        ) = json_array_length(input.payload)
        AND ${syncAccess?.sql ?? "1 = 1"}
    `).bind(
      updatedAt,
      requested,
      scope.organizationId,
      fieldIdsJson,
      ...(syncAccess?.bindings ?? []),
    );
  const selectSaved = client.prepare(`
    SELECT
      paddock.id,
      paddock.field_id AS "fieldId",
      paddock.name,
      paddock.sector,
      paddock.area_hectares AS "areaHectares",
      paddock.coordinates,
      paddock.grazeable_area_hectares AS "grazeableAreaHectares",
      paddock.land_use AS "landUse",
      paddock.hole_kinds AS "holeKinds",
      paddock.soil_ph AS "soilPh",
      paddock.soil_nitrogen AS "soilNitrogen",
      paddock.soil_phosphorus AS "soilPhosphorus",
      paddock.soil_potassium AS "soilPotassium",
      paddock.last_activity AS "lastActivity",
      paddock.status,
      paddock.created_at AS "createdAt",
      paddock.updated_at AS "updatedAt"
    FROM json_each(?) AS request
    INNER JOIN potreros AS paddock
      ON paddock.id = CAST(json_extract(request.value, '$.id') AS TEXT)
    INNER JOIN fields AS current_field ON current_field.id = paddock.field_id
    WHERE paddock.updated_at = ?
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
      AND paddock.deleted_at IS NULL
      AND paddock.archived_at IS NULL
    ORDER BY CAST(request.key AS INTEGER)
  `).bind(requested, updatedAt, scope.organizationId, fieldIdsJson);
  const markerId = syncMarker ? `audit:geo:${syncMarker.mutationId}` : null;
  const markerPayload = syncMarker ? JSON.stringify({
    mutationId: syncMarker.mutationId,
    eventPayload: {
      projection: {
        kind: "paddock_geometry",
        paddocks: updates.map((paddock) => ({ ...paddock, updatedAt })),
      },
      source: syncMarker.source,
      capturedAt: syncMarker.capturedAt,
      resolution: syncMarker.resolution,
    },
  } satisfies PaddockGeometrySyncMarker) : null;
  const marker = syncMarker ? client.prepare(`
    INSERT OR IGNORE INTO audit_log
      (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
    SELECT ?, ?, ?, ?, 'sync.paddock_geometry.projected', 'paddock_geometry', ?, NULL, ?, ?
    WHERE (
      SELECT COUNT(*) FROM potreros AS projected
      WHERE projected.id IN (SELECT CAST(json_extract(value, '$.id') AS TEXT) FROM json_each(?))
        AND projected.field_id = ?
        AND projected.updated_at = ?
        AND projected.deleted_at IS NULL
        AND projected.archived_at IS NULL
    ) = ?
      AND ${syncAccess!.sql}
  `).bind(
    markerId,
    scope.organizationId,
    updates[0]!.fieldId,
    syncMarker.actor.email,
    syncMarker.entityId,
    markerPayload,
    updatedAt,
    requested,
    updates[0]!.fieldId,
    updatedAt,
    updates.length,
    ...syncAccess!.bindings,
  ) : null;
  const authorization = syncAccess ? client.prepare(`
    SELECT CASE WHEN ${syncAccess.sql} THEN 1 ELSE 0 END AS authorized
  `).bind(...syncAccess.bindings) : null;
  const results = await client.batch(
    marker && authorization
      ? [mutation, marker, selectSaved, authorization]
      : [mutation, selectSaved],
  );
  const mutationResult = results[0]!;
  const markerResult = marker ? results[1]! : null;
  const savedResult = results[marker ? 2 : 1]!;
  if (authorization) {
    const accessResult = results[3]?.results[0] as { authorized?: number } | undefined;
    if (Number(accessResult?.authorized) !== 1) throw new SyncWriteAccessRevokedError();
  }
  if (mutationResult.meta.changes !== updates.length) {
    throwFieldScopeConflict("Uno de los potreros cambió de alcance antes de guardar los límites.");
  }
  if (marker && markerResult?.meta.changes !== 1) {
    throwFieldScopeConflict("No fue posible cerrar la marca idempotente de la geometría.");
  }
  const saved = savedResult.results as PaddockResultRow[];
  if (saved.length !== updates.length) {
    throwFieldScopeConflict("Uno de los potreros cambió antes de confirmar los límites.");
  }
  return saved.map(toPotrero);
}

/**
 * Persists a field boundary and every attached paddock boundary in one D1
 * batch. The paddock mutation is guarded by both snapshots and the following
 * field mutation is guarded by the batch timestamp written to every paddock,
 * so a stale field or paddock leaves both resources unchanged.
 */
export async function updateLinkedFieldBoundary(
  fundo: Fundo,
  updates: Potrero[],
  scope: OrganizationFieldScope,
): Promise<LinkedFieldBoundaryResult> {
  if (updates.length === 0 || scope.fieldIds.length === 0) {
    throwFieldScopeConflict("No hay potreros vinculados disponibles para actualizar.");
  }
  if (
    !fundo.id?.trim()
    || !fundo.snapshotToken?.trim()
    || !Array.isArray(fundo.coordinates)
    || fundo.coordinates.length < 3
    || !Number.isFinite(fundo.areaHectares)
    || fundo.areaHectares <= 0
  ) {
    throwFieldScopeConflict("El límite del fundo no es válido.");
  }

  const requestedIds = [...new Set(updates.map((potrero) => potrero.id))];
  if (
    requestedIds.length !== updates.length
    || updates.some((potrero) => potrero.fieldId !== fundo.id)
  ) {
    throwFieldScopeConflict("Uno de los potreros no pertenece al fundo.");
  }

  const db = getDb();
  const [existingField] = await db
    .select()
    .from(fields)
    .where(and(
      eq(fields.id, fundo.id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!existingField) throwFieldScopeConflict("El fundo ya no está disponible.");
  const currentFundo = await toFundo(existingField);
  if (currentFundo.snapshotToken !== fundo.snapshotToken) {
    throwFieldScopeConflict("El fundo cambió desde la última carga.");
  }

  const scoped = await db
    .select({ paddock: paddocks })
    .from(paddocks)
    .innerJoin(fields, eq(fields.id, paddocks.fieldId))
    .where(and(
      inArray(paddocks.id, requestedIds),
      eq(paddocks.fieldId, fundo.id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
    ));
  if (scoped.length !== requestedIds.length) {
    throwFieldScopeConflict("Uno de los potreros no está disponible.");
  }

  const requestedById = new Map(updates.map((potrero) => [potrero.id, potrero]));
  if (scoped.some(({ paddock }) => requestedById.get(paddock.id)?.updatedAt !== paddock.updatedAt)) {
    throwFieldScopeConflict("Uno de los potreros cambió desde la última carga.");
  }

  const snapshotsById = new Map(scoped.map(({ paddock }) => [paddock.id, paddock]));
  const requested = JSON.stringify(updates.map((potrero) => {
    const existing = snapshotsById.get(potrero.id)!;
    const existingPotrero = toPotrero(existing);
    const values = toRow({
      ...existingPotrero,
      ...potrero,
      geometry: potrero.geometry,
      soil: potrero.soil ?? existingPotrero.soil,
    }, existing);
    return {
      id: potrero.id,
      areaHectares: values.areaHectares,
      coordinates: values.coordinates,
      grazeableAreaHectares: values.grazeableAreaHectares,
      landUse: values.landUse,
      holeKinds: values.holeKinds,
      expected: existing,
    };
  }));
  const updatedAt = nextLinkedBoundaryTimestamp(scoped.map(({ paddock }) => paddock.updatedAt));
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const fieldCoordinatesJson = JSON.stringify(fundo.coordinates);
  const existingFieldCoordinatesJson = JSON.stringify(existingField.coordinates);
  const client = db.$client;

  const paddockMutation = client.prepare(`
    UPDATE potreros
    SET
      area_hectares = (
        SELECT CAST(json_extract(request.value, '$.areaHectares') AS REAL)
        FROM json_each(input.payload) AS request
        WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
      ),
      coordinates = (
        SELECT json_extract(request.value, '$.coordinates')
        FROM json_each(input.payload) AS request
        WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
      ),
      grazeable_area_hectares = (
        SELECT json_extract(request.value, '$.grazeableAreaHectares')
        FROM json_each(input.payload) AS request
        WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
      ),
      land_use = (
        SELECT CAST(json_extract(request.value, '$.landUse') AS TEXT)
        FROM json_each(input.payload) AS request
        WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
      ),
      hole_kinds = (
        SELECT json_extract(request.value, '$.holeKinds')
        FROM json_each(input.payload) AS request
        WHERE CAST(json_extract(request.value, '$.id') AS TEXT) = potreros.id
      ),
      updated_at = ?
    FROM (SELECT ? AS payload) AS input
    WHERE id IN (
      SELECT CAST(json_extract(request.value, '$.id') AS TEXT)
      FROM json_each(input.payload) AS request
    )
      AND EXISTS (
        SELECT 1
        FROM fields AS current_field
        WHERE current_field.id = ?
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND current_field.name = ?
          AND current_field.location = ?
          AND current_field.is_demo = ?
          AND current_field.area_hectares = ?
          AND json(current_field.coordinates) = json(?)
          AND current_field.soil_report_filename IS ?
          AND current_field.soil_report_folio IS ?
          AND current_field.soil_sample_id IS ?
          AND current_field.soil_report_date IS ?
          AND current_field.created_at = ?
      )
      AND (
        SELECT COUNT(*)
        FROM json_each(input.payload) AS request
        INNER JOIN potreros AS candidate
          ON candidate.id = CAST(json_extract(request.value, '$.id') AS TEXT)
        INNER JOIN fields AS scoped_field ON scoped_field.id = candidate.field_id
        WHERE scoped_field.organization_id = ?
          AND scoped_field.id IN (SELECT value FROM json_each(?))
          AND candidate.field_id = CAST(json_extract(request.value, '$.expected.fieldId') AS TEXT)
          AND candidate.deleted_at IS NULL
          AND candidate.archived_at IS NULL
          AND candidate.name = CAST(json_extract(request.value, '$.expected.name') AS TEXT)
          AND candidate.sector = CAST(json_extract(request.value, '$.expected.sector') AS TEXT)
          AND candidate.area_hectares = CAST(json_extract(request.value, '$.expected.areaHectares') AS REAL)
          AND json(candidate.coordinates) = json(json_extract(request.value, '$.expected.coordinates'))
          AND candidate.grazeable_area_hectares IS json_extract(request.value, '$.expected.grazeableAreaHectares')
          AND candidate.land_use = CAST(json_extract(request.value, '$.expected.landUse') AS TEXT)
          AND json(candidate.hole_kinds) = json(json_extract(request.value, '$.expected.holeKinds'))
          AND candidate.soil_ph IS json_extract(request.value, '$.expected.soilPh')
          AND candidate.soil_nitrogen IS json_extract(request.value, '$.expected.soilNitrogen')
          AND candidate.soil_phosphorus IS json_extract(request.value, '$.expected.soilPhosphorus')
          AND candidate.soil_potassium IS json_extract(request.value, '$.expected.soilPotassium')
          AND candidate.last_activity = CAST(json_extract(request.value, '$.expected.lastActivity') AS TEXT)
          AND candidate.status = CAST(json_extract(request.value, '$.expected.status') AS TEXT)
          AND candidate.created_at = CAST(json_extract(request.value, '$.expected.createdAt') AS TEXT)
          AND candidate.updated_at = CAST(json_extract(request.value, '$.expected.updatedAt') AS TEXT)
      ) = json_array_length(input.payload)
  `).bind(
    updatedAt,
    requested,
    existingField.id,
    scope.organizationId,
    fieldIdsJson,
    existingField.name,
    existingField.location,
    existingField.isDemo ? 1 : 0,
    existingField.areaHectares,
    existingFieldCoordinatesJson,
    existingField.soilReportFilename,
    existingField.soilReportFolio,
    existingField.soilSampleId,
    existingField.soilReportDate,
    existingField.createdAt,
    scope.organizationId,
    fieldIdsJson,
  );

  const fieldMutation = client.prepare(`
    UPDATE fields
    SET name = ?, location = ?, area_hectares = ?, coordinates = ?,
      soil_report_filename = ?, soil_report_folio = ?, soil_sample_id = ?, soil_report_date = ?
    WHERE id = ?
      AND organization_id = ?
      AND id IN (SELECT value FROM json_each(?))
      AND name = ?
      AND location = ?
      AND is_demo = ?
      AND area_hectares = ?
      AND json(coordinates) = json(?)
      AND soil_report_filename IS ?
      AND soil_report_folio IS ?
      AND soil_sample_id IS ?
      AND soil_report_date IS ?
      AND created_at = ?
      AND (
        SELECT COUNT(*)
        FROM json_each(?) AS request
        INNER JOIN potreros AS updated_paddock
          ON updated_paddock.id = CAST(json_extract(request.value, '$.id') AS TEXT)
        WHERE updated_paddock.field_id = fields.id
          AND updated_paddock.updated_at = ?
          AND updated_paddock.deleted_at IS NULL
          AND updated_paddock.archived_at IS NULL
      ) = json_array_length(?)
  `).bind(
    fundo.name,
    fundo.location,
    fundo.areaHectares,
    fieldCoordinatesJson,
    fundo.soilReport?.filename ?? null,
    fundo.soilReport?.folio ?? null,
    fundo.soilReport?.sampleId ?? null,
    fundo.soilReport?.reportDate ?? null,
    existingField.id,
    scope.organizationId,
    fieldIdsJson,
    existingField.name,
    existingField.location,
    existingField.isDemo ? 1 : 0,
    existingField.areaHectares,
    existingFieldCoordinatesJson,
    existingField.soilReportFilename,
    existingField.soilReportFolio,
    existingField.soilSampleId,
    existingField.soilReportDate,
    existingField.createdAt,
    requested,
    updatedAt,
    requested,
  );

  const selectField = client.prepare(`
    SELECT
      id,
      organization_id AS "organizationId",
      name,
      location,
      is_demo AS "isDemo",
      area_hectares AS "areaHectares",
      coordinates,
      soil_report_filename AS "soilReportFilename",
      soil_report_folio AS "soilReportFolio",
      soil_sample_id AS "soilSampleId",
      soil_report_date AS "soilReportDate",
      created_at AS "createdAt"
    FROM fields
    WHERE id = ?
      AND organization_id = ?
      AND name = ?
      AND location = ?
      AND area_hectares = ?
      AND json(coordinates) = json(?)
  `).bind(
    fundo.id,
    scope.organizationId,
    fundo.name,
    fundo.location,
    fundo.areaHectares,
    fieldCoordinatesJson,
  );
  const selectPaddocks = client.prepare(`
    SELECT
      paddock.id,
      paddock.field_id AS "fieldId",
      paddock.name,
      paddock.sector,
      paddock.area_hectares AS "areaHectares",
      paddock.coordinates,
      paddock.grazeable_area_hectares AS "grazeableAreaHectares",
      paddock.land_use AS "landUse",
      paddock.hole_kinds AS "holeKinds",
      paddock.soil_ph AS "soilPh",
      paddock.soil_nitrogen AS "soilNitrogen",
      paddock.soil_phosphorus AS "soilPhosphorus",
      paddock.soil_potassium AS "soilPotassium",
      paddock.last_activity AS "lastActivity",
      paddock.status,
      paddock.created_at AS "createdAt",
      paddock.updated_at AS "updatedAt"
    FROM json_each(?) AS request
    INNER JOIN potreros AS paddock
      ON paddock.id = CAST(json_extract(request.value, '$.id') AS TEXT)
    INNER JOIN fields AS current_field ON current_field.id = paddock.field_id
    WHERE paddock.updated_at = ?
      AND current_field.organization_id = ?
      AND current_field.id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
      AND paddock.deleted_at IS NULL
      AND paddock.archived_at IS NULL
    ORDER BY CAST(request.key AS INTEGER)
  `).bind(requested, updatedAt, scope.organizationId, fundo.id, fieldIdsJson);

  const [paddockResult, fieldResult, savedFieldResult, savedPaddockResult] = await client.batch([
    paddockMutation,
    fieldMutation,
    selectField,
    selectPaddocks,
  ]);
  if (paddockResult.meta.changes !== updates.length || fieldResult.meta.changes !== 1) {
    throwFieldScopeConflict("El fundo o uno de sus potreros cambió antes de guardar los límites.");
  }
  const savedField = savedFieldResult.results[0] as Parameters<typeof toFundo>[0] | undefined;
  const savedPaddocks = savedPaddockResult.results as PaddockResultRow[];
  if (!savedField || savedPaddocks.length !== updates.length) {
    throwFieldScopeConflict("No fue posible confirmar todos los límites actualizados.");
  }
  return {
    fundo: await toFundo(savedField),
    potreros: savedPaddocks.map(toPotrero),
  };
}

function nextLinkedBoundaryTimestamp(previous: string[]): string {
  const newest = previous.reduce((maximum, value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(maximum, timestamp) : maximum;
  }, 0);
  return new Date(Math.max(Date.now(), newest + 1)).toISOString();
}

export async function readPaddockGeometrySyncMarker(
  mutationId: string,
  fieldId: string,
  scope: OrganizationFieldScope,
): Promise<PaddockGeometrySyncMarker | null> {
  if (!scope.fieldIds.includes(fieldId)) return null;
  const row = await getDb().$client.prepare(`
    SELECT after
    FROM audit_log
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND action = 'sync.paddock_geometry.projected'
      AND entity_type = 'paddock_geometry'
    LIMIT 1
  `).bind(`audit:geo:${mutationId}`, scope.organizationId, fieldId).first<{ after: string | PaddockGeometrySyncMarker }>();
  if (!row) return null;
  const parsed = typeof row.after === "string" ? JSON.parse(row.after) as PaddockGeometrySyncMarker : row.after;
  return parsed?.mutationId === mutationId && parsed.eventPayload?.projection?.kind === "paddock_geometry" ? parsed : null;
}
