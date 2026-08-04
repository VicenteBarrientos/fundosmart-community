import { getDb } from "@/db";
import {
  fields,
  livestockMilkControls,
  milkBulkProduction,
  milkQualitySamples,
  pabcoComplianceItems,
} from "@/db/schema";
import type {
  MilkBulkProduction,
  MilkQualitySample,
  PabcoComplianceItem,
} from "@/src/core/domain/types";
import type { BulkMilkControlRowInput } from "../domain/types";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { and, desc, eq, inArray } from "drizzle-orm";

type MilkOperationWriteContext = OrganizationFieldScope & { actor: string };
type D1Binding = string | number | null;
type D1Client = ReturnType<typeof getDb>["$client"];
type BulkProductionRow = typeof milkBulkProduction.$inferSelect;
type QualitySampleRow = typeof milkQualitySamples.$inferSelect;
type PabcoItemRow = typeof pabcoComplianceItems.$inferSelect;
type MilkControlRow = typeof livestockMilkControls.$inferSelect;
type PreparedQualitySampleRow = Omit<QualitySampleRow, "sanitaryFlags"> & {
  sanitaryFlags: QualitySampleRow["sanitaryFlags"] | string;
};

export class MilkOperationConflictError extends Error {
  constructor(
    message = "El registro cambió desde que lo abriste. Recarga la sección e inténtalo nuevamente.",
  ) {
    super(message);
    this.name = "MilkOperationConflictError";
  }
}

export class MilkOperationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MilkOperationInputError";
  }
}

export async function listMilkBulkProduction(
  scope: OrganizationFieldScope,
): Promise<MilkBulkProduction[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ record: milkBulkProduction })
    .from(milkBulkProduction)
    .innerJoin(fields, eq(fields.id, milkBulkProduction.fieldId))
    .where(
      and(
        eq(fields.organizationId, scope.organizationId),
        inArray(fields.id, scope.fieldIds),
      ),
    )
    .orderBy(
      desc(milkBulkProduction.recordedAt),
      desc(milkBulkProduction.createdAt),
    );
  return rows.map(({ record }) => record);
}

export async function listMilkQualitySamples(
  scope: OrganizationFieldScope,
): Promise<MilkQualitySample[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ record: milkQualitySamples })
    .from(milkQualitySamples)
    .innerJoin(fields, eq(fields.id, milkQualitySamples.fieldId))
    .where(
      and(
        eq(fields.organizationId, scope.organizationId),
        inArray(fields.id, scope.fieldIds),
      ),
    )
    .orderBy(
      desc(milkQualitySamples.sampledAt),
      desc(milkQualitySamples.createdAt),
    );
  return rows.map(({ record }) => record);
}

export async function listPabcoComplianceItems(
  scope: OrganizationFieldScope,
): Promise<PabcoComplianceItem[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ record: pabcoComplianceItems })
    .from(pabcoComplianceItems)
    .innerJoin(fields, eq(fields.id, pabcoComplianceItems.fieldId))
    .where(
      and(
        eq(fields.organizationId, scope.organizationId),
        inArray(fields.id, scope.fieldIds),
      ),
    )
    .orderBy(
      desc(pabcoComplianceItems.validUntil),
      desc(pabcoComplianceItems.updatedAt),
    );
  return rows.map(({ record }) => record);
}

export async function upsertMilkBulkProduction(
  input: MilkBulkProduction,
  context: MilkOperationWriteContext,
): Promise<MilkBulkProduction> {
  await assertMilkOperationFieldScope(input.fieldId, context);
  const db = getDb();
  const client = db.$client;
  const values = {
    organizationId: context.organizationId,
    fieldId: input.fieldId,
    recordedAt: input.recordedAt,
    kind: input.kind,
    volumeLiters: input.volumeLiters,
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    notes: input.notes,
    updatedAt: "",
  };
  const [existing] = await db
    .select()
    .from(milkBulkProduction)
    .where(eq(milkBulkProduction.id, input.id))
    .limit(1);
  assertExistingScope(existing, input.fieldId, context.organizationId);
  if (existing && input.updatedAt !== existing.updatedAt) {
    throw new MilkOperationConflictError();
  }
  values.updatedAt = nextUpdatedAt(existing?.updatedAt);
  const now = values.updatedAt;
  const fieldIdsJson = JSON.stringify(context.fieldIds);
  if (!existing) {
    const record = {
      id: input.id,
      ...values,
      createdBy: context.actor,
      createdAt: input.createdAt || now,
    };
    const guardSql = `
      EXISTS (
        SELECT 1 FROM fields AS target_field
        WHERE target_field.id = ?
          AND target_field.organization_id = ?
          AND target_field.id IN (SELECT value FROM json_each(?))
      )
      AND NOT EXISTS (SELECT 1 FROM milk_bulk_production WHERE id = ?)
    `;
    const guardBindings: D1Binding[] = [record.fieldId, context.organizationId, fieldIdsJson, record.id];
    const mutation = client.prepare(`
      INSERT INTO milk_bulk_production (
        id, organization_id, field_id, recorded_at, kind, volume_liters, source,
        source_record_id, notes, created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${guardSql}
    `).bind(
      record.id, record.organizationId, record.fieldId, record.recordedAt, record.kind,
      record.volumeLiters, record.source, record.sourceRecordId, record.notes,
      record.createdBy, record.createdAt, record.updatedAt, ...guardBindings,
    );
    const savedStatement = prepareBulkProductionSelect(client, record.id, record.fieldId, now, context);
    const auditId = crypto.randomUUID();
    const [auditResult, mutationResult, savedResult] = await executeMilkOperationBatch(client, [
      prepareConditionalMilkAudit(client, {
        id: auditId,
        context,
        action: "milk_bulk_production.created",
        entityType: "milk_bulk_production",
        entityId: record.id,
        fieldId: record.fieldId,
        before: null,
        after: record,
        sourceRecordId: record.sourceRecordId,
        occurredAt: now,
        guardSql,
        guardBindings,
      }),
      mutation,
      savedStatement,
      prepareMilkOperationAssertion(client, {
        auditId, context, action: "milk_bulk_production.created",
        entityType: "milk_bulk_production", entityId: record.id, fieldId: record.fieldId,
        before: null, after: record, sourceRecordId: record.sourceRecordId, occurredAt: now,
        postconditionSql: `EXISTS (SELECT 1 FROM milk_bulk_production WHERE ${bulkProductionSnapshotGuardSql()})`,
        postconditionBindings: bulkProductionSnapshotBindings(record, context),
      }),
    ]);
    assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
    const created = savedResult.results[0] as MilkBulkProduction | undefined;
    if (!created) throw new MilkOperationConflictError();
    return created;
  }
  const after = { ...existing, ...values };
  const rowGuardSql = bulkProductionSnapshotGuardSql();
  const rowGuardBindings = bulkProductionSnapshotBindings(existing, context);
  const auditGuardSql = `EXISTS (SELECT 1 FROM milk_bulk_production WHERE ${rowGuardSql})`;
  const mutation = client.prepare(`
    UPDATE milk_bulk_production
    SET organization_id = ?, field_id = ?, recorded_at = ?, kind = ?, volume_liters = ?,
        source = ?, source_record_id = ?, notes = ?, updated_at = ?
    WHERE ${rowGuardSql}
  `).bind(
    values.organizationId, values.fieldId, values.recordedAt, values.kind, values.volumeLiters,
    values.source, values.sourceRecordId, values.notes, values.updatedAt, ...rowGuardBindings,
  );
  const auditId = crypto.randomUUID();
  const [auditResult, mutationResult, savedResult] = await executeMilkOperationBatch(client, [
    prepareConditionalMilkAudit(client, {
      id: auditId,
      context,
      action: "milk_bulk_production.updated",
      entityType: "milk_bulk_production",
      entityId: input.id,
      fieldId: input.fieldId,
      before: existing,
      after,
      sourceRecordId: input.sourceRecordId,
      occurredAt: now,
      guardSql: auditGuardSql,
      guardBindings: rowGuardBindings,
    }),
    mutation,
    prepareBulkProductionSelect(client, input.id, input.fieldId, now, context),
    prepareMilkOperationAssertion(client, {
      auditId, context, action: "milk_bulk_production.updated",
      entityType: "milk_bulk_production", entityId: input.id, fieldId: input.fieldId,
      before: existing, after, sourceRecordId: input.sourceRecordId, occurredAt: now,
      postconditionSql: `EXISTS (SELECT 1 FROM milk_bulk_production WHERE ${bulkProductionSnapshotGuardSql()})`,
      postconditionBindings: bulkProductionSnapshotBindings(after, context),
    }),
  ]);
  assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
  const updated = savedResult.results[0] as MilkBulkProduction | undefined;
  if (!updated) throw new MilkOperationConflictError();
  return updated;
}

