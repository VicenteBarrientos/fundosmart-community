import { normalizeAuthEmail } from "@/app/auth-core.mjs";
import {
  AccountClosureError,
  canonicalAccountClosureSnapshotJson,
  createAccountClosureRequestPlan,
  createAccountClosureRevocationPlan,
  evaluateAccountClosure,
  type AccountClosureRecord,
  type AccountClosureScope,
  type AccountClosureSnapshot,
} from "@/src/modules/account-lifecycle/account-closure.mjs";

type ClosureRow = {
  id: string;
  scope: AccountClosureScope;
  targetId: string;
  actorIdentityId: string;
  requestId: string;
  status: "grace" | "revoked";
  requestedAt: string;
  graceEndsAt: string;
  revokedAt: string | null;
  version: number;
  snapshotVersion: 1;
  snapshotJson: string;
};

type IdentityRow = {
  id: string;
  email: string;
  normalizedEmail: string;
};

type MembershipSnapshotRow = {
  id: string;
  organizationId: string;
  role: AccountClosureSnapshot["memberships"][number]["role"];
  status: AccountClosureSnapshot["memberships"][number]["status"];
};

type FieldAccessRow = {
  membershipId: string;
  fieldId: string;
};

export type AccountClosureActor = Readonly<{
  subject: string;
  email: string;
}>;

export type AccountClosureSummary = Readonly<AccountClosureRecord & {
  state: "grace" | "revoked" | "expired";
  accessSuspended: boolean;
  revocable: boolean;
}>;

export class AccountClosurePersistenceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountClosurePersistenceError";
    this.code = code;
    this.status = status;
  }
}

export async function listAccountClosureRequests(
  database: D1Database,
  identityId: string,
  now: string,
): Promise<readonly AccountClosureSummary[]> {
  const rows = await database.withSession("first-primary").prepare(`
    SELECT
      id,
      scope,
      target_id AS targetId,
      actor_identity_id AS actorIdentityId,
      request_id AS requestId,
      status,
      requested_at AS requestedAt,
      grace_ends_at AS graceEndsAt,
      revoked_at AS revokedAt,
      version,
      snapshot_version AS snapshotVersion,
      snapshot_json AS snapshotJson
    FROM account_closure_requests
    WHERE actor_identity_id = ?
    ORDER BY requested_at DESC, id DESC
  `).bind(identityId).all<ClosureRow>();
  return Object.freeze((rows.results ?? []).map((row) => {
    const record = closureRecord(row);
    const disposition = evaluateAccountClosure(record, now);
    return Object.freeze({ ...record, ...disposition });
  }));
}

export async function getActiveAccountClosure(
  database: D1Database,
  identityId: string,
): Promise<AccountClosureRecord | null> {
  const row = await database.withSession("first-primary").prepare(`
    SELECT
      id,
      scope,
      target_id AS targetId,
      actor_identity_id AS actorIdentityId,
      request_id AS requestId,
      status,
      requested_at AS requestedAt,
      grace_ends_at AS graceEndsAt,
      revoked_at AS revokedAt,
      version,
      snapshot_version AS snapshotVersion,
      snapshot_json AS snapshotJson
    FROM account_closure_requests
    WHERE scope = 'account'
      AND target_id = ?
      AND status = 'grace'
    LIMIT 1
  `).bind(identityId).first<ClosureRow>();
  return row ? closureRecord(row) : null;
}

