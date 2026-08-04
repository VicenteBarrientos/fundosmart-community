import { getDb } from "@/db";

const ANALYTICS_JOB_TYPE = "analytics.recompute.v1";
const ANALYTICS_JOB_INTERVAL_SECONDS = 31_536_000;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 200;
const CONSUMER_ACTOR = "system:analytics-domain-event-consumer";
const CONSUMED_ACTION = "analytics.domain_event.consumed";

type DomainEventCandidate = {
  sequence: number;
  id: string;
  organizationId: string;
  fieldId: string;
  type: string;
  entity: string;
  payload: string;
  actor: string;
  occurredAt: string;
};

export type AnalyticsDomainEventConsumeResult = {
  examined: number;
  enqueued: number;
  deferred: number;
};

/**
 * Converts authorized append-only domain events into coalesced analytics jobs.
 * It only reads the event log and access/configuration tables: projection code
 * remains the sole reader of transactional livestock and milk sources.
 */
export async function consumeAnalyticsDomainEvents(options: {
  now?: Date;
  limit?: number;
} = {}): Promise<AnalyticsDomainEventConsumeResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = normalizeLimit(options.limit);
  const client = getDb().$client;
  const candidates = await client.prepare(`
    SELECT
      event.sequence,
      event.id,
      event.organization_id AS organizationId,
      event.field_id AS fieldId,
      event.type,
      event.entity,
      event.payload,
      event.actor,
      event.occurred_at AS occurredAt
    FROM domain_events AS event
    INNER JOIN fields AS current_field
      ON current_field.id = event.field_id
      AND current_field.organization_id = event.organization_id
    WHERE current_field.is_demo = 0
      AND NOT EXISTS (
        SELECT 1 FROM audit_log AS consumed
        WHERE consumed.organization_id = event.organization_id
          AND consumed.field_id = event.field_id
          AND consumed.action = '${CONSUMED_ACTION}'
          AND consumed.entity_type = 'domain_event'
          AND consumed.entity_id = event.id
      )
      AND EXISTS (
        SELECT 1 FROM organization_memberships AS current_member
        WHERE current_member.organization_id = event.organization_id
          AND current_member.normalized_email = lower(trim(event.actor))
          AND current_member.status = 'active'
          AND (
            current_member.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_field_access
              WHERE current_field_access.membership_id = current_member.id
                AND current_field_access.field_id = event.field_id
            )
          )
      )
      AND COALESCE(
        (SELECT field_flag.enabled FROM organization_feature_flags AS field_flag
          WHERE field_flag.organization_id = event.organization_id
            AND field_flag.field_id = event.field_id
            AND field_flag.feature = 'analitica' LIMIT 1),
        (SELECT global_flag.enabled FROM organization_feature_flags AS global_flag
          WHERE global_flag.organization_id = event.organization_id
            AND global_flag.field_id IS NULL
            AND global_flag.feature = 'analitica' LIMIT 1),
        0
      ) = 1
    ORDER BY event.sequence
    LIMIT ?
  `).bind(limit).all<DomainEventCandidate>();

  let enqueued = 0;
  let deferred = 0;
  for (const event of candidates.results ?? []) {
    const period = analyticsPeriodForDomainEvent(event.payload, now);
    try {
      await consumeOneEvent(event, period, nowIso);
      enqueued += 1;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("malformed JSON")) {
        deferred += 1;
        continue;
      }
      throw cause;
    }
  }
  return { examined: candidates.results?.length ?? 0, enqueued, deferred };
}

