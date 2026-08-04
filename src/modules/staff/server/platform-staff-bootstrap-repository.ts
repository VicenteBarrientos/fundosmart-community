import { capabilitiesForProfile } from "../domain/staff-authorization.mjs";
import type { StaffCapability } from "../domain/staff-authorization.mjs";

/**
 * Consumo del bootstrap de staff v2. El correo sólo sirve para
 * reclamar un claim `pending` una única vez: crea el principal, sus grants
 * explícitos, el evento de sistema y cierra el claim dentro de un solo batch D1.
 * Después de esa operación el correo deja de autorizar, y la autorización
 * cotidiana pasa por principals y grants.
 */

const BOOTSTRAP_ACTION = "platform.staff.bootstrap-claimed.v1";
const BOOTSTRAP_GRANT_REASON = "Alta inicial del primer principal de plataforma.";
const BOOTSTRAP_PROFILE = "owner-initial";

const IDENTIFIER_PATTERN = /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

const CLAIM_PRECHECK_QUERY = `
  SELECT
    (
      SELECT COUNT(*) FROM platform_staff_bootstrap_claims
      WHERE status = 'pending' AND normalized_email = ?2
    ) AS pendingClaims,
    (
      SELECT COUNT(*) FROM auth_identities
      WHERE id = ?1 AND normalized_email = ?2
    ) AS matchingIdentities,
    (
      SELECT COUNT(*) FROM platform_staff_principals
      WHERE auth_identity_id = ?1
    ) AS existingPrincipals
`;

const PRINCIPAL_STATEMENT = `
  INSERT INTO platform_staff_principals (
    id, auth_identity_id, normalized_email_snapshot, display_name, kind, status,
    version, created_by_principal_id, created_at, updated_at, suspended_at
  )
  SELECT ?1, ?2, ?3, ?4, 'owner', 'active', 1, NULL, ?5, ?5, NULL
  WHERE EXISTS (
    SELECT 1 FROM platform_staff_bootstrap_claims
    WHERE status = 'pending' AND normalized_email = ?3
  )
  AND EXISTS (
    SELECT 1 FROM auth_identities WHERE id = ?2 AND normalized_email = ?3
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_staff_principals WHERE auth_identity_id = ?2
  )
`;

const GRANTS_STATEMENT = `
  INSERT INTO platform_staff_capability_grants (
    id, principal_id, capability, status, reason, granted_by_principal_id,
    granted_at, revoked_by_principal_id, revoked_at, version
  )
  SELECT ?1 || '-' || capability.value, ?2, capability.value, 'active', ?3, ?2, ?4, NULL, NULL, 1
  FROM json_each(?5) AS capability
  WHERE capability.type = 'text'
    AND EXISTS (
      SELECT 1 FROM platform_staff_principals WHERE id = ?2 AND status = 'active'
    )
`;

const EVENT_STATEMENT = `
  INSERT INTO platform_staff_events (
    id, actor_type, actor_principal_id, action, target_type, target_id,
    organization_id, reason, before_json, after_json, request_id,
    idempotency_key_hash, occurred_at
  )
  SELECT ?1, 'system', NULL, ?2, 'platform_staff_principal', ?3, NULL, NULL, NULL,
         json_object('principalId', ?3, 'kind', 'owner', 'capabilities', json(?4)),
         ?5, NULL, ?6
  WHERE EXISTS (SELECT 1 FROM platform_staff_principals WHERE id = ?3)
`;

const CLAIM_STATEMENT = `
  UPDATE platform_staff_bootstrap_claims
  SET status = 'claimed', principal_id = ?1, claimed_at = ?2, version = version + 1
  WHERE status = 'pending'
    AND normalized_email = ?3
    AND EXISTS (
      SELECT 1 FROM platform_staff_principals WHERE id = ?1 AND status = 'active'
    )
`;

const SENTINEL_STATEMENT = `
  SELECT
    CASE WHEN
      EXISTS (
        SELECT 1 FROM platform_staff_principals
        WHERE id = ?1 AND auth_identity_id = ?2 AND kind = 'owner'
          AND status = 'active' AND version = 1
      )
      AND (
        SELECT COUNT(*) FROM platform_staff_capability_grants
        WHERE principal_id = ?1 AND status = 'active'
      ) = ?3
      AND EXISTS (
        SELECT 1 FROM platform_staff_bootstrap_claims
        WHERE normalized_email = ?4 AND status = 'claimed' AND principal_id = ?1
      )
      AND NOT EXISTS (
        SELECT 1 FROM platform_staff_bootstrap_claims
        WHERE normalized_email = ?4 AND status = 'pending'
      )
      AND EXISTS (
        SELECT 1 FROM platform_staff_events WHERE id = ?5 AND target_id = ?1
      )
    THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
    ?1 AS principalId
`;

