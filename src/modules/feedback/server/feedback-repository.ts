import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import {
  FeedbackRequestError,
  type ProductFeedbackItem,
  type ProductFeedbackSummary,
  type StaffFeedbackFilters,
  type StaffFeedbackUpdate,
  type ValidatedFeedbackSubmission,
} from "../domain/types";

const RECENT_LIMIT = 5;
const DAILY_LIMIT = 30;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_STAFF_V2_REQUIRED_KEY = "platform-staff-v2-required";

type D1Value = string | number | null;

type FeedbackRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  fieldId: string | null;
  fieldName: string | null;
  reporterMembershipId: string;
  reporterEmail: string;
  reporterName: string;
  planCode: ProductFeedbackItem["planCode"];
  category: ProductFeedbackItem["category"];
  impact: ProductFeedbackItem["impact"];
  message: string;
  contactAllowed: number;
  pagePath: string;
  releaseSha: string;
  userAgent: string;
  viewportWidth: number | null;
  viewportHeight: number | null;
  online: number;
  status: ProductFeedbackItem["status"];
  priority: ProductFeedbackItem["priority"];
  staffNote: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type FeedbackCountRow = {
  recentCount: number;
  dailyCount: number;
};

type FeedbackSummaryRow = {
  total: number;
  newCount: number;
  reviewingCount: number;
  plannedCount: number;
  resolvedCount: number;
  closedCount: number;
};

export async function submitProductFeedback(input: {
  actor: AccessContext;
  submission: ValidatedFeedbackSubmission;
  releaseSha: string;
  userAgent: string;
  now?: Date;
  idFactory?: () => string;
}): Promise<{ feedback: ProductFeedbackItem; replay: boolean }> {
  const client = getDb().$client;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const recentSince = new Date(now.getTime() - TEN_MINUTES_MS).toISOString();
  const dailySince = new Date(now.getTime() - ONE_DAY_MS).toISOString();
  const idFactory = input.idFactory ?? (() => crypto.randomUUID());
  const feedbackId = `feedback-${idFactory()}`;
  const eventId = `feedback-event-${idFactory()}`;
  const releaseSha = boundedText(input.releaseSha, 128) || "unknown";
  const userAgent = boundedText(input.userAgent, 512);
  const submission = input.submission;
  const createdEvent = JSON.stringify({
    category: submission.category,
    impact: submission.impact,
    status: "new",
    priority: null,
  });

  await client.batch([
    client.prepare(`
      INSERT INTO product_feedback (
        id, organization_id, field_id, reporter_membership_id, reporter_email,
        reporter_name, plan_code, category, impact, message, contact_allowed,
        submission_key, page_path, release_sha, user_agent, viewport_width,
        viewport_height, online, status, priority, staff_note, version,
        last_event_id, created_at, updated_at
      )
      SELECT
        ?, membership.organization_id, ?, membership.id, membership.normalized_email,
        membership.display_name, organization.plan_code, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, 'new', NULL, NULL, 1, ?, ?, ?
      FROM organization_memberships AS membership
      INNER JOIN organizations AS organization
        ON organization.id = membership.organization_id
      WHERE membership.id = ?
        AND membership.organization_id = ?
        AND membership.normalized_email = ?
        AND membership.status = 'active'
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
            FROM fields AS selected_field
            WHERE selected_field.organization_id = membership.organization_id
              AND selected_field.id = ?
              AND (
                membership.role IN ('owner', 'admin')
                OR EXISTS (
                  SELECT 1
                  FROM membership_field_access AS field_access
                  WHERE field_access.membership_id = membership.id
                    AND field_access.field_id = selected_field.id
                )
              )
          )
        )
        AND (
          SELECT COUNT(*)
          FROM product_feedback AS recent_feedback
          WHERE recent_feedback.reporter_membership_id = membership.id
            AND recent_feedback.created_at >= ?
        ) < ?
        AND (
          SELECT COUNT(*)
          FROM product_feedback AS daily_feedback
          WHERE daily_feedback.reporter_membership_id = membership.id
            AND daily_feedback.created_at >= ?
        ) < ?
      ON CONFLICT(reporter_membership_id, submission_key) DO NOTHING
    `).bind(
      feedbackId,
      submission.fieldId,
      submission.category,
      submission.impact,
      submission.message,
      submission.contactAllowed ? 1 : 0,
      submission.submissionKey,
      submission.pagePath,
      releaseSha,
      userAgent,
      submission.viewportWidth,
      submission.viewportHeight,
      submission.online ? 1 : 0,
      eventId,
      nowIso,
      nowIso,
      input.actor.membershipId,
      input.actor.organizationId,
      input.actor.email,
      submission.fieldId,
      submission.fieldId,
      recentSince,
      RECENT_LIMIT,
      dailySince,
      DAILY_LIMIT,
    ),
    client.prepare(`
      INSERT INTO product_feedback_events (
        id, feedback_id, actor_email, event_type, before_json, after_json, occurred_at
      )
      SELECT ?, feedback.id, feedback.reporter_email, 'created', NULL, ?, ?
      FROM product_feedback AS feedback
      WHERE feedback.id = ? AND feedback.last_event_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM product_feedback_events AS existing_event WHERE existing_event.id = ?
        )
    `).bind(
      eventId,
      createdEvent,
      nowIso,
      feedbackId,
      eventId,
      eventId,
    ),
  ]);

  const feedback = await loadProductFeedbackBySubmissionKey(
    input.actor.membershipId,
    submission.submissionKey,
  );
  if (feedback) {
    return { feedback, replay: feedback.id !== feedbackId };
  }

  const counts = await client.prepare(`
    SELECT
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recentCount,
      COUNT(*) AS dailyCount
    FROM product_feedback
    WHERE reporter_membership_id = ? AND created_at >= ?
  `).bind(
    recentSince,
    input.actor.membershipId,
    dailySince,
  ).first<FeedbackCountRow>();

  if (Number(counts?.recentCount ?? 0) >= RECENT_LIMIT || Number(counts?.dailyCount ?? 0) >= DAILY_LIMIT) {
    throw new FeedbackRequestError(
      "Recibimos varios comentarios seguidos. Espera unos minutos antes de enviar otro.",
      429,
      "FEEDBACK_RATE_LIMITED",
    );
  }
  throw new FeedbackRequestError(
    "Tu acceso cambió mientras enviábamos el comentario. Actualiza la página e inténtalo nuevamente.",
    409,
    "FEEDBACK_ACCESS_CHANGED",
  );
}

