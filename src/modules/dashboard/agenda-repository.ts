import { getDb } from "@/db";
import type { AccessContext, OrganizationMembershipRole } from "@/src/modules/access/domain/types";
import { getImportCenterDashboard } from "@/src/modules/importaciones/server/import-center-repository";
import { createOnboardingScope } from "@/src/modules/onboarding/domain/onboarding-progress.mjs";
import {
  AgendaRequestError,
  validateAgendaTaskMutation,
  type AgendaManagementSnapshot,
  type AgendaTaskMutation,
  type AgendaTaskState,
} from "./agenda-management.mjs";

type StateRow = {
  id: string;
  organizationId: string;
  fieldId: string;
  itemKey: string;
  signalRevision: string;
  source: AgendaTaskState["source"];
  status: AgendaTaskState["status"];
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  scheduledFor: string | null;
  resolutionReason: string | null;
  version: number;
  lastOperationId: string;
  createdAt: string;
  updatedAt: string;
};

type OperationRow = {
  requestHash: string;
  resultJson: string;
};

type AssigneeRow = {
  id: string;
  displayName: string;
  role: OrganizationMembershipRole;
};

type FieldAccessRow = {
  membershipId: string;
  fieldId: string;
};

type AgendaMutationResult = {
  state: AgendaTaskState;
  replay: boolean;
};

type AgendaMutationWritePlan = {
  actor: AccessContext;
  mutation: AgendaTaskMutation;
  requestHash: string;
  existing: AgendaTaskState | null;
  next: AgendaTaskState;
  beforeJson: string | null;
  afterJson: string;
  eventId: string;
  statements: D1PreparedStatement[];
};

type AgendaMutationPlan = {
  results: AgendaMutationResult[];
  writes: AgendaMutationWritePlan[];
};

type AgendaPlanningContext = {
  states: Map<string, AgendaTaskState | null>;
  operations: Map<string, OperationRow | null>;
};

type AgendaIdLedger = {
  stateIds: Map<string, string>;
  eventIds: Map<string, string>;
};

// Each completion predicate binds 16 values; six stay below D1's 100-parameter limit.
const AGENDA_SENTINEL_PLAN_LIMIT = 6;

export async function countConfirmedImportsForOnboarding(
  actor: AccessContext,
): Promise<number> {
  const dashboard = await getImportCenterDashboard({
    membershipId: actor.membershipId,
    email: actor.email,
    organizationId: actor.organizationId,
    fieldIds: actor.fieldIds,
  });
  return dashboard.totals.confirmedCount;
}

export function createDashboardOnboardingScope(
  actor: Pick<AccessContext, "membershipId" | "organizationId">,
): Promise<string> {
  return createOnboardingScope(actor.organizationId, actor.membershipId);
}

export async function listAgendaManagement(
  actor: AccessContext,
): Promise<AgendaManagementSnapshot> {
  const fieldIds = [...new Set(actor.fieldIds)].sort();
  if (fieldIds.length === 0) {
    return { states: [], assignees: [], currentMembershipId: actor.membershipId };
  }
  const client = getDb().$client;
  const placeholders = fieldIds.map(() => "?").join(", ");
  const [stateResult, assigneeResult] = await Promise.all([
    client.prepare(`
      SELECT
        state.id,
        state.organization_id AS organizationId,
        state.field_id AS fieldId,
        state.item_key AS itemKey,
        state.signal_revision AS signalRevision,
        state.source,
        state.status,
        state.assignee_membership_id AS assigneeMembershipId,
        assignee.display_name AS assigneeName,
        state.scheduled_for AS scheduledFor,
        state.resolution_reason AS resolutionReason,
        state.version,
        state.last_operation_id AS lastOperationId,
        state.created_at AS createdAt,
        state.updated_at AS updatedAt
      FROM agenda_task_states AS state
      INNER JOIN fields AS scoped_field
        ON scoped_field.organization_id = state.organization_id
       AND scoped_field.id = state.field_id
      LEFT JOIN organization_memberships AS assignee
        ON assignee.organization_id = state.organization_id
       AND assignee.id = state.assignee_membership_id
      WHERE state.organization_id = ?
        AND state.field_id IN (${placeholders})
      ORDER BY state.updated_at DESC, state.id
    `).bind(actor.organizationId, ...fieldIds).all<StateRow>(),
    client.prepare(`
      SELECT
        candidate.id,
        candidate.display_name AS displayName,
        candidate.role
      FROM organization_memberships AS candidate
      WHERE candidate.organization_id = ?
        AND candidate.status = 'active'
        AND candidate.role IN ('owner', 'admin', 'manager', 'operator')
        AND (
          candidate.role IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1
            FROM membership_field_access AS candidate_access
            INNER JOIN fields AS candidate_field
              ON candidate_field.id = candidate_access.field_id
             AND candidate_field.organization_id = candidate.organization_id
            WHERE candidate_access.membership_id = candidate.id
              AND candidate_access.field_id IN (${placeholders})
          )
        )
      ORDER BY candidate.display_name COLLATE NOCASE, candidate.id
    `).bind(actor.organizationId, ...fieldIds).all<AssigneeRow>(),
  ]);

  const candidateRows = assigneeResult.results ?? [];
  const candidateIds = candidateRows.map((candidate) => candidate.id);
  const fieldIdsByMembership = new Map<string, string[]>();
  if (candidateIds.length > 0) {
    const candidatePlaceholders = candidateIds.map(() => "?").join(", ");
    const accessRows = await client.prepare(`
      SELECT
        field_access.membership_id AS membershipId,
        field_access.field_id AS fieldId
      FROM membership_field_access AS field_access
      INNER JOIN organization_memberships AS candidate
        ON candidate.id = field_access.membership_id
       AND candidate.organization_id = ?
       AND candidate.status = 'active'
      INNER JOIN fields AS candidate_field
        ON candidate_field.id = field_access.field_id
       AND candidate_field.organization_id = candidate.organization_id
      WHERE field_access.membership_id IN (${candidatePlaceholders})
        AND field_access.field_id IN (${placeholders})
      ORDER BY field_access.membership_id, field_access.field_id
    `).bind(
      actor.organizationId,
      ...candidateIds,
      ...fieldIds,
    ).all<FieldAccessRow>();
    for (const row of accessRows.results ?? []) {
      fieldIdsByMembership.set(row.membershipId, [
        ...(fieldIdsByMembership.get(row.membershipId) ?? []),
        row.fieldId,
      ]);
    }
  }

  return {
    states: (stateResult.results ?? []).map(toState),
    assignees: candidateRows.map((candidate) => ({
      id: candidate.id,
      displayName: candidate.displayName,
      role: candidate.role,
      fieldIds: candidate.role === "owner" || candidate.role === "admin"
        ? fieldIds
        : fieldIdsByMembership.get(candidate.id) ?? [],
    })),
    currentMembershipId: actor.membershipId,
  };
}

