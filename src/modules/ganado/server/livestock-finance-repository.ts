import { getDb } from "@/db";
import {
  auditLog,
  fields,
  livestockContributions,
  livestockExpenses,
  livestockLots,
  livestockPartners,
} from "@/db/schema";
import type {
  LivestockContribution,
  LivestockExpense,
  LivestockFinanceAuditAction,
  LivestockFinanceAuditEntry,
  LivestockFinanceAuditEntity,
  LivestockPartner,
} from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { ImportRecord } from "@/src/modules/integraciones/cooprinsem/domain/types";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

type PartnerRow = typeof livestockPartners.$inferSelect;
type ContributionRow = typeof livestockContributions.$inferSelect;
type ExpenseRow = typeof livestockExpenses.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;
type SqlBinding = string | number | null;
type SqlCondition = { sql: string; bindings: SqlBinding[] };

const FINANCE_AUDIT_ACTIONS = [
  "finance.partner.created",
  "finance.partner.updated",
  "finance.partner.deleted",
  "finance.contribution.created",
  "finance.contribution.updated",
  "finance.contribution.deleted",
  "finance.expense.created",
  "finance.expense.updated",
  "finance.expense.deleted",
] as const satisfies readonly LivestockFinanceAuditAction[];

const FINANCE_AUDIT_ENTITIES = [
  "livestock_partner",
  "livestock_contribution",
  "livestock_expense",
] as const satisfies readonly LivestockFinanceAuditEntity[];

export type LivestockFinanceData = {
  partners: LivestockPartner[];
  contributions: LivestockContribution[];
  expenses: LivestockExpense[];
};

export type LivestockFinanceReadScope = {
  organizationId: string;
  fieldIds: readonly string[];
  allowOrganizationWide: boolean;
};

export type LivestockFinanceOrganizationWriteScope = {
  organizationId: string;
  actorEmail: string;
};

export type LivestockFinanceOrganizationActorWriteScope = LivestockFinanceOrganizationWriteScope & {
  membershipId: string;
};

export type LivestockFinancePartnerWriteScope = LivestockFinanceOrganizationActorWriteScope;

export type LivestockFinanceContributionWriteScope = LivestockFinanceOrganizationActorWriteScope;

export type LivestockFinanceWriteScope = LivestockFinanceReadScope & {
  actorEmail: string;
};

export type AuditedFinanceMutation<T> = {
  value: T;
  auditEntry: LivestockFinanceAuditEntry;
};

export type AuditedFinanceDelete = {
  deleted: boolean;
  auditEntry: LivestockFinanceAuditEntry | null;
};

async function partnerSnapshotToken(row: PartnerRow): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    email: row.email,
    createdAt: row.createdAt,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `livestock-partner:v1:${hex}`;
}

async function toPartner(row: PartnerRow): Promise<LivestockPartner> {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.createdAt,
    snapshotToken: await partnerSnapshotToken(row),
  };
}

async function contributionSnapshotToken(row: ContributionRow): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    id: row.id,
    organizationId: row.organizationId,
    partnerId: row.partnerId,
    amountClp: row.amountClp,
    date: row.date,
    description: row.description,
    createdAt: row.createdAt,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `livestock-contribution:v1:${hex}`;
}

async function toContribution(row: ContributionRow): Promise<LivestockContribution> {
  return {
    id: row.id,
    partnerId: row.partnerId,
    amountClp: row.amountClp,
    date: row.date,
    description: row.description,
    createdAt: row.createdAt,
    snapshotToken: await contributionSnapshotToken(row),
  };
}

function toExpense(row: ExpenseRow): LivestockExpense {
  return {
    id: row.id,
    fieldId: row.fieldId,
    date: row.date,
    description: row.description,
    category: row.category,
    amountClp: row.amountClp,
    paymentSource: row.paymentSource,
    paidById: row.paidById,
    lotId: row.lotId,
    createdAt: row.createdAt,
  };
}