export async function requestAccountClosure(
  database: D1Database,
  input: {
    actor: AccountClosureActor;
    scope: AccountClosureScope;
    targetId: string;
    requestId: string;
    requestedAt: string;
    organizationConfirmation?: string;
    beforeCommit?: () => Promise<void>;
    idFactory?: (label: string) => string;
  },
): Promise<AccountClosureRecord> {
  if (input.actor.subject === "demo" || input.actor.subject.startsWith("dev:")) {
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_DEMO_FORBIDDEN",
      "La cuenta de demostración no puede solicitar cierres.",
      403,
    );
  }
  const session = database.withSession("first-primary");
  const [identityResult, organizationResult, membershipsResult, fieldAccessResult, replayResult] =
    await session.batch<Record<string, unknown>>([
      session.prepare(`
        SELECT id, email, normalized_email AS normalizedEmail
        FROM auth_identities
        WHERE id = ?
        LIMIT 1
      `).bind(input.actor.subject),
      session.prepare(`
        SELECT organization.id, organization.kind, organization.name
        FROM organizations AS organization
        INNER JOIN auth_identities AS identity
          ON identity.id = ?
        INNER JOIN organization_memberships AS membership
          ON membership.organization_id = organization.id
          AND membership.normalized_email = identity.normalized_email
          AND membership.role = 'owner'
          AND membership.status = 'active'
          AND membership.closure_request_id IS NULL
        WHERE ? = 'organization' AND organization.id = ?
        LIMIT 1
      `).bind(input.actor.subject, input.scope, input.targetId),
      session.prepare(`
        SELECT
          membership.id,
          membership.organization_id AS organizationId,
          membership.role,
          COALESCE((
            SELECT CASE
              WHEN ? <= linked_request.grace_ends_at
                THEN json_extract(linked_snapshot.value, '$.status')
              ELSE membership.status
            END
            FROM account_closure_requests AS linked_request
            INNER JOIN json_each(
              linked_request.snapshot_json,
              '$.memberships'
            ) AS linked_snapshot
            WHERE linked_request.id = membership.closure_request_id
              AND linked_request.status = 'grace'
              AND json_extract(linked_snapshot.value, '$.id') = membership.id
            LIMIT 1
          ), membership.status) AS status
        FROM organization_memberships AS membership
        WHERE (
          ? = 'organization'
          AND membership.organization_id = ?
        ) OR (
          ? = 'account'
          AND membership.normalized_email = (
            SELECT identity.normalized_email
            FROM auth_identities AS identity
            WHERE identity.id = ?
          )
        )
        ORDER BY membership.id
      `).bind(
        input.requestedAt,
        input.scope,
        input.targetId,
        input.scope,
        input.targetId,
      ),
      session.prepare(`
        SELECT access.membership_id AS membershipId, access.field_id AS fieldId
        FROM membership_field_access AS access
        INNER JOIN organization_memberships AS membership
          ON membership.id = access.membership_id
        WHERE (
          ? = 'organization'
          AND membership.organization_id = ?
        ) OR (
          ? = 'account'
          AND membership.normalized_email = (
            SELECT identity.normalized_email
            FROM auth_identities AS identity
            WHERE identity.id = ?
          )
        )
        ORDER BY access.membership_id, access.field_id
      `).bind(input.scope, input.targetId, input.scope, input.targetId),
      session.prepare(`
        SELECT
          id,
          scope,
          target_id AS targetId,
          actor_identity_id AS actorIdentityId,
          request_id AS requestId,
          status,
          requested_at AS requestedAt,
          grace_ends_at AS graceEndsAt,
          revoked_at AS revokedAt,
          version,
          snapshot_version AS snapshotVersion,
          snapshot_json AS snapshotJson
        FROM account_closure_requests
        WHERE actor_identity_id = ? AND request_id = ?
        LIMIT 1
      `).bind(input.actor.subject, input.requestId),
    ]);

  if (input.beforeCommit) await input.beforeCommit();
  const replay = firstRow<ClosureRow>(replayResult);
  if (replay) {
    if (replay.scope !== input.scope || replay.targetId !== input.targetId) {
      throw new AccountClosurePersistenceError(
        "ACCOUNT_CLOSURE_REQUEST_CONFLICT",
        "El identificador de solicitud ya corresponde a otro cierre.",
      );
    }
    if (replay.status === "revoked") {
      throw new AccountClosurePersistenceError(
        "ACCOUNT_CLOSURE_REQUEST_REVOKED",
        "La solicitud anterior ya fue revocada; usa un identificador nuevo.",
      );
    }
    return closureRecord(replay);
  }

  const identity = firstRow<IdentityRow>(identityResult);
  if (
    !identity
    || identity.id !== input.actor.subject
    || identity.normalizedEmail !== normalizeAuthEmail(input.actor.email)
  ) {
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_IDENTITY_CHANGED",
      "La identidad autenticada cambió antes de solicitar el cierre.",
    );
  }
  if (input.scope === "organization") {
    const organization = firstRow<{ id: string; kind: string; name: string }>(
      organizationResult,
    );
    if (!organization || organization.id !== input.targetId || organization.kind === "demo") {
      throw new AccountClosurePersistenceError(
        "ACCOUNT_CLOSURE_OWNER_REQUIRED",
        "Sólo un owner activo puede solicitar el cierre de la organización.",
        403,
      );
    }
    if (input.organizationConfirmation !== organization.name) {
      throw new AccountClosurePersistenceError(
        "CLOSURE_CONFIRMATION_MISMATCH",
        "Escribe el nombre exacto de la organización para confirmar.",
        400,
      );
    }
  }

  const membershipRows = resultRows<MembershipSnapshotRow>(membershipsResult);
  if (
    input.scope === "organization"
    && !membershipRows.some((membership) =>
      membership.role === "owner"
      && membership.status === "active"
      && membership.id.length > 0)
  ) {
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_OWNER_REQUIRED",
      "Sólo un owner activo puede solicitar el cierre de la organización.",
      403,
    );
  }
  const fieldIdsByMembership = new Map<string, string[]>();
  for (const row of resultRows<FieldAccessRow>(fieldAccessResult)) {
    const fieldIds = fieldIdsByMembership.get(row.membershipId) ?? [];
    fieldIds.push(row.fieldId);
    fieldIdsByMembership.set(row.membershipId, fieldIds);
  }
  const snapshot = {
    memberships: membershipRows.map((membership) => ({
      ...membership,
      fieldIds: fieldIdsByMembership.get(membership.id) ?? [],
    })),
  };

  let plan: ReturnType<typeof createAccountClosureRequestPlan>;
  try {
    plan = createAccountClosureRequestPlan({
      actorIdentityId: input.actor.subject,
      idFactory: input.idFactory ?? (() => crypto.randomUUID()),
      now: input.requestedAt,
      requestId: input.requestId,
      scope: input.scope,
      snapshot,
      targetId: input.targetId,
    });
  } catch (cause) {
    if (cause instanceof AccountClosureError) throw cause;
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_INPUT_INVALID",
      "La solicitud de cierre no es válida.",
      400,
      { cause },
    );
  }

  const closure = plan.closureRequest;
  const snapshotJson = canonicalAccountClosureSnapshotJson(closure.snapshot);
  const eventPayloadJson = canonicalJson(plan.event.payload);
  const organizationId = closure.scope === "organization" ? closure.targetId : null;
  const statements = [
    session.prepare(`
      INSERT INTO account_closure_requests (
        id, scope, target_id, actor_identity_id, request_id, status,
        requested_at, grace_ends_at, revoked_at, version,
        snapshot_version, snapshot_json
      )
      SELECT ?, ?, ?, ?, ?, 'grace', ?, ?, NULL, 1, 1, ?
      WHERE EXISTS (
        SELECT 1
        FROM auth_identities
        WHERE id = ? AND normalized_email = ?
      )
        AND (
          ? <> 'organization'
          OR EXISTS (
            SELECT 1
            FROM organizations AS organization
            INNER JOIN auth_identities AS identity
              ON identity.id = ?
            INNER JOIN organization_memberships AS membership
              ON membership.organization_id = organization.id
              AND membership.normalized_email = identity.normalized_email
              AND membership.role = 'owner'
              AND membership.status = 'active'
              AND membership.closure_request_id IS NULL
            WHERE organization.id = ?
              AND organization.name = ?
              AND organization.kind <> 'demo'
          )
        )
    `).bind(
      closure.id,
      closure.scope,
      closure.targetId,
      closure.actorIdentityId,
      closure.requestId,
      closure.requestedAt,
      closure.graceEndsAt,
      snapshotJson,
      input.actor.subject,
      identity.normalizedEmail,
      closure.scope,
      input.actor.subject,
      closure.targetId,
      input.organizationConfirmation ?? "",
    ),
    session.prepare(`
      INSERT INTO personal_data_events (
        id, identity_id, organization_id, request_id, event_type,
        entity_type, entity_id, payload_json, occurred_at
      )
      SELECT ?, ?, ?, ?, 'account.closure.requested',
        'account_closure', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM account_closure_requests
        WHERE id = ? AND status = 'grace'
      )
    `).bind(
      plan.event.id,
      plan.event.actorIdentityId,
      organizationId,
      plan.event.requestId,
      plan.event.closureRequestId,
      eventPayloadJson,
      plan.event.occurredAt,
      closure.id,
    ),
    session.prepare(`
      UPDATE organization_memberships
      SET status = 'suspended', closure_request_id = ?
      WHERE id IN (
        SELECT json_extract(snapshot.value, '$.id')
        FROM json_each(?, '$.memberships') AS snapshot
      )
        AND closure_request_id IS NULL
        AND EXISTS (
          SELECT 1 FROM account_closure_requests
          WHERE id = ? AND status = 'grace'
        )
    `).bind(closure.id, snapshotJson, closure.id),
    session.prepare(`
      DELETE FROM auth_sessions
      WHERE ? = 'account' AND identity_id = ?
    `).bind(closure.scope, closure.targetId),
    closureRequestSentinel(session, {
      closure,
      eventId: plan.event.id,
      eventPayloadJson,
      organizationId,
      snapshotJson,
    }),
  ];

  try {
    const results = await session.batch<Record<string, unknown>>(statements);
    assertSentinel(results.at(-1), closure.id, "ACCOUNT_CLOSURE_NOT_REQUESTED");
  } catch (cause) {
    if (cause instanceof AccountClosurePersistenceError) throw cause;
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_NOT_REQUESTED",
      "No fue posible suspender el acceso durante la ventana de gracia.",
      409,
      { cause },
    );
  }
  return closure;
}

