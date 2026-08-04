import {
  decideStaffAuthorization,
  denyStaffAuthorization,
  isStaffCapability,
  matchesAuthorizationSnapshot,
} from "../domain/staff-authorization.mjs";
import type {
  StaffAuthorizationDecision,
  StaffAuthorizationSnapshot,
  StaffCapability,
  StaffCapabilityGrantRecord,
  StaffElevationRecord,
  StaffPrincipalRecord,
} from "../domain/staff-authorization.mjs";

/**
 * Lecturas de autorización global. El repositorio no decide: sólo
 * carga principal, grants y elevación desde D1 y delega la decisión al dominio.
 *
 * Toda consulta se ancla en `withSession("first-primary")` para que una réplica
 * atrasada no prolongue un privilegio ya revocado, y la misma sesión se reutiliza
 * en la barrera de respuesta para conservar consistencia secuencial.
 */

const PRINCIPAL_QUERY = `
  SELECT id, auth_identity_id AS authIdentityId, status, kind, version
  FROM platform_staff_principals
  WHERE auth_identity_id = ?1
  LIMIT 1
`;

const GRANTS_QUERY = `
  SELECT id, principal_id AS principalId, capability, status, version
  FROM platform_staff_capability_grants
  WHERE status = 'active'
    AND principal_id = (
      SELECT id FROM platform_staff_principals WHERE auth_identity_id = ?1
    )
  ORDER BY capability
`;

const ELEVATION_QUERY = `
  SELECT principal_id AS principalId,
         auth_session_token_hash AS authSessionTokenHash,
         created_at AS createdAt,
         expires_at AS expiresAt,
         revoked_at AS revokedAt
  FROM platform_staff_elevations
  WHERE auth_session_token_hash = ?2
    AND principal_id = (
      SELECT id FROM platform_staff_principals WHERE auth_identity_id = ?1
    )
  ORDER BY expires_at DESC
  LIMIT 1
`;

export type StaffAuthorizationRequest = Readonly<{
  authIdentityId: string;
  capability: StaffCapability;
  authSessionTokenHash: string;
  now: number;
}>;

export type StaffAuthorizationAttempt = Readonly<{
  session: D1DatabaseSession;
  decision: StaffAuthorizationDecision;
}>;

/**
 * Resuelve la autorización inicial y devuelve la sesión D1 abierta para que el
 * llamador cargue sus datos y cierre la barrera con la misma sesión.
 */
export async function authorizeStaff(
  database: D1Database,
  request: StaffAuthorizationRequest,
): Promise<StaffAuthorizationAttempt> {
  const session = database.withSession("first-primary");
  const decision = await readStaffAuthorization(session, request);
  return Object.freeze({ session, decision });
}

/**
 * Barrera de respuesta. Vuelve a leer principal, grants y elevación en la misma
 * sesión y exige los mismos identificadores y versiones del snapshot inicial.
 * Cualquier diferencia devuelve `STAFF_ACCESS_CHANGED` y el llamador descarta el
 * payload ya cargado sin serializarlo.
 */
export async function reauthorizeStaff(
  session: D1DatabaseSession,
  request: StaffAuthorizationRequest,
  snapshot: StaffAuthorizationSnapshot,
): Promise<StaffAuthorizationDecision> {
  const capability = isStaffCapability(request?.capability) ? request.capability : null;
  const fresh = await readStaffAuthorization(session, request);
  if (!fresh.allowed) {
    return fresh.reasonCode === "BACKEND_UNAVAILABLE" || fresh.reasonCode === "ROW_SHAPE_INVALID"
      ? fresh
      : denyStaffAuthorization("STAFF_ACCESS_CHANGED", capability);
  }
  if (!matchesAuthorizationSnapshot(snapshot, fresh.snapshot)) {
    return denyStaffAuthorization("STAFF_ACCESS_CHANGED", capability);
  }
  return fresh;
}

/**
 * Lee el estado vigente y decide. Se exporta para que la barrera y la
 * autorización inicial compartan exactamente el mismo camino de lectura.
 */
