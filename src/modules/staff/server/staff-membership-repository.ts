import { getDb } from "@/db";
import { normalizeAccessEmail } from "@/src/modules/access/domain/access-rules.mjs";
import {
  ORGANIZATION_MEMBERSHIP_ROLES,
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from "@/src/modules/access/domain/types";

const STAFF_CUTOVER_MARKER_KEY = "platform-staff-v2-required";

type D1Binding = string | number | null;
type SqlCondition = {
  sql: string;
  bindings: D1Binding[];
};

type MembershipRow = {
  id: string;
  organizationId: string;
  userEmail: string;
  normalizedEmail: string;
  displayName: string;
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type MembershipPreflightRow = {
  organizationExists: number;
  requestedFieldCount: number;
  validFieldCount: number;
  id: string | null;
  organizationId: string | null;
  userEmail: string | null;
  normalizedEmail: string | null;
  displayName: string | null;
  role: OrganizationMembershipRole | null;
  status: OrganizationMembershipStatus | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  previousFieldIdsJson: string;
};

type MembershipAuditValue = {
  id: string;
  userEmail: string;
  displayName: string;
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
  fieldIds: readonly string[];
};

export type PreparedLegacyStaffMembership = Readonly<{
  action: "access.membership.created" | "access.membership.updated";
  afterJson: string;
  auditId: string;
  beforeJson: string | null;
  displayName: string;
  effectiveFieldIds: readonly string[];
  effectiveFieldIdsJson: string;
  existing: Readonly<MembershipRow> | null;
  insertCandidateId: string;
  membershipId: string;
  normalizedEmail: string;
  now: string;
  organizationId: string;
  previousFieldIds: readonly string[];
  previousFieldIdsJson: string;
  requestedUserEmail: string;
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
}>;

export type LegacyStaffMembershipPreparation =
  | Readonly<{ ok: true; plan: PreparedLegacyStaffMembership }>
  | Readonly<{ ok: false; error: LegacyStaffMembershipError }>;

type LegacyStaffMembershipErrorCode =
  | "STAFF_MEMBERSHIP_INVALID_EMAIL"
  | "STAFF_MEMBERSHIP_INVALID_ORGANIZATION"
  | "STAFF_MEMBERSHIP_INVALID_DISPLAY_NAME"
  | "STAFF_MEMBERSHIP_INVALID_ROLE"
  | "STAFF_MEMBERSHIP_INVALID_STATUS"
  | "STAFF_MEMBERSHIP_INVALID_FIELDS"
  | "STAFF_MEMBERSHIP_INVALID_FIELD"
  | "STAFF_MEMBERSHIP_STAFF_REQUIRED"
  | "STAFF_MEMBERSHIP_CONFLICT"
  | "STAFF_MEMBERSHIP_LAST_OWNER";

export class LegacyStaffMembershipError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: LegacyStaffMembershipErrorCode,
  ) {
    super(message);
    this.name = "LegacyStaffMembershipError";
  }
}

