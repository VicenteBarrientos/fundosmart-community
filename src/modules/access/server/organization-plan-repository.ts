import { getDb } from "@/db";
import { fields, organizations, paddocks } from "@/db/schema";
import type {
  OrganizationPlanLimits,
  OrganizationPlanUsage,
} from "@/src/modules/access/domain/types";
import { and, eq, isNull, sql } from "drizzle-orm";

export const FREE_PLAN_FIELD_LIMIT = 2;
export const FREE_PLAN_PADDOCK_LIMIT = 200;

export const FIELD_LIMIT_MESSAGE =
  "El plan Gratis permite hasta 2 fundos. Puedes seguir usando y editando los fundos existentes.";
export const PADDOCK_LIMIT_MESSAGE =
  "El plan Gratis permite hasta 200 potreros activos entre todos tus fundos.";

export async function getOrganizationPlanLimits(
  organizationId: string,
): Promise<OrganizationPlanLimits> {
  const [row] = await getDb()
    .select({
      planCode: organizations.planCode,
      fieldLimit: organizations.fieldLimit,
      paddockLimit: organizations.paddockLimit,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return row ?? { planCode: "legacy", fieldLimit: null, paddockLimit: null };
}

export async function getOrganizationPlanUsage(
  organizationId: string,
): Promise<OrganizationPlanUsage> {
  const db = getDb();
  const [limits, fieldRows, paddockRows] = await Promise.all([
    getOrganizationPlanLimits(organizationId),
    db.select({ count: sql<number>`count(*)` })
      .from(fields)
      .where(eq(fields.organizationId, organizationId)),
    db.select({ count: sql<number>`count(*)` })
      .from(paddocks)
      .innerJoin(fields, eq(fields.id, paddocks.fieldId))
      .where(and(
        eq(fields.organizationId, organizationId),
        isNull(paddocks.archivedAt),
        isNull(paddocks.deletedAt),
      )),
  ]);

  return {
    ...limits,
    fieldsUsed: Number(fieldRows[0]?.count ?? 0),
    paddocksUsed: Number(paddockRows[0]?.count ?? 0),
  };
}

export async function fieldLimitReached(organizationId: string): Promise<boolean> {
  const usage = await getOrganizationPlanUsage(organizationId);
  return usage.fieldLimit !== null && usage.fieldsUsed >= usage.fieldLimit;
}

export async function paddockLimitWouldBeExceeded(
  organizationId: string,
  activePaddockDelta: number,
): Promise<boolean> {
  const usage = await getOrganizationPlanUsage(organizationId);
  return usage.paddockLimit !== null
    && usage.paddocksUsed + activePaddockDelta > usage.paddockLimit;
}