export async function listLivestockFinance(scope: LivestockFinanceReadScope): Promise<LivestockFinanceData> {
  if (!scope.allowOrganizationWide && scope.fieldIds.length === 0) {
    return { partners: [], contributions: [], expenses: [] };
  }
  const db = getDb();
  const expenseVisibility = scope.allowOrganizationWide
    ? eq(livestockExpenses.organizationId, scope.organizationId)
    : and(
      eq(livestockExpenses.organizationId, scope.organizationId),
      inArray(livestockExpenses.fieldId, [...scope.fieldIds]),
    );
  const [partners, contributions, expenses] = await Promise.all([
    scope.allowOrganizationWide
      ? db.select().from(livestockPartners).where(eq(livestockPartners.organizationId, scope.organizationId)).orderBy(asc(livestockPartners.name))
      : Promise.resolve([]),
    scope.allowOrganizationWide
      ? db.select().from(livestockContributions).where(eq(livestockContributions.organizationId, scope.organizationId)).orderBy(desc(livestockContributions.date), desc(livestockContributions.createdAt))
      : Promise.resolve([]),
    db.select().from(livestockExpenses).where(expenseVisibility).orderBy(desc(livestockExpenses.date), desc(livestockExpenses.createdAt)),
  ]);
  return {
    partners: await Promise.all(partners.map(toPartner)),
    contributions: await Promise.all(contributions.map(toContribution)),
    expenses: expenses.map(toExpense),
  };
}