export async function prepareLegacyStaffMembership(input: {
  organizationId: unknown;
  email: unknown;
  displayName?: unknown;
  role?: unknown;
  status?: unknown;
  fieldIds?: unknown;
  now?: Date;
  idFactory?: () => string;
}): Promise<LegacyStaffMembershipPreparation> {
  const organizationId = requiredString(
    input.organizationId,
    "La organización de destino es requerida.",
    "STAFF_MEMBERSHIP_INVALID_ORGANIZATION",
  );
  const requestedUserEmail = typeof input.email === "string" ? input.email.trim() : "";
  const normalizedEmail = normalizeAccessEmail(requestedUserEmail);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new LegacyStaffMembershipError(
      "Ingresa un correo electrónico válido.",
      400,
      "STAFF_MEMBERSHIP_INVALID_EMAIL",
    );
  }
  if (
    input.displayName !== undefined
    && input.displayName !== null
    && typeof input.displayName !== "string"
  ) {
    throw new LegacyStaffMembershipError(
      "El nombre de la persona no es válido.",
      400,
      "STAFF_MEMBERSHIP_INVALID_DISPLAY_NAME",
    );
  }
  const displayName = (typeof input.displayName === "string"
    ? input.displayName.trim()
    : "") || requestedUserEmail;
  const role = membershipRole(input.role);
  const status = membershipStatus(input.status);
  const requestedFieldIds = canonicalFieldIds(input.fieldIds);
  const effectiveFieldIds = role === "owner" || role === "admin"
    ? []
    : requestedFieldIds;
  const effectiveFieldIdsJson = JSON.stringify(effectiveFieldIds);

  const row = await getDb().$client.prepare(`
    WITH target_membership AS (
      SELECT
        membership.id AS id,
        membership.organization_id AS organizationId,
        membership.user_email AS userEmail,
        membership.normalized_email AS normalizedEmail,
        membership.display_name AS displayName,
        membership.role AS role,
        membership.status AS status,
        membership.created_by AS createdBy,
        membership.created_at AS createdAt,
        membership.updated_at AS updatedAt
      FROM organization_memberships AS membership
      WHERE membership.organization_id = ?
        AND membership.normalized_email = ?
      LIMIT 1
    )
    SELECT
      EXISTS (
        SELECT 1 FROM organizations AS organization
        WHERE organization.id = ?
      ) AS organizationExists,
      (SELECT COUNT(*) FROM json_each(?)) AS requestedFieldCount,
      (
        SELECT COUNT(*)
        FROM json_each(?) AS requested
        INNER JOIN fields AS field
          ON field.id = CAST(requested.value AS TEXT)
         AND field.organization_id = ?
        WHERE requested.type = 'text'
      ) AS validFieldCount,
      target.id AS id,
      target.organizationId AS organizationId,
      target.userEmail AS userEmail,
      target.normalizedEmail AS normalizedEmail,
      target.displayName AS displayName,
      target.role AS role,
      target.status AS status,
      target.createdBy AS createdBy,
      target.createdAt AS createdAt,
      target.updatedAt AS updatedAt,
      COALESCE((
        SELECT json_group_array(previous.field_id)
        FROM (
          SELECT access.field_id AS field_id
          FROM membership_field_access AS access
          WHERE access.membership_id = target.id
          ORDER BY access.field_id
        ) AS previous
      ), '[]') AS previousFieldIdsJson
    FROM (SELECT 1) AS singleton
    LEFT JOIN target_membership AS target ON 1 = 1
  `).bind(
    organizationId,
    normalizedEmail,
    organizationId,
    effectiveFieldIdsJson,
    effectiveFieldIdsJson,
    organizationId,
  ).first<MembershipPreflightRow>();

  if (!row || Number(row.organizationExists) !== 1) {
    return Object.freeze({
      ok: false,
      error: new LegacyStaffMembershipError(
        "La organización destino no existe.",
        400,
        "STAFF_MEMBERSHIP_INVALID_ORGANIZATION",
      ),
    });
  }
  if (Number(row.requestedFieldCount) !== Number(row.validFieldCount)) {
    return Object.freeze({
      ok: false,
      error: new LegacyStaffMembershipError(
        "Uno de los fundos seleccionados no pertenece a la organización.",
        400,
        "STAFF_MEMBERSHIP_INVALID_FIELD",
      ),
    });
  }

  const existing = membershipRow(row);
  const previousFieldIds = existing
    ? parsedFieldIds(row.previousFieldIdsJson)
    : [];
  const idFactory = input.idFactory ?? (() => crypto.randomUUID());
  const insertCandidateId = `membership-${idFactory()}`;
  const membershipId = existing?.id ?? insertCandidateId;
  const auditId = idFactory();
  const now = (input.now ?? new Date()).toISOString();
  const finalUserEmail = existing?.userEmail ?? requestedUserEmail;
  const action = existing
    ? "access.membership.updated"
    : "access.membership.created";
  const beforeJson = existing
    ? JSON.stringify(membershipAuditValue(existing, previousFieldIds))
    : null;
  const afterJson = JSON.stringify({
    id: membershipId,
    userEmail: finalUserEmail,
    displayName,
    role,
    status,
    fieldIds: effectiveFieldIds,
  } satisfies MembershipAuditValue);

  return Object.freeze({
    ok: true,
    plan: Object.freeze({
      action,
      afterJson,
      auditId,
      beforeJson,
      displayName,
      effectiveFieldIds: Object.freeze([...effectiveFieldIds]),
      effectiveFieldIdsJson,
      existing: existing ? Object.freeze(existing) : null,
      insertCandidateId,
      membershipId,
      normalizedEmail,
      now,
      organizationId,
      previousFieldIds: Object.freeze([...previousFieldIds]),
      previousFieldIdsJson: JSON.stringify(previousFieldIds),
      requestedUserEmail,
      role,
      status,
    }),
  });
}