export async function mutateAgendaTask(input: {
  actor: AccessContext;
  mutation: AgendaTaskMutation | unknown;
  now?: Date;
  idFactory?: () => string;
}): Promise<{ state: AgendaTaskState; replay: boolean }> {
  const mutation = validateAgendaTaskMutation(input.mutation);
  if (!input.actor.fieldIds.includes(mutation.fieldId)) {
    throw new AgendaRequestError(
      "La señal no existe o ya no está disponible para tu membresía.",
      404,
      "AGENDA_FIELD_NOT_FOUND",
    );
  }
  const now = input.now ?? new Date();
  if (mutation.action === "postpone" && mutation.scheduledFor! <= now.toISOString().slice(0, 10)) {
    throw new AgendaRequestError(
      "La nueva fecha debe ser posterior a hoy.",
      400,
      "AGENDA_DATE_NOT_FUTURE",
    );
  }
  const requestHash = await hashMutation(mutation);
  const replay = await loadOperation(input.actor.organizationId, mutation.operationId);
  if (replay) return operationReplay(replay, requestHash);

  const existing = await loadState(
    input.actor.organizationId,
    mutation.fieldId,
    mutation.itemKey,
    mutation.signalRevision,
  );
  if (existing?.source !== undefined && existing.source !== mutation.source) {
    throw new AgendaRequestError(
      "La señal cambió de fuente. Actualiza la agenda antes de continuar.",
      409,
      "AGENDA_SOURCE_CONFLICT",
    );
  }
  if (
    (existing === null && mutation.expectedVersion !== null)
    || (existing !== null && mutation.expectedVersion !== existing.version)
  ) {
    throw versionConflict();
  }
  if (!existing && mutation.action === "reopen") {
    throw new AgendaRequestError(
      "La señal todavía no tiene un estado que reabrir.",
      409,
      "AGENDA_STATE_MISSING",
    );
  }

  const requestedAssignee = mutation.action === "assign"
    ? mutation.assigneeMembershipId
    : existing?.assigneeMembershipId ?? null;
  const assignee = requestedAssignee
    ? await loadEligibleAssignee(
      input.actor.organizationId,
      mutation.fieldId,
      requestedAssignee,
    )
    : null;
  if (requestedAssignee && !assignee) {
    throw new AgendaRequestError(
      "El responsable ya no está activo o no puede ver este fundo.",
      409,
      "AGENDA_ASSIGNEE_UNAVAILABLE",
    );
  }

  const idFactory = input.idFactory ?? (() => crypto.randomUUID());
  const stateId = existing?.id ?? `agenda-state-${idFactory()}`;
  const eventId = `agenda-event-${idFactory()}`;
  const timestamp = monotonicTimestamp(now, existing?.updatedAt);
  const next = nextState({
    actor: input.actor,
    assignee,
    existing,
    mutation,
    stateId,
    timestamp,
  });
  const beforeJson = existing ? JSON.stringify(existing) : null;
  const afterJson = JSON.stringify(next);
  const client = getDb().$client;
  const stateWrite = existing
    ? client.prepare(`
      UPDATE agenda_task_states
      SET status = ?,
          assignee_membership_id = ?,
          scheduled_for = ?,
          resolution_reason = ?,
          version = ?,
          last_operation_id = ?,
          updated_by_membership_id = ?,
          updated_at = ?
      WHERE id = ?
        AND organization_id = ?
        AND field_id = ?
        AND item_key = ?
        AND signal_revision = ?
        AND source = ?
        AND version = ?
        AND last_operation_id = ?
        AND ${writeAccessGuard("agenda_task_states.field_id")}
        AND ${assigneeGuard("agenda_task_states.field_id")}
    `).bind(
      next.status,
      next.assigneeMembershipId,
      next.scheduledFor,
      next.resolutionReason,
      next.version,
      next.lastOperationId,
      input.actor.membershipId,
      next.updatedAt,
      existing.id,
      input.actor.organizationId,
      mutation.fieldId,
      mutation.itemKey,
      mutation.signalRevision,
      mutation.source,
      existing.version,
      existing.lastOperationId,
      ...writeAccessBindings(input.actor),
      ...assigneeBindings(input.actor.organizationId, requestedAssignee),
    )
    : client.prepare(`
      INSERT INTO agenda_task_states (
        id, organization_id, field_id, item_key, signal_revision, source,
        status, assignee_membership_id, scheduled_for, resolution_reason,
        version, last_operation_id, created_by_membership_id,
        updated_by_membership_id, created_at, updated_at
      )
      SELECT
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        1, ?, ?, ?, ?, ?
      WHERE ${writeAccessGuard("?")}
        AND ${assigneeGuard("?")}
      ON CONFLICT(organization_id, field_id, item_key, signal_revision) DO NOTHING
    `).bind(
      next.id,
      next.organizationId,
      next.fieldId,
      next.itemKey,
      next.signalRevision,
      next.source,
      next.status,
      next.assigneeMembershipId,
      next.scheduledFor,
      next.resolutionReason,
      next.lastOperationId,
      input.actor.membershipId,
      input.actor.membershipId,
      next.createdAt,
      next.updatedAt,
      mutation.fieldId,
      ...writeAccessBindings(input.actor),
      ...assigneeBindings(input.actor.organizationId, requestedAssignee),
      mutation.fieldId,
    );

  try {
    await client.batch([
      stateWrite,
      client.prepare(`
        INSERT INTO agenda_task_operations (
          id, organization_id, field_id, state_id, actor_membership_id,
          action, request_hash, result_json, created_at
        )
        SELECT ?, state.organization_id, state.field_id, state.id, ?, ?, ?, ?, ?
        FROM agenda_task_states AS state
        WHERE state.id = ?
          AND state.organization_id = ?
          AND state.field_id = ?
          AND state.last_operation_id = ?
          AND state.version = ?
      `).bind(
        mutation.operationId,
        input.actor.membershipId,
        mutation.action,
        requestHash,
        afterJson,
        next.updatedAt,
        next.id,
        input.actor.organizationId,
        mutation.fieldId,
        mutation.operationId,
        next.version,
      ),
      client.prepare(`
        INSERT INTO agenda_task_events (
          id, organization_id, field_id, state_id, operation_id,
          actor_membership_id, actor_email, event_type, before_json,
          after_json, occurred_at
        )
        SELECT
          ?, operation.organization_id, operation.field_id, operation.state_id,
          operation.id, operation.actor_membership_id, ?, operation.action,
          ?, operation.result_json, ?
        FROM agenda_task_operations AS operation
        WHERE operation.id = ?
          AND operation.organization_id = ?
          AND operation.field_id = ?
      `).bind(
        eventId,
        input.actor.email,
        beforeJson,
        next.updatedAt,
        mutation.operationId,
        input.actor.organizationId,
        mutation.fieldId,
      ),
    ]);
  } catch (cause) {
    const concurrentReplay = await loadOperation(
      input.actor.organizationId,
      mutation.operationId,
    );
    if (concurrentReplay) return operationReplay(concurrentReplay, requestHash);
    if (isConstraintFailure(cause)) throw versionConflict();
    throw cause;
  }

  const savedOperation = await loadOperation(
    input.actor.organizationId,
    mutation.operationId,
  );
  if (savedOperation) {
    const result = operationReplay(savedOperation, requestHash);
    return { ...result, replay: false };
  }

  const current = await loadState(
    input.actor.organizationId,
    mutation.fieldId,
    mutation.itemKey,
    mutation.signalRevision,
  );
  if (current && current.version !== mutation.expectedVersion) throw versionConflict();
  throw new AgendaRequestError(
    "Tu acceso o el responsable cambió durante la operación. Actualiza la agenda e inténtalo nuevamente.",
    409,
    "AGENDA_ACCESS_CHANGED",
  );
}