export async function listLivestockFinanceAudit(
  scope: LivestockFinanceReadScope,
  limit = 50,
): Promise<LivestockFinanceAuditEntry[]> {
  if (!scope.allowOrganizationWide && scope.fieldIds.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const financeAudit = and(
    eq(auditLog.organizationId, scope.organizationId),
    inArray(auditLog.action, [...FINANCE_AUDIT_ACTIONS]),
    inArray(auditLog.entityType, [...FINANCE_AUDIT_ENTITIES]),
  );
  const visibility = scope.allowOrganizationWide
    ? financeAudit
    : and(
      financeAudit,
      eq(auditLog.entityType, "livestock_expense"),
      inArray(auditLog.fieldId, [...scope.fieldIds]),
    );
  const rows = await getDb().select().from(auditLog)
    .where(visibility)
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(boundedLimit);
  return rows.map(toFinanceAuditEntry);
}

export async function upsertLivestockPartner(
  partner: LivestockPartner,
  scope: LivestockFinancePartnerWriteScope,
): Promise<AuditedFinanceMutation<LivestockPartner>> {
  const db = getDb();
  const { organizationId } = scope;
  const [duplicate] = await db
    .select({ id: livestockPartners.id })
    .from(livestockPartners)
    .where(and(
      eq(livestockPartners.organizationId, organizationId),
      eq(livestockPartners.name, partner.name),
      ne(livestockPartners.id, partner.id),
    ))
    .limit(1);
  if (duplicate) throw new DomainRuleError("Ya existe un socio con ese nombre.");

  const [existing] = await db.select().from(livestockPartners)
    .where(eq(livestockPartners.id, partner.id)).limit(1);
  if (existing && existing.organizationId !== organizationId) throwFinanceScopeConflict();
  const currentSnapshotToken = existing ? await partnerSnapshotToken(existing) : null;
  if (partner.snapshotToken !== currentSnapshotToken) throwFinanceVersionConflict();

  const saved = {
    id: partner.id,
    organizationId,
    name: partner.name,
    email: partner.email,
    createdAt: existing?.createdAt ?? partner.createdAt,
  } satisfies PartnerRow;
  const audit = createFinanceAudit({
    scope,
    action: existing ? "finance.partner.updated" : "finance.partner.created",
    entityType: "livestock_partner",
    entityId: partner.id,
    fieldId: null,
    before: existing ?? null,
    after: saved,
  });
  const nameAvailable = partnerNameAvailableWriteCondition(saved, scope);
  const actorCondition = organizationFinanceActorWriteCondition(scope);
  const writeCondition = existing
    ? combineSqlConditions(
      partnerExistingWriteCondition(existing, scope),
      nameAvailable,
      actorCondition,
    )
    : combineSqlConditions(
      {
        sql: "NOT EXISTS (SELECT 1 FROM livestock_partners AS existing_id WHERE existing_id.id = ?)",
        bindings: [partner.id],
      },
      nameAvailable,
      actorCondition,
    );
  const client = db.$client;
  const auditStatement = prepareConditionalFinanceAudit(client, audit.row, writeCondition);
  const mutation = existing
    ? client.prepare(`
      UPDATE livestock_partners
      SET name = ?, email = ?
      WHERE id = ? AND organization_id = ? AND ${writeCondition.sql}
    `).bind(saved.name, saved.email, partner.id, organizationId, ...writeCondition.bindings)
    : client.prepare(`
      INSERT INTO livestock_partners (id, organization_id, name, email, created_at)
      SELECT ?, ?, ?, ?, ?
      WHERE ${writeCondition.sql}
    `).bind(
      saved.id,
      saved.organizationId,
      saved.name,
      saved.email,
      saved.createdAt,
      ...writeCondition.bindings,
    );
  const [auditResult, mutationResult] = await client.batch([auditStatement, mutation]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) {
    if (existing) throwFinanceVersionConflict();
    throwFinanceScopeConflict();
  }
  return { value: await toPartner(saved), auditEntry: audit.entry };
}

export async function deleteLivestockPartner(
  id: string,
  scope: LivestockFinancePartnerWriteScope,
  expectedSnapshotToken: string,
): Promise<AuditedFinanceDelete> {
  const db = getDb();
  const [existing] = await db.select().from(livestockPartners)
    .where(and(eq(livestockPartners.id, id), eq(livestockPartners.organizationId, scope.organizationId)))
    .limit(1);
  if (!existing) return { deleted: false, auditEntry: null };
  if (expectedSnapshotToken !== await partnerSnapshotToken(existing)) throwFinanceVersionConflict();

  const [contribution] = await db
    .select({ id: livestockContributions.id })
    .from(livestockContributions)
    .where(and(eq(livestockContributions.organizationId, scope.organizationId), eq(livestockContributions.partnerId, id)))
    .limit(1);
  const [expense] = await db
    .select({ id: livestockExpenses.id })
    .from(livestockExpenses)
    .where(and(eq(livestockExpenses.organizationId, scope.organizationId), eq(livestockExpenses.paidById, id)))
    .limit(1);
  if (contribution || expense) {
    throw new DomainRuleError("El socio tiene aportes o egresos asociados. Elimina los aportes o reasigna los egresos antes de eliminarlo.");
  }

  const audit = createFinanceAudit({
    scope,
    action: "finance.partner.deleted",
    entityType: "livestock_partner",
    entityId: id,
    fieldId: null,
    before: existing,
    after: null,
  });
  const writeCondition = combineSqlConditions(
    partnerDeleteWriteCondition(existing, scope),
    organizationFinanceActorWriteCondition(scope),
  );
  const client = db.$client;
  const [auditResult, mutationResult] = await client.batch([
    prepareConditionalFinanceAudit(client, audit.row, writeCondition),
    client.prepare(`
      DELETE FROM livestock_partners
      WHERE id = ? AND organization_id = ? AND ${writeCondition.sql}
    `).bind(id, scope.organizationId, ...writeCondition.bindings),
  ]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) {
    throwFinanceVersionConflict();
  }
  return { deleted: true, auditEntry: audit.entry };
}

export async function upsertLivestockContribution(
  contribution: LivestockContribution,
  scope: LivestockFinanceContributionWriteScope,
): Promise<AuditedFinanceMutation<LivestockContribution>> {
  const db = getDb();
  const { organizationId } = scope;
  const [partner] = await db
    .select({ id: livestockPartners.id })
    .from(livestockPartners)
    .where(and(
      eq(livestockPartners.id, contribution.partnerId),
      eq(livestockPartners.organizationId, organizationId),
    ))
    .limit(1);
  if (!partner) throw new DomainRuleError("El socio seleccionado no existe.");

  const [existing] = await db.select().from(livestockContributions)
    .where(eq(livestockContributions.id, contribution.id)).limit(1);
  if (existing && existing.organizationId !== organizationId) throwFinanceScopeConflict();
  const currentSnapshotToken = existing ? await contributionSnapshotToken(existing) : null;
  if (contribution.snapshotToken !== currentSnapshotToken) throwFinanceContributionVersionConflict();

  const saved = {
    id: contribution.id,
    organizationId,
    partnerId: contribution.partnerId,
    amountClp: contribution.amountClp,
    date: contribution.date,
    description: contribution.description,
    createdAt: existing?.createdAt ?? contribution.createdAt,
  } satisfies ContributionRow;
  const audit = createFinanceAudit({
    scope,
    action: existing ? "finance.contribution.updated" : "finance.contribution.created",
    entityType: "livestock_contribution",
    entityId: contribution.id,
    fieldId: null,
    before: existing ?? null,
    after: saved,
  });
  const targetCondition = contributionTargetWriteCondition(saved, scope);
  const actorCondition = organizationFinanceActorWriteCondition(scope);
  const writeCondition = existing
    ? combineSqlConditions(
      contributionExistingWriteCondition(existing, scope),
      targetCondition,
      actorCondition,
    )
    : combineSqlConditions(
      {
        sql: "NOT EXISTS (SELECT 1 FROM livestock_contributions AS existing_id WHERE existing_id.id = ?)",
        bindings: [contribution.id],
      },
      targetCondition,
      actorCondition,
    );
  const client = db.$client;
  const auditStatement = prepareConditionalFinanceAudit(client, audit.row, writeCondition);
  const mutation = existing
    ? client.prepare(`
      UPDATE livestock_contributions
      SET partner_id = ?, amount_clp = ?, date = ?, description = ?
      WHERE id = ? AND organization_id = ? AND ${writeCondition.sql}
    `).bind(
      saved.partnerId,
      saved.amountClp,
      saved.date,
      saved.description,
      contribution.id,
      organizationId,
      ...writeCondition.bindings,
    )
    : client.prepare(`
      INSERT INTO livestock_contributions (
        id, organization_id, partner_id, amount_clp, date, description, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE ${writeCondition.sql}
    `).bind(
      saved.id,
      saved.organizationId,
      saved.partnerId,
      saved.amountClp,
      saved.date,
      saved.description,
      saved.createdAt,
      ...writeCondition.bindings,
    );
  const [auditResult, mutationResult] = await client.batch([auditStatement, mutation]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) {
    if (existing) throwFinanceContributionVersionConflict();
    throwFinanceScopeConflict();
  }
  return { value: await toContribution(saved), auditEntry: audit.entry };
}

export async function deleteLivestockContribution(
  id: string,
  scope: LivestockFinanceContributionWriteScope,
  expectedSnapshotToken: string,
): Promise<AuditedFinanceDelete> {
  const db = getDb();
  const [existing] = await db.select().from(livestockContributions)
    .where(and(eq(livestockContributions.id, id), eq(livestockContributions.organizationId, scope.organizationId)))
    .limit(1);
  if (!existing) return { deleted: false, auditEntry: null };
  if (expectedSnapshotToken !== await contributionSnapshotToken(existing)) {
    throwFinanceContributionVersionConflict();
  }
  const audit = createFinanceAudit({
    scope,
    action: "finance.contribution.deleted",
    entityType: "livestock_contribution",
    entityId: id,
    fieldId: null,
    before: existing,
    after: null,
  });
  const writeCondition = combineSqlConditions(
    contributionExistingWriteCondition(existing, scope),
    organizationFinanceActorWriteCondition(scope),
  );
  const client = db.$client;
  const [auditResult, mutationResult] = await client.batch([
    prepareConditionalFinanceAudit(client, audit.row, writeCondition),
    client.prepare(`
      DELETE FROM livestock_contributions
      WHERE id = ? AND organization_id = ? AND ${writeCondition.sql}
    `).bind(id, scope.organizationId, ...writeCondition.bindings),
  ]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) {
    throwFinanceContributionVersionConflict();
  }
  return { deleted: true, auditEntry: audit.entry };
}

export async function upsertLivestockExpense(
  expense: LivestockExpense,
  scope: LivestockFinanceWriteScope,
): Promise<AuditedFinanceMutation<LivestockExpense>> {
  const db = getDb();
  const { organizationId } = scope;

  if (expense.paymentSource === "partner" && !expense.paidById) {
    throw new DomainRuleError("Selecciona el socio que adelantó el pago.");
  }
  if (expense.paymentSource === "partner" && expense.paidById) {
    if (!scope.allowOrganizationWide) throwFinanceScopeConflict();
    const [partner] = await db
      .select({ id: livestockPartners.id })
      .from(livestockPartners)
      .where(and(eq(livestockPartners.id, expense.paidById), eq(livestockPartners.organizationId, organizationId)))
      .limit(1);
    if (!partner) throw new DomainRuleError("El socio pagador no existe.");
  }
  let effectiveFieldId = expense.fieldId;
  if (expense.fieldId) {
    const [field] = await db
      .select({ id: fields.id })
      .from(fields)
      .where(and(eq(fields.id, expense.fieldId), eq(fields.organizationId, organizationId)))
      .limit(1);
    if (!field) throw new DomainRuleError("El fundo seleccionado no existe.");
    assertWritableExpenseField(expense.fieldId, scope);
  }
  if (expense.lotId) {
    const [lot] = await db
      .select({ id: livestockLots.id, fieldId: livestockLots.fieldId })
      .from(livestockLots)
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(eq(livestockLots.id, expense.lotId), eq(fields.organizationId, organizationId)))
      .limit(1);
    if (!lot) throw new DomainRuleError("El lote asociado no existe.");
    if (effectiveFieldId && effectiveFieldId !== lot.fieldId) {
      throw new DomainRuleError("El lote asociado no pertenece al fundo seleccionado.");
    }
    effectiveFieldId ??= lot.fieldId;
  }
  assertWritableExpenseField(effectiveFieldId, scope);

  const [existing] = await db.select().from(livestockExpenses)
    .where(eq(livestockExpenses.id, expense.id)).limit(1);
  if (existing && existing.organizationId !== organizationId) throwFinanceScopeConflict();
  const existingFieldId = existing ? await expenseScopeField(existing) : null;
  if (existing) assertWritableExpenseField(existingFieldId, scope);

  const saved = {
    id: expense.id,
    organizationId,
    fieldId: expense.fieldId,
    date: expense.date,
    description: expense.description,
    category: expense.category,
    amountClp: expense.amountClp,
    paymentSource: expense.paymentSource,
    paidById: expense.paymentSource === "partner" ? expense.paidById : null,
    lotId: expense.lotId,
    createdAt: existing?.createdAt ?? expense.createdAt,
  } satisfies ExpenseRow;
  const audit = createFinanceAudit({
    scope,
    action: existing ? "finance.expense.updated" : "finance.expense.created",
    entityType: "livestock_expense",
    entityId: expense.id,
    fieldId: effectiveFieldId ?? null,
    before: existing ?? null,
    after: saved,
  });
  const targetCondition = expenseTargetWriteCondition(saved, effectiveFieldId ?? null, scope);
  const writeCondition = existing
    ? combineSqlConditions(
      expenseExistingWriteCondition(existing, existingFieldId, scope),
      targetCondition,
    )
    : combineSqlConditions(
      {
        sql: "NOT EXISTS (SELECT 1 FROM livestock_expenses AS existing_id WHERE existing_id.id = ?)",
        bindings: [expense.id],
      },
      targetCondition,
    );
  const client = db.$client;
  const auditStatement = prepareConditionalFinanceAudit(client, audit.row, writeCondition);
  const mutation = existing
    ? client.prepare(`
      UPDATE livestock_expenses
      SET field_id = ?, date = ?, description = ?, category = ?, amount_clp = ?,
          payment_source = ?, paid_by_id = ?, lot_id = ?
      WHERE id = ? AND organization_id = ? AND ${writeCondition.sql}
    `).bind(
      saved.fieldId,
      saved.date,
      saved.description,
      saved.category,
      saved.amountClp,
      saved.paymentSource,
      saved.paidById,
      saved.lotId,
      expense.id,
      organizationId,
      ...writeCondition.bindings,
    )
    : client.prepare(`
      INSERT INTO livestock_expenses (
        id, organization_id, field_id, date, description, category, amount_clp,
        payment_source, paid_by_id, lot_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${writeCondition.sql}
    `).bind(
      saved.id,
      saved.organizationId,
      saved.fieldId,
      saved.date,
      saved.description,
      saved.category,
      saved.amountClp,
      saved.paymentSource,
      saved.paidById,
      saved.lotId,
      saved.createdAt,
      ...writeCondition.bindings,
    );
  const [auditResult, mutationResult] = await client.batch([auditStatement, mutation]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) throwFinanceScopeConflict();
  return { value: toExpense(saved), auditEntry: audit.entry };
}