export async function revokeAccountClosure(
  database: D1Database,
  input: {
    actor: AccountClosureActor;
    closureRequestId: string;
    requestId: string;
    revokedAt: string;
    beforeCommit?: () => Promise<void>;
    idFactory?: (label: string) => string;
  },
): Promise<AccountClosureRecord> {
  const session = database.withSession("first-primary");
  const [closureResult, identityResult, replayResult] =
    await session.batch<Record<string, unknown>>([
      session.prepare(`
        SELECT
          id,
          scope,
          target_id AS targetId,
          actor_identity_id AS actorIdentityId,
          request_id AS requestId,
          status,
          requested_at AS requestedAt,
          grace_ends_at AS graceEndsAt,
          revoked_at AS revokedAt,
          version,
          snapshot_version AS snapshotVersion,
          snapshot_json AS snapshotJson
        FROM account_closure_requests
        WHERE id = ?
        LIMIT 1
      `).bind(input.closureRequestId),
      session.prepare(`
        SELECT id, email, normalized_email AS normalizedEmail
        FROM auth_identities
        WHERE id = ?
        LIMIT 1
      `).bind(input.actor.subject),
      session.prepare(`
        SELECT entity_id AS closureRequestId
        FROM personal_data_events
        WHERE identity_id = ?
          AND request_id = ?
          AND event_type = 'account.closure.revoked'
        LIMIT 1
      `).bind(input.actor.subject, input.requestId),
    ]);
  if (input.beforeCommit) await input.beforeCommit();
  const row = firstRow<ClosureRow>(closureResult);
  const identity = firstRow<IdentityRow>(identityResult);
  if (
    !row
    || row.actorIdentityId !== input.actor.subject
    || !identity
    || identity.normalizedEmail !== normalizeAuthEmail(input.actor.email)
  ) {
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_RECOVERY_FORBIDDEN",
      "La solicitud de cierre no está disponible para esta identidad.",
      403,
    );
  }
  const replay = firstRow<{ closureRequestId: string }>(replayResult);
  if (row.status === "revoked" && replay?.closureRequestId === row.id) {
    return closureRecord(row);
  }
  const current = closureRecord(row);
  let plan: ReturnType<typeof createAccountClosureRevocationPlan>;
  try {
    plan = createAccountClosureRevocationPlan({
      actorIdentityId: input.actor.subject,
      current,
      idFactory: input.idFactory ?? (() => crypto.randomUUID()),
      now: input.revokedAt,
      requestId: input.requestId,
    });
  } catch (cause) {
    if (cause instanceof AccountClosureError) throw cause;
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_REVOCATION_INVALID",
      "La revocación no es válida.",
      409,
      { cause },
    );
  }
  const snapshotJson = canonicalAccountClosureSnapshotJson(current.snapshot);
  const eventPayloadJson = canonicalJson(plan.event.payload);
  const organizationId = current.scope === "organization" ? current.targetId : null;
  const statements = [
    session.prepare(`
      INSERT INTO personal_data_events (
        id, identity_id, organization_id, request_id, event_type,
        entity_type, entity_id, payload_json, occurred_at
      )
      SELECT ?, ?, ?, ?, 'account.closure.revoked',
        'account_closure', ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM account_closure_requests
        WHERE id = ?
          AND actor_identity_id = ?
          AND status = 'grace'
          AND version = ?
          AND ? >= requested_at
          AND ? <= grace_ends_at
      )
    `).bind(
      plan.event.id,
      plan.event.actorIdentityId,
      organizationId,
      plan.event.requestId,
      plan.event.closureRequestId,
      eventPayloadJson,
      plan.event.occurredAt,
      current.id,
      input.actor.subject,
      plan.revocation.expectedVersion,
      plan.revocation.revokedAt,
      plan.revocation.revokedAt,
    ),
    session.prepare(`
      UPDATE account_closure_requests
      SET status = 'revoked', revoked_at = ?, version = ?
      WHERE id = ?
        AND actor_identity_id = ?
        AND status = 'grace'
        AND version = ?
    `).bind(
      plan.revocation.revokedAt,
      plan.revocation.nextVersion,
      current.id,
      input.actor.subject,
      plan.revocation.expectedVersion,
    ),
    session.prepare(`
      UPDATE organization_memberships
      SET
        status = CASE WHEN EXISTS (
          SELECT 1
          FROM account_closure_requests AS replacement
          INNER JOIN json_each(
            replacement.snapshot_json,
            '$.memberships'
          ) AS replacement_snapshot
          INNER JOIN json_each(?1, '$.memberships') AS current_snapshot
          WHERE replacement.id <> ?2
            AND replacement.status = 'grace'
            AND json_extract(replacement_snapshot.value, '$.id')
              = organization_memberships.id
            AND json_extract(current_snapshot.value, '$.id')
              = organization_memberships.id
            AND (
              ?3 > replacement.grace_ends_at
              OR json_extract(replacement_snapshot.value, '$.status')
                = json_extract(current_snapshot.value, '$.status')
            )
        ) THEN 'suspended' ELSE (
          SELECT json_extract(snapshot.value, '$.status')
          FROM json_each(?1, '$.memberships') AS snapshot
          WHERE json_extract(snapshot.value, '$.id') = organization_memberships.id
        ) END,
        closure_request_id = (
          SELECT replacement.id
          FROM account_closure_requests AS replacement
          INNER JOIN json_each(
            replacement.snapshot_json,
            '$.memberships'
          ) AS replacement_snapshot
          INNER JOIN json_each(?1, '$.memberships') AS current_snapshot
          WHERE replacement.id <> ?2
            AND replacement.status = 'grace'
            AND json_extract(replacement_snapshot.value, '$.id')
              = organization_memberships.id
            AND json_extract(current_snapshot.value, '$.id')
              = organization_memberships.id
            AND (
              ?3 > replacement.grace_ends_at
              OR json_extract(replacement_snapshot.value, '$.status')
                = json_extract(current_snapshot.value, '$.status')
            )
          ORDER BY replacement.requested_at, replacement.id
          LIMIT 1
        )
      WHERE closure_request_id = ?2
        AND EXISTS (
          SELECT 1 FROM account_closure_requests
          WHERE id = ?2 AND status = 'revoked' AND revoked_at = ?3
        )
    `).bind(snapshotJson, current.id, plan.revocation.revokedAt),
    closureRevocationSentinel(session, {
      actorIdentityId: input.actor.subject,
      closure: current,
      eventId: plan.event.id,
      eventPayloadJson,
      organizationId,
      requestId: plan.event.requestId,
      revokedAt: plan.revocation.revokedAt,
      snapshotJson,
      version: plan.revocation.nextVersion,
    }),
  ];

  try {
    const results = await session.batch<Record<string, unknown>>(statements);
    assertSentinel(results.at(-1), current.id, "ACCOUNT_CLOSURE_NOT_REVOKED");
  } catch (cause) {
    if (cause instanceof AccountClosurePersistenceError) throw cause;
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_NOT_REVOKED",
      "No fue posible restaurar el acceso dentro de la ventana de gracia.",
      409,
      { cause },
    );
  }
  return Object.freeze({
    ...current,
    status: "revoked" as const,
    revokedAt: plan.revocation.revokedAt,
    version: plan.revocation.nextVersion,
  });
}