export async function upsertMilkQualitySample(
  input: MilkQualitySample,
  context: MilkOperationWriteContext,
): Promise<MilkQualitySample> {
  await assertMilkOperationFieldScope(input.fieldId, context);
  const db = getDb();
  const client = db.$client;
  const values = {
    organizationId: context.organizationId,
    fieldId: input.fieldId,
    sampledAt: input.sampledAt,
    period: input.period,
    kind: input.kind,
    fatPercent: input.fatPercent,
    proteinPercent: input.proteinPercent,
    totalSolidsPercent: input.totalSolidsPercent,
    somaticCellCount: input.somaticCellCount,
    somaticCellCountUnit: input.somaticCellCountUnit,
    bacterialCount: input.bacterialCount,
    bacterialCountUnit: input.bacterialCountUnit,
    sanitaryFlags: input.sanitaryFlags,
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    notes: input.notes,
    updatedAt: "",
  };
  const [existing] = await db
    .select()
    .from(milkQualitySamples)
    .where(eq(milkQualitySamples.id, input.id))
    .limit(1);
  assertExistingScope(existing, input.fieldId, context.organizationId);
  if (existing && input.updatedAt !== existing.updatedAt) {
    throw new MilkOperationConflictError();
  }
  values.updatedAt = nextUpdatedAt(existing?.updatedAt);
  const now = values.updatedAt;
  const fieldIdsJson = JSON.stringify(context.fieldIds);
  if (!existing) {
    const record = {
      id: input.id,
      ...values,
      createdBy: context.actor,
      createdAt: input.createdAt || now,
    };
    const guardSql = `
      EXISTS (
        SELECT 1 FROM fields AS target_field
        WHERE target_field.id = ?
          AND target_field.organization_id = ?
          AND target_field.id IN (SELECT value FROM json_each(?))
      )
      AND NOT EXISTS (SELECT 1 FROM milk_quality_samples WHERE id = ?)
    `;
    const guardBindings: D1Binding[] = [record.fieldId, context.organizationId, fieldIdsJson, record.id];
    const mutation = client.prepare(`
      INSERT INTO milk_quality_samples (
        id, organization_id, field_id, sampled_at, period, kind, fat_percent,
        protein_percent, total_solids_percent, somatic_cell_count,
        somatic_cell_count_unit, bacterial_count, bacterial_count_unit,
        sanitary_flags, source, source_record_id, notes, created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${guardSql}
    `).bind(
      record.id, record.organizationId, record.fieldId, record.sampledAt, record.period,
      record.kind, record.fatPercent, record.proteinPercent, record.totalSolidsPercent,
      record.somaticCellCount, record.somaticCellCountUnit, record.bacterialCount,
      record.bacterialCountUnit, JSON.stringify(record.sanitaryFlags), record.source,
      record.sourceRecordId, record.notes, record.createdBy, record.createdAt, record.updatedAt,
      ...guardBindings,
    );
    const auditId = crypto.randomUUID();
    const [auditResult, mutationResult, savedResult] = await executeMilkOperationBatch(client, [
      prepareConditionalMilkAudit(client, {
        id: auditId,
        context,
        action: "milk_quality_sample.created",
        entityType: "milk_quality_sample",
        entityId: record.id,
        fieldId: record.fieldId,
        before: null,
        after: record,
        sourceRecordId: record.sourceRecordId,
        occurredAt: now,
        guardSql,
        guardBindings,
      }),
      mutation,
      prepareQualitySampleSelect(client, record.id, record.fieldId, now, context),
      prepareMilkOperationAssertion(client, {
        auditId, context, action: "milk_quality_sample.created",
        entityType: "milk_quality_sample", entityId: record.id, fieldId: record.fieldId,
        before: null, after: record, sourceRecordId: record.sourceRecordId, occurredAt: now,
        postconditionSql: `EXISTS (SELECT 1 FROM milk_quality_samples WHERE ${qualitySampleSnapshotGuardSql()})`,
        postconditionBindings: qualitySampleSnapshotBindings(record, context),
      }),
    ]);
    assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
    const createdRow = savedResult.results[0] as PreparedQualitySampleRow | undefined;
    const created = createdRow ? toMilkQualitySample(createdRow) : undefined;
    if (!created) throw new MilkOperationConflictError();
    return created;
  }
  const after = { ...existing, ...values };
  const rowGuardSql = qualitySampleSnapshotGuardSql();
  const rowGuardBindings = qualitySampleSnapshotBindings(existing, context);
  const auditGuardSql = `EXISTS (SELECT 1 FROM milk_quality_samples WHERE ${rowGuardSql})`;
  const mutation = client.prepare(`
    UPDATE milk_quality_samples
    SET organization_id = ?, field_id = ?, sampled_at = ?, period = ?, kind = ?,
        fat_percent = ?, protein_percent = ?, total_solids_percent = ?,
        somatic_cell_count = ?, somatic_cell_count_unit = ?, bacterial_count = ?,
        bacterial_count_unit = ?, sanitary_flags = ?, source = ?, source_record_id = ?,
        notes = ?, updated_at = ?
    WHERE ${rowGuardSql}
  `).bind(
    values.organizationId, values.fieldId, values.sampledAt, values.period, values.kind,
    values.fatPercent, values.proteinPercent, values.totalSolidsPercent,
    values.somaticCellCount, values.somaticCellCountUnit, values.bacterialCount,
    values.bacterialCountUnit, JSON.stringify(values.sanitaryFlags), values.source,
    values.sourceRecordId, values.notes, values.updatedAt, ...rowGuardBindings,
  );
  const auditId = crypto.randomUUID();
  const [auditResult, mutationResult, savedResult] = await executeMilkOperationBatch(client, [
    prepareConditionalMilkAudit(client, {
      id: auditId,
      context,
      action: "milk_quality_sample.updated",
      entityType: "milk_quality_sample",
      entityId: input.id,
      fieldId: input.fieldId,
      before: existing,
      after,
      sourceRecordId: input.sourceRecordId,
      occurredAt: now,
      guardSql: auditGuardSql,
      guardBindings: rowGuardBindings,
    }),
    mutation,
    prepareQualitySampleSelect(client, input.id, input.fieldId, now, context),
    prepareMilkOperationAssertion(client, {
      auditId, context, action: "milk_quality_sample.updated",
      entityType: "milk_quality_sample", entityId: input.id, fieldId: input.fieldId,
      before: existing, after, sourceRecordId: input.sourceRecordId, occurredAt: now,
      postconditionSql: `EXISTS (SELECT 1 FROM milk_quality_samples WHERE ${qualitySampleSnapshotGuardSql()})`,
      postconditionBindings: qualitySampleSnapshotBindings(after, context),
    }),
  ]);
  assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
  const updatedRow = savedResult.results[0] as PreparedQualitySampleRow | undefined;
  const updated = updatedRow ? toMilkQualitySample(updatedRow) : undefined;
  if (!updated) throw new MilkOperationConflictError();
  return updated;
}

