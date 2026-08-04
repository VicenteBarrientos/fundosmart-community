import {
  hasStaffCapability,
  reauthorizeStaffCapability,
  requireStaffCapability,
} from "@/app/staff-access";
import { getDb } from "@/db";
import {
  organizations,
  organizationMemberships,
  fields,
  membershipFieldAccess,
  organizationFeatureFlags,
  auditLog,
} from "@/db/schema";
import { asc, desc } from "drizzle-orm";
import { StaffConsolePage } from "@/src/modules/staff/StaffConsolePage";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StaffConsoleRoute() {
  const access = await requireStaffCapability("/app/staff", "support:read");
  const canReadAudit = await hasStaffCapability(access, "audit:read");

  const db = getDb();
  const orgsList = await db.select().from(organizations).orderBy(asc(organizations.name));
  const fieldsList = await db.select().from(fields).orderBy(asc(fields.name));
  const membershipsList = await db.select().from(organizationMemberships).orderBy(asc(organizationMemberships.userEmail));
  const fieldAccessList = await db.select().from(membershipFieldAccess);
  const featureFlagsList = await db.select().from(organizationFeatureFlags);
  // La auditoría es la única lectura que exige su propia capacidad: sin
  // `audit:read` no se consulta, de modo que un rol de soporte no la recibe.
  const auditLogsList = canReadAudit
    ? await db.select().from(auditLog).orderBy(desc(auditLog.occurredAt)).limit(100)
    : [];

  const initialData = {
    organizations: orgsList,
    fields: fieldsList,
    memberships: membershipsList,
    membershipFieldAccess: fieldAccessList,
    featureFlags: featureFlagsList,
    auditLogs: auditLogsList,
  };

  const currentAccess = await reauthorizeStaffCapability(access);
  if (!currentAccess) {
    redirect("/app/sin-acceso?code=STAFF_ACCESS_CHANGED");
  }
  const currentUser = currentAccess.user;
  return <StaffConsolePage initialData={initialData} userName={currentUser.displayName ?? currentUser.email} />;
}
