import { getDb } from "@/db";

const ANALYTICS_DELIVERY_RESERVATION_PREFIX = "analytics_delivery_reserved:";
const ANALYTICS_DELIVERY_LEASE_MS = 5 * 60 * 1000;

type AnalyticsDeliveryClient = ReturnType<typeof getDb>["$client"];

type PreferenceRow = {
  id: string;
  organizationId: string;
  fieldId: string;
  userEmail: string;
  fieldName: string;
};

type AlertRow = {
  id: string;
  code: string;
  severity: "warning" | "critical";
  explanation: string;
  evidenceJson: string;
  period: string;
  windowEnd: string;
};

type DeliverableAlert = AlertRow & {
  dueDate: string;
  subjectLabel: string | null;
  workItemId: string;
};

type AnalyticsNotificationRunOptions = {
  now?: Date;
  clock?: () => Date;
  appBaseUrl?: string;
  emailFrom?: string;
};

export async function runDueAnalyticsNotifications(
  emailBinding: SendEmail,
  options: AnalyticsNotificationRunOptions = {},
): Promise<{ recipients: number; deliveries: number; failures: number }> {
  const periods = currentAndPreviousChilePeriods(readNotificationClock(options));
  const client = getDb().$client;
  const preferences = await loadEligiblePreferences(client);
  let recipients = 0;
  let deliveries = 0;
  let failures = 0;

  for (const preference of preferences) {
    const candidates = await loadTriggeredAlerts(client, preference, periods);
    if (candidates.length === 0) continue;
    const claimNow = readNotificationClock(options);
    const unavailable = await loadUnavailableDeliveryKeys(client, preference.id, claimNow.toISOString());
    const pending = candidates.filter((entry) => !unavailable.has(`${entry.workItemId}:${entry.dueDate}`));
    if (pending.length === 0) continue;

    let claimToken: string | null;
    try {
      claimToken = await claimAnalyticsDeliveries(client, preference, pending, claimNow);
    } catch (cause) {
      failures += 1;
      logFailure("analytics.notification.claim_failed", cause);
      continue;
    }
    if (!claimToken) continue;

    let emailAccepted = false;
    try {
      await emailBinding.send({
        to: preference.userEmail,
        from: { email: notificationEmailFrom(options.emailFrom), name: "FundoSmart" },
        subject: `FundoSmart · ${pending.length} alerta${pending.length === 1 ? "" : "s"} explicable${pending.length === 1 ? "" : "s"}`,
        text: textDigest(preference, pending),
        html: htmlDigest(preference, pending, options.appBaseUrl),
      });
      emailAccepted = true;
      await finalizeAnalyticsDeliveries(
        client,
        preference.id,
        pending,
        claimToken,
        readNotificationClock(options).toISOString(),
      );
      recipients += 1;
      deliveries += pending.length;
    } catch (cause) {
      failures += 1;
      if (!emailAccepted) {
        try {
          await releaseAnalyticsDeliveryClaims(
            client,
            preference.id,
            pending,
            claimToken,
            `email_send_failed: ${errorMessage(cause)}`.slice(0, 500),
          );
        } catch (releaseCause) {
          logFailure("analytics.notification.claim_release_failed", releaseCause);
        }
      }
      logFailure(
        emailAccepted ? "analytics.notification.ledger_unconfirmed" : "analytics.notification.email_failed",
        cause,
      );
    }
  }

  return { recipients, deliveries, failures };
}

function readNotificationClock(options: AnalyticsNotificationRunOptions): Date {
  const value = options.clock?.() ?? options.now ?? new Date();
  return new Date(value.getTime());
}

async function loadEligiblePreferences(client: AnalyticsDeliveryClient): Promise<PreferenceRow[]> {
  const result = await client.prepare(`
    SELECT DISTINCT
      preference.id,
      preference.organization_id AS organizationId,
      preference.field_id AS fieldId,
      preference.user_email AS userEmail,
      scoped_field.name AS fieldName
    FROM livestock_notification_preferences AS preference
    INNER JOIN fields AS scoped_field
      ON scoped_field.organization_id = preference.organization_id
     AND scoped_field.id = preference.field_id
    WHERE preference.email_enabled = 1
      AND scoped_field.is_demo = 0
      AND EXISTS (
        SELECT 1 FROM organization_memberships AS current_member
        WHERE current_member.organization_id = preference.organization_id
          AND current_member.normalized_email = preference.user_email
          AND current_member.status = 'active'
          AND current_member.role IN ('owner', 'admin', 'manager', 'operator', 'viewer')
          AND (
            current_member.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_access
              WHERE current_access.membership_id = current_member.id
                AND current_access.field_id = preference.field_id
            )
          )
      )
      AND COALESCE(
        (SELECT field_flag.enabled
          FROM organization_feature_flags AS field_flag
          WHERE field_flag.organization_id = preference.organization_id
            AND field_flag.field_id = preference.field_id
            AND field_flag.feature = 'analitica'
          LIMIT 1),
        (SELECT global_flag.enabled
          FROM organization_feature_flags AS global_flag
          WHERE global_flag.organization_id = preference.organization_id
            AND global_flag.field_id IS NULL
            AND global_flag.feature = 'analitica'
          LIMIT 1),
        0
      ) = 1
    ORDER BY preference.id
  `).all<PreferenceRow>();
  return result.results ?? [];
}