export async function deleteLivestockExpense(
  id: string,
  scope: LivestockFinanceWriteScope,
): Promise<AuditedFinanceDelete> {
  const db = getDb();
  const [existing] = await db.select().from(livestockExpenses)
    .where(and(eq(livestockExpenses.id, id), eq(livestockExpenses.organizationId, scope.organizationId)))
    .limit(1);
  if (!existing) return { deleted: false, auditEntry: null };
  const fieldId = await expenseScopeField(existing);
  assertWritableExpenseField(fieldId, scope);

  const audit = createFinanceAudit({
    scope,
    action: "finance.expense.deleted",
    entityType: "livestock_expense",
    entityId: id,
    fieldId,
    before: existing,
    after: null,
  });
  const writeCondition = expenseExistingWriteCondition(existing, fieldId, scope);
  const client = db.$client;
  const [auditResult, mutationResult] = await client.batch([
    prepareConditionalFinanceAudit(client, audit.row, writeCondition),
    client.prepare(`
      DELETE FROM livestock_expenses
      WHERE id = ? AND organization_id = ? AND ${writeCondition.sql}
    `).bind(id, scope.organizationId, ...writeCondition.bindings),
  ]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) {
    return { deleted: false, auditEntry: null };
  }
  return { deleted: true, auditEntry: audit.entry };
}

