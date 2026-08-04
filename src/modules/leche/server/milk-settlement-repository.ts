import { getDb } from "@/db";
import { fields, milkSettlements } from "@/db/schema";
import type { MilkSettlement } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import {
  deriveMilkSettlementPrices,
  milkSettlementIntegrityIssues,
} from "@/src/modules/leche/server/milk-settlement-integrity.mjs";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

type SettlementRow = typeof milkSettlements.$inferSelect;
type PreparedSettlementRow = Omit<SettlementRow, "lineItems"> & {
  lineItems: SettlementRow["lineItems"] | string;
};
type D1Binding = string | number | null;
type D1Client = ReturnType<typeof getDb>["$client"];

function toSettlement(row: PreparedSettlementRow): MilkSettlement {
  return {
    id: row.id,
    fieldId: row.fieldId,
    period: row.period,
    generatedAt: row.generatedAt,
    plant: row.plant,
    purchaseOrder: row.purchaseOrder,
    producerCode: row.producerCode,
    producerName: row.producerName,
    buyerName: row.buyerName,
    litersFirstHalf: row.litersFirstHalf,
    litersSecondHalf: row.litersSecondHalf,
    totalLiters: row.totalLiters,
    netAmountClp: row.netAmountClp,
    taxAmountClp: row.taxAmountClp,
    grossAmountClp: row.grossAmountClp,
    netPricePerLiterClp: row.netPricePerLiterClp,
    grossPricePerLiterClp: row.grossPricePerLiterClp,
    sourceDocumentName: row.sourceDocumentName,
    notes: row.notes,
    lineItems: typeof row.lineItems === "string"
      ? JSON.parse(row.lineItems) as SettlementRow["lineItems"]
      : row.lineItems,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nextUpdatedAt(previous?: string): string {
  const now = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(previousTime) && previousTime >= now ? previousTime + 1 : now).toISOString();
}

export async function listMilkSettlements(scope: OrganizationFieldScope): Promise<MilkSettlement[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ settlement: milkSettlements })
    .from(milkSettlements)
    .innerJoin(fields, eq(fields.id, milkSettlements.fieldId))
    .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
    .orderBy(desc(milkSettlements.period), asc(milkSettlements.purchaseOrder));
  return rows.map(({ settlement }) => toSettlement(settlement));
}