async function loadTriggeredAlerts(
  client: AnalyticsDeliveryClient,
  preference: PreferenceRow,
  periods: [string, string],
): Promise<DeliverableAlert[]> {
  const result = await client.prepare(`
    SELECT
      evaluation.id,
      evaluation.code,
      evaluation.severity,
      evaluation.explanation,
      evaluation.evidence_json AS evidenceJson,
      run.period,
      run.window_end AS windowEnd
    FROM analytics_alert_evaluations AS evaluation
    INNER JOIN analytics_projection_runs AS run ON run.id = evaluation.projection_id
    WHERE run.organization_id = ?
      AND run.field_id = ?
      AND run.is_current = 1
      AND run.period IN (?, ?)
      AND evaluation.organization_id = run.organization_id
      AND evaluation.field_id = run.field_id
      AND evaluation.status = 'triggered'
    ORDER BY run.period, evaluation.code
  `).bind(
    preference.organizationId,
    preference.fieldId,
    periods[0],
    periods[1],
  ).all<AlertRow>();
  return (result.results ?? []).map((entry) => ({
    ...entry,
    dueDate: entry.windowEnd,
    subjectLabel: subjectLabel(entry.evidenceJson),
    workItemId: `analytics-alert:${entry.id}`,
  }));
}

async function loadUnavailableDeliveryKeys(
  client: AnalyticsDeliveryClient,
  preferenceId: string,
  now: string,
): Promise<Set<string>> {
  const result = await client.prepare(`
    SELECT work_item_id AS workItemId, due_date AS dueDate
    FROM livestock_notification_deliveries
    WHERE preference_id = ?
      AND channel = 'email'
      AND (status = 'sent' OR (lease_token IS NOT NULL AND lease_expires_at > ?))
  `).bind(preferenceId, now).all<{
    workItemId: string;
    dueDate: string;
  }>();
  return new Set((result.results ?? []).map((entry) => `${entry.workItemId}:${entry.dueDate}`));
}

