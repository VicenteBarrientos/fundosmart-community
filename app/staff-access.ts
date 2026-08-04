import { getAppUser, type AppUser } from "@/app/auth";
import { getActiveAccountClosure } from "@/src/modules/account-lifecycle/server/account-closure-repository";
import {
  reauthorizeLegalIdentity,
  requirePageLegalAcceptance,
} from "@/app/legal-access";
import { normalizeAccessEmail } from "@/src/modules/access/domain/access-rules.mjs";
import type { StaffCapability } from "@/src/modules/staff/domain/staff-authorization.mjs";
import {
  reauthorizeResolvedStaffAccess,
  resolveStaffAccess,
  type StaffAccessResolution,
} from "@/src/modules/staff/server/staff-access-resolver";
import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAMES, sha256Hex } from "./auth-core.mjs";

/**
 * La identidad del propietario de la plataforma es configuración del Worker, no
 * código: `FUNDOSMART_OWNER_EMAIL` es un secreto obligatorio y el preflight de
 * `scripts/release/self-hosting-preflight.mjs` aborta el release si falta. Sin
 * valor no hay propietario legado y la autorización cae en la capa de staff v2.
 */
function configuredOwnerEmail(environment: StaffAccessEnvironment): string {
  return normalizeAccessEmail(environment.FUNDOSMART_OWNER_EMAIL);
}
export const PLATFORM_STAFF_V2_REQUIRED_KEY = "platform-staff-v2-required";

type StaffAccessEnvironment = {
  DB?: D1Database;
  FUNDOSMART_OWNER_EMAIL?: string;
};
type StaffAuthorityRow = { allowed: number };

export type StaffActorSnapshot = Readonly<Pick<AppUser, "subject" | "email">>;

export type StaffCapabilityAccess = Readonly<{
  user: AppUser;
  resolution: StaffAccessResolution;
}>;

export async function isStaffAccountOpen(subject: string): Promise<boolean> {
  const environment = env as unknown as StaffAccessEnvironment;
  if (!environment.DB) return false;
  return await getActiveAccountClosure(environment.DB, subject) === null;
}

export async function isStaffEmail(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const normalized = normalizeAccessEmail(email);
  const environment = env as unknown as StaffAccessEnvironment;
  if (!matchesConfiguredStaffEmail(normalized, environment)) return false;

  const database = environment.DB;
  if (!database) return false;

  try {
    const marker = await database
      .withSession("first-primary")
      .prepare("SELECT 1 AS required FROM app_state WHERE key = ?1 LIMIT 1")
      .bind(PLATFORM_STAFF_V2_REQUIRED_KEY)
      .first<{ required: number }>();
    return marker === null;
  } catch {
    return false;
  }
}

export async function reauthorizeStaffAccess(
  expected: StaffActorSnapshot,
): Promise<AppUser | null> {
  const current = await getAppUser();
  if (!current) return null;

  const expectedEmail = normalizeAccessEmail(expected.email);
  const currentEmail = normalizeAccessEmail(current.email);
  if (
    !expected.subject
    || !expectedEmail
    || current.subject !== expected.subject
    || currentEmail !== expectedEmail
  ) {
    return null;
  }
  const legal = await reauthorizeLegalIdentity(current);
  if (!legal.ok) return null;
  const legalEmail = normalizeAccessEmail(legal.user.email);
  if (
    legal.user.subject !== expected.subject
    || legalEmail !== expectedEmail
  ) {
    return null;
  }
  const allowed = await hasCurrentStaffAuthority(legal.user, legalEmail);
  return allowed ? legal.user : null;
}

export async function requireStaffAccess(returnTo: string) {
  const user = await getAppUser();
  if (!user) redirect(`/cuenta?modo=personal&returnTo=${encodeURIComponent(returnTo)}`);
  await requirePageLegalAcceptance(user, returnTo);
  if (!(await isStaffAccountOpen(user.subject))) {
    redirect("/app/cuenta/datos?error=account-suspended");
  }
  if (!(await isStaffEmail(user.email))) {
    redirect(`/app/sin-acceso?code=STAFF_REQUIRED`);
  }
  return user;
}

/**
 * Autoridad de staff por capacidad. Antes del corte resuelve por el correo
 * legado; después manda el principal con su grant. Devuelve la resolución
 * completa —incluida la sesión D1 abierta— para que la superficie cargue sus
 * datos y cierre su barrera contra el mismo estado.
 *
 * `isStaffEmail` sigue existiendo para las superficies aún no migradas y se
 * retira junto con cualquier mecanismo legado basado en correo.
 */
export async function authorizeStaffCapability(
  capability: StaffCapability,
): Promise<StaffCapabilityAccess | null> {
  const user = await getAppUser();
  if (!user) return null;

  const database = (env as unknown as StaffAccessEnvironment).DB;
  if (!database) return null;

  const resolution = await resolveStaffAccess(database, {
    authIdentityId: user.subject,
    normalizedEmail: normalizeAccessEmail(user.email),
    authSessionTokenHash: await currentSessionTokenHash(),
    capability,
    now: Math.floor(Date.now() / 1000),
    legacyOwnerEmails: legacyOwnerEmails(),
  });

  return { user, resolution };
}