export async function upsertPabcoComplianceItem(
  input: PabcoComplianceItem,
  context: MilkOperationWriteContext,
): Promise<PabcoComplianceItem> {
  await assertMilkOperationFieldScope(input.fieldId, context);
  const db = getDb();
  const client = db.$client;
  const values = {
    organizationId: context.organizationId,
    fieldId: input.fieldId,
    requirement: input.requirement,
    status: input.status,
    evidenceDocumentId: input.evidenceDocumentId,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    reminderAt: input.reminderAt,
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    notes: input.notes,
    updatedAt: "",
  };
  const [existing] = await db
    .select()
    .from(pabcoComplianceItems)
    .where(eq(pabcoComplianceItems.id, input.id))
    .limit(1);
  assertExistingScope(existing, input.fieldId, context.organizationId);
  if (existing && input.updatedAt !== existing.updatedAt) {
    throw new MilkOperationConflictError();
  }
  values.updatedAt = nextUpdatedAt(existing?.updatedAt);
  const now = values.updatedAt;
  const fieldIdsJson = JSON.stringify(context.fieldIds);
  if (!existing) {
    const record = {
      id: input.id,
      ...values,
      createdBy: context.actor,
      createdAt: input.createdAt || now,
    };
    const evidenceGuardSql = pabcoEvidenceReferenceGuardSql();
    const evidenceGuardBindings = pabcoEvidenceReferenceGuardBindings(
      record.evidenceDocumentId,
      context.organizationId,
      record.fieldId,
    );
    const guardSql = `
      EXISTS (
        SELECT 1 FROM fields AS target_field
        WHERE target_field.id = ?
          AND target_field.organization_id = ?
          AND target_field.id IN (SELECT value FROM json_each(?))
      )
      AND ${evidenceGuardSql}
      AND NOT EXISTS (SELECT 1 FROM pabco_compliance_items WHERE id = ?)
    `;
    const guardBindings: D1Binding[] = [
      record.fieldId,
      context.organizationId,
      fieldIdsJson,
      ...evidenceGuardBindings,
      record.id,
    ];
    const mutation = client.prepare(`
      INSERT INTO pabco_compliance_items (
        id, organization_id, field_id, requirement, status, evidence_document_id,
        valid_from, valid_until, reminder_at, source, source_record_id, notes,
        created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${guardSql}
    `).bind(
      record.id, record.organizationId, record.fieldId, record.requirement, record.status,
      record.evidenceDocumentId, record.validFrom, record.validUntil, record.reminderAt,
      record.source, record.sourceRecordId, record.notes, record.createdBy, record.createdAt,
      record.updatedAt, ...guardBindings,
    );
    const auditId = crypto.randomUUID();
    const [auditResult, mutationResult, savedResult] = await executeMilkOperationBatch(client, [
      prepareConditionalMilkAudit(client, {
        id: auditId,
        context,
        action: "pabco_compliance_item.created",
        entityType: "pabco_compliance_item",
        entityId: record.id,
        fieldId: record.fieldId,
        before: null,
        after: record,
        sourceRecordId: record.sourceRecordId,
        occurredAt: now,
        guardSql,
        guardBindings,
      }),
      mutation,
      preparePabcoItemSelect(client, record.id, record.fieldId, now, context),
      prepareMilkOperationAssertion(client, {
        auditId, context, action: "pabco_compliance_item.created",
        entityType: "pabco_compliance_item", entityId: record.id, fieldId: record.fieldId,
        before: null, after: record, sourceRecordId: record.sourceRecordId, occurredAt: now,
        postconditionSql: `
          EXISTS (SELECT 1 FROM pabco_compliance_items WHERE ${pabcoItemSnapshotGuardSql()})
          AND ${evidenceGuardSql}
        `,
        postconditionBindings: [
          ...pabcoItemSnapshotBindings(record, context),
          ...evidenceGuardBindings,
        ],
      }),
    ]);
    assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
    const created = savedResult.results[0] as PabcoComplianceItem | undefined;
    if (!created) throw new MilkOperationConflictError();
    return created;
  }
  const after = { ...existing, ...values };
  const rowGuardSql = pabcoItemSnapshotGuardSql();
  const rowGuardBindings = pabcoItemSnapshotBindings(existing, context);
  const evidenceGuardSql = pabcoEvidenceReferenceGuardSql();
  const evidenceGuardBindings = pabcoEvidenceReferenceGuardBindings(
    after.evidenceDocumentId,
    context.organizationId,
    after.fieldId,
  );
  const auditGuardSql = `
    EXISTS (SELECT 1 FROM pabco_compliance_items WHERE ${rowGuardSql})
    AND ${evidenceGuardSql}
  `;
  const mutation = client.prepare(`
    UPDATE pabco_compliance_items
    SET organization_id = ?, field_id = ?, requirement = ?, status = ?, evidence_document_id = ?,
        valid_from = ?, valid_until = ?, reminder_at = ?, source = ?, source_record_id = ?,
        notes = ?, updated_at = ?
    WHERE ${rowGuardSql}
      AND ${evidenceGuardSql}
  `).bind(
    values.organizationId, values.fieldId, values.requirement, values.status,
    values.evidenceDocumentId, values.validFrom, values.validUntil, values.reminderAt,
    values.source, values.sourceRecordId, values.notes, values.updatedAt,
    ...rowGuardBindings, ...evidenceGuardBindings,
  );
  const auditId = crypto.randomUUID();
  const [auditResult, mutationResult, savedResult] = await executeMilkOperationBatch(client, [
    prepareConditionalMilkAudit(client, {
      id: auditId,
      context,
      action: "pabco_compliance_item.updated",
      entityType: "pabco_compliance_item",
      entityId: input.id,
      fieldId: input.fieldId,
      before: existing,
      after,
      sourceRecordId: input.sourceRecordId,
      occurredAt: now,
      guardSql: auditGuardSql,
      guardBindings: [...rowGuardBindings, ...evidenceGuardBindings],
    }),
    mutation,
    preparePabcoItemSelect(client, input.id, input.fieldId, now, context),
    prepareMilkOperationAssertion(client, {
      auditId, context, action: "pabco_compliance_item.updated",
      entityType: "pabco_compliance_item", entityId: input.id, fieldId: input.fieldId,
      before: existing, after, sourceRecordId: input.sourceRecordId, occurredAt: now,
      postconditionSql: `
        EXISTS (SELECT 1 FROM pabco_compliance_items WHERE ${pabcoItemSnapshotGuardSql()})
        AND ${evidenceGuardSql}
      `,
      postconditionBindings: [
        ...pabcoItemSnapshotBindings(after, context),
        ...evidenceGuardBindings,
      ],
    }),
  ]);
  assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
  const updated = savedResult.results[0] as PabcoComplianceItem | undefined;
  if (!updated) throw new MilkOperationConflictError();
  return updated;
}