export async function readStaffAuthorization(
  session: D1DatabaseSession,
  request: StaffAuthorizationRequest,
): Promise<StaffAuthorizationDecision> {
  const capability = isStaffCapability(request?.capability) ? request.capability : null;

  const authIdentityId = request?.authIdentityId;
  const authSessionTokenHash = request?.authSessionTokenHash;
  if (typeof authIdentityId !== "string" || authIdentityId.length === 0) {
    return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }
  if (typeof authSessionTokenHash !== "string" || authSessionTokenHash.length === 0) {
    return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }

  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>([
      session.prepare(PRINCIPAL_QUERY).bind(authIdentityId),
      session.prepare(GRANTS_QUERY).bind(authIdentityId),
      session.prepare(ELEVATION_QUERY).bind(authIdentityId, authSessionTokenHash),
    ]);
  } catch {
    return denyStaffAuthorization("BACKEND_UNAVAILABLE", capability);
  }

  if (!Array.isArray(results) || results.length !== 3) {
    return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }

  const principalRows = rowsOf(results[0]);
  const grantRows = rowsOf(results[1]);
  const elevationRows = rowsOf(results[2]);
  if (!principalRows || !grantRows || !elevationRows) {
    return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }
  if (principalRows.length > 1 || elevationRows.length > 1) {
    return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }

  let principal: StaffPrincipalRecord | null = null;
  if (principalRows.length === 1) {
    principal = readPrincipalRow(principalRows[0]);
    if (!principal) return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }

  const grants: StaffCapabilityGrantRecord[] = [];
  for (const row of grantRows) {
    const grant = readGrantRow(row);
    if (!grant) return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
    grants.push(grant);
  }

  let elevation: StaffElevationRecord | null = null;
  if (elevationRows.length === 1) {
    elevation = readElevationRow(elevationRows[0]);
    if (!elevation) return denyStaffAuthorization("ROW_SHAPE_INVALID", capability);
  }

  return decideStaffAuthorization({
    capability: request.capability,
    principal,
    grants,
    elevation,
    authSessionTokenHash,
    now: request.now,
  });
}

function rowsOf(result: D1Result<Record<string, unknown>> | undefined) {
  if (!result || typeof result !== "object") return null;
  const rows = result.results;
  if (!Array.isArray(rows)) return null;
  return rows;
}

function readPrincipalRow(row: Record<string, unknown>): StaffPrincipalRecord | null {
  const id = textOf(row?.id);
  const authIdentityId = textOf(row?.authIdentityId);
  const status = textOf(row?.status);
  const kind = textOf(row?.kind);
  const version = integerOf(row?.version);
  if (!id || !authIdentityId || version === null) return null;
  if (status !== "active" && status !== "suspended") return null;
  if (kind !== "owner" && kind !== "staff") return null;
  return { id, authIdentityId, status, kind, version };
}

function readGrantRow(row: Record<string, unknown>): StaffCapabilityGrantRecord | null {
  const id = textOf(row?.id);
  const principalId = textOf(row?.principalId);
  const capability = textOf(row?.capability);
  const status = textOf(row?.status);
  const version = integerOf(row?.version);
  if (!id || !principalId || version === null) return null;
  if (!isStaffCapability(capability)) return null;
  if (status !== "active" && status !== "revoked") return null;
  return { id, principalId, capability, status, version };
}

function readElevationRow(row: Record<string, unknown>): StaffElevationRecord | null {
  const principalId = textOf(row?.principalId);
  const authSessionTokenHash = textOf(row?.authSessionTokenHash);
  const createdAt = integerOf(row?.createdAt);
  const expiresAt = integerOf(row?.expiresAt);
  if (!principalId || !authSessionTokenHash) return null;
  if (createdAt === null || expiresAt === null) return null;

  const revoked = row?.revokedAt;
  if (revoked !== null && revoked !== undefined) {
    const revokedAt = integerOf(revoked);
    if (revokedAt === null) return null;
    return { principalId, authSessionTokenHash, createdAt, expiresAt, revokedAt };
  }
  return { principalId, authSessionTokenHash, createdAt, expiresAt, revokedAt: null };
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerOf(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value)) return null;
  return value;
}