function nextState(input: {
  actor: AccessContext;
  assignee: AssigneeRow | null;
  existing: AgendaTaskState | null;
  mutation: AgendaTaskMutation;
  stateId: string;
  timestamp: string;
}): AgendaTaskState {
  const base: AgendaTaskState = input.existing ?? {
    id: input.stateId,
    organizationId: input.actor.organizationId,
    fieldId: input.mutation.fieldId,
    itemKey: input.mutation.itemKey,
    signalRevision: input.mutation.signalRevision,
    source: input.mutation.source,
    status: "open",
    assigneeMembershipId: null,
    assigneeName: null,
    scheduledFor: null,
    resolutionReason: null,
    version: 0,
    lastOperationId: input.mutation.operationId,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  const next = {
    ...base,
    version: base.version + 1,
    lastOperationId: input.mutation.operationId,
    updatedAt: input.timestamp,
  };
  switch (input.mutation.action) {
    case "complete":
      return {
        ...next,
        status: "completed",
        scheduledFor: null,
        resolutionReason: input.mutation.reason,
      };
    case "postpone":
      return {
        ...next,
        status: "postponed",
        scheduledFor: input.mutation.scheduledFor,
        resolutionReason: input.mutation.reason,
      };
    case "dismiss":
      return {
        ...next,
        status: "dismissed",
        scheduledFor: null,
        resolutionReason: input.mutation.reason,
      };
    case "reopen":
      return {
        ...next,
        status: "open",
        scheduledFor: null,
        resolutionReason: null,
      };
    case "assign":
      return {
        ...next,
        assigneeMembershipId: input.assignee?.id ?? null,
        assigneeName: input.assignee?.displayName ?? null,
      };
  }
  throw new AgendaRequestError("La acción de agenda no es válida.", 400, "AGENDA_ACTION_INVALID");
}

async function loadState(
  organizationId: string,
  fieldId: string,
  itemKey: string,
  signalRevision: string,
): Promise<AgendaTaskState | null> {
  const row = await getDb().$client.prepare(`
    SELECT
      state.id,
      state.organization_id AS organizationId,
      state.field_id AS fieldId,
      state.item_key AS itemKey,
      state.signal_revision AS signalRevision,
      state.source,
      state.status,
      state.assignee_membership_id AS assigneeMembershipId,
      assignee.display_name AS assigneeName,
      state.scheduled_for AS scheduledFor,
      state.resolution_reason AS resolutionReason,
      state.version,
      state.last_operation_id AS lastOperationId,
      state.created_at AS createdAt,
      state.updated_at AS updatedAt
    FROM agenda_task_states AS state
    LEFT JOIN organization_memberships AS assignee
      ON assignee.organization_id = state.organization_id
     AND assignee.id = state.assignee_membership_id
    WHERE state.organization_id = ?
      AND state.field_id = ?
      AND state.item_key = ?
      AND state.signal_revision = ?
  `).bind(organizationId, fieldId, itemKey, signalRevision).first<StateRow>();
  return row ? toState(row) : null;
}

async function loadOperation(
  organizationId: string,
  operationId: string,
): Promise<OperationRow | null> {
  return getDb().$client.prepare(`
    SELECT request_hash AS requestHash, result_json AS resultJson
    FROM agenda_task_operations
    WHERE organization_id = ? AND id = ?
  `).bind(organizationId, operationId).first<OperationRow>();
}

async function loadEligibleAssignee(
  organizationId: string,
  fieldId: string,
  membershipId: string,
): Promise<AssigneeRow | null> {
  return getDb().$client.prepare(`
    SELECT
      candidate.id,
      candidate.display_name AS displayName,
      candidate.role
    FROM organization_memberships AS candidate
    INNER JOIN fields AS selected_field
      ON selected_field.organization_id = candidate.organization_id
     AND selected_field.id = ?
    WHERE candidate.id = ?
      AND candidate.organization_id = ?
      AND candidate.status = 'active'
      AND candidate.role IN ('owner', 'admin', 'manager', 'operator')
      AND (
        candidate.role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1
          FROM membership_field_access AS candidate_access
          WHERE candidate_access.membership_id = candidate.id
            AND candidate_access.field_id = selected_field.id
        )
      )
  `).bind(fieldId, membershipId, organizationId).first<AssigneeRow>();
}

function writeAccessGuard(fieldExpression: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM organization_memberships AS current_actor
      INNER JOIN fields AS current_field
        ON current_field.organization_id = current_actor.organization_id
       AND current_field.id = ${fieldExpression}
      WHERE current_actor.id = ?
        AND current_actor.organization_id = ?
        AND current_actor.normalized_email = ?
        AND current_actor.status = 'active'
        AND current_actor.role IN ('owner', 'admin', 'manager', 'operator')
        AND (
          current_actor.role IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1
            FROM membership_field_access AS current_access
            WHERE current_access.membership_id = current_actor.id
              AND current_access.field_id = current_field.id
          )
        )
    )
  `;
}

function writeAccessBindings(actor: AccessContext): [string, string, string] {
  return [actor.membershipId, actor.organizationId, actor.email];
}

function assigneeGuard(fieldExpression: string): string {
  return `
    (
      ? IS NULL
      OR EXISTS (
        SELECT 1
        FROM organization_memberships AS current_assignee
        WHERE current_assignee.id = ?
          AND current_assignee.organization_id = ?
          AND current_assignee.status = 'active'
          AND current_assignee.role IN ('owner', 'admin', 'manager', 'operator')
          AND (
            current_assignee.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1
              FROM membership_field_access AS assignee_access
              WHERE assignee_access.membership_id = current_assignee.id
                AND assignee_access.field_id = ${fieldExpression}
            )
          )
      )
    )
  `;
}

function assigneeBindings(
  organizationId: string,
  membershipId: string | null,
): [string | null, string | null, string] {
  return [membershipId, membershipId, organizationId];
}

function toState(row: StateRow): AgendaTaskState {
  return {
    ...row,
    assigneeMembershipId: row.assigneeMembershipId ?? null,
    assigneeName: row.assigneeName ?? null,
    scheduledFor: row.scheduledFor ?? null,
    resolutionReason: row.resolutionReason ?? null,
    version: Number(row.version),
  };
}

function operationReplay(
  operation: OperationRow,
  requestHash: string,
): { state: AgendaTaskState; replay: boolean } {
  if (operation.requestHash !== requestHash) {
    throw new AgendaRequestError(
      "La clave idempotente ya fue usada con otra acción o contenido.",
      409,
      "AGENDA_IDEMPOTENCY_COLLISION",
    );
  }
  try {
    return { state: JSON.parse(operation.resultJson) as AgendaTaskState, replay: true };
  } catch {
    throw new AgendaRequestError(
      "La evidencia de la operación no pudo verificarse.",
      500,
      "AGENDA_OPERATION_CORRUPT",
    );
  }
}

async function hashMutation(mutation: AgendaTaskMutation): Promise<string> {
  const canonical = JSON.stringify([
    mutation.action,
    mutation.operationId,
    mutation.fieldId,
    mutation.itemKey,
    mutation.signalRevision,
    mutation.source,
    mutation.expectedVersion,
    mutation.reason,
    mutation.scheduledFor,
    mutation.assigneeMembershipId,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function monotonicTimestamp(now: Date, previous?: string): string {
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  const timestamp = Number.isFinite(previousTime)
    ? Math.max(now.getTime(), previousTime + 1)
    : now.getTime();
  return new Date(timestamp).toISOString();
}

function versionConflict(): AgendaRequestError {
  return new AgendaRequestError(
    "Otra persona actualizó esta señal. Recarga su estado antes de intentarlo nuevamente.",
    409,
    "AGENDA_VERSION_CONFLICT",
  );
}

function isConstraintFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /constraint|unique|foreign key|agenda_task_/iu.test(message);
}

export async function batchMutateAgendaTasks(input: {
  actor: AccessContext;
  mutations: (AgendaTaskMutation | unknown)[];
  now?: Date;
  idFactory?: () => string;
}): Promise<AgendaMutationResult[]> {
  if (!Array.isArray(input.mutations) || input.mutations.length === 0) {
    throw new AgendaRequestError(
      "Se requiere una lista no vacía de mutaciones.",
      400,
      "AGENDA_BATCH_EMPTY",
    );
  }
  return attemptAgendaMutationBatch({
    actor: input.actor,
    mutations: input.mutations,
    now: input.now,
    idFactory: input.idFactory ?? (() => crypto.randomUUID()),
    idLedger: {
      stateIds: new Map(),
      eventIds: new Map(),
    },
    observedConcurrentOperationIds: new Set(),
  });
}

async function attemptAgendaMutationBatch(input: {
  actor: AccessContext;
  mutations: (AgendaTaskMutation | unknown)[];
  now?: Date;
  idFactory: () => string;
  idLedger: AgendaIdLedger;
  observedConcurrentOperationIds: Set<string>;
}): Promise<AgendaMutationResult[]> {
  const client = getDb().$client;
  const plan = await planAgendaMutations({
    actor: input.actor,
    mutations: input.mutations,
    now: input.now,
    idFactory: input.idFactory,
    idLedger: input.idLedger,
    client,
  });
  if (plan.writes.length === 0) return plan.results;

  const statements = plan.writes.flatMap((write) => write.statements);
  for (let offset = 0; offset < plan.writes.length; offset += AGENDA_SENTINEL_PLAN_LIMIT) {
    statements.push(buildAgendaBatchSentinel(
      client,
      plan.writes.slice(offset, offset + AGENDA_SENTINEL_PLAN_LIMIT),
    ));
  }

  try {
    await client.batch(statements);
  } catch (cause) {
    const sentinelFailure = isAgendaBatchSentinelFailure(cause);
    if (!sentinelFailure && !isConstraintFailure(cause)) throw cause;
    const discoveredConcurrentOperation = await discoverConcurrentAgendaOperation(
      plan.writes,
      input.observedConcurrentOperationIds,
    );
    if (discoveredConcurrentOperation) {
      return attemptAgendaMutationBatch(input);
    }
    await throwAgendaBatchGuardFailure(plan.writes, cause);
  }

  return plan.results;
}

async function planAgendaMutations(input: {
  actor: AccessContext;
  mutations: (AgendaTaskMutation | unknown)[];
  now?: Date;
  idFactory: () => string;
  idLedger: AgendaIdLedger;
  client: D1Database;
}): Promise<AgendaMutationPlan> {
  const context: AgendaPlanningContext = {
    states: new Map(),
    operations: new Map(),
  };
  const results: AgendaMutationResult[] = [];
  const writes: AgendaMutationWritePlan[] = [];
  for (const rawMutation of input.mutations) {
    const planned = await planAgendaBatchMutation({
      actor: input.actor,
      rawMutation,
      now: input.now,
      idFactory: input.idFactory,
      idLedger: input.idLedger,
      client: input.client,
      context,
    });
    results.push(planned.result);
    if (planned.write) writes.push(planned.write);
  }
  return { results, writes };
}

async function planAgendaBatchMutation(input: {
  actor: AccessContext;
  rawMutation: AgendaTaskMutation | unknown;
  now?: Date;
  idFactory: () => string;
  idLedger: AgendaIdLedger;
  client: D1Database;
  context: AgendaPlanningContext;
}): Promise<{ result: AgendaMutationResult; write?: AgendaMutationWritePlan }> {
  const mutation = validateAgendaTaskMutation(input.rawMutation);
  if (!input.actor.fieldIds.includes(mutation.fieldId)) {
    throw new AgendaRequestError(
      "La señal no existe o ya no está disponible para tu membresía.",
      404,
      "AGENDA_FIELD_NOT_FOUND",
    );
  }
  const now = input.now ?? new Date();
  if (mutation.action === "postpone" && mutation.scheduledFor! <= now.toISOString().slice(0, 10)) {
    throw new AgendaRequestError(
      "La nueva fecha debe ser posterior a hoy.",
      400,
      "AGENDA_DATE_NOT_FUTURE",
    );
  }

  const requestHash = await hashMutation(mutation);
  let replay = input.context.operations.get(mutation.operationId);
  if (!input.context.operations.has(mutation.operationId)) {
    replay = await loadOperation(input.actor.organizationId, mutation.operationId);
    input.context.operations.set(mutation.operationId, replay);
  }
  if (replay) return { result: operationReplay(replay, requestHash) };

  const stateKey = agendaStateKey(input.actor.organizationId, mutation);
  let cachedState = input.context.states.get(stateKey);
  if (!input.context.states.has(stateKey)) {
    cachedState = await loadState(
      input.actor.organizationId,
      mutation.fieldId,
      mutation.itemKey,
      mutation.signalRevision,
    );
    input.context.states.set(stateKey, cachedState);
  }
  const existing = cachedState ?? null;
  if (existing?.source !== undefined && existing.source !== mutation.source) {
    throw new AgendaRequestError(
      "La señal cambió de fuente. Actualiza la agenda antes de continuar.",
      409,
      "AGENDA_SOURCE_CONFLICT",
    );
  }
  if (
    (existing === null && mutation.expectedVersion !== null)
    || (existing !== null && mutation.expectedVersion !== existing.version)
  ) {
    throw versionConflict();
  }
  if (!existing && mutation.action === "reopen") {
    throw new AgendaRequestError(
      "La señal todavía no tiene un estado que reabrir.",
      409,
      "AGENDA_STATE_MISSING",
    );
  }

  const requestedAssignee = mutation.action === "assign"
    ? mutation.assigneeMembershipId
    : existing?.assigneeMembershipId ?? null;
  const assignee = requestedAssignee
    ? await loadEligibleAssignee(
      input.actor.organizationId,
      mutation.fieldId,
      requestedAssignee,
    )
    : null;
  if (requestedAssignee && !assignee) {
    throw new AgendaRequestError(
      "El responsable ya no está activo o no puede ver este fundo.",
      409,
      "AGENDA_ASSIGNEE_UNAVAILABLE",
    );
  }

  const stateId = existing?.id ?? agendaStateId(
    input.idLedger,
    stateKey,
    input.idFactory,
  );
  const eventId = agendaEventId(
    input.idLedger,
    mutation.operationId,
    input.idFactory,
  );
  const timestamp = monotonicTimestamp(now, existing?.updatedAt);
  const next = nextState({
    actor: input.actor,
    assignee,
    existing,
    mutation,
    stateId,
    timestamp,
  });
  const beforeJson = existing ? JSON.stringify(existing) : null;
  const afterJson = JSON.stringify(next);
  const writeInput: Omit<AgendaMutationWritePlan, "statements"> = {
    actor: input.actor,
    mutation,
    requestHash,
    existing,
    next,
    beforeJson,
    afterJson,
    eventId,
  };
  const write: AgendaMutationWritePlan = {
    ...writeInput,
    statements: buildAgendaMutationStatements(input.client, writeInput),
  };
  input.context.states.set(stateKey, next);
  input.context.operations.set(mutation.operationId, {
    requestHash,
    resultJson: afterJson,
  });
  return {
    result: { state: next, replay: false },
    write,
  };
}

function buildAgendaMutationStatements(
  client: D1Database,
  input: Omit<AgendaMutationWritePlan, "statements">,
): D1PreparedStatement[] {
  const requestedAssignee = input.mutation.action === "assign"
    ? input.mutation.assigneeMembershipId
    : input.existing?.assigneeMembershipId ?? null;
  const stateWrite = input.existing
    ? client.prepare(`
      UPDATE agenda_task_states
      SET status = ?,
          assignee_membership_id = ?,
          scheduled_for = ?,
          resolution_reason = ?,
          version = ?,
          last_operation_id = ?,
          updated_by_membership_id = ?,
          updated_at = ?
      WHERE id = ?
        AND organization_id = ?
        AND field_id = ?
        AND item_key = ?
        AND signal_revision = ?
        AND source = ?
        AND version = ?
        AND last_operation_id = ?
        AND ${writeAccessGuard("agenda_task_states.field_id")}
        AND ${assigneeGuard("agenda_task_states.field_id")}
    `).bind(
      input.next.status,
      input.next.assigneeMembershipId,
      input.next.scheduledFor,
      input.next.resolutionReason,
      input.next.version,
      input.next.lastOperationId,
      input.actor.membershipId,
      input.next.updatedAt,
      input.existing.id,
      input.actor.organizationId,
      input.mutation.fieldId,
      input.mutation.itemKey,
      input.mutation.signalRevision,
      input.mutation.source,
      input.existing.version,
      input.existing.lastOperationId,
      ...writeAccessBindings(input.actor),
      ...assigneeBindings(input.actor.organizationId, requestedAssignee),
    )
    : client.prepare(`
      INSERT INTO agenda_task_states (
        id, organization_id, field_id, item_key, signal_revision, source,
        status, assignee_membership_id, scheduled_for, resolution_reason,
        version, last_operation_id, created_by_membership_id,
        updated_by_membership_id, created_at, updated_at
      )
      SELECT
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        1, ?, ?, ?, ?, ?
      WHERE ${writeAccessGuard("?")}
        AND ${assigneeGuard("?")}
      ON CONFLICT(organization_id, field_id, item_key, signal_revision) DO NOTHING
    `).bind(
      input.next.id,
      input.next.organizationId,
      input.next.fieldId,
      input.next.itemKey,
      input.next.signalRevision,
      input.next.source,
      input.next.status,
      input.next.assigneeMembershipId,
      input.next.scheduledFor,
      input.next.resolutionReason,
      input.next.lastOperationId,
      input.actor.membershipId,
      input.actor.membershipId,
      input.next.createdAt,
      input.next.updatedAt,
      input.mutation.fieldId,
      ...writeAccessBindings(input.actor),
      ...assigneeBindings(input.actor.organizationId, requestedAssignee),
      input.mutation.fieldId,
    );

  return [
    stateWrite,
    client.prepare(`
      INSERT INTO agenda_task_operations (
        id, organization_id, field_id, state_id, actor_membership_id,
        action, request_hash, result_json, created_at
      )
      SELECT ?, state.organization_id, state.field_id, state.id, ?, ?, ?, ?, ?
      FROM agenda_task_states AS state
      WHERE state.id = ?
        AND state.organization_id = ?
        AND state.field_id = ?
        AND state.last_operation_id = ?
        AND state.version = ?
        AND state.status = ?
        AND state.assignee_membership_id IS ?
        AND state.scheduled_for IS ?
        AND state.resolution_reason IS ?
        AND state.updated_by_membership_id = ?
        AND state.updated_at = ?
    `).bind(
      input.mutation.operationId,
      input.actor.membershipId,
      input.mutation.action,
      input.requestHash,
      input.afterJson,
      input.next.updatedAt,
      input.next.id,
      input.actor.organizationId,
      input.mutation.fieldId,
      input.mutation.operationId,
      input.next.version,
      input.next.status,
      input.next.assigneeMembershipId,
      input.next.scheduledFor,
      input.next.resolutionReason,
      input.actor.membershipId,
      input.next.updatedAt,
    ),
    client.prepare(`
      INSERT INTO agenda_task_events (
        id, organization_id, field_id, state_id, operation_id,
        actor_membership_id, actor_email, event_type, before_json,
        after_json, occurred_at
      )
      SELECT
        ?, operation.organization_id, operation.field_id, operation.state_id,
        operation.id, operation.actor_membership_id, ?, operation.action,
        ?, operation.result_json, ?
      FROM agenda_task_operations AS operation
      WHERE operation.id = ?
        AND operation.organization_id = ?
        AND operation.field_id = ?
    `).bind(
      input.eventId,
      input.actor.email,
      input.beforeJson,
      input.next.updatedAt,
      input.mutation.operationId,
      input.actor.organizationId,
      input.mutation.fieldId,
    ),
  ];
}

function buildAgendaBatchSentinel(
  client: D1Database,
  writes: AgendaMutationWritePlan[],
): D1PreparedStatement {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  for (const write of writes) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM agenda_task_operations AS operation
        INNER JOIN agenda_task_events AS event
          ON event.operation_id = operation.id
         AND event.organization_id = operation.organization_id
         AND event.field_id = operation.field_id
         AND event.state_id = operation.state_id
        WHERE operation.id = ?
          AND operation.organization_id = ?
          AND operation.field_id = ?
          AND operation.state_id = ?
          AND operation.actor_membership_id = ?
          AND operation.action = ?
          AND operation.request_hash = ?
          AND operation.result_json = ?
          AND operation.created_at = ?
          AND event.id = ?
          AND event.actor_membership_id = ?
          AND event.actor_email = ?
          AND event.event_type = ?
          AND event.before_json IS ?
          AND event.after_json = ?
          AND event.occurred_at = ?
      )
    `);
    bindings.push(
      write.mutation.operationId,
      write.actor.organizationId,
      write.mutation.fieldId,
      write.next.id,
      write.actor.membershipId,
      write.mutation.action,
      write.requestHash,
      write.afterJson,
      write.next.updatedAt,
      write.eventId,
      write.actor.membershipId,
      write.actor.email,
      write.mutation.action,
      write.beforeJson,
      write.afterJson,
      write.next.updatedAt,
    );
  }

  return client.prepare(`
    SELECT CASE WHEN
      ${conditions.join("\n      AND ")}
    THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(...bindings);
}

async function discoverConcurrentAgendaOperation(
  writes: AgendaMutationWritePlan[],
  observedOperationIds: Set<string>,
): Promise<boolean> {
  let discovered = false;
  for (const write of writes) {
    const operationId = write.mutation.operationId;
    if (observedOperationIds.has(operationId)) continue;
    const operation = await loadOperation(write.actor.organizationId, operationId);
    if (!operation) continue;
    observedOperationIds.add(operationId);
    discovered = true;
  }
  return discovered;
}

async function throwAgendaBatchGuardFailure(
  writes: AgendaMutationWritePlan[],
  cause: unknown,
): Promise<never> {
  const baselines = new Map<string, AgendaMutationWritePlan>();
  for (const write of writes) {
    const key = agendaStateKey(write.actor.organizationId, write.mutation);
    if (!baselines.has(key)) baselines.set(key, write);
  }
  for (const write of baselines.values()) {
    const current = await loadState(
      write.actor.organizationId,
      write.mutation.fieldId,
      write.mutation.itemKey,
      write.mutation.signalRevision,
    );
    if (!sameAgendaStateVersion(current, write.existing)) throw versionConflict();
  }
  for (const write of writes) {
    if (!(await hasCurrentAgendaWriteAccess(write))) throw accessChanged();
  }
  throw cause instanceof Error ? cause : new Error(String(cause));
}

async function hasCurrentAgendaWriteAccess(
  write: AgendaMutationWritePlan,
): Promise<boolean> {
  const requestedAssignee = write.mutation.action === "assign"
    ? write.mutation.assigneeMembershipId
    : write.existing?.assigneeMembershipId ?? null;
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN
      ${writeAccessGuard("?")}
      AND ${assigneeGuard("?")}
    THEN 1 ELSE 0 END AS allowed
  `).bind(
    write.mutation.fieldId,
    ...writeAccessBindings(write.actor),
    ...assigneeBindings(write.actor.organizationId, requestedAssignee),
    write.mutation.fieldId,
  ).first<{ allowed: number }>();
  return Number(row?.allowed) === 1;
}