export async function upsertMilkSettlement(
  settlementInput: MilkSettlement,
  scope: AccessContext,
): Promise<MilkSettlement> {
  const requestedSettlement = deriveMilkSettlementPrices(settlementInput);
  const db = getDb();
  await assertFieldInScope(requestedSettlement.fieldId, scope);
  const [existingRow] = await db
    .select({ settlement: milkSettlements })
    .from(milkSettlements)
    .where(eq(milkSettlements.id, requestedSettlement.id))
    .limit(1);
  const existing = existingRow?.settlement;
  if (existing) await assertFieldInScope(existing.fieldId, scope, "El identificador de la liquidación no está disponible.");
  const writeTimestamp = nextUpdatedAt(existing?.updatedAt);
  const settlement: MilkSettlement = existing
    ? { ...requestedSettlement, createdAt: existing.createdAt }
    : { ...requestedSettlement, createdAt: writeTimestamp, updatedAt: writeTimestamp };
  assertMilkSettlementIntegrity(settlement);
  if (existing && settlement.updatedAt !== existing.updatedAt) {
    throwFieldScopeConflict("La liquidación cambió desde la última carga.");
  }

  const values = {
    id: settlement.id,
    fieldId: settlement.fieldId,
    period: settlement.period,
    generatedAt: settlement.generatedAt,
    plant: settlement.plant,
    purchaseOrder: settlement.purchaseOrder,
    producerCode: settlement.producerCode,
    producerName: settlement.producerName,
    buyerName: settlement.buyerName,
    litersFirstHalf: settlement.litersFirstHalf,
    litersSecondHalf: settlement.litersSecondHalf,
    totalLiters: settlement.totalLiters,
    netAmountClp: settlement.netAmountClp,
    taxAmountClp: settlement.taxAmountClp,
    grossAmountClp: settlement.grossAmountClp,
    netPricePerLiterClp: settlement.netPricePerLiterClp,
    grossPricePerLiterClp: settlement.grossPricePerLiterClp,
    sourceDocumentName: settlement.sourceDocumentName,
    notes: settlement.notes,
    lineItems: settlement.lineItems,
    updatedAt: writeTimestamp,
  };
  const expectedSettlement: MilkSettlement = {
    ...settlement,
    ...values,
    createdAt: existing?.createdAt ?? settlement.createdAt,
  };
  const beforeSettlement = existing ? toSettlement(existing) : null;
  const client = db.$client;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const auditId = crypto.randomUUID();
  const auditAction = existing ? "milk_settlement.updated" : "milk_settlement.created";
  const auditGuardSql = existing
    ? `EXISTS (
      SELECT 1 FROM milk_settlements AS auditable_settlement
      WHERE ${settlementSnapshotSql("auditable_settlement")}
        AND ${currentSettlementWriteAccessSql()}
        AND ${currentSettlementWriteAccessSql()}
        AND NOT EXISTS (
          SELECT 1 FROM milk_settlements AS conflicting_order
          WHERE conflicting_order.field_id = ?
            AND conflicting_order.purchase_order = ?
            AND conflicting_order.id <> ?
        )
    )`
    : `${currentSettlementWriteAccessSql()}
      AND NOT EXISTS (
        SELECT 1 FROM milk_settlements AS existing_id WHERE existing_id.id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM milk_settlements AS existing_order
        WHERE existing_order.field_id = ?
          AND existing_order.purchase_order = ?
      )`;
  const auditGuardBindings = existing
    ? [
      ...settlementSnapshotBindings(beforeSettlement!),
      ...currentSettlementWriteAccessBindings(beforeSettlement!.fieldId, scope),
      ...currentSettlementWriteAccessBindings(expectedSettlement.fieldId, scope),
      expectedSettlement.fieldId,
      expectedSettlement.purchaseOrder,
      expectedSettlement.id,
    ]
    : [
      ...currentSettlementWriteAccessBindings(expectedSettlement.fieldId, scope),
      expectedSettlement.id,
      expectedSettlement.fieldId,
      expectedSettlement.purchaseOrder,
    ];
  const auditStatement = prepareSettlementAudit(client, {
    id: auditId,
    scope,
    action: auditAction,
    fieldId: expectedSettlement.fieldId,
    entityId: expectedSettlement.id,
    before: beforeSettlement,
    after: expectedSettlement,
    occurredAt: values.updatedAt,
    guardSql: auditGuardSql,
    guardBindings: auditGuardBindings,
  });
  const mutation = existing
    ? client.prepare(`
      UPDATE milk_settlements
      SET field_id = ?, period = ?, generated_at = ?, plant = ?, purchase_order = ?,
          producer_code = ?, producer_name = ?, buyer_name = ?, liters_first_half = ?,
          liters_second_half = ?, total_liters = ?, net_amount_clp = ?, tax_amount_clp = ?,
          gross_amount_clp = ?, net_price_per_liter_clp = ?, gross_price_per_liter_clp = ?,
          source_document_name = ?, notes = ?, line_items = ?, updated_at = ?
      WHERE id = ? AND field_id IS ? AND period IS ? AND generated_at IS ? AND plant IS ?
        AND purchase_order IS ? AND producer_code IS ? AND producer_name IS ? AND buyer_name IS ?
        AND liters_first_half IS ? AND liters_second_half IS ? AND total_liters IS ?
        AND net_amount_clp IS ? AND tax_amount_clp IS ? AND gross_amount_clp IS ?
        AND net_price_per_liter_clp IS ? AND gross_price_per_liter_clp IS ?
        AND source_document_name IS ? AND notes IS ? AND line_items IS ?
        AND created_at IS ? AND updated_at IS ?
        AND ${currentSettlementWriteAccessSql()}
        AND ${currentSettlementWriteAccessSql()}
        AND NOT EXISTS (
          SELECT 1 FROM milk_settlements AS conflicting_order
          WHERE conflicting_order.field_id = ?
            AND conflicting_order.purchase_order = ?
            AND conflicting_order.id <> ?
        )
    `).bind(
      values.fieldId,
      values.period,
      values.generatedAt,
      values.plant,
      values.purchaseOrder,
      values.producerCode,
      values.producerName,
      values.buyerName,
      values.litersFirstHalf,
      values.litersSecondHalf,
      values.totalLiters,
      values.netAmountClp,
      values.taxAmountClp,
      values.grossAmountClp,
      values.netPricePerLiterClp,
      values.grossPricePerLiterClp,
      values.sourceDocumentName,
      values.notes,
      JSON.stringify(values.lineItems),
      values.updatedAt,
      settlement.id,
      existing.fieldId,
      existing.period,
      existing.generatedAt,
      existing.plant,
      existing.purchaseOrder,
      existing.producerCode,
      existing.producerName,
      existing.buyerName,
      existing.litersFirstHalf,
      existing.litersSecondHalf,
      existing.totalLiters,
      existing.netAmountClp,
      existing.taxAmountClp,
      existing.grossAmountClp,
      existing.netPricePerLiterClp,
      existing.grossPricePerLiterClp,
      existing.sourceDocumentName,
      existing.notes,
      JSON.stringify(existing.lineItems),
      existing.createdAt,
      existing.updatedAt,
      ...currentSettlementWriteAccessBindings(existing.fieldId, scope),
      ...currentSettlementWriteAccessBindings(settlement.fieldId, scope),
      settlement.fieldId,
      settlement.purchaseOrder,
      settlement.id,
    )
    : client.prepare(`
      INSERT INTO milk_settlements (
        id, field_id, period, generated_at, plant, purchase_order, producer_code,
        producer_name, buyer_name, liters_first_half, liters_second_half, total_liters,
        net_amount_clp, tax_amount_clp, gross_amount_clp, net_price_per_liter_clp,
        gross_price_per_liter_clp, source_document_name, notes, line_items, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${currentSettlementWriteAccessSql()}
        AND NOT EXISTS (
          SELECT 1 FROM milk_settlements AS existing_id WHERE existing_id.id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM milk_settlements AS existing_order
          WHERE existing_order.field_id = ?
            AND existing_order.purchase_order = ?
        )
    `).bind(
      settlement.id,
      values.fieldId,
      values.period,
      values.generatedAt,
      values.plant,
      values.purchaseOrder,
      values.producerCode,
      values.producerName,
      values.buyerName,
      values.litersFirstHalf,
      values.litersSecondHalf,
      values.totalLiters,
      values.netAmountClp,
      values.taxAmountClp,
      values.grossAmountClp,
      values.netPricePerLiterClp,
      values.grossPricePerLiterClp,
      values.sourceDocumentName,
      values.notes,
      JSON.stringify(values.lineItems),
      settlement.createdAt,
      values.updatedAt,
      ...currentSettlementWriteAccessBindings(settlement.fieldId, scope),
      settlement.id,
      settlement.fieldId,
      settlement.purchaseOrder,
    );
  const savedStatement = client.prepare(`
    SELECT
      saved_settlement.id,
      saved_settlement.field_id AS "fieldId",
      saved_settlement.period,
      saved_settlement.generated_at AS "generatedAt",
      saved_settlement.plant,
      saved_settlement.purchase_order AS "purchaseOrder",
      saved_settlement.producer_code AS "producerCode",
      saved_settlement.producer_name AS "producerName",
      saved_settlement.buyer_name AS "buyerName",
      saved_settlement.liters_first_half AS "litersFirstHalf",
      saved_settlement.liters_second_half AS "litersSecondHalf",
      saved_settlement.total_liters AS "totalLiters",
      saved_settlement.net_amount_clp AS "netAmountClp",
      saved_settlement.tax_amount_clp AS "taxAmountClp",
      saved_settlement.gross_amount_clp AS "grossAmountClp",
      saved_settlement.net_price_per_liter_clp AS "netPricePerLiterClp",
      saved_settlement.gross_price_per_liter_clp AS "grossPricePerLiterClp",
      saved_settlement.source_document_name AS "sourceDocumentName",
      saved_settlement.notes,
      saved_settlement.line_items AS "lineItems",
      saved_settlement.created_at AS "createdAt",
      saved_settlement.updated_at AS "updatedAt"
    FROM milk_settlements AS saved_settlement
    INNER JOIN fields AS saved_field ON saved_field.id = saved_settlement.field_id
    WHERE saved_settlement.id = ?
      AND saved_settlement.field_id = ?
      AND saved_settlement.updated_at = ?
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT value FROM json_each(?))
    LIMIT 1
  `).bind(settlement.id, settlement.fieldId, values.updatedAt, scope.organizationId, fieldIdsJson);
  const assertion = client.prepare(`
    SELECT CASE WHEN (
      changes() = 1
      AND ${settlementAuditExistsSql()}
      AND EXISTS (
        SELECT 1 FROM milk_settlements AS verified_settlement
        WHERE ${settlementSnapshotSql("verified_settlement")}
          AND ${currentSettlementWriteAccessSql()}
      )
    ) THEN 1 ELSE json_extract('fundosmart_milk_settlement_postcondition_failed', '$') END
      AS milk_settlement_postcondition
  `).bind(
    ...settlementAuditBindings({
      id: auditId,
      scope,
      action: auditAction,
      fieldId: expectedSettlement.fieldId,
      entityId: expectedSettlement.id,
      before: beforeSettlement,
      after: expectedSettlement,
      occurredAt: values.updatedAt,
    }),
    ...settlementSnapshotBindings(expectedSettlement),
    ...currentSettlementWriteAccessBindings(expectedSettlement.fieldId, scope),
  );
  let batchResults;
  try {
    batchResults = await client.batch([auditStatement, mutation, savedStatement, assertion]);
  } catch (cause) {
    if (isSettlementPostconditionFailure(cause)) {
      throwFieldScopeConflict("La liquidación cambió durante la operación.");
    }
    throw cause;
  }
  const [auditResult, result, savedResult] = batchResults;
  if (auditResult.meta.changes !== 1 || result.meta.changes !== 1) {
    throwFieldScopeConflict("El identificador de la liquidación no está disponible.");
  }
  const saved = savedResult.results[0] as PreparedSettlementRow | undefined;
  if (!saved) throwFieldScopeConflict("El identificador de la liquidación no está disponible.");
  return toSettlement(saved);
}