/**
 * Variante de página: redirige en vez de devolver `null`.
 */
export async function requireStaffCapability(
  returnTo: string,
  capability: StaffCapability,
): Promise<StaffCapabilityAccess> {
  const access = await authorizeStaffCapability(capability);
  if (!access) {
    redirect(`/cuenta?modo=personal&returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (!access.resolution.granted) {
    redirect(`/app/sin-acceso?code=${access.resolution.publicCode ?? "STAFF_REQUIRED"}`);
  }
  return access;
}

/**
 * Barrera final de una superficie por capacidad: se ejecuta como último `await`
 * antes de serializar. Exige la misma identidad estable y que la autoridad siga
 * vigente; después del corte compara además principal, grant y versiones contra
 * el snapshot inicial, en la misma sesión D1.
 */
export async function reauthorizeStaffCapability(
  expected: StaffCapabilityAccess,
): Promise<StaffCapabilityAccess | null> {
  const current = await getAppUser();
  if (!current) return null;

  const expectedEmail = normalizeAccessEmail(expected.user.email);
  const currentEmail = normalizeAccessEmail(current.email);
  if (
    !expected.user.subject
    || !expectedEmail
    || current.subject !== expected.user.subject
    || currentEmail !== expectedEmail
  ) {
    return null;
  }

  const database = (env as unknown as StaffAccessEnvironment).DB;
  if (!database) return null;

  const resolution = await reauthorizeResolvedStaffAccess(database, expected.resolution, {
    authIdentityId: current.subject,
    normalizedEmail: currentEmail,
    authSessionTokenHash: await currentSessionTokenHash(),
    capability: expected.resolution.capability,
    now: Math.floor(Date.now() / 1000),
    legacyOwnerEmails: legacyOwnerEmails(),
  });

  if (!resolution.granted) return null;
  return { user: current, resolution };
}

/**
 * Comprueba una capacidad adicional sobre un acceso ya concedido, para que una
 * superficie no cargue datos que su actor no puede ver.
 *
 * Antes del corte devuelve `true`: el camino legado no tiene grants y el único
 * actor posible es el propietario histórico, así que negar aquí sería retirarle
 * una capacidad que hoy sí tiene. Después del corte manda el grant.
 */
export async function hasStaffCapability(
  access: StaffCapabilityAccess,
  capability: StaffCapability,
): Promise<boolean> {
  if (access.resolution.mode === "legacy-email") return access.resolution.granted;
  if (access.resolution.capability === capability) return access.resolution.granted;
  const additional = await authorizeStaffCapability(capability);
  return additional?.resolution.granted === true;
}

function legacyOwnerEmails(): readonly string[] {
  const configured = configuredOwnerEmail(env as unknown as StaffAccessEnvironment);
  return configured ? [configured] : [];
}

/**
 * Hash de la cookie de sesión vigente, usado sólo para ligar una elevación a su
 * sesión. `sessionCookie()` escribe exactamente un nombre por entorno, así que
 * el primero presente es el de la sesión activa. Si aun así no coincidiera, la
 * elevación no encuentra fila y la operación sensible falla cerrada; el hash
 * nunca autentica por sí solo.
 */
async function currentSessionTokenHash(): Promise<string | null> {
  const cookieStore = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const rawToken = cookieStore.get(name)?.value ?? null;
    if (rawToken) return sha256Hex(rawToken);
  }
  return null;
}

async function hasCurrentStaffAuthority(
  user: AppUser,
  normalizedEmail: string,
): Promise<boolean> {
  const environment = env as unknown as StaffAccessEnvironment;
  const environmentOwnerEmail = configuredOwnerEmail(environment);
  if (
    !matchesConfiguredStaffEmail(normalizedEmail, environment)
    || !environment.DB
  ) {
    return false;
  }
  try {
    const authority = await environment.DB
      .withSession("first-primary")
      .prepare(`
        SELECT CASE WHEN
          (?3 <> '' AND ?2 = ?3)
          AND (
            ?1 = 'dev:' || ?2
            OR EXISTS (
              SELECT 1
              FROM auth_identities AS identity
              WHERE identity.id = ?1
                AND identity.normalized_email = ?2
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM account_closure_requests AS closure
            WHERE closure.scope = 'account'
              AND closure.target_id = ?1
              AND closure.status = 'grace'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app_state
            WHERE key = ?4
          )
        THEN 1 ELSE 0 END AS allowed
      `)
      .bind(
        user.subject,
        normalizedEmail,
        environmentOwnerEmail,
        PLATFORM_STAFF_V2_REQUIRED_KEY,
      )
      .first<StaffAuthorityRow>();
    return Number(authority?.allowed) === 1;
  } catch {
    return false;
  }
}

function matchesConfiguredStaffEmail(
  normalizedEmail: string,
  environment: StaffAccessEnvironment,
): boolean {
  const environmentOwnerEmail = configuredOwnerEmail(environment);
  return Boolean(environmentOwnerEmail) && normalizedEmail === environmentOwnerEmail;
}