function sameAgendaStateVersion(
  current: AgendaTaskState | null,
  expected: AgendaTaskState | null,
): boolean {
  if (current === null || expected === null) return current === expected;
  return current.id === expected.id
    && current.source === expected.source
    && current.version === expected.version
    && current.lastOperationId === expected.lastOperationId;
}

function agendaStateKey(
  organizationId: string,
  mutation: Pick<AgendaTaskMutation, "fieldId" | "itemKey" | "signalRevision">,
): string {
  return JSON.stringify([
    organizationId,
    mutation.fieldId,
    mutation.itemKey,
    mutation.signalRevision,
  ]);
}

function agendaStateId(
  ledger: AgendaIdLedger,
  stateKey: string,
  idFactory: () => string,
): string {
  const existing = ledger.stateIds.get(stateKey);
  if (existing) return existing;
  const allocated = `agenda-state-${idFactory()}`;
  ledger.stateIds.set(stateKey, allocated);
  return allocated;
}

function agendaEventId(
  ledger: AgendaIdLedger,
  operationId: string,
  idFactory: () => string,
): string {
  const existing = ledger.eventIds.get(operationId);
  if (existing) return existing;
  const allocated = `agenda-event-${idFactory()}`;
  ledger.eventIds.set(operationId, allocated);
  return allocated;
}

function isAgendaBatchSentinelFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /integer overflow/iu.test(message);
}

function accessChanged(): AgendaRequestError {
  return new AgendaRequestError(
    "Tu acceso o el responsable cambió durante la operación. Actualiza la agenda e inténtalo nuevamente.",
    409,
    "AGENDA_ACCESS_CHANGED",
  );
}