export async function commitLegacyStaffMembership(input: {
  plan: PreparedLegacyStaffMembership;
  actorSubject: string;
  actorEmail: string;
  staffCutoverMarkerKey: string;
}): Promise<{ membershipId: string }> {
  if (input.staffCutoverMarkerKey !== STAFF_CUTOVER_MARKER_KEY) {
    throw membershipConflict();
  }
  const actorEmail = input.actorEmail.trim();
  const normalizedActorEmail = normalizeAccessEmail(actorEmail);
  const actorSubject = input.actorSubject.trim();
  if (
    !actorSubject
    || !normalizedActorEmail
    || !normalizedActorEmail.includes("@")
  ) {
    throw new LegacyStaffMembershipError(
      "No fue posible identificar al miembro de staff.",
      403,
      "STAFF_MEMBERSHIP_STAFF_REQUIRED",
    );
  }

  const plan = input.plan;
  const client = getDb().$client;
  const receipt = receiptCondition(plan, actorEmail);
  const expectedState = expectedStateCondition(plan);
  const finalMembership = finalMembershipCondition(plan, actorEmail);
  const authority = currentStaffAuthorityCondition({
    actorSubject,
    normalizedActorEmail,
    organizationId: plan.organizationId,
    staffCutoverMarkerKey: input.staffCutoverMarkerKey,
  });
  const accessIdPrefix = `access-${plan.auditId}-`;

  const auditStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, NULL, ?, ?, 'organization_membership', ?, ?, ?, NULL, ?
    WHERE ${authority.sql}
      AND EXISTS (
        SELECT 1 FROM organizations AS organization
        WHERE organization.id = ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?) AS requested
        LEFT JOIN fields AS scoped
          ON scoped.id = CAST(requested.value AS TEXT)
         AND scoped.organization_id = ?
        WHERE requested.type <> 'text' OR scoped.id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships AS candidate_collision
        WHERE candidate_collision.id = ?
      )
      AND ${expectedState.sql}
  `).bind(
    plan.auditId,
    plan.organizationId,
    actorEmail,
    plan.action,
    plan.membershipId,
    plan.beforeJson,
    plan.afterJson,
    plan.now,
    ...authority.bindings,
    plan.organizationId,
    plan.effectiveFieldIdsJson,
    plan.organizationId,
    plan.insertCandidateId,
    ...expectedState.bindings,
  );

  const membershipStatement = client.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${receipt.sql}
      AND ${authority.sql}
    ON CONFLICT(organization_id, normalized_email) DO UPDATE SET
      display_name = excluded.display_name,
      role = excluded.role,
      status = excluded.status,
      updated_at = excluded.updated_at
    WHERE organization_memberships.id = ?
  `).bind(
    plan.insertCandidateId,
    plan.organizationId,
    plan.requestedUserEmail,
    plan.normalizedEmail,
    plan.displayName,
    plan.role,
    plan.status,
    actorEmail,
    plan.now,
    plan.now,
    ...receipt.bindings,
    ...authority.bindings,
    plan.membershipId,
  );

  const clearScopesStatement = client.prepare(`
    DELETE FROM membership_field_access
    WHERE membership_id = ?
      AND ${receipt.sql}
      AND ${finalMembership.sql}
      AND ${authority.sql}
  `).bind(
    plan.membershipId,
    ...receipt.bindings,
    ...finalMembership.bindings,
    ...authority.bindings,
  );

  const insertScopesStatement = client.prepare(`
    INSERT INTO membership_field_access (
      id, membership_id, field_id, created_by, created_at
    )
    SELECT
      ? || CAST(requested.key AS TEXT),
      committed.id,
      scoped.id,
      ?,
      ?
    FROM json_each(?) AS requested
    INNER JOIN fields AS scoped
      ON scoped.id = CAST(requested.value AS TEXT)
     AND scoped.organization_id = ?
    INNER JOIN organization_memberships AS committed
      ON committed.id = ?
     AND committed.organization_id = ?
     AND committed.normalized_email = ?
    WHERE requested.type = 'text'
      AND ${receipt.sql}
      AND ${finalMembership.sql}
      AND ${authority.sql}
  `).bind(
    accessIdPrefix,
    actorEmail,
    plan.now,
    plan.effectiveFieldIdsJson,
    plan.organizationId,
    plan.membershipId,
    plan.organizationId,
    plan.normalizedEmail,
    ...receipt.bindings,
    ...finalMembership.bindings,
    ...authority.bindings,
  );

  const sentinelStatement = client.prepare(`
    SELECT
      CASE WHEN
        ${authority.sql}
        AND ${receipt.sql}
        AND ${finalMembership.sql}
        AND NOT EXISTS (
          SELECT 1
          FROM membership_field_access AS actual
          LEFT JOIN json_each(?) AS expected
            ON expected.type = 'text'
           AND expected.value = actual.field_id
          WHERE actual.membership_id = ?
            AND (
              expected.value IS NULL
              OR actual.id <> (? || CAST(expected.key AS TEXT))
              OR actual.created_by <> ?
              OR actual.created_at <> ?
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(?) AS expected
          WHERE expected.type <> 'text'
             OR NOT EXISTS (
               SELECT 1
               FROM membership_field_access AS actual
               WHERE actual.membership_id = ?
                 AND actual.field_id = expected.value
                 AND actual.id = (? || CAST(expected.key AS TEXT))
                 AND actual.created_by = ?
                 AND actual.created_at = ?
             )
        )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
      ? AS membershipId
  `).bind(
    ...authority.bindings,
    ...receipt.bindings,
    ...finalMembership.bindings,
    plan.effectiveFieldIdsJson,
    plan.membershipId,
    accessIdPrefix,
    actorEmail,
    plan.now,
    plan.effectiveFieldIdsJson,
    plan.membershipId,
    accessIdPrefix,
    actorEmail,
    plan.now,
    plan.membershipId,
  );

  let results: D1Result<unknown>[];
  try {
    results = await client.batch([
      auditStatement,
      membershipStatement,
      clearScopesStatement,
      insertScopesStatement,
      sentinelStatement,
    ]);
  } catch (cause) {
    const diagnostic = cause instanceof Error ? cause.message : String(cause);
    if (diagnostic.includes("LAST_ACTIVE_OWNER")) {
      throw new LegacyStaffMembershipError(
        "La organización debe conservar al menos un propietario activo.",
        409,
        "STAFF_MEMBERSHIP_LAST_OWNER",
      );
    }
    if (/integer overflow/iu.test(diagnostic)) {
      throw membershipConflict();
    }
    throw cause;
  }

  const sentinel = results[4]?.results?.[0] as {
    complete?: number;
    membershipId?: string;
  } | undefined;
  if (
    Number(sentinel?.complete) !== 1
    || sentinel?.membershipId !== plan.membershipId
  ) {
    throw new Error("The staff membership batch returned an invalid sentinel.");
  }
  return { membershipId: plan.membershipId };
}

