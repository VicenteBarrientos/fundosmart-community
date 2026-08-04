export type StaffCapability =
  | "support:read"
  | "tenants:manage"
  | "flags:manage"
  | "audit:read"
  | "operations:sensitive"
  | "staff:manage";

export type StaffCapabilityProfileKey =
  | "owner-initial"
  | "platform-operator"
  | "support";

export type StaffPrincipalKind = "owner" | "staff";
export type StaffPrincipalStatus = "active" | "suspended";
export type StaffGrantStatus = "active" | "revoked";

export type StaffPublicAccessCode =
  | "STAFF_REQUIRED"
  | "STAFF_ELEVATION_REQUIRED"
  | "STAFF_ACCESS_CHANGED";

export type StaffInfrastructureReasonCode =
  | "BACKEND_UNAVAILABLE"
  | "ROW_SHAPE_INVALID"
  | "STAFF_ACCESS_CHANGED";

export type StaffAuthorizationReasonCode =
  | StaffInfrastructureReasonCode
  | "INPUT_SHAPE_INVALID"
  | "CAPABILITY_INVALID"
  | "PRINCIPAL_MISSING"
  | "PRINCIPAL_INVALID"
  | "PRINCIPAL_SUSPENDED"
  | "GRANT_INVALID"
  | "GRANT_MISSING"
  | "GRANT_AMBIGUOUS"
  | "GRANT_PRINCIPAL_MISMATCH"
  | "ELEVATION_MISSING"
  | "ELEVATION_REVOKED"
  | "ELEVATION_EXPIRED"
  | "ELEVATION_NOT_YET_VALID"
  | "ELEVATION_LIFETIME_INVALID"
  | "ELEVATION_SESSION_MISMATCH"
  | "ELEVATION_PRINCIPAL_MISMATCH";

export type StaffPrincipalRecord = {
  readonly id: string;
  readonly authIdentityId: string;
  readonly status: StaffPrincipalStatus;
  readonly kind: StaffPrincipalKind;
  readonly version: number;
};

export type StaffCapabilityGrantRecord = {
  readonly id: string;
  readonly principalId: string;
  readonly capability: StaffCapability;
  readonly status: StaffGrantStatus;
  readonly version: number;
};

export type StaffElevationRecord = {
  readonly principalId: string;
  readonly authSessionTokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
};

export type StaffAuthorizationSnapshot = {
  readonly capability: StaffCapability;
  readonly principalId: string;
  readonly principalVersion: number;
  readonly principalStatus: StaffPrincipalStatus;
  readonly grantId: string;
  readonly grantVersion: number;
};

export type StaffAuthorizationInput = {
  readonly capability: StaffCapability | string;
  readonly principal: StaffPrincipalRecord | null;
  readonly grants: readonly StaffCapabilityGrantRecord[];
  readonly elevation: StaffElevationRecord | null;
  readonly authSessionTokenHash: string;
  readonly now: number;
};

export type StaffAuthorizationDecision =
  | {
      readonly contractVersion: "fundosmart.staff-authorization.v1";
      readonly allowed: true;
      readonly capability: StaffCapability;
      readonly reasonCode: null;
      readonly publicCode: null;
      readonly principalId: string;
      readonly principalKind: StaffPrincipalKind;
      readonly principalVersion: number;
      readonly grantId: string;
      readonly grantVersion: number;
      readonly elevationRequired: boolean;
      readonly elevationConfirmed: boolean;
      readonly snapshot: StaffAuthorizationSnapshot;
    }
  | {
      readonly contractVersion: "fundosmart.staff-authorization.v1";
      readonly allowed: false;
      readonly capability: StaffCapability | null;
      readonly reasonCode: StaffAuthorizationReasonCode;
      readonly publicCode: StaffPublicAccessCode;
      readonly principalId: string | null;
      readonly principalKind: StaffPrincipalKind | null;
      readonly principalVersion: number | null;
      readonly grantId: string | null;
      readonly grantVersion: number | null;
      readonly elevationRequired: boolean;
      readonly elevationConfirmed: false;
      readonly snapshot: null;
    };

export const STAFF_AUTHORIZATION_CONTRACT_VERSION: "fundosmart.staff-authorization.v1";
export const STAFF_CAPABILITIES: readonly StaffCapability[];
export const ELEVATION_REQUIRED_CAPABILITIES: readonly StaffCapability[];
export const MAXIMUM_ELEVATION_LIFETIME_SECONDS: 900;
export const STAFF_CAPABILITY_PROFILES: Readonly<
  Record<StaffCapabilityProfileKey, readonly StaffCapability[]>
>;
export const STAFF_PUBLIC_ACCESS_CODES: readonly StaffPublicAccessCode[];
export const STAFF_INFRASTRUCTURE_REASON_CODES: readonly StaffInfrastructureReasonCode[];

export function isStaffCapability(value: unknown): value is StaffCapability;
export function requiresElevation(capability: unknown): boolean;
export function capabilitiesForProfile(
  profileKey: unknown,
): readonly StaffCapability[] | null;
export function staffCapabilityProfileKeys(): readonly StaffCapabilityProfileKey[];
export function decideStaffAuthorization(
  input: StaffAuthorizationInput,
): StaffAuthorizationDecision;
export function matchesAuthorizationSnapshot(
  before: unknown,
  after: unknown,
): boolean;
export function denyStaffAuthorization(
  reasonCode: StaffInfrastructureReasonCode,
  capability?: unknown,
): Extract<StaffAuthorizationDecision, { allowed: false }>;
export function publicStaffAccessCode(reasonCode: unknown): StaffPublicAccessCode;
