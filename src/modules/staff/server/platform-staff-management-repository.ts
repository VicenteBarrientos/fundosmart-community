import { isStaffCapability } from "../domain/staff-authorization.mjs";
import type { StaffCapability } from "../domain/staff-authorization.mjs";

/**
 * Gestión de principals y grants. Cada mutación exige
 * `staff:manage` con elevación vigente **en el llamador**; aquí se garantiza que
 * el cambio, su evento global y sus postcondiciones se confirmen o se reviertan
 * juntos, y que el actor siga activo dentro de la misma transacción.
 *
 * Nunca se borra un principal ni un grant: se suspenden y se revocan.
 */

const ACTIONS = Object.freeze({
  principalCreated: "platform.staff.principal-created.v1",
  principalSuspended: "platform.staff.principal-suspended.v1",
  capabilityGranted: "platform.staff.capability-granted.v1",
  capabilityRevoked: "platform.staff.capability-revoked.v1",
});

const IDENTIFIER_PATTERN = /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

const EVENT_STATEMENT = `
  INSERT INTO platform_staff_events (
    id, actor_type, actor_principal_id, action, target_type, target_id,
    organization_id, reason, before_json, after_json, request_id,
    idempotency_key_hash, occurred_at
  )
  SELECT ?1, 'staff', ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11
  WHERE EXISTS (
    SELECT 1 FROM platform_staff_principals
    WHERE id = ?2 AND status = 'active'
  )
`;

const CREATE_PRINCIPAL = `
  INSERT INTO platform_staff_principals (
    id, auth_identity_id, normalized_email_snapshot, display_name, kind, status,
    version, created_by_principal_id, created_at, updated_at, suspended_at
  )
  SELECT ?1, ?2, ?3, ?4, 'staff', 'active', 1, ?5, ?6, ?6, NULL
  WHERE EXISTS (
    SELECT 1 FROM auth_identities WHERE id = ?2 AND normalized_email = ?3
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_staff_principals WHERE auth_identity_id = ?2
  )
  AND EXISTS (
    SELECT 1 FROM platform_staff_principals WHERE id = ?5 AND status = 'active'
  )
  AND EXISTS (SELECT 1 FROM platform_staff_events WHERE id = ?7)
`;

const CREATE_SENTINEL = `
  SELECT CASE WHEN
    EXISTS (
      SELECT 1 FROM platform_staff_principals
      WHERE id = ?1 AND auth_identity_id = ?2 AND status = 'active'
        AND kind = 'staff' AND version = 1 AND created_by_principal_id = ?3
    )
    AND (
      SELECT COUNT(*) FROM platform_staff_capability_grants WHERE principal_id = ?1
    ) = 0
  THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete, ?1 AS targetId
`;

/**
 * Un actor no puede suspenderse a sí mismo; el trigger de último owner activo
 * sigue siendo la autoridad final sobre la última cuenta propietaria.
 */
const SUSPEND_PRINCIPAL = `
  UPDATE platform_staff_principals
  SET status = 'suspended', suspended_at = ?1, updated_at = ?1, version = version + 1
  WHERE id = ?2
    AND status = 'active'
    AND id <> ?3
    AND version = ?4
    AND created_at <= ?1
    AND EXISTS (SELECT 1 FROM platform_staff_events WHERE id = ?5)
`;

const SUSPEND_SENTINEL = `
  SELECT CASE WHEN
    EXISTS (
      SELECT 1 FROM platform_staff_principals
      WHERE id = ?1 AND status = 'suspended' AND suspended_at = ?2 AND version = ?3 + 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM platform_staff_elevations
      WHERE principal_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
    )
  THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete, ?1 AS targetId
`;

const REVOKE_SUSPENDED_ELEVATIONS = `
  UPDATE platform_staff_elevations
  SET revoked_at = ?1
  WHERE principal_id = ?2
    AND revoked_at IS NULL
    AND created_at <= ?1
    AND expires_at >= ?1
`;

const GRANT_CAPABILITY = `
  INSERT INTO platform_staff_capability_grants (
    id, principal_id, capability, status, reason, granted_by_principal_id,
    granted_at, revoked_by_principal_id, revoked_at, version
  )
  SELECT ?1, ?2, ?3, 'active', ?4, ?5, ?6, NULL, NULL, 1
  WHERE EXISTS (
    SELECT 1 FROM platform_staff_principals WHERE id = ?2 AND status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM platform_staff_principals WHERE id = ?5 AND status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_staff_capability_grants
    WHERE principal_id = ?2 AND capability = ?3 AND status = 'active'
  )
  AND EXISTS (SELECT 1 FROM platform_staff_events WHERE id = ?7)
`;

const GRANT_SENTINEL = `
  SELECT CASE WHEN
    (
      SELECT COUNT(*) FROM platform_staff_capability_grants
      WHERE principal_id = ?1 AND capability = ?2 AND status = 'active'
    ) = 1
    AND EXISTS (
      SELECT 1 FROM platform_staff_capability_grants
      WHERE id = ?3 AND status = 'active' AND version = 1 AND granted_by_principal_id = ?4
    )
  THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete, ?3 AS targetId
`;