function combineSqlConditions(...conditions: SqlCondition[]): SqlCondition {
  return {
    sql: conditions.map((condition) => `(${condition.sql})`).join(" AND "),
    bindings: conditions.flatMap((condition) => condition.bindings),
  };
}

function partnerNameAvailableWriteCondition(
  partner: PartnerRow,
  scope: LivestockFinanceOrganizationWriteScope,
): SqlCondition {
  return {
    sql: `
      NOT EXISTS (
        SELECT 1
        FROM livestock_partners AS duplicate_partner
        WHERE duplicate_partner.organization_id = ?
          AND duplicate_partner.name = ?
          AND duplicate_partner.id <> ?
      )
    `,
    bindings: [scope.organizationId, partner.name, partner.id],
  };
}

function partnerExistingWriteCondition(
  partner: PartnerRow,
  scope: LivestockFinanceOrganizationWriteScope,
): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_partners AS current_partner
        WHERE current_partner.id = ?
          AND current_partner.organization_id = ?
          AND current_partner.name = ?
          AND current_partner.email IS ?
          AND current_partner.created_at = ?
      )
    `,
    bindings: [partner.id, scope.organizationId, partner.name, partner.email, partner.createdAt],
  };
}

function partnerDeleteWriteCondition(
  partner: PartnerRow,
  scope: LivestockFinanceOrganizationWriteScope,
): SqlCondition {
  return combineSqlConditions(
    partnerExistingWriteCondition(partner, scope),
    {
      sql: `
        NOT EXISTS (
          SELECT 1 FROM livestock_contributions AS current_contribution
          WHERE current_contribution.partner_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_expenses AS current_expense
          WHERE current_expense.paid_by_id = ?
        )
      `,
      bindings: [partner.id, partner.id],
    },
  );
}

function contributionTargetWriteCondition(
  contribution: ContributionRow,
  scope: LivestockFinanceOrganizationWriteScope,
): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1 FROM livestock_partners AS target_partner
        WHERE target_partner.id = ? AND target_partner.organization_id = ?
      )
    `,
    bindings: [contribution.partnerId, scope.organizationId],
  };
}