export async function deleteMilkSettlement(
  id: string,
  scope: AccessContext,
  expectedUpdatedAt: string,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existingRow] = await db
    .select({ settlement: milkSettlements })
    .from(milkSettlements)
    .innerJoin(fields, eq(fields.id, milkSettlements.fieldId))
    .where(and(
      eq(milkSettlements.id, id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  const existing = existingRow?.settlement;
  if (!existing) return false;
  if (!expectedUpdatedAt || expectedUpdatedAt !== existing.updatedAt) {
    throwFieldScopeConflict("La liquidación cambió desde la última carga.");
  }
  const client = db.$client;
  const beforeSettlement = toSettlement(existing);
  const occurredAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const auditAction = "milk_settlement.deleted";
  const deletion = client.prepare(`
    DELETE FROM milk_settlements
    WHERE id = ? AND field_id IS ? AND period IS ? AND generated_at IS ? AND plant IS ?
      AND purchase_order IS ? AND producer_code IS ? AND producer_name IS ? AND buyer_name IS ?
      AND liters_first_half IS ? AND liters_second_half IS ? AND total_liters IS ?
      AND net_amount_clp IS ? AND tax_amount_clp IS ? AND gross_amount_clp IS ?
      AND net_price_per_liter_clp IS ? AND gross_price_per_liter_clp IS ?
      AND source_document_name IS ? AND notes IS ? AND line_items IS ?
      AND created_at IS ? AND updated_at IS ?
      AND ${currentSettlementWriteAccessSql()}
  `).bind(
    ...settlementSnapshotBindings(beforeSettlement),
    ...currentSettlementWriteAccessBindings(beforeSettlement.fieldId, scope),
  );
  const auditGuardSql = `EXISTS (
    SELECT 1 FROM milk_settlements AS auditable_settlement
    WHERE ${settlementSnapshotSql("auditable_settlement")}
      AND ${currentSettlementWriteAccessSql()}
  )`;
  const auditStatement = prepareSettlementAudit(client, {
    id: auditId,
    scope,
    action: auditAction,
    fieldId: beforeSettlement.fieldId,
    entityId: beforeSettlement.id,
    before: beforeSettlement,
    after: null,
    occurredAt,
    guardSql: auditGuardSql,
    guardBindings: [
      ...settlementSnapshotBindings(beforeSettlement),
      ...currentSettlementWriteAccessBindings(beforeSettlement.fieldId, scope),
    ],
  });
  const assertion = client.prepare(`
    SELECT CASE WHEN (
      changes() = 1
      AND ${settlementAuditExistsSql()}
      AND NOT EXISTS (SELECT 1 FROM milk_settlements WHERE id = ?)
      AND ${currentSettlementWriteAccessSql()}
    ) THEN 1 ELSE json_extract('fundosmart_milk_settlement_postcondition_failed', '$') END
      AS milk_settlement_postcondition
  `).bind(
    ...settlementAuditBindings({
      id: auditId,
      scope,
      action: auditAction,
      fieldId: beforeSettlement.fieldId,
      entityId: beforeSettlement.id,
      before: beforeSettlement,
      after: null,
      occurredAt,
    }),
    id,
    ...currentSettlementWriteAccessBindings(beforeSettlement.fieldId, scope),
  );
  let batchResults;
  try {
    batchResults = await client.batch([auditStatement, deletion, assertion]);
  } catch (cause) {
    if (isSettlementPostconditionFailure(cause)) {
      throwFieldScopeConflict("La liquidación cambió durante la operación.");
    }
    throw cause;
  }
  const [auditResult, deleted] = batchResults;
  if (auditResult.meta.changes !== 1 || deleted.meta.changes !== 1) {
    throwFieldScopeConflict("La liquidación cambió desde la última carga.");
  }
  return true;
}

export function assertMilkSettlementIntegrity(settlement: MilkSettlement): void {
  const [issue] = milkSettlementIntegrityIssues(settlement);
  if (issue) throwInvalidSettlement(issue);
}

function throwInvalidSettlement(message: string): never {
  throw new DomainRuleError(message, "MILK_SETTLEMENT_INVALID");
}

type SettlementAuditInput = {
  id: string;
  scope: AccessContext;
  action: "milk_settlement.created" | "milk_settlement.updated" | "milk_settlement.deleted";
  fieldId: string;
  entityId: string;
  before: MilkSettlement | null;
  after: MilkSettlement | null;
  occurredAt: string;
};

function prepareSettlementAudit(
  client: D1Client,
  input: SettlementAuditInput & { guardSql: string; guardBindings: D1Binding[] },
) {
  return client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, 'milk_settlement', ?, ?, ?, NULL, ?
    WHERE ${input.guardSql}
  `).bind(
    ...settlementAuditBindings(input),
    ...input.guardBindings,
  );
}

function settlementAuditExistsSql(): string {
  return `EXISTS (
    SELECT 1 FROM audit_log AS current_audit
    WHERE current_audit.id = ?
      AND current_audit.organization_id = ?
      AND current_audit.field_id = ?
      AND current_audit.actor = ?
      AND current_audit.action = ?
      AND current_audit.entity_type = 'milk_settlement'
      AND current_audit.entity_id = ?
      AND current_audit.before IS ?
      AND current_audit.after IS ?
      AND current_audit.source_record_id IS NULL
      AND current_audit.occurred_at = ?
  )`;
}

function settlementAuditBindings(input: SettlementAuditInput): D1Binding[] {
  return [
    input.id,
    input.scope.organizationId,
    input.fieldId,
    input.scope.email.trim().toLowerCase(),
    input.action,
    input.entityId,
    input.before === null ? null : JSON.stringify(input.before),
    input.after === null ? null : JSON.stringify(input.after),
    input.occurredAt,
  ];
}

function currentSettlementWriteAccessSql(): string {
  return `EXISTS (
    SELECT 1
    FROM organization_memberships AS current_membership
    JOIN fields AS authorized_field
      ON authorized_field.id = ?
     AND authorized_field.organization_id = current_membership.organization_id
    LEFT JOIN membership_field_access AS current_field_access
      ON current_field_access.membership_id = current_membership.id
     AND current_field_access.field_id = authorized_field.id
    WHERE current_membership.id = ?
      AND current_membership.organization_id = ?
      AND current_membership.normalized_email = ?
      AND current_membership.status = 'active'
      AND (
        current_membership.role IN ('owner', 'admin')
        OR (
          current_membership.role = 'manager'
          AND current_field_access.field_id IS NOT NULL
        )
      )
  )`;
}

function settlementSnapshotSql(alias: string): string {
  return `
    ${alias}.id IS ? AND ${alias}.field_id IS ? AND ${alias}.period IS ?
    AND ${alias}.generated_at IS ? AND ${alias}.plant IS ?
    AND ${alias}.purchase_order IS ? AND ${alias}.producer_code IS ?
    AND ${alias}.producer_name IS ? AND ${alias}.buyer_name IS ?
    AND ${alias}.liters_first_half IS ? AND ${alias}.liters_second_half IS ?
    AND ${alias}.total_liters IS ? AND ${alias}.net_amount_clp IS ?
    AND ${alias}.tax_amount_clp IS ? AND ${alias}.gross_amount_clp IS ?
    AND ${alias}.net_price_per_liter_clp IS ?
    AND ${alias}.gross_price_per_liter_clp IS ?
    AND ${alias}.source_document_name IS ? AND ${alias}.notes IS ?
    AND ${alias}.line_items IS ? AND ${alias}.created_at IS ?
    AND ${alias}.updated_at IS ?
  `;
}

function settlementSnapshotBindings(settlement: MilkSettlement): D1Binding[] {
  return [
    settlement.id,
    settlement.fieldId,
    settlement.period,
    settlement.generatedAt,
    settlement.plant,
    settlement.purchaseOrder,
    settlement.producerCode,
    settlement.producerName,
    settlement.buyerName,
    settlement.litersFirstHalf,
    settlement.litersSecondHalf,
    settlement.totalLiters,
    settlement.netAmountClp,
    settlement.taxAmountClp,
    settlement.grossAmountClp,
    settlement.netPricePerLiterClp,
    settlement.grossPricePerLiterClp,
    settlement.sourceDocumentName,
    settlement.notes,
    JSON.stringify(settlement.lineItems),
    settlement.createdAt,
    settlement.updatedAt,
  ];
}

function isSettlementPostconditionFailure(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("malformed JSON");
}

function currentSettlementWriteAccessBindings(
  fieldId: string,
  scope: AccessContext,
): D1Binding[] {
  return [
    fieldId,
    scope.membershipId,
    scope.organizationId,
    scope.email.trim().toLowerCase(),
  ];
}