const REVOKE_CAPABILITY = `
  UPDATE platform_staff_capability_grants
  SET status = 'revoked', revoked_by_principal_id = ?1, revoked_at = ?2, version = version + 1
  WHERE id = ?3
    AND principal_id = ?4
    AND status = 'active'
    AND version = ?5
    AND granted_at <= ?2
    AND EXISTS (SELECT 1 FROM platform_staff_events WHERE id = ?6)
`;

const REVOKE_SENTINEL = `
  SELECT CASE WHEN
    EXISTS (
      SELECT 1 FROM platform_staff_capability_grants
      WHERE id = ?1 AND status = 'revoked' AND revoked_at = ?2 AND version = ?3 + 1
    )
  THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete, ?1 AS targetId
`;

export type StaffManagementOutcome =
  | Readonly<{ ok: true; targetId: string; reasonCode: null }>
  | Readonly<{
      ok: false;
      targetId: null;
      reasonCode: "INPUT_INVALID" | "NOT_APPLIED" | "BACKEND_UNAVAILABLE";
    }>;

type AuditFields = Readonly<{
  actorPrincipalId: string;
  eventId: string;
  requestId: string;
  idempotencyKeyHash: string;
  reason: string;
  now: number;
}>;

export type CreateStaffPrincipalRequest = AuditFields & Readonly<{
  principalId: string;
  authIdentityId: string;
  normalizedEmail: string;
  displayName: string;
}>;

export type SuspendStaffPrincipalRequest = AuditFields & Readonly<{
  principalId: string;
  expectedVersion: number;
}>;

export type GrantStaffCapabilityRequest = AuditFields & Readonly<{
  grantId: string;
  principalId: string;
  capability: StaffCapability;
}>;

export type RevokeStaffCapabilityRequest = AuditFields & Readonly<{
  grantId: string;
  principalId: string;
  expectedVersion: number;
}>;

/** Alta de un principal de staff sin capacidad alguna: los grants van aparte. */
export async function createStaffPrincipal(
  database: D1Database,
  request: CreateStaffPrincipalRequest,
): Promise<StaffManagementOutcome> {
  if (!isValidAudit(request) || !IDENTIFIER_PATTERN.test(request.principalId ?? "")) {
    return failure("INPUT_INVALID");
  }
  if (!isBoundedText(request.authIdentityId, 1, 160)) return failure("INPUT_INVALID");
  if (!isBoundedText(request.displayName, 1, 160)) return failure("INPUT_INVALID");
  if (request.displayName.trim().length === 0) return failure("INPUT_INVALID");
  if (!isNormalizedEmail(request.normalizedEmail)) return failure("INPUT_INVALID");

  return runManagement(database, request.principalId, (session) => [
    session.prepare(EVENT_STATEMENT).bind(
      request.eventId,
      request.actorPrincipalId,
      ACTIONS.principalCreated,
      "platform_staff_principal",
      request.principalId,
      request.reason,
      null,
      JSON.stringify({ kind: "staff", status: "active" }),
      request.requestId,
      request.idempotencyKeyHash,
      request.now,
    ),
    session.prepare(CREATE_PRINCIPAL).bind(
      request.principalId,
      request.authIdentityId,
      request.normalizedEmail,
      request.displayName,
      request.actorPrincipalId,
      request.now,
      request.eventId,
    ),
    session.prepare(CREATE_SENTINEL).bind(
      request.principalId,
      request.authIdentityId,
      request.actorPrincipalId,
    ),
  ]);
}

/** Suspende un principal y cierra sus elevaciones vigentes en el mismo batch. */
export async function suspendStaffPrincipal(
  database: D1Database,
  request: SuspendStaffPrincipalRequest,
): Promise<StaffManagementOutcome> {
  if (!isValidAudit(request)) return failure("INPUT_INVALID");
  if (!isBoundedText(request.principalId, 1, 160)) return failure("INPUT_INVALID");
  if (!isPositiveInteger(request.expectedVersion)) return failure("INPUT_INVALID");
  if (request.principalId === request.actorPrincipalId) return failure("INPUT_INVALID");

  return runManagement(database, request.principalId, (session) => [
    session.prepare(EVENT_STATEMENT).bind(
      request.eventId,
      request.actorPrincipalId,
      ACTIONS.principalSuspended,
      "platform_staff_principal",
      request.principalId,
      request.reason,
      JSON.stringify({ status: "active", version: request.expectedVersion }),
      JSON.stringify({ status: "suspended", version: request.expectedVersion + 1 }),
      request.requestId,
      request.idempotencyKeyHash,
      request.now,
    ),
    session.prepare(SUSPEND_PRINCIPAL).bind(
      request.now,
      request.principalId,
      request.actorPrincipalId,
      request.expectedVersion,
      request.eventId,
    ),
    session.prepare(REVOKE_SUSPENDED_ELEVATIONS).bind(request.now, request.principalId),
    session.prepare(SUSPEND_SENTINEL).bind(
      request.principalId,
      request.now,
      request.expectedVersion,
    ),
  ]);
}