function currentStaffAuthorityCondition(input: {
  actorSubject: string;
  normalizedActorEmail: string;
  organizationId: string;
  staffCutoverMarkerKey: string;
}): SqlCondition {
  return {
    sql: `(
      ? = 'dev:' || ?
      OR EXISTS (
        SELECT 1
        FROM auth_identities AS actor_identity
        WHERE actor_identity.id = ?
          AND actor_identity.normalized_email = ?
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM account_closure_requests AS account_closure
      WHERE account_closure.scope = 'account'
        AND account_closure.target_id = ?
        AND account_closure.status = 'grace'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM account_closure_requests AS organization_closure
      WHERE organization_closure.scope = 'organization'
        AND organization_closure.target_id = ?
        AND organization_closure.status = 'grace'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app_state AS staff_cutover
      WHERE staff_cutover.key = ?
    )`,
    bindings: [
      input.actorSubject,
      input.normalizedActorEmail,
      input.actorSubject,
      input.normalizedActorEmail,
      input.actorSubject,
      input.organizationId,
      input.staffCutoverMarkerKey,
    ],
  };
}

function receiptCondition(
  plan: PreparedLegacyStaffMembership,
  actorEmail: string,
): SqlCondition {
  return {
    sql: `EXISTS (
      SELECT 1
      FROM audit_log AS receipt
      WHERE receipt.id = ?
        AND receipt.organization_id = ?
        AND receipt.field_id IS NULL
        AND receipt.actor = ?
        AND receipt.action = ?
        AND receipt.entity_type = 'organization_membership'
        AND receipt.entity_id = ?
        AND receipt.before IS ?
        AND receipt.after = ?
        AND receipt.source_record_id IS NULL
        AND receipt.occurred_at = ?
    )`,
    bindings: [
      plan.auditId,
      plan.organizationId,
      actorEmail,
      plan.action,
      plan.membershipId,
      plan.beforeJson,
      plan.afterJson,
      plan.now,
    ],
  };
}