export async function listProductFeedbackForStaff(
  filters: StaffFeedbackFilters = {},
): Promise<{ items: ProductFeedbackItem[]; summary: ProductFeedbackSummary }> {
  const client = getDb().$client;
  const where = ["1 = 1"];
  const bindings: D1Value[] = [];

  if (filters.category) {
    where.push("feedback.category = ?");
    bindings.push(filters.category);
  }
  if (filters.status) {
    where.push("feedback.status = ?");
    bindings.push(filters.status);
  }
  if (filters.priority === "unassigned") {
    where.push("feedback.priority IS NULL");
  } else if (filters.priority) {
    where.push("feedback.priority = ?");
    bindings.push(filters.priority);
  }
  if (filters.organizationId) {
    where.push("feedback.organization_id = ?");
    bindings.push(filters.organizationId);
  }
  if (filters.search) {
    where.push(`(
      instr(lower(feedback.message), ?) > 0
      OR instr(lower(feedback.reporter_email), ?) > 0
      OR instr(lower(feedback.reporter_name), ?) > 0
      OR instr(lower(organization.name), ?) > 0
      OR instr(lower(COALESCE(feedback.staff_note, '')), ?) > 0
    )`);
    const search = filters.search.toLocaleLowerCase("es");
    bindings.push(search, search, search, search, search);
  }

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const [feedbackResult, summaryRow] = await Promise.all([
    client.prepare(`
      ${FEEDBACK_SELECT}
      WHERE ${where.join("\nAND ")}
      ORDER BY feedback.created_at DESC, feedback.id DESC
      LIMIT ?
    `).bind(...bindings, limit).all<FeedbackRow>(),
    client.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(status = 'new'), 0) AS newCount,
        COALESCE(SUM(status = 'reviewing'), 0) AS reviewingCount,
        COALESCE(SUM(status = 'planned'), 0) AS plannedCount,
        COALESCE(SUM(status = 'resolved'), 0) AS resolvedCount,
        COALESCE(SUM(status = 'closed'), 0) AS closedCount
      FROM product_feedback
    `).first<FeedbackSummaryRow>(),
  ]);

  return {
    items: feedbackResult.results.map(feedbackItem),
    summary: {
      total: Number(summaryRow?.total ?? 0),
      new: Number(summaryRow?.newCount ?? 0),
      reviewing: Number(summaryRow?.reviewingCount ?? 0),
      planned: Number(summaryRow?.plannedCount ?? 0),
      resolved: Number(summaryRow?.resolvedCount ?? 0),
      closed: Number(summaryRow?.closedCount ?? 0),
    },
  };
}

export async function updateProductFeedbackForStaff(input: {
  actorSubject: string;
  actorEmail: string;
  staffCutoverMarkerKey: string;
  update: StaffFeedbackUpdate;
  now?: Date;
  idFactory?: () => string;
}): Promise<ProductFeedbackItem> {
  const staffCutoverMarkerKey = validateStaffCutoverMarkerKey(input.staffCutoverMarkerKey);
  const client = getDb().$client;
  const current = await loadProductFeedbackById(input.update.feedbackId);
  if (!current) {
    throw new FeedbackRequestError("El comentario ya no está disponible.", 404, "FEEDBACK_NOT_FOUND");
  }
  if (current.version !== input.update.expectedVersion) {
    throw new FeedbackRequestError(
      "El comentario cambió mientras lo revisabas. Vuelve a cargarlo.",
      409,
      "FEEDBACK_VERSION_CONFLICT",
    );
  }
  if (await isStaffCutoverRequired(client, staffCutoverMarkerKey)) {
    throw staffFeedbackAccessChangedError();
  }

  const nextState = {
    status: input.update.status,
    priority: input.update.priority,
    staffNote: input.update.staffNote,
  };
  const currentState = {
    status: current.status,
    priority: current.priority,
    staffNote: current.staffNote,
  };
  if (JSON.stringify(nextState) === JSON.stringify(currentState)) return current;

  const eventId = `feedback-event-${(input.idFactory ?? (() => crypto.randomUUID()))()}`;
  const requestedTime = (input.now ?? new Date()).getTime();
  const minimumTime = Date.parse(current.updatedAt) + 1;
  const updatedAt = new Date(Math.max(requestedTime, minimumTime)).toISOString();
  const actorEmail = boundedText(input.actorEmail.toLowerCase(), 320);
  const actorSubject = input.actorSubject.trim();
  if (!actorEmail || !actorSubject || actorSubject.length > 320) {
    throw new FeedbackRequestError("No fue posible identificar al miembro de staff.", 403, "FEEDBACK_STAFF_REQUIRED");
  }
  const authority = staffFeedbackAuthorityCondition({
    actorSubject,
    normalizedActorEmail: actorEmail,
    organizationId: current.organizationId,
    staffCutoverMarkerKey,
  });

  try {
    await client.batch([
      client.prepare(`
        UPDATE product_feedback
        SET status = ?, priority = ?, staff_note = ?, version = version + 1,
            last_event_id = ?, updated_at = ?
        WHERE id = ? AND version = ?
          AND ${authority.sql}
      `).bind(
        nextState.status,
        nextState.priority,
        nextState.staffNote,
        eventId,
        updatedAt,
        current.id,
        current.version,
        ...authority.bindings,
      ),
      client.prepare(`
        INSERT INTO product_feedback_events (
          id, feedback_id, actor_email, event_type, before_json, after_json, occurred_at
        )
        SELECT ?, feedback.id, ?, 'triage_updated', ?, ?, ?
        FROM product_feedback AS feedback
        WHERE feedback.id = ? AND feedback.last_event_id = ? AND feedback.version = ?
          AND ${authority.sql}
      `).bind(
        eventId,
        actorEmail,
        JSON.stringify(currentState),
        JSON.stringify(nextState),
        updatedAt,
        current.id,
        eventId,
        current.version + 1,
        ...authority.bindings,
      ),
      client.prepare(`
        SELECT CASE
        WHEN NOT (${authority.sql})
        THEN json_extract('fundosmart_feedback_staff_access_changed', '$')
        WHEN EXISTS (
          SELECT 1
          FROM product_feedback AS feedback
          INNER JOIN product_feedback_events AS event
            ON event.id = feedback.last_event_id AND event.feedback_id = feedback.id
          WHERE feedback.id = ? AND feedback.version = ? AND feedback.last_event_id = ?
        )
        THEN 1
        ELSE json_extract('fundosmart_feedback_version_conflict', '$')
        END AS feedback_postcondition
      `).bind(
        ...authority.bindings,
        current.id,
        current.version + 1,
        eventId,
      ),
    ]);
  } catch (cause) {
    if (!(await hasCurrentStaffFeedbackAuthority(client, authority))) {
      throw staffFeedbackAccessChangedError();
    }
    const latest = await loadProductFeedbackById(current.id);
    if (!latest || latest.version !== current.version) {
      throw new FeedbackRequestError(
        "El comentario cambió mientras lo revisabas. Vuelve a cargarlo.",
        409,
        "FEEDBACK_VERSION_CONFLICT",
      );
    }
    throw cause;
  }

  const updated = await loadProductFeedbackById(current.id);
  if (!updated || updated.version !== current.version + 1) {
    throw new FeedbackRequestError(
      "No fue posible confirmar la actualización del comentario.",
      409,
      "FEEDBACK_UPDATE_NOT_CONFIRMED",
    );
  }
  if (!(await hasCurrentStaffFeedbackAuthority(client, authority))) {
    throw staffFeedbackAccessChangedError();
  }
  return updated;
}

async function loadProductFeedbackBySubmissionKey(
  membershipId: string,
  submissionKey: string,
): Promise<ProductFeedbackItem | null> {
  const row = await getDb().$client.prepare(`
    ${FEEDBACK_SELECT}
    WHERE feedback.reporter_membership_id = ? AND feedback.submission_key = ?
    LIMIT 1
  `).bind(membershipId, submissionKey).first<FeedbackRow>();
  return row ? feedbackItem(row) : null;
}

async function loadProductFeedbackById(id: string): Promise<ProductFeedbackItem | null> {
  const row = await getDb().$client.prepare(`
    ${FEEDBACK_SELECT}
    WHERE feedback.id = ?
    LIMIT 1
  `).bind(id).first<FeedbackRow>();
  return row ? feedbackItem(row) : null;
}

function feedbackItem(row: FeedbackRow): ProductFeedbackItem {
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    fieldId: row.fieldId,
    fieldName: row.fieldName,
    reporterMembershipId: row.reporterMembershipId,
    reporterEmail: row.reporterEmail,
    reporterName: row.reporterName,
    planCode: row.planCode,
    category: row.category,
    impact: row.impact,
    message: row.message,
    contactAllowed: Boolean(row.contactAllowed),
    pagePath: row.pagePath,
    releaseSha: row.releaseSha,
    userAgent: row.userAgent,
    viewportWidth: row.viewportWidth === null ? null : Number(row.viewportWidth),
    viewportHeight: row.viewportHeight === null ? null : Number(row.viewportHeight),
    online: Boolean(row.online),
    status: row.status,
    priority: row.priority,
    staffNote: row.staffNote,
    version: Number(row.version),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function boundedText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function validateStaffCutoverMarkerKey(value: string): string {
  if (value !== PLATFORM_STAFF_V2_REQUIRED_KEY) {
    throw staffFeedbackAccessChangedError();
  }
  return value;
}

function staffFeedbackAuthorityCondition(input: {
  actorSubject: string;
  normalizedActorEmail: string;
  organizationId: string;
  staffCutoverMarkerKey: string;
}): { sql: string; bindings: D1Value[] } {
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

async function hasCurrentStaffFeedbackAuthority(
  client: D1Database,
  authority: { sql: string; bindings: D1Value[] },
): Promise<boolean> {
  const row = await client.prepare(`
    SELECT CASE WHEN ${authority.sql} THEN 1 ELSE 0 END AS authorized
  `).bind(...authority.bindings).first<{ authorized: number }>();
  return Number(row?.authorized) === 1;
}

async function isStaffCutoverRequired(
  client: D1Database,
  markerKey: string,
): Promise<boolean> {
  const marker = await client.prepare(`
    SELECT 1 AS required
    FROM app_state
    WHERE key = ?
    LIMIT 1
  `).bind(markerKey).first<{ required: number }>();
  return marker !== null;
}

function staffFeedbackAccessChangedError(): FeedbackRequestError {
  return new FeedbackRequestError(
    "Tu acceso staff cambió durante la actualización. Actualiza la página e inténtalo nuevamente.",
    409,
    "FEEDBACK_STAFF_ACCESS_CHANGED",
  );
}

const FEEDBACK_SELECT = `
  SELECT
    feedback.id AS id,
    feedback.organization_id AS organizationId,
    organization.name AS organizationName,
    feedback.field_id AS fieldId,
    field.name AS fieldName,
    feedback.reporter_membership_id AS reporterMembershipId,
    feedback.reporter_email AS reporterEmail,
    feedback.reporter_name AS reporterName,
    feedback.plan_code AS planCode,
    feedback.category AS category,
    feedback.impact AS impact,
    feedback.message AS message,
    feedback.contact_allowed AS contactAllowed,
    feedback.page_path AS pagePath,
    feedback.release_sha AS releaseSha,
    feedback.user_agent AS userAgent,
    feedback.viewport_width AS viewportWidth,
    feedback.viewport_height AS viewportHeight,
    feedback.online AS online,
    feedback.status AS status,
    feedback.priority AS priority,
    feedback.staff_note AS staffNote,
    feedback.version AS version,
    feedback.created_at AS createdAt,
    feedback.updated_at AS updatedAt
  FROM product_feedback AS feedback
  INNER JOIN organizations AS organization ON organization.id = feedback.organization_id
  LEFT JOIN fields AS field
    ON field.organization_id = feedback.organization_id AND field.id = feedback.field_id
`;