export async function deleteMilkOperation(
  resource: "bulk_production" | "quality_sample" | "pabco_item",
  id: string,
  expectedUpdatedAt: string,
  context: MilkOperationWriteContext,
): Promise<boolean> {
  if (context.fieldIds.length === 0) return false;
  const db = getDb();
  const client = db.$client;
  if (resource === "bulk_production") {
    const [existing] = await db
      .select()
      .from(milkBulkProduction)
      .where(
        and(
          eq(milkBulkProduction.id, id),
          eq(milkBulkProduction.organizationId, context.organizationId),
          inArray(milkBulkProduction.fieldId, context.fieldIds),
        ),
      )
      .limit(1);
    if (!existing) return false;
    assertExpectedUpdatedAt(expectedUpdatedAt, existing.updatedAt);
    const rowGuardSql = bulkProductionSnapshotGuardSql();
    const rowGuardBindings = bulkProductionSnapshotBindings(existing, context);
    const occurredAt = new Date().toISOString();
    const auditId = crypto.randomUUID();
    const [auditResult, mutationResult] = await executeMilkOperationBatch(client, [
      prepareConditionalMilkAudit(client, {
        id: auditId,
        context,
        action: "milk_bulk_production.deleted",
        entityType: "milk_bulk_production",
        entityId: existing.id,
        fieldId: existing.fieldId,
        before: existing,
        after: null,
        sourceRecordId: existing.sourceRecordId,
        occurredAt,
        guardSql: `EXISTS (SELECT 1 FROM milk_bulk_production WHERE ${rowGuardSql})`,
        guardBindings: rowGuardBindings,
      }),
      client.prepare(`DELETE FROM milk_bulk_production WHERE ${rowGuardSql}`).bind(...rowGuardBindings),
      prepareMilkOperationAssertion(client, {
        auditId, context, action: "milk_bulk_production.deleted",
        entityType: "milk_bulk_production", entityId: existing.id, fieldId: existing.fieldId,
        before: existing, after: null, sourceRecordId: existing.sourceRecordId, occurredAt,
        postconditionSql: `NOT EXISTS (SELECT 1 FROM milk_bulk_production WHERE id = ?)
          AND EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ?
            AND id IN (SELECT value FROM json_each(?)))`,
        postconditionBindings: [existing.id, existing.fieldId, context.organizationId, JSON.stringify(context.fieldIds)],
      }),
    ]);
    assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
    return true;
  }
  if (resource === "quality_sample") {
    const [existing] = await db
      .select()
      .from(milkQualitySamples)
      .where(
        and(
          eq(milkQualitySamples.id, id),
          eq(milkQualitySamples.organizationId, context.organizationId),
          inArray(milkQualitySamples.fieldId, context.fieldIds),
        ),
      )
      .limit(1);
    if (!existing) return false;
    assertExpectedUpdatedAt(expectedUpdatedAt, existing.updatedAt);
    const rowGuardSql = qualitySampleSnapshotGuardSql();
    const rowGuardBindings = qualitySampleSnapshotBindings(existing, context);
    const occurredAt = new Date().toISOString();
    const auditId = crypto.randomUUID();
    const [auditResult, mutationResult] = await executeMilkOperationBatch(client, [
      prepareConditionalMilkAudit(client, {
        id: auditId,
        context,
        action: "milk_quality_sample.deleted",
        entityType: "milk_quality_sample",
        entityId: existing.id,
        fieldId: existing.fieldId,
        before: existing,
        after: null,
        sourceRecordId: existing.sourceRecordId,
        occurredAt,
        guardSql: `EXISTS (SELECT 1 FROM milk_quality_samples WHERE ${rowGuardSql})`,
        guardBindings: rowGuardBindings,
      }),
      client.prepare(`DELETE FROM milk_quality_samples WHERE ${rowGuardSql}`).bind(...rowGuardBindings),
      prepareMilkOperationAssertion(client, {
        auditId, context, action: "milk_quality_sample.deleted",
        entityType: "milk_quality_sample", entityId: existing.id, fieldId: existing.fieldId,
        before: existing, after: null, sourceRecordId: existing.sourceRecordId, occurredAt,
        postconditionSql: `NOT EXISTS (SELECT 1 FROM milk_quality_samples WHERE id = ?)
          AND EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ?
            AND id IN (SELECT value FROM json_each(?)))`,
        postconditionBindings: [existing.id, existing.fieldId, context.organizationId, JSON.stringify(context.fieldIds)],
      }),
    ]);
    assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
    return true;
  }
  const [existing] = await db
    .select()
    .from(pabcoComplianceItems)
    .where(
      and(
        eq(pabcoComplianceItems.id, id),
        eq(pabcoComplianceItems.organizationId, context.organizationId),
      inArray(pabcoComplianceItems.fieldId, context.fieldIds),
      ),
    )
    .limit(1);
  if (!existing) return false;
  assertExpectedUpdatedAt(expectedUpdatedAt, existing.updatedAt);
  const rowGuardSql = pabcoItemSnapshotGuardSql();
  const rowGuardBindings = pabcoItemSnapshotBindings(existing, context);
  const occurredAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const [auditResult, mutationResult] = await executeMilkOperationBatch(client, [
    prepareConditionalMilkAudit(client, {
      id: auditId,
      context,
      action: "pabco_compliance_item.deleted",
      entityType: "pabco_compliance_item",
      entityId: existing.id,
      fieldId: existing.fieldId,
      before: existing,
      after: null,
      sourceRecordId: existing.sourceRecordId,
      occurredAt,
      guardSql: `EXISTS (SELECT 1 FROM pabco_compliance_items WHERE ${rowGuardSql})`,
      guardBindings: rowGuardBindings,
    }),
    client.prepare(`DELETE FROM pabco_compliance_items WHERE ${rowGuardSql}`).bind(...rowGuardBindings),
    prepareMilkOperationAssertion(client, {
      auditId, context, action: "pabco_compliance_item.deleted",
      entityType: "pabco_compliance_item", entityId: existing.id, fieldId: existing.fieldId,
      before: existing, after: null, sourceRecordId: existing.sourceRecordId, occurredAt,
      postconditionSql: `NOT EXISTS (SELECT 1 FROM pabco_compliance_items WHERE id = ?)
        AND EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ?
          AND id IN (SELECT value FROM json_each(?)))`,
      postconditionBindings: [existing.id, existing.fieldId, context.organizationId, JSON.stringify(context.fieldIds)],
    }),
  ]);
  assertAtomicWrite(auditResult.meta.changes, mutationResult.meta.changes);
  return true;
}

