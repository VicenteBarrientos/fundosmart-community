import { MAXIMUM_ELEVATION_LIFETIME_SECONDS } from "../domain/staff-authorization.mjs";

/**
 * Elevación corta para operaciones sensibles. La elevación demuestra
 * reautenticación reciente: no contiene ni congela capacidades, y sólo sirve
 * mientras el principal siga activo y la sesión normal siga viva.
 *
 * El navegador recibe únicamente el token opaco; D1 conserva su SHA-256.
 * Concederla revoca cualquier elevación anterior de la misma sesión, de modo que
 * una sesión nunca tiene dos elevaciones vigentes.
 */

const ELEVATION_GRANTED_ACTION = "platform.staff.elevation-granted.v1";
const ELEVATION_REVOKED_ACTION = "platform.staff.elevation-revoked.v1";
const ELEVATION_GRANTED_REASON = "Reautenticación para una operación sensible.";
const ELEVATION_REVOKED_REASON = "Cierre de la elevación sensible.";

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/u;

const REVOKE_SESSION_ELEVATIONS = `
  UPDATE platform_staff_elevations
  SET revoked_at = ?1
  WHERE auth_session_token_hash = ?2
    AND revoked_at IS NULL
    AND created_at <= ?1
    AND expires_at >= ?1
`;

/**
 * La sesión debe estar viva y pertenecer a la identidad del principal: una
 * elevación jamás puede quedar ligada a la sesión de otra persona.
 */
const INSERT_ELEVATION = `
  INSERT INTO platform_staff_elevations (
    token_hash, principal_id, auth_session_token_hash, created_at, expires_at, revoked_at
  )
  SELECT ?1, ?2, ?3, ?4, ?5, NULL
  WHERE EXISTS (
    SELECT 1
    FROM auth_sessions AS live_session
    INNER JOIN platform_staff_principals AS principal
      ON principal.auth_identity_id = live_session.identity_id
    WHERE live_session.token_hash = ?3
      AND live_session.expires_at > ?4
      AND principal.id = ?2
      AND principal.status = 'active'
  )
`;

const INSERT_EVENT = `
  INSERT INTO platform_staff_events (
    id, actor_type, actor_principal_id, action, target_type, target_id,
    organization_id, reason, before_json, after_json, request_id,
    idempotency_key_hash, occurred_at
  )
  SELECT ?1, 'staff', ?2, ?3, 'platform_staff_elevation', ?4, NULL, ?5, NULL,
         json_object('expiresAt', ?6), ?7, ?8, ?9
  WHERE EXISTS (
    SELECT 1 FROM platform_staff_elevations WHERE token_hash = ?4
  )
`;

const GRANT_SENTINEL = `
  SELECT
    CASE WHEN
      EXISTS (
        SELECT 1 FROM platform_staff_elevations
        WHERE token_hash = ?1
          AND principal_id = ?2
          AND auth_session_token_hash = ?3
          AND revoked_at IS NULL
          AND expires_at = ?4
      )
      AND (
        SELECT COUNT(*) FROM platform_staff_elevations
        WHERE auth_session_token_hash = ?3 AND revoked_at IS NULL AND expires_at > ?5
      ) = 1
      AND EXISTS (SELECT 1 FROM platform_staff_events WHERE id = ?6)
    THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
    ?1 AS tokenHash
`;

const REVOKE_ELEVATION = `
  UPDATE platform_staff_elevations
  SET revoked_at = ?1
  WHERE token_hash = ?2
    AND principal_id = ?3
    AND revoked_at IS NULL
    AND created_at <= ?1
    AND expires_at >= ?1
`;

/**
 * Exige que la revocación la haya hecho **esta** llamada: si la fila ya estaba
 * cerrada, `revoked_at` conserva la marca anterior, el sentinel falla y el batch
 * revierte, de modo que un segundo cierre no duplica evidencia.
 */
const REVOKE_SENTINEL = `
  SELECT
    CASE WHEN
      EXISTS (
        SELECT 1 FROM platform_staff_elevations
        WHERE token_hash = ?1 AND principal_id = ?2 AND revoked_at = ?4
      )
      AND EXISTS (SELECT 1 FROM platform_staff_events WHERE id = ?3)
    THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
    ?1 AS tokenHash
`;

export type StaffElevationGrantRequest = Readonly<{
  principalId: string;
  authSessionTokenHash: string;
  tokenHash: string;
  eventId: string;
  requestId: string;
  /** SHA-256 de la clave de idempotencia del cliente, único por principal. */
  idempotencyKeyHash: string;
  now: number;
  lifetimeSeconds: number;
}>;

export type StaffElevationRevokeRequest = Readonly<{
  principalId: string;
  tokenHash: string;
  eventId: string;
  requestId: string;
  idempotencyKeyHash: string;
  now: number;
}>;

export type StaffElevationOutcome =
  | Readonly<{ ok: true; tokenHash: string; expiresAt: number; reasonCode: null }>
  | Readonly<{
      ok: false;
      tokenHash: null;
      expiresAt: null;
      reasonCode: "INPUT_INVALID" | "NOT_ELIGIBLE" | "BACKEND_UNAVAILABLE";
    }>;