/** Concede una capacidad explícita. Ningún `kind` la concede por sí solo. */
export async function grantStaffCapability(
  database: D1Database,
  request: GrantStaffCapabilityRequest,
): Promise<StaffManagementOutcome> {
  if (!isValidAudit(request)) return failure("INPUT_INVALID");
  if (!isBoundedText(request.grantId, 1, 160)) return failure("INPUT_INVALID");
  if (!isBoundedText(request.principalId, 1, 160)) return failure("INPUT_INVALID");
  if (!isStaffCapability(request.capability)) return failure("INPUT_INVALID");

  return runManagement(database, request.grantId, (session) => [
    session.prepare(EVENT_STATEMENT).bind(
      request.eventId,
      request.actorPrincipalId,
      ACTIONS.capabilityGranted,
      "platform_staff_capability_grant",
      request.grantId,
      request.reason,
      null,
      JSON.stringify({ principalId: request.principalId, capability: request.capability }),
      request.requestId,
      request.idempotencyKeyHash,
      request.now,
    ),
    session.prepare(GRANT_CAPABILITY).bind(
      request.grantId,
      request.principalId,
      request.capability,
      request.reason,
      request.actorPrincipalId,
      request.now,
      request.eventId,
    ),
    session.prepare(GRANT_SENTINEL).bind(
      request.principalId,
      request.capability,
      request.grantId,
      request.actorPrincipalId,
    ),
  ]);
}

/** Revoca una capacidad vigente comprobando su versión esperada. */
export async function revokeStaffCapability(
  database: D1Database,
  request: RevokeStaffCapabilityRequest,
): Promise<StaffManagementOutcome> {
  if (!isValidAudit(request)) return failure("INPUT_INVALID");
  if (!isBoundedText(request.grantId, 1, 160)) return failure("INPUT_INVALID");
  if (!isBoundedText(request.principalId, 1, 160)) return failure("INPUT_INVALID");
  if (!isPositiveInteger(request.expectedVersion)) return failure("INPUT_INVALID");

  return runManagement(database, request.grantId, (session) => [
    session.prepare(EVENT_STATEMENT).bind(
      request.eventId,
      request.actorPrincipalId,
      ACTIONS.capabilityRevoked,
      "platform_staff_capability_grant",
      request.grantId,
      request.reason,
      JSON.stringify({ status: "active", version: request.expectedVersion }),
      JSON.stringify({ status: "revoked", version: request.expectedVersion + 1 }),
      request.requestId,
      request.idempotencyKeyHash,
      request.now,
    ),
    session.prepare(REVOKE_CAPABILITY).bind(
      request.actorPrincipalId,
      request.now,
      request.grantId,
      request.principalId,
      request.expectedVersion,
      request.eventId,
    ),
    session.prepare(REVOKE_SENTINEL).bind(
      request.grantId,
      request.now,
      request.expectedVersion,
    ),
  ]);
}

async function runManagement(
  database: D1Database,
  targetId: string,
  build: (session: D1DatabaseSession) => D1PreparedStatement[],
): Promise<StaffManagementOutcome> {
  const session = database.withSession("first-primary");
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>(build(session));
  } catch {
    return failure("NOT_APPLIED");
  }

  const sentinel = results?.[results.length - 1]?.results?.[0];
  if (!sentinel || Number(sentinel.complete) !== 1 || sentinel.targetId !== targetId) {
    return failure("NOT_APPLIED");
  }
  return Object.freeze({ ok: true as const, targetId, reasonCode: null });
}

function isValidAudit(request: Partial<AuditFields> | null | undefined): request is AuditFields {
  if (!request || typeof request !== "object") return false;
  if (!isBoundedText(request.actorPrincipalId, 1, 160)) return false;
  if (!isBoundedText(request.eventId, 1, 160)) return false;
  if (!isBoundedText(request.requestId, 1, 180)) return false;
  if (!HASH_PATTERN.test(request.idempotencyKeyHash ?? "")) return false;
  if (!isBoundedText(request.reason, 3, 1000)) return false;
  if (request.reason.trim().length < 3) return false;
  const now = request.now;
  return Number.isSafeInteger(now) && (now as number) >= 0;
}

function isNormalizedEmail(value: unknown): value is string {
  return isBoundedText(value, 3, 320)
    && value === value.toLowerCase().trim()
    && EMAIL_PATTERN.test(value);
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function failure(
  reasonCode: Extract<StaffManagementOutcome, { ok: false }>["reasonCode"],
): StaffManagementOutcome {
  return Object.freeze({ ok: false as const, targetId: null, reasonCode });
}