export async function saveBulkMilkControls(
  rows: BulkMilkControlRowInput[],
  context: MilkOperationWriteContext,
): Promise<{ savedCount: number; fieldIds: string[] }> {
  if (rows.length === 0) return { savedCount: 0, fieldIds: [] };
  if (rows.length > 200)
    throw new MilkOperationInputError(
      "La carga masiva admite hasta 200 controles por operación.",
    );
  const uniqueKeys = new Set<string>();
  for (const row of rows) {
    const key = `${row.animalId}:${row.controlDate}`;
    if (uniqueKeys.has(key)) {
      throw new MilkOperationInputError(
        "La carga contiene más de un control para el mismo animal y fecha.",
      );
    }
    uniqueKeys.add(key);
  }
  const db = getDb();
  const client = db.$client;
  const animalIds = [...new Set(rows.map((row) => row.animalId))];
  const animalIdsJson = JSON.stringify(animalIds);
  const [animalResult, lactationResult, existingResult] = await Promise.all([
    client.prepare(`
      SELECT animal.id, animal.sex, lot.field_id AS "fieldId"
      FROM livestock_animals AS animal
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      WHERE animal.id IN (SELECT value FROM json_each(?))
    `).bind(animalIdsJson).all<{ id: string; sex: string; fieldId: string }>(),
    client.prepare(`
      SELECT id, field_id AS "fieldId", animal_id AS "animalId",
        started_at AS "startedAt", ended_at AS "endedAt"
      FROM livestock_lactations
      WHERE animal_id IN (SELECT value FROM json_each(?))
      ORDER BY started_at DESC, id DESC
    `).bind(animalIdsJson).all<{
      id: string;
      fieldId: string;
      animalId: string;
      startedAt: string;
      endedAt: string | null;
    }>(),
    client.prepare(`
      SELECT id, field_id AS "fieldId", animal_id AS "animalId",
        lactation_id AS "lactationId", control_date AS "controlDate",
        morning_liters AS "morningLiters", afternoon_liters AS "afternoonLiters",
        third_milking_liters AS "thirdMilkingLiters", total_liters AS "totalLiters",
        fat_pct AS "fatPct", protein_pct AS "proteinPct",
        somatic_cell_count AS "somaticCellCount", notes, source,
        source_record_id AS "sourceRecordId", created_by AS "createdBy",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM livestock_milk_controls
      WHERE animal_id IN (SELECT value FROM json_each(?))
    `).bind(animalIdsJson).all<MilkControlRow>(),
  ]);
  const animalRows = animalResult.results;
  const lactationRows = lactationResult.results;
  const existingRows = existingResult.results;
  const animalsById = new Map(animalRows.map((animal) => [animal.id, animal]));
  const allowed = new Set(context.fieldIds);
  for (const row of rows) {
    const animal = animalsById.get(row.animalId);
    if (!animal || !allowed.has(animal.fieldId))
      throw new MilkOperationInputError(
        "Uno de los animales no existe o no está disponible para tu membresía.",
      );
    if (animal.sex === "male")
      throw new MilkOperationInputError(
        "Un animal registrado como macho no puede recibir controles lecheros.",
      );
  }

  const existingByKey = new Map(
    existingRows.map((row) => [`${row.animalId}:${row.controlDate}`, row]),
  );
  const occurredAt = new Date().toISOString();
  const preparedRows = rows.map((row) => {
    const animal = animalsById.get(row.animalId)!;
    const existing = existingByKey.get(`${row.animalId}:${row.controlDate}`);
    const lactation = lactationRows.find(
      (entry) =>
        entry.animalId === row.animalId &&
        entry.fieldId === animal.fieldId &&
        entry.startedAt <= row.controlDate &&
        (entry.endedAt === null || entry.endedAt >= row.controlDate),
    );
    const id = existing?.id ?? `milk-${crypto.randomUUID()}`;
    const values: MilkControlRow = {
      id,
      fieldId: animal.fieldId,
      animalId: row.animalId,
      lactationId: lactation?.id ?? null,
      controlDate: row.controlDate,
      morningLiters: row.morningLiters,
      afternoonLiters: row.afternoonLiters,
      thirdMilkingLiters: row.thirdMilkingLiters,
      totalLiters: row.totalLiters,
      fatPct: row.fatPercent,
      proteinPct: row.proteinPercent,
      somaticCellCount: row.somaticCellCount,
      notes: "Carga masiva desde el módulo Leche",
      source: existing?.source ?? "Registro manual",
      sourceRecordId: existing?.sourceRecordId ?? null,
      createdBy: existing?.createdBy ?? context.actor,
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: nextUpdatedAt(existing?.updatedAt),
    };
    return {
      auditId: crypto.randomUUID(),
      action: existing
        ? "milk_control.bulk_updated"
        : "milk_control.bulk_created",
      before: existing ?? null,
      after: values,
    };
  });

  const payload = JSON.stringify({
    organizationId: context.organizationId,
    fieldIds: context.fieldIds,
    actor: context.actor,
    occurredAt,
    rows: preparedRows,
  });
  const inputCte = "WITH input(payload) AS (VALUES (?))";
  const writeGuard = bulkMilkControlWriteGuardSql();
  const auditStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    ${inputCte}
    SELECT
      json_extract(request.value, '$.auditId'),
      json_extract(input.payload, '$.organizationId'),
      json_extract(request.value, '$.after.fieldId'),
      json_extract(input.payload, '$.actor'),
      json_extract(request.value, '$.action'),
      'livestock_milk_control',
      json_extract(request.value, '$.after.id'),
      json_extract(request.value, '$.before'),
      json_extract(request.value, '$.after'),
      json_extract(request.value, '$.after.sourceRecordId'),
      json_extract(input.payload, '$.occurredAt')
    FROM input
    INNER JOIN json_each(input.payload, '$.rows') AS request
    WHERE ${writeGuard}
  `).bind(payload);
  const mutationStatement = client.prepare(`
    INSERT INTO livestock_milk_controls (
      id, field_id, animal_id, lactation_id, control_date,
      morning_liters, afternoon_liters, third_milking_liters, total_liters,
      fat_pct, protein_pct, somatic_cell_count, notes, source,
      source_record_id, created_by, created_at, updated_at
    )
    ${inputCte}
    SELECT
      json_extract(request.value, '$.after.id'),
      json_extract(request.value, '$.after.fieldId'),
      json_extract(request.value, '$.after.animalId'),
      json_extract(request.value, '$.after.lactationId'),
      json_extract(request.value, '$.after.controlDate'),
      json_extract(request.value, '$.after.morningLiters'),
      json_extract(request.value, '$.after.afternoonLiters'),
      json_extract(request.value, '$.after.thirdMilkingLiters'),
      json_extract(request.value, '$.after.totalLiters'),
      json_extract(request.value, '$.after.fatPct'),
      json_extract(request.value, '$.after.proteinPct'),
      json_extract(request.value, '$.after.somaticCellCount'),
      json_extract(request.value, '$.after.notes'),
      json_extract(request.value, '$.after.source'),
      json_extract(request.value, '$.after.sourceRecordId'),
      json_extract(request.value, '$.after.createdBy'),
      json_extract(request.value, '$.after.createdAt'),
      json_extract(request.value, '$.after.updatedAt')
    FROM input
    INNER JOIN json_each(input.payload, '$.rows') AS request
    WHERE ${writeGuard}
    ON CONFLICT(animal_id, control_date) DO UPDATE SET
      lactation_id = excluded.lactation_id,
      morning_liters = excluded.morning_liters,
      afternoon_liters = excluded.afternoon_liters,
      third_milking_liters = excluded.third_milking_liters,
      total_liters = excluded.total_liters,
      fat_pct = excluded.fat_pct,
      protein_pct = excluded.protein_pct,
      somatic_cell_count = excluded.somatic_cell_count,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).bind(payload);
  const assertionStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, actor, action, entity_type, entity_id, occurred_at
    )
    ${inputCte}
    SELECT
      NULL,
      json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.actor'),
      'milk_control.bulk_assertion_failed',
      'livestock_milk_control_batch',
      json_extract(input.payload, '$.actor'),
      json_extract(input.payload, '$.occurredAt')
    FROM input
    WHERE NOT (
      changes() = json_array_length(input.payload, '$.rows')
      AND (
        SELECT COUNT(*)
        FROM json_each(input.payload, '$.rows') AS request
        INNER JOIN audit_log AS current_audit
          ON current_audit.id = json_extract(request.value, '$.auditId')
        WHERE current_audit.organization_id = json_extract(input.payload, '$.organizationId')
          AND current_audit.field_id = json_extract(request.value, '$.after.fieldId')
          AND current_audit.actor = json_extract(input.payload, '$.actor')
          AND current_audit.action = json_extract(request.value, '$.action')
          AND current_audit.entity_type = 'livestock_milk_control'
          AND current_audit.entity_id = json_extract(request.value, '$.after.id')
          AND current_audit.before IS json_extract(request.value, '$.before')
          AND current_audit.after IS json_extract(request.value, '$.after')
          AND current_audit.source_record_id IS json_extract(request.value, '$.after.sourceRecordId')
          AND current_audit.occurred_at = json_extract(input.payload, '$.occurredAt')
      ) = json_array_length(input.payload, '$.rows')
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(input.payload, '$.rows') AS request
        WHERE NOT EXISTS (
          SELECT 1
          FROM livestock_milk_controls AS saved
          INNER JOIN livestock_animals AS saved_animal ON saved_animal.id = saved.animal_id
          INNER JOIN livestock_lots AS saved_lot ON saved_lot.id = saved_animal.lot_id
          INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
          WHERE saved.id = json_extract(request.value, '$.after.id')
            AND saved.field_id = json_extract(request.value, '$.after.fieldId')
            AND saved.animal_id = json_extract(request.value, '$.after.animalId')
            AND saved.lactation_id IS json_extract(request.value, '$.after.lactationId')
            AND saved.lactation_id IS (
              SELECT eligible_lactation.id
              FROM livestock_lactations AS eligible_lactation
              WHERE eligible_lactation.animal_id = saved.animal_id
                AND eligible_lactation.field_id = saved.field_id
                AND eligible_lactation.started_at <= saved.control_date
                AND (eligible_lactation.ended_at IS NULL OR eligible_lactation.ended_at >= saved.control_date)
              ORDER BY eligible_lactation.started_at DESC, eligible_lactation.id DESC
              LIMIT 1
            )
            AND saved.control_date = json_extract(request.value, '$.after.controlDate')
            AND saved.morning_liters IS json_extract(request.value, '$.after.morningLiters')
            AND saved.afternoon_liters IS json_extract(request.value, '$.after.afternoonLiters')
            AND saved.third_milking_liters IS json_extract(request.value, '$.after.thirdMilkingLiters')
            AND saved.total_liters IS json_extract(request.value, '$.after.totalLiters')
            AND saved.fat_pct IS json_extract(request.value, '$.after.fatPct')
            AND saved.protein_pct IS json_extract(request.value, '$.after.proteinPct')
            AND saved.somatic_cell_count IS json_extract(request.value, '$.after.somaticCellCount')
            AND saved.notes = json_extract(request.value, '$.after.notes')
            AND saved.source = json_extract(request.value, '$.after.source')
            AND saved.source_record_id IS json_extract(request.value, '$.after.sourceRecordId')
            AND saved.created_by = json_extract(request.value, '$.after.createdBy')
            AND saved.created_at = json_extract(request.value, '$.after.createdAt')
            AND saved.updated_at = json_extract(request.value, '$.after.updatedAt')
            AND saved_animal.sex <> 'male'
            AND saved_lot.field_id = saved.field_id
            AND saved_field.organization_id = json_extract(input.payload, '$.organizationId')
            AND saved_field.id IN (SELECT value FROM json_each(input.payload, '$.fieldIds'))
        )
      )
    )
  `).bind(payload);
  let batchResults;
  try {
    batchResults = await client.batch([
      auditStatement,
      mutationStatement,
      assertionStatement,
    ]);
  } catch (cause) {
    if (
      cause instanceof Error
      && cause.message.includes("NOT NULL constraint failed: audit_log.id")
    ) {
      throw new MilkOperationConflictError(
        "Uno de los animales, lactancias o controles cambió mientras se guardaba la carga masiva.",
      );
    }
    throw cause;
  }
  const [auditResult, mutationResult, assertionResult] = batchResults;
  if (
    auditResult.meta.changes !== rows.length
    || mutationResult.meta.changes !== rows.length
    || assertionResult.meta.changes !== 0
  ) {
    throw new MilkOperationConflictError(
      "Uno de los animales, lactancias o controles cambió mientras se guardaba la carga masiva.",
    );
  }
  return {
    savedCount: rows.length,
    fieldIds: [...new Set(preparedRows.map((row) => row.after.fieldId))],
  };
}

function bulkMilkControlWriteGuardSql(): string {
  return `
    json_array_length(input.payload, '$.rows') BETWEEN 1 AND 200
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(input.payload, '$.rows') AS candidate
      WHERE NOT EXISTS (
        SELECT 1
        FROM livestock_animals AS current_animal
        INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
        INNER JOIN fields AS current_field ON current_field.id = current_lot.field_id
        WHERE current_animal.id = json_extract(candidate.value, '$.after.animalId')
          AND current_animal.sex <> 'male'
          AND current_lot.field_id = json_extract(candidate.value, '$.after.fieldId')
          AND current_field.organization_id = json_extract(input.payload, '$.organizationId')
          AND current_field.id IN (SELECT value FROM json_each(input.payload, '$.fieldIds'))
      )
        OR NOT (
          json_extract(candidate.value, '$.after.lactationId') IS (
            SELECT eligible_lactation.id
            FROM livestock_lactations AS eligible_lactation
            WHERE eligible_lactation.animal_id = json_extract(candidate.value, '$.after.animalId')
              AND eligible_lactation.field_id = json_extract(candidate.value, '$.after.fieldId')
              AND eligible_lactation.started_at <= json_extract(candidate.value, '$.after.controlDate')
              AND (
                eligible_lactation.ended_at IS NULL
                OR eligible_lactation.ended_at >= json_extract(candidate.value, '$.after.controlDate')
              )
            ORDER BY eligible_lactation.started_at DESC, eligible_lactation.id DESC
            LIMIT 1
          )
        )
        OR NOT (
          (
            json_type(candidate.value, '$.before') = 'null'
            AND NOT EXISTS (
              SELECT 1
              FROM livestock_milk_controls AS competing_control
              WHERE competing_control.id = json_extract(candidate.value, '$.after.id')
                OR (
                  competing_control.animal_id = json_extract(candidate.value, '$.after.animalId')
                  AND competing_control.control_date = json_extract(candidate.value, '$.after.controlDate')
                )
            )
          )
          OR (
            json_type(candidate.value, '$.before') = 'object'
            AND json_extract(candidate.value, '$.before.fieldId') = json_extract(candidate.value, '$.after.fieldId')
            AND EXISTS (
              SELECT 1
              FROM livestock_milk_controls AS current_control
              WHERE current_control.id = json_extract(candidate.value, '$.before.id')
                AND current_control.field_id = json_extract(candidate.value, '$.before.fieldId')
                AND current_control.animal_id = json_extract(candidate.value, '$.before.animalId')
                AND current_control.lactation_id IS json_extract(candidate.value, '$.before.lactationId')
                AND current_control.control_date = json_extract(candidate.value, '$.before.controlDate')
                AND current_control.morning_liters IS json_extract(candidate.value, '$.before.morningLiters')
                AND current_control.afternoon_liters IS json_extract(candidate.value, '$.before.afternoonLiters')
                AND current_control.third_milking_liters IS json_extract(candidate.value, '$.before.thirdMilkingLiters')
                AND current_control.total_liters IS json_extract(candidate.value, '$.before.totalLiters')
                AND current_control.fat_pct IS json_extract(candidate.value, '$.before.fatPct')
                AND current_control.protein_pct IS json_extract(candidate.value, '$.before.proteinPct')
                AND current_control.somatic_cell_count IS json_extract(candidate.value, '$.before.somaticCellCount')
                AND current_control.notes = json_extract(candidate.value, '$.before.notes')
                AND current_control.source = json_extract(candidate.value, '$.before.source')
                AND current_control.source_record_id IS json_extract(candidate.value, '$.before.sourceRecordId')
                AND current_control.created_by = json_extract(candidate.value, '$.before.createdBy')
                AND current_control.created_at = json_extract(candidate.value, '$.before.createdAt')
                AND current_control.updated_at = json_extract(candidate.value, '$.before.updatedAt')
            )
          )
        )
    )
  `;
}

async function assertFieldOrganization(
  fieldId: string,
  organizationId: string,
): Promise<void> {
  const [field] = await getDb()
    .select({ organizationId: fields.organizationId })
    .from(fields)
    .where(eq(fields.id, fieldId))
    .limit(1);
  if (!field || field.organizationId !== organizationId) {
    throw new MilkOperationConflictError(
      "El fundo no existe o no pertenece a la organización activa.",
    );
  }
}

function assertExistingScope(
  existing: { fieldId: string; organizationId: string } | undefined,
  fieldId: string,
  organizationId: string,
): void {
  if (
    existing &&
    (existing.fieldId !== fieldId || existing.organizationId !== organizationId)
  ) {
    throw new MilkOperationConflictError(
      "El registro no existe o no está disponible para tu membresía.",
    );
  }
}

async function assertMilkOperationFieldScope(
  fieldId: string,
  context: MilkOperationWriteContext,
): Promise<void> {
  if (!context.fieldIds.includes(fieldId)) {
    throw new MilkOperationConflictError(
      "El fundo no existe o no está disponible para tu membresía.",
    );
  }
  await assertFieldOrganization(fieldId, context.organizationId);
}

function nextUpdatedAt(previous?: string): string {
  const now = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(
    Number.isFinite(previousTime) && previousTime >= now
      ? previousTime + 1
      : now,
  ).toISOString();
}

function assertExpectedUpdatedAt(
  expectedUpdatedAt: string,
  actualUpdatedAt: string,
): void {
  if (!expectedUpdatedAt || expectedUpdatedAt !== actualUpdatedAt) {
    throw new MilkOperationConflictError();
  }
}

function assertAtomicWrite(auditChanges: number, mutationChanges: number): void {
  if (auditChanges !== 1 || mutationChanges !== 1) {
    throw new MilkOperationConflictError();
  }
}

function prepareConditionalMilkAudit(client: D1Client, input: {
  id?: string;
  context: MilkOperationWriteContext;
  action: string;
  entityType: string;
  entityId: string;
  fieldId: string;
  before: unknown;
  after: unknown;
  sourceRecordId: string | null;
  occurredAt: string;
  guardSql: string;
  guardBindings: D1Binding[];
}) {
  const before = toAuditRecord(input.before);
  const after = toAuditRecord(input.after);
  return client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${input.guardSql}
  `).bind(
    input.id ?? crypto.randomUUID(),
    input.context.organizationId,
    input.fieldId,
    input.context.actor,
    input.action,
    input.entityType,
    input.entityId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    input.sourceRecordId,
    input.occurredAt,
    ...input.guardBindings,
  );
}