function organizationFinanceActorWriteCondition(
  scope: LivestockFinanceOrganizationActorWriteScope,
): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM organization_memberships AS current_actor
        WHERE current_actor.id = ?
          AND current_actor.organization_id = ?
          AND current_actor.normalized_email = ?
          AND current_actor.status = 'active'
          AND current_actor.role IN ('owner', 'admin')
      )
    `,
    bindings: [
      scope.membershipId,
      scope.organizationId,
      scope.actorEmail.trim().toLowerCase(),
    ],
  };
}

function contributionExistingWriteCondition(
  contribution: ContributionRow,
  scope: LivestockFinanceOrganizationWriteScope,
): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_contributions AS current_contribution
        WHERE current_contribution.id = ?
          AND current_contribution.organization_id = ?
          AND current_contribution.partner_id = ?
          AND current_contribution.amount_clp = ?
          AND current_contribution.date IS ?
          AND current_contribution.description = ?
          AND current_contribution.created_at = ?
          AND EXISTS (
            SELECT 1 FROM livestock_partners AS current_partner
            WHERE current_partner.id = current_contribution.partner_id
              AND current_partner.organization_id = ?
          )
      )
    `,
    bindings: [
      contribution.id,
      scope.organizationId,
      contribution.partnerId,
      contribution.amountClp,
      contribution.date,
      contribution.description,
      contribution.createdAt,
      scope.organizationId,
    ],
  };
}