async function claimAnalyticsDeliveries(
  client: AnalyticsDeliveryClient,
  preference: PreferenceRow,
  items: DeliverableAlert[],
  now: Date,
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const claimError = `${ANALYTICS_DELIVERY_RESERVATION_PREFIX}${claimToken}`;
  const leaseExpiresAt = new Date(now.getTime() + ANALYTICS_DELIVERY_LEASE_MS).toISOString();
  const payload = deliveryClaimPayload(preference.id, items, claimToken, claimError, now.toISOString(), leaseExpiresAt);
  try {
    await client.batch([
      client.prepare(`
        INSERT INTO livestock_notification_deliveries (
          id, preference_id, work_item_id, due_date, channel, status,
          error, lease_token, lease_expires_at, created_at, sent_at
        )
        SELECT
          json_extract(request.value, '$.id'),
          json_extract(request.value, '$.preferenceId'),
          json_extract(request.value, '$.workItemId'),
          json_extract(request.value, '$.dueDate'),
          'email',
          'failed',
          json_extract(request.value, '$.claimError'),
          json_extract(request.value, '$.claimToken'),
          json_extract(request.value, '$.leaseExpiresAt'),
          json_extract(request.value, '$.claimedAt'),
          NULL
        FROM json_each(?) AS request
        WHERE EXISTS (
          SELECT 1
          FROM livestock_notification_preferences AS current_preference
          INNER JOIN fields AS current_field
            ON current_field.organization_id = current_preference.organization_id
           AND current_field.id = current_preference.field_id
          WHERE current_preference.id = json_extract(request.value, '$.preferenceId')
            AND current_preference.organization_id = ?
            AND current_preference.field_id = ?
            AND current_preference.user_email = ?
            AND current_preference.email_enabled = 1
            AND current_field.is_demo = 0
            AND EXISTS (
              SELECT 1 FROM organization_memberships AS current_member
              WHERE current_member.organization_id = current_preference.organization_id
                AND current_member.normalized_email = current_preference.user_email
                AND current_member.status = 'active'
                AND (
                  current_member.role IN ('owner', 'admin')
                  OR EXISTS (
                    SELECT 1 FROM membership_field_access AS current_access
                    WHERE current_access.membership_id = current_member.id
                      AND current_access.field_id = current_preference.field_id
                  )
                )
            )
            AND COALESCE(
              (SELECT field_flag.enabled FROM organization_feature_flags AS field_flag
                WHERE field_flag.organization_id = current_preference.organization_id
                  AND field_flag.field_id = current_preference.field_id
                  AND field_flag.feature = 'analitica' LIMIT 1),
              (SELECT global_flag.enabled FROM organization_feature_flags AS global_flag
                WHERE global_flag.organization_id = current_preference.organization_id
                  AND global_flag.field_id IS NULL
                  AND global_flag.feature = 'analitica' LIMIT 1),
              0
            ) = 1
        )
        ON CONFLICT(preference_id, work_item_id, due_date, channel) DO UPDATE SET
          status = 'failed',
          error = excluded.error,
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          created_at = excluded.created_at,
          sent_at = NULL
        WHERE livestock_notification_deliveries.status = 'failed'
          AND (
            livestock_notification_deliveries.lease_token IS NULL
            OR livestock_notification_deliveries.lease_expires_at <= excluded.created_at
          )
      `).bind(
        payload,
        preference.organizationId,
        preference.fieldId,
        preference.userEmail,
      ),
      client.prepare(`
        SELECT CASE WHEN (
          changes() = json_array_length(?)
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(?) AS request
            LEFT JOIN livestock_notification_deliveries AS claimed
              ON claimed.preference_id = json_extract(request.value, '$.preferenceId')
             AND claimed.work_item_id = json_extract(request.value, '$.workItemId')
             AND claimed.due_date = json_extract(request.value, '$.dueDate')
             AND claimed.channel = 'email'
             AND claimed.status = 'failed'
             AND claimed.error = json_extract(request.value, '$.claimError')
             AND claimed.lease_token = json_extract(request.value, '$.claimToken')
             AND claimed.lease_expires_at = json_extract(request.value, '$.leaseExpiresAt')
            WHERE claimed.id IS NULL
          )
        ) THEN 1 ELSE json_extract('fundosmart_analytics_delivery_claim_conflict', '$') END
          AS analytics_delivery_claim_postcondition
      `).bind(payload, payload),
    ]);
    return claimToken;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("malformed JSON")) return null;
    throw cause;
  }
}

async function finalizeAnalyticsDeliveries(
  client: AnalyticsDeliveryClient,
  preferenceId: string,
  items: DeliverableAlert[],
  claimToken: string,
  sentAt: string,
): Promise<void> {
  const payload = deliveryClaimPayload(preferenceId, items, claimToken, `${ANALYTICS_DELIVERY_RESERVATION_PREFIX}${claimToken}`, sentAt, sentAt);
  await client.batch([
    client.prepare(`
      UPDATE livestock_notification_deliveries
      SET status = 'sent', error = NULL, lease_token = NULL, lease_expires_at = NULL, sent_at = ?
      WHERE preference_id = ?
        AND channel = 'email'
        AND status = 'failed'
        AND lease_token = ?
        AND EXISTS (
          SELECT 1 FROM json_each(?) AS request
          WHERE json_extract(request.value, '$.workItemId') = work_item_id
            AND json_extract(request.value, '$.dueDate') = due_date
        )
    `).bind(sentAt, preferenceId, claimToken, payload),
    client.prepare(`
      SELECT CASE WHEN (
        changes() = json_array_length(?)
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(?) AS request
          LEFT JOIN livestock_notification_deliveries AS delivered
            ON delivered.preference_id = json_extract(request.value, '$.preferenceId')
           AND delivered.work_item_id = json_extract(request.value, '$.workItemId')
           AND delivered.due_date = json_extract(request.value, '$.dueDate')
           AND delivered.channel = 'email'
           AND delivered.status = 'sent'
           AND delivered.error IS NULL
           AND delivered.lease_token IS NULL
           AND delivered.lease_expires_at IS NULL
           AND delivered.sent_at = ?
          WHERE delivered.id IS NULL
        )
      ) THEN 1 ELSE json_extract('fundosmart_analytics_delivery_finalize_failed', '$') END
        AS analytics_delivery_finalize_postcondition
    `).bind(payload, payload, sentAt),
  ]);
}

async function releaseAnalyticsDeliveryClaims(
  client: AnalyticsDeliveryClient,
  preferenceId: string,
  items: DeliverableAlert[],
  claimToken: string,
  error: string,
): Promise<void> {
  const releasedAt = new Date().toISOString();
  const payload = deliveryClaimPayload(preferenceId, items, claimToken, `${ANALYTICS_DELIVERY_RESERVATION_PREFIX}${claimToken}`, releasedAt, releasedAt);
  await client.prepare(`
    UPDATE livestock_notification_deliveries
    SET error = ?, lease_token = NULL, lease_expires_at = NULL, sent_at = NULL
    WHERE preference_id = ?
      AND channel = 'email'
      AND status = 'failed'
      AND lease_token = ?
      AND EXISTS (
        SELECT 1 FROM json_each(?) AS request
        WHERE json_extract(request.value, '$.workItemId') = work_item_id
          AND json_extract(request.value, '$.dueDate') = due_date
      )
  `).bind(error, preferenceId, claimToken, payload).run();
}