function prepareMilkOperationAssertion(client: D1Client, input: {
  auditId: string;
  context: MilkOperationWriteContext;
  action: string;
  entityType: string;
  entityId: string;
  fieldId: string;
  before: unknown;
  after: unknown;
  sourceRecordId: string | null;
  occurredAt: string;
  postconditionSql: string;
  postconditionBindings: D1Binding[];
}) {
  const before = toAuditRecord(input.before);
  const after = toAuditRecord(input.after);
  return client.prepare(`
    SELECT CASE WHEN (
      changes() = 1
      AND EXISTS (
        SELECT 1 FROM audit_log AS current_audit
        WHERE current_audit.id = ?
          AND current_audit.organization_id = ?
          AND current_audit.field_id = ?
          AND current_audit.actor = ?
          AND current_audit.action = ?
          AND current_audit.entity_type = ?
          AND current_audit.entity_id = ?
          AND current_audit.before IS ?
          AND current_audit.after IS ?
          AND current_audit.source_record_id IS ?
          AND current_audit.occurred_at = ?
      )
      AND (${input.postconditionSql})
    ) THEN 1 ELSE json_extract('fundosmart_milk_operation_postcondition_failed', '$') END
      AS milk_operation_postcondition
  `).bind(
    input.auditId,
    input.context.organizationId,
    input.fieldId,
    input.context.actor,
    input.action,
    input.entityType,
    input.entityId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    input.sourceRecordId,
    input.occurredAt,
    ...input.postconditionBindings,
  );
}