function finalMembershipCondition(
  plan: PreparedLegacyStaffMembership,
  actorEmail: string,
): SqlCondition {
  const existing = plan.existing;
  return {
    sql: `EXISTS (
      SELECT 1
      FROM organization_memberships AS committed
      WHERE committed.id = ?
        AND committed.organization_id = ?
        AND committed.user_email = ?
        AND committed.normalized_email = ?
        AND committed.display_name = ?
        AND committed.role = ?
        AND committed.status = ?
        AND committed.created_by = ?
        AND committed.created_at = ?
        AND committed.updated_at = ?
    )`,
    bindings: [
      plan.membershipId,
      plan.organizationId,
      existing?.userEmail ?? plan.requestedUserEmail,
      plan.normalizedEmail,
      plan.displayName,
      plan.role,
      plan.status,
      existing?.createdBy ?? actorEmail,
      existing?.createdAt ?? plan.now,
      plan.now,
    ],
  };
}

function expectedStateCondition(
  plan: PreparedLegacyStaffMembership,
): SqlCondition {
  const existing = plan.existing;
  if (!existing) {
    return {
      sql: `NOT EXISTS (
        SELECT 1
        FROM organization_memberships AS conflicting_email
        WHERE conflicting_email.organization_id = ?
          AND conflicting_email.normalized_email = ?
      )`,
      bindings: [plan.organizationId, plan.normalizedEmail],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1
      FROM organization_memberships AS current
      WHERE current.id = ?
        AND current.organization_id = ?
        AND current.user_email = ?
        AND current.normalized_email = ?
        AND current.display_name = ?
        AND current.role = ?
        AND current.status = ?
        AND current.created_by = ?
        AND current.created_at = ?
        AND current.updated_at = ?
    )
    AND NOT EXISTS (
      SELECT 1
      FROM membership_field_access AS current_access
      WHERE current_access.membership_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(?) AS expected
          WHERE expected.type = 'text'
            AND expected.value = current_access.field_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) AS expected
      WHERE expected.type <> 'text'
         OR NOT EXISTS (
           SELECT 1
           FROM membership_field_access AS current_access
           WHERE current_access.membership_id = ?
             AND current_access.field_id = expected.value
         )
    )`,
    bindings: [
      existing.id,
      existing.organizationId,
      existing.userEmail,
      existing.normalizedEmail,
      existing.displayName,
      existing.role,
      existing.status,
      existing.createdBy,
      existing.createdAt,
      existing.updatedAt,
      existing.id,
      plan.previousFieldIdsJson,
      plan.previousFieldIdsJson,
      existing.id,
    ],
  };
}

function membershipRow(row: MembershipPreflightRow): MembershipRow | null {
  if (!row.id) return null;
  if (
    !row.organizationId
    || row.userEmail === null
    || row.normalizedEmail === null
    || row.displayName === null
    || row.role === null
    || row.status === null
    || row.createdBy === null
    || row.createdAt === null
    || row.updatedAt === null
  ) {
    throw new Error("The legacy staff membership preflight returned a partial row.");
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    userEmail: row.userEmail,
    normalizedEmail: row.normalizedEmail,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function membershipAuditValue(
  membership: MembershipRow,
  fieldIds: readonly string[],
): MembershipAuditValue {
  return {
    id: membership.id,
    userEmail: membership.userEmail,
    displayName: membership.displayName,
    role: membership.role,
    status: membership.status,
    fieldIds,
  };
}

function requiredString(
  value: unknown,
  message: string,
  code: LegacyStaffMembershipErrorCode,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new LegacyStaffMembershipError(message, 400, code);
  }
  return normalized;
}

function membershipRole(value: unknown): OrganizationMembershipRole {
  const role = value === undefined ? "viewer" : value;
  if (
    typeof role !== "string"
    || !ORGANIZATION_MEMBERSHIP_ROLES.includes(role as OrganizationMembershipRole)
  ) {
    throw new LegacyStaffMembershipError(
      "El rol seleccionado no es válido.",
      400,
      "STAFF_MEMBERSHIP_INVALID_ROLE",
    );
  }
  return role as OrganizationMembershipRole;
}

function membershipStatus(value: unknown): OrganizationMembershipStatus {
  const status = value === undefined ? "active" : value;
  if (
    typeof status !== "string"
    || !ORGANIZATION_MEMBERSHIP_STATUSES.includes(status as OrganizationMembershipStatus)
  ) {
    throw new LegacyStaffMembershipError(
      "El estado seleccionado no es válido.",
      400,
      "STAFF_MEMBERSHIP_INVALID_STATUS",
    );
  }
  return status as OrganizationMembershipStatus;
}

function canonicalFieldIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.some((fieldId) => typeof fieldId !== "string" || !fieldId.trim())
  ) {
    throw new LegacyStaffMembershipError(
      "Los fundos seleccionados no son válidos.",
      400,
      "STAFF_MEMBERSHIP_INVALID_FIELDS",
    );
  }
  return [...new Set(value.map((fieldId) => fieldId.trim()))].sort();
}

function parsedFieldIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed)
    || parsed.some((fieldId) => typeof fieldId !== "string")
  ) {
    throw new Error("The legacy staff membership preflight returned invalid scopes.");
  }
  return [...new Set(parsed)].sort();
}

function membershipConflict(): LegacyStaffMembershipError {
  return new LegacyStaffMembershipError(
    "La membresía cambió mientras se guardaba. Vuelve a cargarla.",
    409,
    "STAFF_MEMBERSHIP_CONFLICT",
  );
}
