import { getDb } from "@/db";
import { env } from "cloudflare:workers";
import {
  fields,
  membershipFieldAccess,
  organizationAccessBootstrap,
  organizationMemberships,
  organizations,
} from "@/db/schema";
import type { AppUser } from "@/app/auth";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { getActiveAccountClosure } from "@/src/modules/account-lifecycle/server/account-closure-repository";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import type {
  AccessCapability,
  AccessContext,
  AccessDashboard,
  AccessMembership,
  AccessibleOrganization,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from "../domain/types";
import {
  defaultWorkspaceMembership,
  featureForCapability,
  normalizeAccessEmail,
  roleHasCapability,
  roleHasGlobalFieldAccess,
} from "../domain/access-rules.mjs";
import { isFeatureEnabled } from "./feature-flag-repository";
import {
  FREE_PLAN_FIELD_LIMIT,
  FREE_PLAN_PADDOCK_LIMIT,
} from "./organization-plan-repository";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

export const DEFAULT_ORGANIZATION_ID = "org-fundosmart";
const PUBLIC_DEMO_ORGANIZATION_ID = "org-fundosmart-demo";
const PUBLIC_DEMO_MEMBERSHIP_ID = "membership-fundo-el-ejemplo-demo";

export class AccessDeniedError extends Error {
  constructor(
    message: string,
    public readonly code: "ACCOUNT_CLOSURE_ACTIVE" | "MEMBERSHIP_REQUIRED" | "MEMBERSHIP_SUSPENDED" | "MEMBERSHIP_AMBIGUOUS" | "CAPABILITY_REQUIRED" | "FIELD_REQUIRED" | "FEATURE_REQUIRED",
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

type MembershipRow = typeof organizationMemberships.$inferSelect;
type SqlBinding = string | number | null;
type SqlCondition = { sql: string; bindings: SqlBinding[] };
type AccessEnvironment = { FUNDOSMART_OWNER_EMAIL?: string };
type OrganizationSelection = string | (() => Promise<string | undefined>);
type AccessibleOrganizationSnapshotRow = {
  accountClosureActive: number;
  membershipId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  organizationKind: AccessibleOrganization["kind"] | null;
  membershipRole: OrganizationMembershipRole | null;
  fieldName: string | null;
};
type AuthorizationSnapshotRow = {
  accountClosureActive: number;
  id: string | null;
  organizationId: string | null;
  organizationKind: AccessibleOrganization["kind"] | null;
  userEmail: string | null;
  normalizedEmail: string | null;
  displayName: string | null;
  role: OrganizationMembershipRole | null;
  status: OrganizationMembershipStatus | null;
  closureRequestId: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  fieldId: string | null;
};
type CurrentAccessSealRow = {
  accountClosureActive: number;
  authorized: number;
  featureCurrent: number;
  fieldScopeCurrent: number;
  identityCurrent: number;
  membershipCurrent: number;
  organizationClosureActive: number;
  organizationName: string | null;
};

/* La base vive en Norteamérica oriental y los usuarios en el sur de Chile: cada
   ida y vuelta a D1 cuesta ~200 ms medidos en producción. La autorización hacía
   seis, y las tres lecturas de membresía preguntaban lo mismo —qué membresías,
   qué rol, qué fundos— por datos que cambian una vez al mes.

   Guardarlas es seguro por construcción: `assertCurrentAccessSeal` vuelve a
   comprobar contra la base *todo* lo que el snapshot afirma —identidad, cierres,
   membresía, rol, alcance y feature— en cada autorización, sin caché. Un
   snapshot vencido no puede conceder nada que la base no conceda; el sello falla
   cerrado.

   Lo que sí podría hacer es negar de más —un rol recién ampliado seguiría viéndose
   angosto—, así que cualquier negativa desde caché la descarta y reintenta contra
   la base. El costo de equivocarse es un viaje extra; el de acertar, ninguno. */
const AUTHORIZATION_SNAPSHOT_TTL_MS = 30_000;
const AUTHORIZATION_SNAPSHOT_CACHE_LIMIT = 256;

type AuthorizationSnapshot = {
  accountClosureActive: boolean;
  memberships: MembershipRow[];
  fieldIdsByMembership: Map<string, string[]>;
  organizationKindById: Map<string, AccessibleOrganization["kind"]>;
};

const authorizationSnapshotCache = new Map<
  string,
  { expiresAt: number; snapshot: AuthorizationSnapshot }
>();

/* La clave incluye el sujeto autenticado, así que no puede cruzar identidades.
   Aun si lo hiciera, el sello está atado a `user.subject` y al correo, y
   rechazaría el contexto resultante. */
function authorizationSnapshotKey(subject: string, normalizedEmail: string, demoIdentity: boolean) {
  return `${subject}\u0000${normalizedEmail}\u0000${demoIdentity ? "demo" : "real"}`;
}

function readAuthorizationSnapshotCache(key: string): AuthorizationSnapshot | null {
  const entry = authorizationSnapshotCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    authorizationSnapshotCache.delete(key);
    return null;
  }
  return entry.snapshot;
}

function writeAuthorizationSnapshotCache(key: string, snapshot: AuthorizationSnapshot): void {
  /* Un cierre vigente y una cuenta sin membresías son estados de transición que
     abren caminos de escritura (aprovisionamiento); esos se releen siempre. */
  if (snapshot.accountClosureActive || snapshot.memberships.length === 0) return;
  if (authorizationSnapshotCache.size >= AUTHORIZATION_SNAPSHOT_CACHE_LIMIT) {
    const oldest = authorizationSnapshotCache.keys().next();
    if (!oldest.done) authorizationSnapshotCache.delete(oldest.value);
  }
  authorizationSnapshotCache.set(key, {
    expiresAt: Date.now() + AUTHORIZATION_SNAPSHOT_TTL_MS,
    snapshot,
  });
}

/* Señal interna: el snapshot en caché llevaría a un camino que escribe. No es un
   rechazo, es «reléelo de la base antes de decidir». */
class StaleAuthorizationSnapshot extends Error {}

export async function authorizeUser(
  user: AppUser,
  capability: AccessCapability = "view",
  fieldId?: string,
  organizationSelection?: OrganizationSelection,
): Promise<AccessContext> {
  const email = normalizeAccessEmail(user.email);
  const demoIdentity = email === DEMO_EMAIL;
  /* Una selección explícita o persistida se resuelve una sola vez por request y
     luego se conserva también si un snapshot en caché obliga a releer D1. Así no
     puede cambiar de tenant entre ambos intentos. La demo jamás lee la selección. */
  const selectedOrganizationId = demoIdentity
    ? undefined
    : typeof organizationSelection === "function"
      ? await organizationSelection()
      : organizationSelection;
  const cacheKey = authorizationSnapshotKey(user.subject, email, demoIdentity);
  const cached = readAuthorizationSnapshotCache(cacheKey);
  if (cached) {
    try {
      return await authorizeFromSnapshot(
        user, email, demoIdentity, cached, capability, fieldId, selectedOrganizationId, false,
      );
    } catch (cause) {
      if (!(cause instanceof AccessDeniedError) && !(cause instanceof StaleAuthorizationSnapshot)) {
        throw cause;
      }
      authorizationSnapshotCache.delete(cacheKey);
    }
  }
  const snapshot = await loadAuthorizationSnapshot(user.subject, email, demoIdentity);
  writeAuthorizationSnapshotCache(cacheKey, snapshot);
  return authorizeFromSnapshot(
    user, email, demoIdentity, snapshot, capability, fieldId, selectedOrganizationId, true,
  );
}

async function authorizeFromSnapshot(
  user: AppUser,
  email: string,
  demoIdentity: boolean,
  snapshot: AuthorizationSnapshot,
  capability: AccessCapability,
  fieldId: string | undefined,
  selectedOrganizationId: string | undefined,
  provision: boolean,
): Promise<AccessContext> {
  if (snapshot.accountClosureActive) {
    throw new AccessDeniedError(
      "Tu cuenta está suspendida durante una ventana de cierre.",
      "ACCOUNT_CLOSURE_ACTIVE",
    );
  }
  let memberships = snapshot.memberships;
  if (memberships.length === 0) {
    if (!provision) throw new StaleAuthorizationSnapshot();
    const provisioned = await provisionInitialMembership(user, email);
    if (provisioned) memberships = [provisioned];
  }
  const activeMemberships = memberships.filter((row) => row.status === "active");
  /* La selección siempre se respeta aunque después de una revocación quede una
     sola membresía activa. Ignorarla cambiaría de tenant silenciosamente. */
  const requestedOrganizationId = selectedOrganizationId;
  let membership: MembershipRow | null = requestedOrganizationId
    ? memberships.find((row) => row.organizationId === requestedOrganizationId) ?? null
    : !demoIdentity && activeMemberships.length > 1
      ? defaultWorkspaceMembership(activeMemberships, snapshot.organizationKindById)
      : activeMemberships[0] ?? memberships[0] ?? null;

  if (requestedOrganizationId === DEFAULT_ORGANIZATION_ID && !membership) {
    if (!provision) throw new StaleAuthorizationSnapshot();
    membership = await provisionConfiguredOwner(user, email);
  }
  /* Queda un solo caso sin resolver: la cookie apunta a un espacio donde ya no
     hay membresía. Ahí el silencio sería peor que la pregunta —a alguien lo
     sacaron de un espacio y moverlo de callado a otro oculta el hecho—, así que
     sigue derivando al selector, ahora con el motivo. */
  if (requestedOrganizationId && !membership) {
    throw new AccessDeniedError(
      "El espacio seleccionado ya no está disponible para tu cuenta.",
      "MEMBERSHIP_AMBIGUOUS",
    );
  }
  if (!membership) {
    throw new AccessDeniedError("Tu cuenta no tiene una membresía activa en esta organización.", "MEMBERSHIP_REQUIRED");
  }
  if (membership.status !== "active") {
    throw new AccessDeniedError("Tu membresía está suspendida.", "MEMBERSHIP_SUSPENDED");
  }
  // The public demo identity is shared by every anonymous visitor. Its effective
  // role must stay read-only even if persisted data is accidentally elevated.
  const effectiveRole: OrganizationMembershipRole = demoIdentity ? "viewer" : membership.role;
  if (!roleHasCapability(effectiveRole, capability)) {
    throw new AccessDeniedError("Tu rol no permite realizar esta operación.", "CAPABILITY_REQUIRED");
  }

  /* El mapa ya trae el alcance con el rol efectivo; sólo las membresías recién
     aprovisionadas —que no existían al leer— necesitan su propia consulta. */
  const fieldIds = snapshot.fieldIdsByMembership.get(membership.id)
    ?? await listMembershipFieldIds({ ...membership, role: effectiveRole });
  if (fieldId && !fieldIds.includes(fieldId)) {
    throw new AccessDeniedError("No tienes acceso al fundo solicitado.", "FIELD_REQUIRED");
  }
  const feature = featureForCapability(capability);
  if (feature) {
    if (!fieldId || !await isFeatureEnabled({ organizationId: membership.organizationId, fieldIds }, feature, fieldId)) {
      throw new AccessDeniedError("Esta función todavía no está habilitada para el fundo.", "FEATURE_REQUIRED");
    }
  }
  const access = {
    membershipId: membership.id,
    organizationId: membership.organizationId,
    email: membership.normalizedEmail,
    displayName: membership.displayName || user.displayName,
    role: effectiveRole,
    fieldIds,
  };
  /* El sello ya lee la organización para comprobar su cierre: devolver de paso su
     nombre deja el espacio activo a la vista del shell sin un viaje extra a D1, y
     nunca desde caché —el nombre que se muestra es el que la base tiene ahora. */
  const organizationName = await assertCurrentAccessSeal(user, access, membership.role, feature, fieldId);
  return { ...access, organizationName };
}

async function assertCurrentAccessSeal(
  user: AppUser,
  access: Omit<AccessContext, "organizationName">,
  persistedRole: OrganizationMembershipRole,
  feature: ReturnType<typeof featureForCapability>,
  fieldId: string | undefined,
): Promise<string> {
  const expectedFieldIds = JSON.stringify([...access.fieldIds].sort());
  const row = await env.DB
    .withSession("first-primary")
    .prepare(`
      WITH current_fields AS (
        SELECT DISTINCT field.id
        FROM fields AS field
        LEFT JOIN membership_field_access AS field_access
          ON field_access.field_id = field.id
         AND field_access.membership_id = ?4
        WHERE field.organization_id = ?5
          AND (?8 = 1 OR field_access.membership_id = ?4)
      ),
      facts AS (
        SELECT
          CASE WHEN (
            (?1 = 'demo' AND ?2 = ?3)
            OR ?1 = 'dev:' || ?2
            OR EXISTS (
              SELECT 1
              FROM auth_identities AS identity
              WHERE identity.id = ?1
                AND identity.normalized_email = ?2
            )
          ) THEN 1 ELSE 0 END AS identityCurrent,
          CASE WHEN EXISTS (
            SELECT 1
            FROM account_closure_requests AS closure
            WHERE closure.scope = 'account'
              AND closure.target_id = ?1
              AND closure.status = 'grace'
          ) THEN 1 ELSE 0 END AS accountClosureActive,
          CASE WHEN EXISTS (
            SELECT 1
            FROM account_closure_requests AS closure
            WHERE closure.scope = 'organization'
              AND closure.target_id = ?5
              AND closure.status = 'grace'
          ) THEN 1 ELSE 0 END AS organizationClosureActive,
          CASE WHEN EXISTS (
            SELECT 1
            FROM organization_memberships AS membership
            WHERE membership.id = ?4
              AND membership.organization_id = ?5
              AND membership.normalized_email = ?2
              AND (?2 <> ?3 OR (?4 = ?11 AND ?5 = ?12))
              AND membership.role = ?6
              AND membership.status = 'active'
              AND membership.closure_request_id IS NULL
          ) THEN 1 ELSE 0 END AS membershipCurrent,
          CASE WHEN
            NOT EXISTS (
              SELECT 1
              FROM current_fields AS current_field
              WHERE NOT EXISTS (
                SELECT 1
                FROM json_each(?7) AS expected_field
                WHERE expected_field.type = 'text'
                  AND expected_field.value = current_field.id
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(?7) AS expected_field
              WHERE expected_field.type <> 'text'
                 OR NOT EXISTS (
                   SELECT 1
                   FROM current_fields AS current_field
                   WHERE current_field.id = expected_field.value
                 )
            )
          THEN 1 ELSE 0 END AS fieldScopeCurrent,
          CASE WHEN ?9 IS NULL THEN 1
            WHEN COALESCE(
              (
                SELECT flag.enabled
                FROM organization_feature_flags AS flag
                WHERE flag.organization_id = ?5
                  AND flag.field_id = ?10
                  AND flag.feature = ?9
                LIMIT 1
              ),
              (
                SELECT flag.enabled
                FROM organization_feature_flags AS flag
                WHERE flag.organization_id = ?5
                  AND flag.field_id IS NULL
                  AND flag.feature = ?9
                LIMIT 1
              ),
              0
            ) = 1
          THEN 1 ELSE 0 END AS featureCurrent
      )
      SELECT
        identityCurrent,
        accountClosureActive,
        organizationClosureActive,
        membershipCurrent,
        fieldScopeCurrent,
        featureCurrent,
        (
          SELECT organization.name
          FROM organizations AS organization
          WHERE organization.id = ?5
        ) AS organizationName,
        CASE WHEN
          identityCurrent = 1
          AND accountClosureActive = 0
          AND organizationClosureActive = 0
          AND membershipCurrent = 1
          AND fieldScopeCurrent = 1
          AND featureCurrent = 1
        THEN 1 ELSE 0 END AS authorized
      FROM facts
    `)
    .bind(
      user.subject,
      normalizeAccessEmail(user.email),
      DEMO_EMAIL,
      access.membershipId,
      access.organizationId,
      persistedRole,
      expectedFieldIds,
      roleHasGlobalFieldAccess(access.role) ? 1 : 0,
      feature ?? null,
      fieldId ?? null,
      PUBLIC_DEMO_MEMBERSHIP_ID,
      PUBLIC_DEMO_ORGANIZATION_ID,
    )
    .first<CurrentAccessSealRow>();
  if (Number(row?.accountClosureActive) === 1) {
    throw new AccessDeniedError(
      "Tu cuenta tiene una solicitud de cierre vigente.",
      "ACCOUNT_CLOSURE_ACTIVE",
    );
  }
  if (
    Number(row?.identityCurrent) !== 1
    || Number(row?.organizationClosureActive) === 1
    || Number(row?.membershipCurrent) !== 1
  ) {
    throw new AccessDeniedError(
      "Tu membresía cambió durante la autorización.",
      "MEMBERSHIP_SUSPENDED",
    );
  }
  if (Number(row?.fieldScopeCurrent) !== 1) {
    throw new AccessDeniedError(
      "Tu alcance de fundos cambió durante la autorización.",
      "FIELD_REQUIRED",
    );
  }
  if (Number(row?.featureCurrent) !== 1) {
    throw new AccessDeniedError(
      "La funcionalidad cambió durante la autorización.",
      "FEATURE_REQUIRED",
    );
  }
  if (Number(row?.authorized) !== 1) {
    throw new AccessDeniedError(
      "Tu autorización cambió durante la operación.",
      "MEMBERSHIP_REQUIRED",
    );
  }
  return row?.organizationName ?? "Espacio de trabajo";
}

export async function listAccessibleOrganizations(user: AppUser): Promise<AccessibleOrganization[]> {
  await assertAccountOpen(user);
  const email = normalizeAccessEmail(user.email);
  const memberships = await findMembershipsByEmail(email);
  if (memberships.length === 0) {
    await provisionInitialMembership(user, email);
  }
  return await loadAccessibleOrganizationsSnapshot(user.subject, email);
}

async function loadAccessibleOrganizationsSnapshot(
  subject: string,
  normalizedEmail: string,
): Promise<AccessibleOrganization[]> {
  const rows = await env.DB
    .withSession("first-primary")
    .prepare(`
      WITH current_memberships AS (
        SELECT
          membership.id AS membership_id,
          membership.organization_id,
          membership.role
        FROM organization_memberships AS membership
        WHERE membership.normalized_email = ?2
          AND membership.status = 'active'
          AND (?2 <> ?3 OR (
            membership.organization_id = ?4
            AND membership.id = ?5
          ))
          AND (
            (?1 = 'demo' AND ?2 = ?3)
            OR ?1 = 'dev:' || ?2
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
            FROM account_closure_requests AS closure
            WHERE closure.scope = 'organization'
              AND closure.target_id = membership.organization_id
              AND closure.status = 'grace'
          )
      ),
      snapshot AS (
        SELECT
          membership.membership_id,
          organization.id AS organization_id,
          organization.name AS organization_name,
          organization.kind AS organization_kind,
          membership.role AS membership_role,
          field.name AS field_name
        FROM current_memberships AS membership
        INNER JOIN organizations AS organization
          ON organization.id = membership.organization_id
        LEFT JOIN fields AS field
          ON field.organization_id = organization.id
      )
      SELECT
        CASE WHEN EXISTS (
          SELECT 1
          FROM account_closure_requests AS closure
          WHERE closure.scope = 'account'
            AND closure.target_id = ?1
            AND closure.status = 'grace'
        ) THEN 1 ELSE 0 END AS accountClosureActive,
        snapshot.membership_id AS membershipId,
        snapshot.organization_id AS organizationId,
        snapshot.organization_name AS organizationName,
        snapshot.organization_kind AS organizationKind,
        snapshot.membership_role AS membershipRole,
        snapshot.field_name AS fieldName
      FROM (SELECT 1) AS authority
      LEFT JOIN snapshot ON TRUE
      ORDER BY snapshot.organization_id, snapshot.field_name
    `)
    .bind(
      subject,
      normalizedEmail,
      DEMO_EMAIL,
      PUBLIC_DEMO_ORGANIZATION_ID,
      PUBLIC_DEMO_MEMBERSHIP_ID,
    )
    .all<AccessibleOrganizationSnapshotRow>();
  const results = rows.results ?? [];
  if (results.some((row) => Number(row.accountClosureActive) === 1)) {
    throw new AccessDeniedError(
      "Tu cuenta tiene una solicitud de cierre vigente.",
      "ACCOUNT_CLOSURE_ACTIVE",
    );
  }

  const organizationsById = new Map<string, AccessibleOrganization>();
  for (const row of results) {
    if (
      !row.membershipId
      || !row.organizationId
      || !row.organizationName
      || !row.organizationKind
      || !row.membershipRole
    ) {
      continue;
    }
    const existing = organizationsById.get(row.organizationId);
    if (existing) {
      if (row.fieldName !== null && !existing.fieldNames.includes(row.fieldName)) {
        existing.fieldNames.push(row.fieldName);
      }
      continue;
    }
    organizationsById.set(row.organizationId, {
      id: row.organizationId,
      name: row.organizationName,
      kind: row.organizationKind,
      role: normalizedEmail === DEMO_EMAIL ? "viewer" : row.membershipRole,
      fieldNames: row.fieldName === null ? [] : [row.fieldName],
    });
  }
  return [...organizationsById.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "es"));
}

export async function canSelectOrganization(user: AppUser, organizationId: string): Promise<boolean> {
  await assertAccountOpen(user);
  if (normalizeAccessEmail(user.email) === DEMO_EMAIL) return false;
  const membership = await findMembership(organizationId, normalizeAccessEmail(user.email));
  return membership?.status === "active";
}

export async function getAccessDashboard(actor: AccessContext): Promise<AccessDashboard> {
  assertCapability(actor.role, "manage_members");
  const db = getDb();
  const [organization, fieldRows, membershipRows, accessRows] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, actor.organizationId)).limit(1),
    db.select({ id: fields.id, name: fields.name }).from(fields).where(eq(fields.organizationId, actor.organizationId)).orderBy(asc(fields.name)),
    db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, actor.organizationId)).orderBy(asc(organizationMemberships.displayName)),
    db.select({ membershipId: membershipFieldAccess.membershipId, fieldId: membershipFieldAccess.fieldId })
      .from(membershipFieldAccess)
      .innerJoin(organizationMemberships, eq(organizationMemberships.id, membershipFieldAccess.membershipId))
      .where(eq(organizationMemberships.organizationId, actor.organizationId)),
  ]);
  const fieldIdsByMembership = new Map<string, string[]>();
  for (const row of accessRows) {
    const current = fieldIdsByMembership.get(row.membershipId) ?? [];
    current.push(row.fieldId);
    fieldIdsByMembership.set(row.membershipId, current);
  }
  return {
    currentMembershipId: actor.membershipId,
    organizationId: actor.organizationId,
    organizationName: organization[0]?.name ?? "FundoSmart",
    fields: fieldRows,
    memberships: membershipRows.map((row) => toAccessMembership(row, fieldIdsByMembership.get(row.id) ?? [])),
  };
}