async function executeMilkOperationBatch<T extends D1PreparedStatement[]>(
  client: D1Client,
  statements: T,
) {
  try {
    return await client.batch(statements);
  } catch (cause) {
    if (
      cause instanceof Error
      && cause.message.includes("malformed JSON")
    ) {
      throw new MilkOperationConflictError();
    }
    throw cause;
  }
}

function bulkProductionSnapshotGuardSql(): string {
  return `
    id = ? AND organization_id IS ? AND field_id IS ? AND recorded_at IS ?
    AND kind IS ? AND volume_liters IS ? AND source IS ? AND source_record_id IS ?
    AND notes IS ? AND created_by IS ? AND created_at IS ? AND updated_at IS ?
    AND EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = milk_bulk_production.field_id
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT value FROM json_each(?))
    )
  `;
}

function bulkProductionSnapshotBindings(
  row: BulkProductionRow,
  context: MilkOperationWriteContext,
): D1Binding[] {
  return [
    row.id,
    row.organizationId,
    row.fieldId,
    row.recordedAt,
    row.kind,
    row.volumeLiters,
    row.source,
    row.sourceRecordId,
    row.notes,
    row.createdBy,
    row.createdAt,
    row.updatedAt,
    context.organizationId,
    JSON.stringify(context.fieldIds),
  ];
}

