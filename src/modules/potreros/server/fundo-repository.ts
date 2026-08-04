import { getDb } from "@/db";
import { fields } from "@/db/schema";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import {
  FIELD_LIMIT_MESSAGE,
  fieldLimitReached,
} from "@/src/modules/access/server/organization-plan-repository";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Fundo } from "../types";

type FieldRow = typeof fields.$inferSelect;
type FieldResultRow = Omit<FieldRow, "coordinates" | "isDemo"> & {
  coordinates: FieldRow["coordinates"] | string;
  isDemo: FieldRow["isDemo"] | number;
};

function normalizedCoordinates(row: FieldResultRow) {
  return typeof row.coordinates === "string" ? JSON.parse(row.coordinates) : row.coordinates;
}

async function fundoSnapshotToken(row: FieldResultRow): Promise<string> {
  const snapshot = JSON.stringify([
    row.id,
    row.organizationId,
    row.name,
    row.location,
    Boolean(row.isDemo),
    row.areaHectares,
    normalizedCoordinates(row),
    row.soilReportFilename,
    row.soilReportFolio,
    row.soilSampleId,
    row.soilReportDate,
    row.createdAt,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `field-snapshot:v1:${hex}`;
}

export async function toFundo(row: FieldResultRow): Promise<Fundo> {
  const hasReport = Boolean(row.soilReportFilename && row.soilReportFolio && row.soilSampleId && row.soilReportDate);
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    areaHectares: row.areaHectares,
    coordinates: normalizedCoordinates(row),
    soilReport: hasReport
      ? {
          filename: row.soilReportFilename!,
          folio: row.soilReportFolio!,
          sampleId: row.soilSampleId!,
          reportDate: row.soilReportDate!,
        }
      : null,
    snapshotToken: await fundoSnapshotToken(row),
  };
}

function toFieldRow(fundo: Fundo, organizationId: string): typeof fields.$inferInsert {
  return {
    id: fundo.id,
    organizationId,
    name: fundo.name,
    location: fundo.location,
    isDemo: false,
    areaHectares: fundo.areaHectares,
    coordinates: fundo.coordinates,
    soilReportFilename: fundo.soilReport?.filename ?? null,
    soilReportFolio: fundo.soilReport?.folio ?? null,
    soilSampleId: fundo.soilReport?.sampleId ?? null,
    soilReportDate: fundo.soilReport?.reportDate ?? null,
  };
}

export async function listFundos(scope: OrganizationFieldScope): Promise<Fundo[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(fields)
    .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
    .orderBy(asc(fields.name));
  return Promise.all(rows.map(toFundo));
}

export async function upsertFundo(fundo: Fundo, scope: OrganizationFieldScope): Promise<Fundo> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(fields)
    .where(eq(fields.id, fundo.id))
    .limit(1);
  if (existing && (existing.organizationId !== scope.organizationId || !scope.fieldIds.includes(existing.id))) {
    throw new DomainRuleError("El identificador del fundo no está disponible.", "FIELD_SCOPE_CONFLICT");
  }
  if (existing && (!fundo.snapshotToken || fundo.snapshotToken !== await fundoSnapshotToken(existing))) {
    throw new DomainRuleError("El fundo cambió desde la última carga.", "FIELD_SCOPE_CONFLICT");
  }

  const values = toFieldRow(fundo, scope.organizationId);
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const coordinatesJson = JSON.stringify(values.coordinates);
  const client = db.$client;
  const mutation = existing
    ? client.prepare(`
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
        AND coordinates = ?
        AND soil_report_filename IS ?
        AND soil_report_folio IS ?
        AND soil_sample_id IS ?
        AND soil_report_date IS ?
        AND created_at = ?
    `).bind(
      values.name,
      values.location,
      values.areaHectares,
      coordinatesJson,
      values.soilReportFilename,
      values.soilReportFolio,
      values.soilSampleId,
      values.soilReportDate,
      existing.id,
      scope.organizationId,
      fieldIdsJson,
      existing.name,
      existing.location,
      existing.isDemo ? 1 : 0,
      existing.areaHectares,
      JSON.stringify(existing.coordinates),
      existing.soilReportFilename,
      existing.soilReportFolio,
      existing.soilSampleId,
      existing.soilReportDate,
      existing.createdAt,
    )
    : client.prepare(`
      INSERT INTO fields (
        id, organization_id, name, location, is_demo, area_hectares, coordinates,
        soil_report_filename, soil_report_folio, soil_sample_id, soil_report_date
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM fields AS conflicting_field WHERE conflicting_field.id = ?
      )
        AND EXISTS (
          SELECT 1 FROM organizations AS current_organization
          WHERE current_organization.id = ?
            AND (
              current_organization.field_limit IS NULL
              OR (
                SELECT COUNT(*)
                FROM fields AS existing_field
                WHERE existing_field.organization_id = current_organization.id
              ) < current_organization.field_limit
            )
        )
    `).bind(
      values.id,
      values.organizationId,
      values.name,
      values.location,
      values.isDemo ? 1 : 0,
      values.areaHectares,
      coordinatesJson,
      values.soilReportFilename,
      values.soilReportFolio,
      values.soilSampleId,
      values.soilReportDate,
      values.id,
      scope.organizationId,
    );
  const selectSaved = client.prepare(`
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
    WHERE id = ? AND organization_id = ?
  `).bind(values.id, scope.organizationId);
  const [mutationResult, savedResult] = await client.batch([mutation, selectSaved]);
  if (mutationResult.meta.changes !== 1) {
    if (!existing && await fieldLimitReached(scope.organizationId)) {
      throw new DomainRuleError(FIELD_LIMIT_MESSAGE, "PLAN_FIELD_LIMIT_REACHED");
    }
    throw new DomainRuleError("El identificador del fundo no está disponible.", "FIELD_SCOPE_CONFLICT");
  }
  const saved = savedResult.results[0] as FieldResultRow | undefined;
  if (!saved) throw new DomainRuleError("El identificador del fundo no está disponible.", "FIELD_SCOPE_CONFLICT");
  return toFundo(saved);
}