function expenseTargetWriteCondition(
  expense: ExpenseRow,
  effectiveFieldId: string | null,
  scope: LivestockFinanceWriteScope,
): SqlCondition {
  return {
    sql: `
      (? IS NULL OR EXISTS (
        SELECT 1 FROM fields AS target_field
        WHERE target_field.id = ? AND target_field.organization_id = ?
      ))
      AND (? IS NULL OR EXISTS (
        SELECT 1
        FROM livestock_lots AS target_lot
        INNER JOIN fields AS target_lot_field ON target_lot_field.id = target_lot.field_id
        WHERE target_lot.id = ?
          AND target_lot_field.organization_id = ?
          AND target_lot.field_id = ?
      ))
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM livestock_partners AS target_partner
        WHERE target_partner.id = ? AND target_partner.organization_id = ?
      ))
      AND (? = 1 OR EXISTS (
        SELECT 1 FROM fields AS writable_field
        WHERE writable_field.id = ?
          AND writable_field.organization_id = ?
          AND writable_field.id IN (SELECT value FROM json_each(?))
      ))
    `,
    bindings: [
      expense.fieldId,
      expense.fieldId,
      scope.organizationId,
      expense.lotId,
      expense.lotId,
      scope.organizationId,
      effectiveFieldId,
      expense.paidById,
      expense.paidById,
      scope.organizationId,
      scope.allowOrganizationWide ? 1 : 0,
      effectiveFieldId,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
    ],
  };
}

function expenseExistingWriteCondition(
  expense: ExpenseRow,
  effectiveFieldId: string | null,
  scope: LivestockFinanceWriteScope,
): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_expenses AS current_expense
        WHERE current_expense.id = ?
          AND current_expense.organization_id = ?
          AND current_expense.field_id IS ?
          AND current_expense.date IS ?
          AND current_expense.description = ?
          AND current_expense.category = ?
          AND current_expense.amount_clp = ?
          AND current_expense.payment_source = ?
          AND current_expense.paid_by_id IS ?
          AND current_expense.lot_id IS ?
          AND current_expense.created_at = ?
          AND (current_expense.field_id IS NULL OR EXISTS (
            SELECT 1 FROM fields AS current_field
            WHERE current_field.id = current_expense.field_id
              AND current_field.organization_id = ?
          ))
          AND (current_expense.lot_id IS NULL OR EXISTS (
            SELECT 1
            FROM livestock_lots AS current_lot
            INNER JOIN fields AS current_lot_field ON current_lot_field.id = current_lot.field_id
            WHERE current_lot.id = current_expense.lot_id
              AND current_lot_field.organization_id = ?
              AND current_lot.field_id = ?
              AND (current_expense.field_id IS NULL OR current_expense.field_id = current_lot.field_id)
          ))
          AND (current_expense.paid_by_id IS NULL OR EXISTS (
            SELECT 1 FROM livestock_partners AS current_partner
            WHERE current_partner.id = current_expense.paid_by_id
              AND current_partner.organization_id = ?
          ))
          AND (? = 1 OR EXISTS (
            SELECT 1 FROM fields AS writable_field
            WHERE writable_field.id = ?
              AND writable_field.organization_id = ?
              AND writable_field.id IN (SELECT value FROM json_each(?))
          ))
      )
    `,
    bindings: [
      expense.id,
      scope.organizationId,
      expense.fieldId,
      expense.date,
      expense.description,
      expense.category,
      expense.amountClp,
      expense.paymentSource,
      expense.paidById,
      expense.lotId,
      expense.createdAt,
      scope.organizationId,
      scope.organizationId,
      effectiveFieldId,
      scope.organizationId,
      scope.allowOrganizationWide ? 1 : 0,
      effectiveFieldId,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
    ],
  };
}

function prepareConditionalFinanceAudit(
  client: D1Database,
  row: ReturnType<typeof createFinanceAudit>["row"],
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
    WHERE ${condition.sql}
  `).bind(
    row.id,
    row.organizationId,
    row.fieldId,
    row.actor,
    row.action,
    row.entityType,
    row.entityId,
    row.before ? JSON.stringify(row.before) ?? null : null,
    row.after ? JSON.stringify(row.after) ?? null : null,
    row.occurredAt,
    ...condition.bindings,
  );
}