async function consumeOneEvent(event: DomainEventCandidate, period: string, nowIso: string): Promise<void> {
  const client = getDb().$client;
  const jobId = `analytics:${event.organizationId}:${event.fieldId}:${period}`;
  const auditId = `analytics-domain-event:${event.id}`;
  const payload = JSON.stringify({
    schemaVersion: "fundosmart.analytics.recompute-job.v1",
    organizationId: event.organizationId,
    fieldId: event.fieldId,
    period,
    cause: "domain_events",
    requestedBy: CONSUMER_ACTOR,
  });
  await client.batch([
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, occurred_at
      )
      SELECT ?, event.organization_id, event.field_id, ?, '${CONSUMED_ACTION}',
        'domain_event', event.id, NULL, ?, ?
      FROM domain_events AS event
      INNER JOIN fields AS current_field
        ON current_field.id = event.field_id
        AND current_field.organization_id = event.organization_id
      WHERE event.id = ? AND event.organization_id = ? AND event.field_id = ?
        AND current_field.is_demo = 0
        AND EXISTS (
          SELECT 1 FROM organization_memberships AS current_member
          WHERE current_member.organization_id = event.organization_id
            AND current_member.normalized_email = lower(trim(event.actor))
            AND current_member.status = 'active'
            AND (
              current_member.role IN ('owner', 'admin')
              OR EXISTS (
                SELECT 1 FROM membership_field_access AS current_field_access
                WHERE current_field_access.membership_id = current_member.id
                  AND current_field_access.field_id = event.field_id
              )
            )
        )
        AND COALESCE(
          (SELECT field_flag.enabled FROM organization_feature_flags AS field_flag
            WHERE field_flag.organization_id = event.organization_id
              AND field_flag.field_id = event.field_id
              AND field_flag.feature = 'analitica' LIMIT 1),
          (SELECT global_flag.enabled FROM organization_feature_flags AS global_flag
            WHERE global_flag.organization_id = event.organization_id
              AND global_flag.field_id IS NULL
              AND global_flag.feature = 'analitica' LIMIT 1),
          0
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs AS leased_job
          WHERE leased_job.id = ?
            AND leased_job.lease_expires_at IS NOT NULL
            AND leased_job.lease_expires_at > ?
        )
      ON CONFLICT(id) DO NOTHING
    `).bind(
      auditId,
      CONSUMER_ACTOR,
      JSON.stringify({
        sequence: event.sequence,
        eventType: event.type,
        entity: event.entity,
        period,
        jobId,
      }),
      nowIso,
      event.id,
      event.organizationId,
      event.fieldId,
      jobId,
      nowIso,
    ),
    client.prepare(`
      INSERT INTO scheduled_jobs (
        id, organization_id, field_id, type, payload, status, due_at,
        interval_seconds, lease_owner, lease_expires_at, attempt_count,
        last_error_type, updated_at
      )
      SELECT ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 0, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM audit_log AS consumed
        WHERE consumed.id = ?
          AND consumed.organization_id = ?
          AND consumed.field_id = ?
          AND consumed.action = '${CONSUMED_ACTION}'
      )
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs AS leased_job
          WHERE leased_job.id = ?
            AND leased_job.lease_expires_at IS NOT NULL
            AND leased_job.lease_expires_at > ?
        )
      ON CONFLICT(id) DO UPDATE SET
        organization_id = excluded.organization_id,
        field_id = excluded.field_id,
        type = excluded.type,
        payload = excluded.payload,
        status = 'active',
        due_at = excluded.due_at,
        interval_seconds = excluded.interval_seconds,
        attempt_count = 0,
        last_error_type = NULL,
        updated_at = excluded.updated_at
      WHERE scheduled_jobs.lease_expires_at IS NULL
        OR scheduled_jobs.lease_expires_at <= excluded.updated_at
    `).bind(
      jobId,
      event.organizationId,
      event.fieldId,
      ANALYTICS_JOB_TYPE,
      payload,
      nowIso,
      ANALYTICS_JOB_INTERVAL_SECONDS,
      nowIso,
      auditId,
      event.organizationId,
      event.fieldId,
      jobId,
      nowIso,
    ),
    client.prepare(`
      SELECT CASE WHEN (
        EXISTS (
          SELECT 1 FROM audit_log AS consumed
          WHERE consumed.id = ? AND consumed.organization_id = ? AND consumed.field_id = ?
            AND consumed.action = '${CONSUMED_ACTION}'
        )
        AND EXISTS (
          SELECT 1 FROM scheduled_jobs AS queued_job
          WHERE queued_job.id = ? AND queued_job.organization_id = ? AND queued_job.field_id = ?
            AND queued_job.type = ? AND queued_job.updated_at = ?
        )
      ) THEN 1 ELSE json_extract('fundosmart_analytics_domain_event_deferred', '$') END
        AS analytics_domain_event_postcondition
    `).bind(
      auditId,
      event.organizationId,
      event.fieldId,
      jobId,
      event.organizationId,
      event.fieldId,
      ANALYTICS_JOB_TYPE,
      nowIso,
    ),
  ]);
}

export function analyticsPeriodForDomainEvent(payloadJson: string, now: Date): string {
  const payload = parseObject(payloadJson);
  for (const key of ["period", "recordedAt", "sampledAt", "occurredAt", "controlDate", "date"]) {
    const value = typeof payload[key] === "string" ? payload[key].trim() : "";
    const match = /^(\d{4})-(\d{2})(?:-|$)/u.exec(value);
    if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return `${match[1]}-${match[2]}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_LIMIT) {
    throw new RangeError(`El consumidor admite entre 1 y ${MAX_BATCH_LIMIT} eventos por lote.`);
  }
  return value;
}
