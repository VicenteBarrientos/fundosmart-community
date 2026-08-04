export const ORGANIZATION_KINDS = ["shared", "personal", "demo"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export const ORGANIZATION_PLAN_CODES = ["legacy", "free", "pro"] as const;
export type OrganizationPlanCode = (typeof ORGANIZATION_PLAN_CODES)[number];

export type OrganizationPlanLimits = {
  planCode: OrganizationPlanCode;
  fieldLimit: number | null;
  paddockLimit: number | null;
};

export type OrganizationPlanUsage = OrganizationPlanLimits & {
  fieldsUsed: number;
  paddocksUsed: number;
};

export const ORGANIZATION_MEMBERSHIP_ROLES = ["owner", "admin", "manager", "operator", "viewer"] as const;
export type OrganizationMembershipRole = (typeof ORGANIZATION_MEMBERSHIP_ROLES)[number];

export const ORGANIZATION_MEMBERSHIP_STATUSES = ["active", "suspended"] as const;
export type OrganizationMembershipStatus = (typeof ORGANIZATION_MEMBERSHIP_STATUSES)[number];

export const FEATURE_KEYS = ["trazabilidad", "pastoreo", "analitica", "benchmarking"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_CAPABILITIES = [
  "trazabilidad:read",
  "trazabilidad:write",
  "pastoreo:read",
  "pastoreo:write",
  "analitica:read",
  "benchmarking:read",
  "benchmarking:write",
] as const;
export type FeatureCapability = (typeof FEATURE_CAPABILITIES)[number];

export const ACCESS_CAPABILITIES = [
  "view",
  "operate",
  "manage_imports",
  "manage_finance",
  "manage_members",
  "export_data",
  "restore_data",
  ...FEATURE_CAPABILITIES,
] as const;
export type AccessCapability = (typeof ACCESS_CAPABILITIES)[number];

export type AccessContext = {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  displayName: string;
  role: OrganizationMembershipRole;
  fieldIds: string[];
};

export type OrganizationFieldScope = Pick<AccessContext, "organizationId" | "fieldIds">;

export type AccessMembership = {
  id: string;
  email: string;
  displayName: string;
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
  fieldIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type AccessDashboard = {
  currentMembershipId: string;
  organizationId: string;
  organizationName: string;
  fields: { id: string; name: string }[];
  memberships: AccessMembership[];
};

export type OrganizationFeatureFlag = {
  id: string;
  organizationId: string;
  fieldId: string | null;
  feature: FeatureKey;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AccessibleOrganization = {
  id: string;
  name: string;
  kind: OrganizationKind;
  role: OrganizationMembershipRole;
  fieldNames: string[];
};