function createFinanceAudit(input: {
  scope: LivestockFinanceOrganizationWriteScope;
  action: LivestockFinanceAuditAction;
  entityType: LivestockFinanceAuditEntity;
  entityId: string;
  fieldId: string | null;
  before: object | null;
  after: object | null;
}): { row: typeof auditLog.$inferInsert; entry: LivestockFinanceAuditEntry } {
  const occurredAt = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    organizationId: input.scope.organizationId,
    fieldId: input.fieldId,
    actor: input.scope.actorEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: auditValue(input.before),
    after: auditValue(input.after),
    occurredAt,
  } satisfies typeof auditLog.$inferInsert;
  return { row, entry: toFinanceAuditEntry(row as AuditRow) };
}

function toFinanceAuditEntry(row: AuditRow): LivestockFinanceAuditEntry {
  const snapshot = row.after ?? row.before ?? {};
  const entityType = row.entityType as LivestockFinanceAuditEntity;
  const subject = entityType === "livestock_partner"
    ? stringValue(snapshot.name) || "Socio"
    : stringValue(snapshot.description) || (entityType === "livestock_contribution" ? "Aporte" : "Egreso");
  return {
    id: row.id,
    action: row.action as LivestockFinanceAuditAction,
    actor: row.actor,
    entityType,
    entityId: row.entityId,
    fieldId: row.fieldId,
    subject,
    amountClp: numberValue(snapshot.amountClp),
    occurredAt: row.occurredAt,
  };
}

function auditValue(value: object | null): ImportRecord | null {
  return value ? structuredClone(value) as ImportRecord : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function expenseScopeField(expense: ExpenseRow): Promise<string | null> {
  if (expense.fieldId || !expense.lotId) return expense.fieldId;
  const [lot] = await getDb().select({ fieldId: livestockLots.fieldId })
    .from(livestockLots).where(eq(livestockLots.id, expense.lotId)).limit(1);
  return lot?.fieldId ?? null;
}

function throwFinanceScopeConflict(): never {
  throw new DomainRuleError("El identificador financiero no está disponible.", "FINANCE_SCOPE_CONFLICT");
}

function throwFinanceVersionConflict(): never {
  throw new DomainRuleError(
    "El socio cambió desde la última carga. Recarga la página antes de continuar.",
    "FINANCE_VERSION_CONFLICT",
  );
}

function throwFinanceContributionVersionConflict(): never {
  throw new DomainRuleError(
    "El aporte cambió desde la última carga. Recarga la página antes de continuar.",
    "FINANCE_CONTRIBUTION_VERSION_CONFLICT",
  );
}

function assertWritableExpenseField(fieldId: string | null | undefined, scope: LivestockFinanceReadScope): void {
  if (fieldId ? !scope.fieldIds.includes(fieldId) : !scope.allowOrganizationWide) throwFinanceScopeConflict();
}