function closureRequestSentinel(
  session: D1DatabaseSession,
  input: {
    closure: ReturnType<typeof createAccountClosureRequestPlan>["closureRequest"];
    eventId: string;
    eventPayloadJson: string;
    organizationId: string | null;
    snapshotJson: string;
  },
): D1PreparedStatement {
  return session.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1
        FROM account_closure_requests
        WHERE id = ?1
          AND status = 'grace'
          AND snapshot_json = ?2
      )
      AND EXISTS (
        SELECT 1
        FROM personal_data_events
        WHERE id = ?3
          AND identity_id = ?4
          AND organization_id IS ?5
          AND request_id = ?6
          AND event_type = 'account.closure.requested'
          AND entity_type = 'account_closure'
          AND entity_id = ?1
          AND payload_json = ?7
          AND occurred_at = ?8
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?2, '$.memberships') AS snapshot
        LEFT JOIN organization_memberships AS membership
          ON membership.id = json_extract(snapshot.value, '$.id')
        WHERE membership.id IS NULL
          OR membership.organization_id <> json_extract(snapshot.value, '$.organizationId')
          OR membership.role <> json_extract(snapshot.value, '$.role')
          OR membership.status <> 'suspended'
          OR membership.closure_request_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM account_closure_requests AS linked_request
            INNER JOIN json_each(
              linked_request.snapshot_json,
              '$.memberships'
            ) AS linked_snapshot
            WHERE linked_request.id = membership.closure_request_id
              AND linked_request.status = 'grace'
              AND json_extract(linked_snapshot.value, '$.id') = membership.id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?2, '$.memberships') AS snapshot
        INNER JOIN membership_field_access AS access
          ON access.membership_id = json_extract(snapshot.value, '$.id')
        WHERE NOT EXISTS (
          SELECT 1
          FROM json_each(snapshot.value, '$.fieldIds') AS field
          WHERE field.value = access.field_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?2, '$.memberships') AS snapshot
        INNER JOIN json_each(snapshot.value, '$.fieldIds') AS field
        WHERE NOT EXISTS (
          SELECT 1
          FROM membership_field_access AS access
          WHERE access.membership_id = json_extract(snapshot.value, '$.id')
            AND access.field_id = field.value
        )
      )
      AND (
        ?9 <> 'account'
        OR NOT EXISTS (
          SELECT 1 FROM auth_sessions WHERE identity_id = ?10
        )
      )
    THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
    ?1 AS closureRequestId
  `).bind(
    input.closure.id,
    input.snapshotJson,
    input.eventId,
    input.closure.actorIdentityId,
    input.organizationId,
    input.closure.requestId,
    input.eventPayloadJson,
    input.closure.requestedAt,
    input.closure.scope,
    input.closure.targetId,
  );
}

function closureRevocationSentinel(
  session: D1DatabaseSession,
  input: {
    actorIdentityId: string;
    closure: AccountClosureRecord;
    eventId: string;
    eventPayloadJson: string;
    organizationId: string | null;
    requestId: string;
    revokedAt: string;
    snapshotJson: string;
    version: number;
  },
): D1PreparedStatement {
  return session.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1
        FROM account_closure_requests
        WHERE id = ?1
          AND status = 'revoked'
          AND revoked_at = ?2
          AND version = ?3
          AND snapshot_json = ?4
      )
      AND EXISTS (
        SELECT 1
        FROM personal_data_events
        WHERE id = ?5
          AND identity_id = ?6
          AND organization_id IS ?7
          AND request_id = ?8
          AND event_type = 'account.closure.revoked'
          AND entity_type = 'account_closure'
          AND entity_id = ?1
          AND payload_json = ?9
          AND occurred_at = ?2
      )
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE closure_request_id = ?1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?4, '$.memberships') AS snapshot
        LEFT JOIN organization_memberships AS membership
          ON membership.id = json_extract(snapshot.value, '$.id')
        WHERE membership.id IS NULL
          OR membership.organization_id <> json_extract(snapshot.value, '$.organizationId')
          OR membership.role <> json_extract(snapshot.value, '$.role')
          OR NOT (
            (
              membership.status = 'suspended'
              AND membership.closure_request_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM account_closure_requests AS replacement
                INNER JOIN json_each(
                  replacement.snapshot_json,
                  '$.memberships'
                ) AS replacement_snapshot
                WHERE replacement.id = membership.closure_request_id
                  AND replacement.id <> ?1
                  AND replacement.status = 'grace'
                  AND json_extract(replacement_snapshot.value, '$.id')
                    = membership.id
                  AND (
                    ?2 > replacement.grace_ends_at
                    OR json_extract(replacement_snapshot.value, '$.status')
                      = json_extract(snapshot.value, '$.status')
                  )
              )
            )
            OR (
              membership.closure_request_id IS NULL
              AND membership.status = json_extract(snapshot.value, '$.status')
              AND NOT EXISTS (
                SELECT 1
                FROM account_closure_requests AS replacement
                INNER JOIN json_each(
                  replacement.snapshot_json,
                  '$.memberships'
                ) AS replacement_snapshot
                WHERE replacement.id <> ?1
                  AND replacement.status = 'grace'
                  AND json_extract(replacement_snapshot.value, '$.id')
                    = membership.id
                  AND (
                    ?2 > replacement.grace_ends_at
                    OR json_extract(replacement_snapshot.value, '$.status')
                      = json_extract(snapshot.value, '$.status')
                  )
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?4, '$.memberships') AS snapshot
        INNER JOIN membership_field_access AS access
          ON access.membership_id = json_extract(snapshot.value, '$.id')
        WHERE NOT EXISTS (
          SELECT 1
          FROM json_each(snapshot.value, '$.fieldIds') AS field
          WHERE field.value = access.field_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(?4, '$.memberships') AS snapshot
        INNER JOIN json_each(snapshot.value, '$.fieldIds') AS field
        WHERE NOT EXISTS (
          SELECT 1
          FROM membership_field_access AS access
          WHERE access.membership_id = json_extract(snapshot.value, '$.id')
            AND access.field_id = field.value
        )
      )
    THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
    ?1 AS closureRequestId
  `).bind(
    input.closure.id,
    input.revokedAt,
    input.version,
    input.snapshotJson,
    input.eventId,
    input.actorIdentityId,
    input.organizationId,
    input.requestId,
    input.eventPayloadJson,
  );
}