export type StaffBootstrapRequest = Readonly<{
  authIdentityId: string;
  normalizedEmail: string;
  displayName: string;
  principalId: string;
  eventId: string;
  requestId: string;
  now: number;
}>;

export type StaffBootstrapOutcome =
  | Readonly<{
      claimed: true;
      principalId: string;
      capabilities: readonly StaffCapability[];
      reasonCode: null;
    }>
  | Readonly<{
      claimed: false;
      principalId: null;
      capabilities: readonly [];
      reasonCode:
        | "INPUT_INVALID"
        | "NO_PENDING_CLAIM"
        | "IDENTITY_MISMATCH"
        | "PRINCIPAL_EXISTS"
        | "CONFLICT"
        | "BACKEND_UNAVAILABLE";
    }>;

/**
 * Reclama el bootstrap para una identidad Google ya autenticada. Es idempotente
 * por construcción: el claim es terminal, de modo que un segundo intento con el
 * mismo correo devuelve `NO_PENDING_CLAIM` sin conceder nada.
 */
export async function claimStaffBootstrap(
  database: D1Database,
  request: StaffBootstrapRequest,
): Promise<StaffBootstrapOutcome> {
  const capabilities = capabilitiesForProfile(BOOTSTRAP_PROFILE);
  if (!capabilities || capabilities.length === 0) return failure("INPUT_INVALID");
  if (!isValidRequest(request)) return failure("INPUT_INVALID");

  const capabilitiesJson = JSON.stringify([...capabilities]);
  const session = database.withSession("first-primary");

  let precheck: Record<string, unknown> | null;
  try {
    precheck = await session
      .prepare(CLAIM_PRECHECK_QUERY)
      .bind(request.authIdentityId, request.normalizedEmail)
      .first<Record<string, unknown>>();
  } catch {
    return failure("BACKEND_UNAVAILABLE");
  }

  if (!precheck) return failure("BACKEND_UNAVAILABLE");
  if (countOf(precheck.existingPrincipals) !== 0) return failure("PRINCIPAL_EXISTS");
  if (countOf(precheck.matchingIdentities) !== 1) return failure("IDENTITY_MISMATCH");
  if (countOf(precheck.pendingClaims) !== 1) return failure("NO_PENDING_CLAIM");

  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>([
      session
        .prepare(PRINCIPAL_STATEMENT)
        .bind(
          request.principalId,
          request.authIdentityId,
          request.normalizedEmail,
          request.displayName,
          request.now,
        ),
      session
        .prepare(GRANTS_STATEMENT)
        .bind(
          request.principalId,
          request.principalId,
          BOOTSTRAP_GRANT_REASON,
          request.now,
          capabilitiesJson,
        ),
      session
        .prepare(EVENT_STATEMENT)
        .bind(
          request.eventId,
          BOOTSTRAP_ACTION,
          request.principalId,
          capabilitiesJson,
          request.requestId,
          request.now,
        ),
      session
        .prepare(CLAIM_STATEMENT)
        .bind(request.principalId, request.now, request.normalizedEmail),
      session
        .prepare(SENTINEL_STATEMENT)
        .bind(
          request.principalId,
          request.authIdentityId,
          capabilities.length,
          request.normalizedEmail,
          request.eventId,
        ),
    ]);
  } catch {
    return failure("CONFLICT");
  }

  const sentinel = results?.[4]?.results?.[0];
  if (
    !sentinel
    || Number(sentinel.complete) !== 1
    || sentinel.principalId !== request.principalId
  ) {
    return failure("CONFLICT");
  }

  return Object.freeze({
    claimed: true as const,
    principalId: request.principalId,
    capabilities,
    reasonCode: null,
  });
}

function isValidRequest(request: StaffBootstrapRequest): boolean {
  if (!request || typeof request !== "object") return false;
  if (!IDENTIFIER_PATTERN.test(request.principalId ?? "")) return false;
  if (!isBoundedText(request.authIdentityId, 1, 160)) return false;
  if (!isBoundedText(request.eventId, 1, 160)) return false;
  if (!isBoundedText(request.requestId, 1, 180)) return false;
  if (!isBoundedText(request.displayName, 1, 160)) return false;
  if (request.displayName.trim().length === 0) return false;

  const email = request.normalizedEmail;
  if (!isBoundedText(email, 3, 320)) return false;
  if (email !== email.toLowerCase().trim()) return false;
  if (!EMAIL_PATTERN.test(email)) return false;

  return Number.isSafeInteger(request.now) && request.now >= 0;
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function failure(
  reasonCode: Extract<StaffBootstrapOutcome, { claimed: false }>["reasonCode"],
): StaffBootstrapOutcome {
  return Object.freeze({
    claimed: false as const,
    principalId: null,
    capabilities: Object.freeze([]) as readonly [],
    reasonCode,
  });
}
