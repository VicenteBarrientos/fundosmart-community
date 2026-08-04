import { publicStaffAccessCode } from "../domain/staff-authorization.mjs";
import type {
  StaffAuthorizationDecision,
  StaffAuthorizationSnapshot,
  StaffCapability,
  StaffPublicAccessCode,
} from "../domain/staff-authorization.mjs";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { readStaffAuthorization, reauthorizeStaff } from "./platform-staff-repository.ts";

/**
 * Punto único donde se decide con qué autoridad responde una superficie de
 * staff. Antes del corte manda el correo legado; después del corte mandan los
 * principals y grants persistidos, y el correo deja de autorizar.
 *
 * El marcador y la autorización se leen en la misma sesión `first-primary`, de
 * modo que la barrera de respuesta observe el mismo estado secuencial.
 */

export const PLATFORM_STAFF_V2_REQUIRED_KEY = "platform-staff-v2-required";

const MARKER_QUERY = "SELECT 1 AS required FROM app_state WHERE key = ?1 LIMIT 1";

export type StaffAccessMode = "legacy-email" | "principal";

export type StaffAccessReasonCode =
  | "IDENTITY_MISSING"
  | "SESSION_MISSING"
  | "LEGACY_EMAIL_MISMATCH"
  | "BACKEND_UNAVAILABLE";

export type StaffAccessResolution = Readonly<{
  granted: boolean;
  mode: StaffAccessMode | null;
  capability: StaffCapability;
  decision: StaffAuthorizationDecision | null;
  session: D1DatabaseSession | null;
  snapshot: StaffAuthorizationSnapshot | null;
  reasonCode: StaffAccessReasonCode | null;
  publicCode: StaffPublicAccessCode | null;
}>;

export type StaffAccessRequest = Readonly<{
  authIdentityId: string | null;
  normalizedEmail: string | null;
  authSessionTokenHash: string | null;
  capability: StaffCapability;
  now: number;
  legacyOwnerEmails: readonly string[];
}>;

/**
 * Resuelve el acceso de staff y devuelve la sesión abierta para que la
 * superficie cargue sus datos y cierre su barrera con la misma sesión.
 */
export async function resolveStaffAccess(
  database: D1Database,
  request: StaffAccessRequest,
): Promise<StaffAccessResolution> {
  const session = database.withSession("first-primary");

  let cutover: boolean;
  try {
    const marker = await session
      .prepare(MARKER_QUERY)
      .bind(PLATFORM_STAFF_V2_REQUIRED_KEY)
      .first<{ required: number }>();
    cutover = marker !== null;
  } catch {
    return denied(request.capability, "BACKEND_UNAVAILABLE", null, session);
  }

  if (!cutover) {
    const normalizedEmail = request.normalizedEmail;
    const allowed = typeof normalizedEmail === "string"
      && normalizedEmail.length > 0
      && request.legacyOwnerEmails.includes(normalizedEmail);
    if (!allowed) {
      return denied(request.capability, "LEGACY_EMAIL_MISMATCH", "legacy-email", session);
    }
    return Object.freeze({
      granted: true,
      mode: "legacy-email" as const,
      capability: request.capability,
      decision: null,
      session,
      snapshot: null,
      reasonCode: null,
      publicCode: null,
    });
  }

  if (typeof request.authIdentityId !== "string" || request.authIdentityId.length === 0) {
    return denied(request.capability, "IDENTITY_MISSING", "principal", session);
  }
  if (
    typeof request.authSessionTokenHash !== "string"
    || request.authSessionTokenHash.length === 0
  ) {
    return denied(request.capability, "SESSION_MISSING", "principal", session);
  }

  const decision = await readStaffAuthorization(session, {
    authIdentityId: request.authIdentityId,
    capability: request.capability,
    authSessionTokenHash: request.authSessionTokenHash,
    now: request.now,
  });

  return Object.freeze({
    granted: decision.allowed,
    mode: "principal" as const,
    capability: request.capability,
    decision,
    session,
    snapshot: decision.allowed ? decision.snapshot : null,
    reasonCode: null,
    publicCode: decision.allowed ? null : decision.publicCode,
  });
}

/**
 * Barrera de respuesta de una superficie ya resuelta. Después del corte relee en
 * la **misma** sesión y exige el mismo principal, grant y versiones; antes del
 * corte vuelve a resolver el correo legado desde cero. En ambos casos, perder la
 * autoridad durante la carga termina sin entregar el payload.
 */
export async function reauthorizeResolvedStaffAccess(
  database: D1Database,
  resolved: StaffAccessResolution,
  request: StaffAccessRequest,
): Promise<StaffAccessResolution> {
  if (resolved.mode !== "principal" || !resolved.session || !resolved.snapshot) {
    return resolveStaffAccess(database, request);
  }

  if (
    typeof request.authIdentityId !== "string"
    || request.authIdentityId.length === 0
    || typeof request.authSessionTokenHash !== "string"
    || request.authSessionTokenHash.length === 0
  ) {
    return denied(request.capability, "IDENTITY_MISSING", "principal", resolved.session);
  }

  const fresh = await reauthorizeStaff(
    resolved.session,
    {
      authIdentityId: request.authIdentityId,
      capability: request.capability,
      authSessionTokenHash: request.authSessionTokenHash,
      now: request.now,
    },
    resolved.snapshot,
  );

  return Object.freeze({
    granted: fresh.allowed,
    mode: "principal" as const,
    capability: request.capability,
    decision: fresh,
    session: resolved.session,
    snapshot: fresh.allowed ? fresh.snapshot : null,
    reasonCode: null,
    publicCode: fresh.allowed ? null : fresh.publicCode,
  });
}

function denied(
  capability: StaffCapability,
  reasonCode: StaffAccessReasonCode,
  mode: StaffAccessMode | null,
  session: D1DatabaseSession,
): StaffAccessResolution {
  return Object.freeze({
    granted: false,
    mode,
    capability,
    decision: null,
    session,
    snapshot: null,
    reasonCode,
    publicCode: publicStaffAccessCode(
      reasonCode === "BACKEND_UNAVAILABLE" ? "BACKEND_UNAVAILABLE" : "PRINCIPAL_MISSING",
    ),
  });
}