/**
 * Concede una elevación. Falla cerrada si el principal no está activo, si la
 * sesión no existe, caducó o pertenece a otra identidad.
 */
export async function grantStaffElevation(
  database: D1Database,
  request: StaffElevationGrantRequest,
): Promise<StaffElevationOutcome> {
  if (!isValidGrant(request)) return elevationFailure("INPUT_INVALID");

  const expiresAt = request.now + request.lifetimeSeconds;
  const session = database.withSession("first-primary");

  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>([
      session.prepare(REVOKE_SESSION_ELEVATIONS).bind(request.now, request.authSessionTokenHash),
      session
        .prepare(INSERT_ELEVATION)
        .bind(
          request.tokenHash,
          request.principalId,
          request.authSessionTokenHash,
          request.now,
          expiresAt,
        ),
      session
        .prepare(INSERT_EVENT)
        .bind(
          request.eventId,
          request.principalId,
          ELEVATION_GRANTED_ACTION,
          request.tokenHash,
          ELEVATION_GRANTED_REASON,
          expiresAt,
          request.requestId,
          request.idempotencyKeyHash,
          request.now,
        ),
      session
        .prepare(GRANT_SENTINEL)
        .bind(
          request.tokenHash,
          request.principalId,
          request.authSessionTokenHash,
          expiresAt,
          request.now,
          request.eventId,
        ),
    ]);
  } catch {
    return elevationFailure("NOT_ELIGIBLE");
  }

  const sentinel = results?.[3]?.results?.[0];
  if (!sentinel || Number(sentinel.complete) !== 1 || sentinel.tokenHash !== request.tokenHash) {
    return elevationFailure("NOT_ELIGIBLE");
  }

  return Object.freeze({
    ok: true as const,
    tokenHash: request.tokenHash,
    expiresAt,
    reasonCode: null,
  });
}

/**
 * Cierra una elevación vigente. Una elevación ya revocada o ya caducada no es un
 * error del llamador, pero tampoco vuelve a auditarse.
 */
export async function revokeStaffElevation(
  database: D1Database,
  request: StaffElevationRevokeRequest,
): Promise<StaffElevationOutcome> {
  if (
    !TOKEN_HASH_PATTERN.test(request?.tokenHash ?? "")
    || !isBoundedText(request?.principalId, 1, 160)
    || !isBoundedText(request?.eventId, 1, 160)
    || !isBoundedText(request?.requestId, 1, 180)
    || !TOKEN_HASH_PATTERN.test(request?.idempotencyKeyHash ?? "")
    || !isEpochSeconds(request?.now)
  ) {
    return elevationFailure("INPUT_INVALID");
  }

  const session = database.withSession("first-primary");
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>([
      session.prepare(REVOKE_ELEVATION).bind(request.now, request.tokenHash, request.principalId),
      session
        .prepare(INSERT_EVENT)
        .bind(
          request.eventId,
          request.principalId,
          ELEVATION_REVOKED_ACTION,
          request.tokenHash,
          ELEVATION_REVOKED_REASON,
          request.now,
          request.requestId,
          request.idempotencyKeyHash,
          request.now,
        ),
      session
        .prepare(REVOKE_SENTINEL)
        .bind(request.tokenHash, request.principalId, request.eventId, request.now),
    ]);
  } catch {
    return elevationFailure("NOT_ELIGIBLE");
  }

  const sentinel = results?.[2]?.results?.[0];
  if (!sentinel || Number(sentinel.complete) !== 1) {
    return elevationFailure("NOT_ELIGIBLE");
  }

  return Object.freeze({
    ok: true as const,
    tokenHash: request.tokenHash,
    expiresAt: request.now,
    reasonCode: null,
  });
}

function isValidGrant(request: StaffElevationGrantRequest): boolean {
  if (!request || typeof request !== "object") return false;
  if (!TOKEN_HASH_PATTERN.test(request.tokenHash ?? "")) return false;
  if (!TOKEN_HASH_PATTERN.test(request.authSessionTokenHash ?? "")) return false;
  if (!isBoundedText(request.principalId, 1, 160)) return false;
  if (!isBoundedText(request.eventId, 1, 160)) return false;
  if (!isBoundedText(request.requestId, 1, 180)) return false;
  if (!TOKEN_HASH_PATTERN.test(request.idempotencyKeyHash ?? "")) return false;
  if (!isEpochSeconds(request.now)) return false;
  return Number.isSafeInteger(request.lifetimeSeconds)
    && request.lifetimeSeconds > 0
    && request.lifetimeSeconds <= MAXIMUM_ELEVATION_LIFETIME_SECONDS;
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isEpochSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function elevationFailure(
  reasonCode: Extract<StaffElevationOutcome, { ok: false }>["reasonCode"],
): StaffElevationOutcome {
  return Object.freeze({ ok: false as const, tokenHash: null, expiresAt: null, reasonCode });
}