function qualitySampleSnapshotGuardSql(): string {
  return `
    id = ? AND organization_id IS ? AND field_id IS ? AND sampled_at IS ?
    AND period IS ? AND kind IS ? AND fat_percent IS ? AND protein_percent IS ?
    AND total_solids_percent IS ? AND somatic_cell_count IS ?
    AND somatic_cell_count_unit IS ? AND bacterial_count IS ?
    AND bacterial_count_unit IS ? AND sanitary_flags IS ? AND source IS ?
    AND source_record_id IS ? AND notes IS ? AND created_by IS ?
    AND created_at IS ? AND updated_at IS ?
    AND EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = milk_quality_samples.field_id
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT value FROM json_each(?))
    )
  `;
}

function qualitySampleSnapshotBindings(
  row: QualitySampleRow,
  context: MilkOperationWriteContext,
): D1Binding[] {
  return [
    row.id,
    row.organizationId,
    row.fieldId,
    row.sampledAt,
    row.period,
    row.kind,
    row.fatPercent,
    row.proteinPercent,
    row.totalSolidsPercent,
    row.somaticCellCount,
    row.somaticCellCountUnit,
    row.bacterialCount,
    row.bacterialCountUnit,
    JSON.stringify(row.sanitaryFlags),
    row.source,
    row.sourceRecordId,
    row.notes,
    row.createdBy,
    row.createdAt,
    row.updatedAt,
    context.organizationId,
    JSON.stringify(context.fieldIds),
  ];
}

function pabcoItemSnapshotGuardSql(): string {
  return `
    id = ? AND organization_id IS ? AND field_id IS ? AND requirement IS ?
    AND status IS ? AND evidence_document_id IS ? AND valid_from IS ?
    AND valid_until IS ? AND reminder_at IS ? AND source IS ?
    AND source_record_id IS ? AND notes IS ? AND created_by IS ?
    AND created_at IS ? AND updated_at IS ?
    AND EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = pabco_compliance_items.field_id
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT value FROM json_each(?))
    )
  `;
}

function pabcoItemSnapshotBindings(
  row: PabcoItemRow,
  context: MilkOperationWriteContext,
): D1Binding[] {
  return [
    row.id,
    row.organizationId,
    row.fieldId,
    row.requirement,
    row.status,
    row.evidenceDocumentId,
    row.validFrom,
    row.validUntil,
    row.reminderAt,
    row.source,
    row.sourceRecordId,
    row.notes,
    row.createdBy,
    row.createdAt,
    row.updatedAt,
    context.organizationId,
    JSON.stringify(context.fieldIds),
  ];
}

function pabcoEvidenceReferenceGuardSql(): string {
  return `(
    ? IS NULL
    OR EXISTS (
      SELECT 1 FROM pabco_evidence_documents AS stored_evidence
      WHERE stored_evidence.id = ?
        AND stored_evidence.organization_id = ?
        AND stored_evidence.field_id = ?
        AND stored_evidence.status = 'stored'
        AND stored_evidence.etag IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM audit_log AS legacy_evidence
      WHERE legacy_evidence.entity_id = ?
        AND legacy_evidence.organization_id = ?
        AND legacy_evidence.field_id = ?
        AND legacy_evidence.action = 'pabco.evidence.uploaded'
        AND legacy_evidence.entity_type = 'pabco_evidence_document'
    )
  )`;
}

function pabcoEvidenceReferenceGuardBindings(
  evidenceDocumentId: string | null,
  organizationId: string,
  fieldId: string,
): D1Binding[] {
  return [
    evidenceDocumentId,
    evidenceDocumentId,
    organizationId,
    fieldId,
    evidenceDocumentId,
    organizationId,
    fieldId,
  ];
}

function prepareBulkProductionSelect(
  client: D1Client,
  id: string,
  fieldId: string,
  updatedAt: string,
  context: MilkOperationWriteContext,
) {
  return client.prepare(`
    SELECT
      saved.id, saved.organization_id AS "organizationId", saved.field_id AS "fieldId",
      saved.recorded_at AS "recordedAt", saved.kind, saved.volume_liters AS "volumeLiters",
      saved.source, saved.source_record_id AS "sourceRecordId", saved.notes,
      saved.created_by AS "createdBy", saved.created_at AS "createdAt",
      saved.updated_at AS "updatedAt"
    FROM milk_bulk_production AS saved
    INNER JOIN fields AS saved_field ON saved_field.id = saved.field_id
    WHERE saved.id = ? AND saved.field_id = ? AND saved.updated_at = ?
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT value FROM json_each(?))
    LIMIT 1
  `).bind(id, fieldId, updatedAt, context.organizationId, JSON.stringify(context.fieldIds));
}

function prepareQualitySampleSelect(
  client: D1Client,
  id: string,
  fieldId: string,
  updatedAt: string,
  context: MilkOperationWriteContext,
) {
  return client.prepare(`
    SELECT
      saved.id, saved.organization_id AS "organizationId", saved.field_id AS "fieldId",
      saved.sampled_at AS "sampledAt", saved.period, saved.kind,
      saved.fat_percent AS "fatPercent", saved.protein_percent AS "proteinPercent",
      saved.total_solids_percent AS "totalSolidsPercent",
      saved.somatic_cell_count AS "somaticCellCount",
      saved.somatic_cell_count_unit AS "somaticCellCountUnit",
      saved.bacterial_count AS "bacterialCount",
      saved.bacterial_count_unit AS "bacterialCountUnit",
      saved.sanitary_flags AS "sanitaryFlags", saved.source,
      saved.source_record_id AS "sourceRecordId", saved.notes,
      saved.created_by AS "createdBy", saved.created_at AS "createdAt",
      saved.updated_at AS "updatedAt"
    FROM milk_quality_samples AS saved
    INNER JOIN fields AS saved_field ON saved_field.id = saved.field_id
    WHERE saved.id = ? AND saved.field_id = ? AND saved.updated_at = ?
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT value FROM json_each(?))
    LIMIT 1
  `).bind(id, fieldId, updatedAt, context.organizationId, JSON.stringify(context.fieldIds));
}

function preparePabcoItemSelect(
  client: D1Client,
  id: string,
  fieldId: string,
  updatedAt: string,
  context: MilkOperationWriteContext,
) {
  return client.prepare(`
    SELECT
      saved.id, saved.organization_id AS "organizationId", saved.field_id AS "fieldId",
      saved.requirement, saved.status,
      saved.evidence_document_id AS "evidenceDocumentId",
      saved.valid_from AS "validFrom", saved.valid_until AS "validUntil",
      saved.reminder_at AS "reminderAt", saved.source,
      saved.source_record_id AS "sourceRecordId", saved.notes,
      saved.created_by AS "createdBy", saved.created_at AS "createdAt",
      saved.updated_at AS "updatedAt"
    FROM pabco_compliance_items AS saved
    INNER JOIN fields AS saved_field ON saved_field.id = saved.field_id
    WHERE saved.id = ? AND saved.field_id = ? AND saved.updated_at = ?
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT value FROM json_each(?))
    LIMIT 1
  `).bind(id, fieldId, updatedAt, context.organizationId, JSON.stringify(context.fieldIds));
}

function toMilkQualitySample(row: PreparedQualitySampleRow): MilkQualitySample {
  return {
    ...row,
    sanitaryFlags:
      typeof row.sanitaryFlags === "string"
        ? JSON.parse(row.sanitaryFlags) as QualitySampleRow["sanitaryFlags"]
        : row.sanitaryFlags,
  };
}

function toAuditRecord(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined
    ? null
    : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}