export async function saveAccessMembership(input: {
  actor: AccessContext;
  email: string;
  displayName: string;
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
  fieldIds: string[];
}): Promise<AccessDashboard> {
  assertCapability(input.actor.role, "manage_members");
  const normalizedEmail = normalizeAccessEmail(input.email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) throw new DomainRuleError("Ingresa un correo válido.");
  if (normalizedEmail === DEMO_EMAIL && input.role !== "viewer") {
    throw new DomainRuleError("La cuenta demo pública debe permanecer con acceso de solo lectura.");
  }
  if (normalizedEmail === DEMO_EMAIL && input.actor.organizationId !== PUBLIC_DEMO_ORGANIZATION_ID) {
    throw new DomainRuleError("La identidad demo pública está reservada al espacio de demostración.");
  }
  const displayName = input.displayName.trim() || normalizedEmail;
  const uniqueFieldIds = [...new Set(input.fieldIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (!roleHasGlobalFieldAccess(input.role) && input.status === "active" && uniqueFieldIds.length === 0) {
    throw new DomainRuleError("Asigna al menos un fundo a la membresía activa.");
  }

  const db = getDb();
  const existing = await findMembership(input.actor.organizationId, normalizedEmail);
  if ((input.role === "owner" || existing?.role === "owner") && input.actor.role !== "owner") {
    throw new DomainRuleError("Solo un propietario puede otorgar o modificar el rol propietario.");
  }
  if (existing?.role === "owner" && (input.role !== "owner" || input.status !== "active")) {
    const otherOwners = await db.select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.organizationId, input.actor.organizationId),
        eq(organizationMemberships.role, "owner"),
        eq(organizationMemberships.status, "active"),
        ne(organizationMemberships.id, existing.id),
      ));
    if (otherOwners.length === 0) throw new DomainRuleError("La organización debe conservar al menos un propietario activo.");
  }

  if (uniqueFieldIds.length) {
    const validFields = await db.select({ id: fields.id }).from(fields).where(and(
      eq(fields.organizationId, input.actor.organizationId),
      inArray(fields.id, uniqueFieldIds),
    ));
    if (validFields.length !== uniqueFieldIds.length) throw new DomainRuleError("Uno de los fundos seleccionados no pertenece a la organización.");
  }

  const previousFieldIds = existing ? [...new Set(await membershipFieldIds(existing.id))].sort() : [];
  const now = new Date().toISOString();
  const membershipId = existing?.id ?? `membership-${crypto.randomUUID()}`;
  const next = {
    id: membershipId,
    organizationId: input.actor.organizationId,
    userEmail: input.email.trim(),
    normalizedEmail,
    displayName,
    role: input.role,
    status: input.status,
    createdBy: existing?.createdBy ?? input.actor.email,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } satisfies typeof organizationMemberships.$inferInsert;
  const effectiveFieldIds = roleHasGlobalFieldAccess(input.role) ? [] : uniqueFieldIds;
  const action = existing ? "access.membership.updated" : "access.membership.created";
  const auditId = crypto.randomUUID();
  const writeCondition = accessMembershipWriteCondition({
    actor: input.actor,
    existing,
    previousFieldIds,
    membershipId,
    normalizedEmail,
    effectiveFieldIds,
    requiresOwner: input.role === "owner" || existing?.role === "owner",
  });
  const guardCondition: SqlCondition = {
    sql: `EXISTS (
      SELECT 1 FROM audit_log AS access_guard
      WHERE access_guard.id = ?
        AND access_guard.organization_id = ?
        AND access_guard.action = ?
        AND access_guard.entity_id = ?
    )`,
    bindings: [auditId, input.actor.organizationId, action, membershipId],
  };
  const client = db.$client;
  const auditStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, actor, action, entity_type, entity_id,
      before, after, occurred_at
    )
    SELECT ?, ?, ?, ?, 'organization_membership', ?, ?, ?, ?
    WHERE ${writeCondition.sql}
  `).bind(
    auditId,
    input.actor.organizationId,
    input.actor.email,
    action,
    membershipId,
    existing ? JSON.stringify(membershipAuditValue(existing, previousFieldIds)) : null,
    JSON.stringify(membershipAuditValue(next as MembershipRow, effectiveFieldIds)),
    now,
    ...writeCondition.bindings,
  );
  const membershipStatement = existing
    ? client.prepare(`
      UPDATE organization_memberships
      SET user_email = ?, normalized_email = ?, display_name = ?, role = ?, status = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND ${guardCondition.sql}
    `).bind(
      next.userEmail,
      next.normalizedEmail,
      next.displayName,
      next.role,
      next.status,
      next.updatedAt,
      membershipId,
      input.actor.organizationId,
      ...guardCondition.bindings,
    )
    : client.prepare(`
      INSERT INTO organization_memberships (
        id, organization_id, user_email, normalized_email, display_name,
        role, status, created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${guardCondition.sql}
    `).bind(
      next.id,
      next.organizationId,
      next.userEmail,
      next.normalizedEmail,
      next.displayName,
      next.role,
      next.status,
      next.createdBy,
      next.createdAt,
      next.updatedAt,
      ...guardCondition.bindings,
    );
  const clearFieldAccessStatement = client.prepare(`
    DELETE FROM membership_field_access
    WHERE membership_id = ? AND ${guardCondition.sql}
  `).bind(membershipId, ...guardCondition.bindings);
  const fieldAccessStatements = effectiveFieldIds.map((assignedFieldId) => client.prepare(`
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE ${guardCondition.sql}
  `).bind(
    `membership-field-${crypto.randomUUID()}`,
    membershipId,
    assignedFieldId,
    input.actor.email,
    now,
    ...guardCondition.bindings,
  ));
  try {
    const results = await client.batch([
      auditStatement,
      membershipStatement,
      clearFieldAccessStatement,
      ...fieldAccessStatements,
    ]);
    const assignmentsChanged = results.slice(3).every((result) => result.meta.changes === 1);
    if (
      results[0].meta.changes !== 1
      || results[1].meta.changes !== 1
      || results[2].meta.changes !== previousFieldIds.length
      || !assignmentsChanged
    ) {
      throw new DomainRuleError(
        "Los permisos, la membresía o los fundos cambiaron mientras se guardaba el acceso.",
        "FIELD_SCOPE_CONFLICT",
      );
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("LAST_ACTIVE_OWNER")) {
      throw new DomainRuleError("La organización debe conservar al menos un propietario activo.");
    }
    throw cause;
  }
  return getAccessDashboard(input.actor);
}

async function provisionConfiguredOwner(user: AppUser, normalizedEmail: string): Promise<MembershipRow | null> {
  const db = getDb();
  const [claim] = await db.select().from(organizationAccessBootstrap)
    .where(eq(organizationAccessBootstrap.organizationId, DEFAULT_ORGANIZATION_ID)).limit(1);
  const claimOwnerEmail = normalizeAccessEmail(claim?.ownerEmail);
  const environmentOwnerEmail = normalizeAccessEmail(
    (env as unknown as AccessEnvironment).FUNDOSMART_OWNER_EMAIL,
  );
  if (
    claimOwnerEmail !== normalizedEmail
    && environmentOwnerEmail !== normalizedEmail
  ) return null;

  const now = new Date().toISOString();
  const id = `membership-${crypto.randomUUID()}`;
  const membership = {
    id,
    organizationId: DEFAULT_ORGANIZATION_ID,
    userEmail: user.email.trim(),
    normalizedEmail,
    displayName: user.displayName,
    role: "owner",
    status: "active",
    closureRequestId: null,
    createdBy: normalizedEmail,
    createdAt: now,
    updatedAt: now,
  } satisfies MembershipRow;
  const client = db.$client;
  const [created] = await client.batch([
    client.prepare(`
      INSERT INTO organization_memberships (
        id, organization_id, user_email, normalized_email, display_name,
        role, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(
      membership.id,
      membership.organizationId,
      membership.userEmail,
      membership.normalizedEmail,
      membership.displayName,
      membership.role,
      membership.status,
      membership.createdBy,
      membership.createdAt,
      membership.updatedAt,
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, actor, action, entity_type, entity_id, after, occurred_at
      )
      SELECT ?, ?, ?, 'access.owner.bootstrapped', 'organization_membership', ?, ?, ?
      WHERE changes() > 0
    `).bind(
      crypto.randomUUID(),
      DEFAULT_ORGANIZATION_ID,
      normalizedEmail,
      membership.id,
      JSON.stringify(membershipAuditValue(membership, [])),
      now,
    ),
  ]);
  if (created.meta.changes > 0) return membership;
  return findMembership(DEFAULT_ORGANIZATION_ID, normalizedEmail);
}

async function provisionInitialMembership(
  user: AppUser,
  normalizedEmail: string,
): Promise<MembershipRow | null> {
  const configuredOwner = await provisionConfiguredOwner(user, normalizedEmail);
  if (configuredOwner) return configuredOwner;
  if (!normalizedEmail || normalizedEmail === DEMO_EMAIL) return null;
  return provisionSelfServiceWorkspace(user, normalizedEmail);
}

async function provisionSelfServiceWorkspace(
  user: AppUser,
  normalizedEmail: string,
): Promise<MembershipRow | null> {
  const digest = await sha256Hex(normalizedEmail);
  const stableSuffix = digest.slice(0, 24);
  const organizationId = `org-free-${stableSuffix}`;
  const membershipId = `membership-free-${stableSuffix}`;
  const auditId = `audit-self-service-${stableSuffix}`;
  const now = new Date().toISOString();
  const displayName = user.displayName.trim() || normalizedEmail;
  const membership = {
    id: membershipId,
    organizationId,
    userEmail: user.email.trim(),
    normalizedEmail,
    displayName,
    role: "owner",
    status: "active",
    closureRequestId: null,
    createdBy: normalizedEmail,
    createdAt: now,
    updatedAt: now,
  } satisfies MembershipRow;
  const client = getDb().$client;

  try {
    await client.batch([
      client.prepare(`
        INSERT INTO organizations (
          id, name, kind, plan_code, field_limit, paddock_limit,
          self_service_owner_email, created_at
        )
        SELECT ?, 'Mi FundoSmart', 'personal', 'free', ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM organization_memberships
          WHERE normalized_email = ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM organizations
            WHERE id = ? OR self_service_owner_email = ?
          )
      `).bind(
        organizationId,
        FREE_PLAN_FIELD_LIMIT,
        FREE_PLAN_PADDOCK_LIMIT,
        normalizedEmail,
        now,
        normalizedEmail,
        organizationId,
        normalizedEmail,
      ),
      client.prepare(`
        INSERT INTO organization_memberships (
          id, organization_id, user_email, normalized_email, display_name,
          role, status, created_by, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, 'owner', 'active', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM organizations
          WHERE id = ?
            AND plan_code = 'free'
            AND field_limit = ?
            AND paddock_limit = ?
            AND self_service_owner_email = ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships
            WHERE normalized_email = ?
          )
      `).bind(
        membership.id,
        membership.organizationId,
        membership.userEmail,
        membership.normalizedEmail,
        membership.displayName,
        membership.createdBy,
        membership.createdAt,
        membership.updatedAt,
        organizationId,
        FREE_PLAN_FIELD_LIMIT,
        FREE_PLAN_PADDOCK_LIMIT,
        normalizedEmail,
        normalizedEmail,
      ),
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, actor, action, entity_type, entity_id, after, occurred_at
        )
        SELECT ?, ?, ?, 'access.self_service.provisioned', 'organization', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM organization_memberships
          WHERE id = ?
            AND organization_id = ?
            AND normalized_email = ?
            AND role = 'owner'
            AND status = 'active'
        )
      `).bind(
        auditId,
        organizationId,
        normalizedEmail,
        organizationId,
        JSON.stringify({
          kind: "personal",
          planCode: "free",
          fieldLimit: FREE_PLAN_FIELD_LIMIT,
          paddockLimit: FREE_PLAN_PADDOCK_LIMIT,
        }),
        now,
        membershipId,
        organizationId,
        normalizedEmail,
      ),
      client.prepare(`
        SELECT CASE WHEN
          EXISTS (
            SELECT 1 FROM organizations
            WHERE id = ?
              AND plan_code = 'free'
              AND field_limit = ?
              AND paddock_limit = ?
              AND self_service_owner_email = ?
          )
          AND EXISTS (
            SELECT 1 FROM organization_memberships
            WHERE id = ?
              AND organization_id = ?
              AND normalized_email = ?
              AND role = 'owner'
              AND status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM audit_log
            WHERE id = ?
              AND organization_id = ?
              AND action = 'access.self_service.provisioned'
          )
          THEN 1 ELSE abs(-9223372036854775807 - 1)
        END AS complete
      `).bind(
        organizationId,
        FREE_PLAN_FIELD_LIMIT,
        FREE_PLAN_PADDOCK_LIMIT,
        normalizedEmail,
        membershipId,
        organizationId,
        normalizedEmail,
        auditId,
        organizationId,
      ),
    ]);
    return membership;
  } catch (cause) {
    const raced = await findMembershipsByEmail(normalizedEmail);
    const provisioned = raced.find((row) => row.organizationId === organizationId) ?? raced[0] ?? null;
    if (provisioned) return provisioned;
    throw cause;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function findMembership(organizationId: string, normalizedEmail: string): Promise<MembershipRow | null> {
  const [row] = await getDb().select().from(organizationMemberships).where(and(
    eq(organizationMemberships.organizationId, organizationId),
    eq(organizationMemberships.normalizedEmail, normalizedEmail),
  )).limit(1);
  return row ?? null;
}

async function findMembershipsByEmail(normalizedEmail: string): Promise<MembershipRow[]> {
  const membershipScope = normalizedEmail === DEMO_EMAIL
    ? and(
      eq(organizationMemberships.normalizedEmail, normalizedEmail),
      eq(organizationMemberships.organizationId, PUBLIC_DEMO_ORGANIZATION_ID),
      eq(organizationMemberships.id, PUBLIC_DEMO_MEMBERSHIP_ID),
    )
    : eq(organizationMemberships.normalizedEmail, normalizedEmail);
  return getDb().select().from(organizationMemberships)
    .where(membershipScope)
    .orderBy(asc(organizationMemberships.organizationId));
}

/* Autorizar costaba cuatro viajes encadenados a D1 —cierre de cuenta, membresías,
   fundos y sello—, y cada página los paga dos veces. Contra una base regional los
   viajes, no las consultas, son el gasto: desde el sur de Chile son ~150 ms cada
   uno. Cierre, membresías y fundos no dependen entre sí, así que viajan juntos.
   El sello sigue aparte a propósito: su trabajo es releer después, y fundirlo con
   esta lectura lo dejaría sin nada que verificar. */
async function loadAuthorizationSnapshot(
  subject: string,
  normalizedEmail: string,
  /* El alcance de fundos se resuelve con el rol *efectivo*: la identidad demo se
     degrada a `viewer` aunque su fila diga `owner`, y un `viewer` lee por
     `membership_field_access` en vez de ver el fundo completo. */
  demoIdentity: boolean,
): Promise<AuthorizationSnapshot> {
  const rows = await env.DB
    .withSession("first-primary")
    .prepare(`
      WITH account AS (
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM account_closure_requests AS closure
          WHERE closure.scope = 'account'
            AND closure.target_id = ?1
            AND closure.status = 'grace'
        ) THEN 1 ELSE 0 END AS accountClosureActive
      )
      SELECT
        account.accountClosureActive AS accountClosureActive,
        membership.id AS id,
        membership.organization_id AS organizationId,
        organization.kind AS organizationKind,
        membership.user_email AS userEmail,
        membership.normalized_email AS normalizedEmail,
        membership.display_name AS displayName,
        membership.role AS role,
        membership.status AS status,
        membership.closure_request_id AS closureRequestId,
        membership.created_by AS createdBy,
        membership.created_at AS createdAt,
        membership.updated_at AS updatedAt,
        field.id AS fieldId
       FROM account
       LEFT JOIN organization_memberships AS membership
         ON membership.normalized_email = ?2
        AND (?3 = 0 OR (
          membership.organization_id = ?4
          AND membership.id = ?5
        ))
       LEFT JOIN organizations AS organization
         ON organization.id = membership.organization_id
       LEFT JOIN fields AS field
        ON field.organization_id = membership.organization_id
       AND (
         (?3 = 0 AND membership.role IN ('owner', 'admin'))
         OR EXISTS (
           SELECT 1
           FROM membership_field_access AS granted
           WHERE granted.membership_id = membership.id
             AND granted.field_id = field.id
         )
       )
      ORDER BY membership.organization_id ASC, field.name ASC
    `)
    .bind(
      subject,
      normalizedEmail,
      demoIdentity ? 1 : 0,
      PUBLIC_DEMO_ORGANIZATION_ID,
      PUBLIC_DEMO_MEMBERSHIP_ID,
    )
    .all<AuthorizationSnapshotRow>();

  const results = rows.results ?? [];
  const memberships: MembershipRow[] = [];
  const fieldIdsByMembership = new Map<string, string[]>();
  const organizationKindById = new Map<string, AccessibleOrganization["kind"]>();
  for (const row of results) {
    if (row.id === null) continue;
    if (row.organizationId && row.organizationKind) {
      organizationKindById.set(row.organizationId, row.organizationKind);
    }
    let fieldIds = fieldIdsByMembership.get(row.id);
    if (!fieldIds) {
      fieldIds = [];
      fieldIdsByMembership.set(row.id, fieldIds);
      memberships.push({
        id: row.id,
        organizationId: row.organizationId!,
        userEmail: row.userEmail!,
        normalizedEmail: row.normalizedEmail!,
        displayName: row.displayName!,
        role: row.role!,
        status: row.status!,
        closureRequestId: row.closureRequestId,
        createdBy: row.createdBy!,
        createdAt: row.createdAt!,
        updatedAt: row.updatedAt!,
      });
    }
    if (row.fieldId !== null) fieldIds.push(row.fieldId);
  }
  return {
    accountClosureActive: Number(results[0]?.accountClosureActive) === 1,
    memberships,
    fieldIdsByMembership,
    organizationKindById,
  };
}

async function listMembershipFieldIds(membership: MembershipRow): Promise<string[]> {
  if (roleHasGlobalFieldAccess(membership.role)) {
    const rows = await getDb().select({ id: fields.id }).from(fields)
      .where(eq(fields.organizationId, membership.organizationId)).orderBy(asc(fields.name));
    return rows.map((row) => row.id);
  }
  const rows = await getDb().select({ id: membershipFieldAccess.fieldId })
    .from(membershipFieldAccess)
    .innerJoin(fields, eq(fields.id, membershipFieldAccess.fieldId))
    .where(and(
      eq(membershipFieldAccess.membershipId, membership.id),
      eq(fields.organizationId, membership.organizationId),
    ));
  return rows.map((row) => row.id);
}

async function membershipFieldIds(membershipId: string): Promise<string[]> {
  const rows = await getDb().select({ fieldId: membershipFieldAccess.fieldId }).from(membershipFieldAccess)
    .where(eq(membershipFieldAccess.membershipId, membershipId));
  return rows.map((row) => row.fieldId);
}

function accessMembershipWriteCondition(input: {
  actor: AccessContext;
  existing: MembershipRow | null;
  previousFieldIds: string[];
  membershipId: string;
  normalizedEmail: string;
  effectiveFieldIds: string[];
  requiresOwner: boolean;
}): SqlCondition {
  const actorAndFields: SqlCondition = {
    sql: `
      EXISTS (
        SELECT 1 FROM organization_memberships AS current_actor
        WHERE current_actor.id = ?
          AND current_actor.organization_id = ?
          AND current_actor.normalized_email = ?
          AND current_actor.status = 'active'
          AND current_actor.role IN ('owner', 'admin')
          AND (? = 0 OR current_actor.role = 'owner')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?) AS requested_field
        LEFT JOIN fields AS current_field ON current_field.id = requested_field.value
        WHERE current_field.id IS NULL OR current_field.organization_id <> ?
      )
    `,
    bindings: [
      input.actor.membershipId,
      input.actor.organizationId,
      input.actor.email,
      input.requiresOwner ? 1 : 0,
      JSON.stringify(input.effectiveFieldIds),
      input.actor.organizationId,
    ],
  };
  if (!input.existing) {
    return {
      sql: `
        ${actorAndFields.sql}
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships AS conflicting_id
          WHERE conflicting_id.id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships AS conflicting_email
          WHERE conflicting_email.organization_id = ?
            AND conflicting_email.normalized_email = ?
        )
      `,
      bindings: [
        ...actorAndFields.bindings,
        input.membershipId,
        input.actor.organizationId,
        input.normalizedEmail,
      ],
    };
  }

  const current = input.existing;
  const previousFieldIdsJson = JSON.stringify(input.previousFieldIds);
  return {
    sql: `
      ${actorAndFields.sql}
      AND EXISTS (
        SELECT 1 FROM organization_memberships AS current_membership
        WHERE current_membership.id = ?
          AND current_membership.organization_id = ?
          AND current_membership.user_email = ?
          AND current_membership.normalized_email = ?
          AND current_membership.display_name = ?
          AND current_membership.role = ?
          AND current_membership.status = ?
          AND current_membership.created_by = ?
          AND current_membership.created_at = ?
          AND current_membership.updated_at = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM membership_field_access AS current_access
        WHERE current_access.membership_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) AS expected_access
            WHERE expected_access.value = current_access.field_id
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS expected_access
        WHERE NOT EXISTS (
          SELECT 1 FROM membership_field_access AS current_access
          WHERE current_access.membership_id = ?
            AND current_access.field_id = expected_access.value
        )
      )
    `,
    bindings: [
      ...actorAndFields.bindings,
      current.id,
      current.organizationId,
      current.userEmail,
      current.normalizedEmail,
      current.displayName,
      current.role,
      current.status,
      current.createdBy,
      current.createdAt,
      current.updatedAt,
      current.id,
      previousFieldIdsJson,
      previousFieldIdsJson,
      current.id,
    ],
  };
}

function assertCapability(role: OrganizationMembershipRole, capability: AccessCapability): void {
  if (!roleHasCapability(role, capability)) {
    throw new AccessDeniedError("Tu rol no permite administrar accesos.", "CAPABILITY_REQUIRED");
  }
}

async function assertAccountOpen(user: AppUser): Promise<void> {
  if (await getActiveAccountClosure(env.DB, user.subject)) {
    throw new AccessDeniedError(
      "Tu cuenta está suspendida durante una ventana de cierre.",
      "ACCOUNT_CLOSURE_ACTIVE",
    );
  }
}

function toAccessMembership(row: MembershipRow, fieldIds: string[]): AccessMembership {
  return {
    id: row.id,
    email: row.userEmail,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    fieldIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function membershipAuditValue(row: MembershipRow, fieldIds: string[]) {
  return {
    email: row.normalizedEmail,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    fieldIds,
  };
}