function deliveryClaimPayload(
  preferenceId: string,
  items: DeliverableAlert[],
  claimToken: string,
  claimError: string,
  claimedAt: string,
  leaseExpiresAt: string,
): string {
  return JSON.stringify(items.map((item) => ({
    id: `delivery:${preferenceId}:${item.workItemId}:${item.dueDate}:email`,
    preferenceId,
    workItemId: item.workItemId,
    dueDate: item.dueDate,
    claimToken,
    claimError,
    claimedAt,
    leaseExpiresAt,
  })));
}

function textDigest(preference: PreferenceRow, items: DeliverableAlert[]): string {
  const lines = items.map((item) => (
    `- ${alertTitle(item)} [${item.severity === "critical" ? "crítica" : "advertencia"}]: ${item.explanation}`
  ));
  return `Alertas explicables de ${preference.fieldName}\n\n${lines.join("\n")}\n\nCada alerta indica la regla y el dato que la activaron. Revísalas en FundoSmart; no sustituyen diagnóstico veterinario.`;
}

function htmlDigest(preference: PreferenceRow, items: DeliverableAlert[], appBaseUrl?: string): string {
  const href = new URL("/app/analitica", notificationBaseUrl(appBaseUrl));
  href.searchParams.set("fieldId", preference.fieldId);
  href.searchParams.set("period", items.at(-1)?.period ?? "");
  return `<div style="font-family:Arial,sans-serif;color:#17201c"><h1 style="color:#173b2d">Alertas explicables · ${escapeHtml(preference.fieldName)}</h1><ul>${items.map((item) => `<li><strong>${escapeHtml(alertTitle(item))} · ${item.severity === "critical" ? "Crítica" : "Advertencia"}</strong><br>${escapeHtml(item.explanation)}</li>`).join("")}</ul><p>Cada alerta indica la regla y el dato que la activaron. No sustituye diagnóstico veterinario.</p><p><a href="${href.toString()}">Abrir Analítica en FundoSmart</a></p></div>`;
}

function notificationBaseUrl(value?: string): string {
  return value?.trim() || "http://localhost:3000";
}

function notificationEmailFrom(value?: string): string {
  return value?.trim() || "notifications@localhost.invalid";
}

function alertTitle(item: DeliverableAlert): string {
  const base = item.code.startsWith("PROBLEM_COW_PRODUCTION_DROP:")
    ? "Caída sostenida de producción"
    : item.code.startsWith("PROBLEM_COW_SOMATIC_CELL_HIGH:")
      ? "Recuento celular individual elevado"
      : item.code.startsWith("EXPECTED_HEAT:")
        ? "Celo esperado"
      : ({
        MILK_PRODUCTION_DROP: "Caída de producción de leche",
        SOMATIC_CELL_COUNT_HIGH: "Recuento celular del rebaño elevado",
        MASTITIS_RATE_HIGH: "Tasa de mastitis elevada",
        PREGNANCY_RATE_LOW: "Tasa de preñez baja",
        DAYS_OPEN_HIGH: "Días abiertos elevados",
        CALVING_INTERVAL_HIGH: "Intervalo entre partos elevado",
        WEIGHT_GAIN_LOW: "Ganancia de peso baja",
        MORTALITY_RATE_HIGH: "Mortalidad elevada",
        DISCARD_RATE_HIGH: "Descarte elevado",
        IOFC_LOW: "Ingreso sobre alimento bajo",
      } as Record<string, string>)[item.code] ?? item.code;
  return item.subjectLabel ? `${base} · ${item.subjectLabel}` : base;
}

function subjectLabel(evidenceJson: string): string | null {
  try {
    const evidence = JSON.parse(evidenceJson) as { subject?: { label?: unknown } };
    const label = typeof evidence.subject?.label === "string" ? evidence.subject.label.trim() : "";
    return label.slice(0, 120) || null;
  } catch {
    return null;
  }
}

function currentAndPreviousChilePeriods(now: Date): [string, string] {
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
  }).format(now);
  const [year, month] = current.split("-").map(Number);
  const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  return [current, previous];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown_error";
}

function logFailure(event: string, cause: unknown): void {
  console.error(JSON.stringify({
    event,
    error: errorMessage(cause).slice(0, 500),
  }));
}