function closureRecord(row: ClosureRow): AccountClosureRecord {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.snapshotJson);
  } catch (cause) {
    throw new AccountClosurePersistenceError(
      "ACCOUNT_CLOSURE_SNAPSHOT_INVALID",
      "La instantánea de cierre persistida no es válida.",
      500,
      { cause },
    );
  }
  return Object.freeze({
    id: row.id,
    scope: row.scope,
    targetId: row.targetId,
    status: row.status,
    requestedAt: row.requestedAt,
    graceEndsAt: row.graceEndsAt,
    revokedAt: row.revokedAt,
    version: Number(row.version),
    snapshotVersion: Number(row.snapshotVersion) as 1,
    snapshot: snapshot as AccountClosureSnapshot,
  });
}

function firstRow<T>(result: D1Result<Record<string, unknown>>): T | null {
  return (result.results?.[0] as T | undefined) ?? null;
}

function resultRows<T>(result: D1Result<Record<string, unknown>>): T[] {
  return (result.results ?? []) as T[];
}

function assertSentinel(
  result: D1Result<Record<string, unknown>> | undefined,
  closureRequestId: string,
  code: string,
): void {
  const row = result?.results?.[0];
  if (
    Number(row?.complete) !== 1
    || row?.closureRequestId !== closureRequestId
  ) {
    throw new AccountClosurePersistenceError(
      code,
      "No fue posible confirmar el estado durable del cierre.",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
