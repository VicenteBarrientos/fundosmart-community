import { getDb } from "@/db";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  fields,
  livestockNotificationPreferences,
  membershipFieldAccess,
  organizationMemberships,
  pabcoComplianceItems,
} from "@/db/schema";
import {
  clampReminderDays,
  selectDuePabcoReminderWorkItems,
  type PabcoReminderWorkItem,
} from "../domain/pabco-notification-rules.mjs";
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";

const PABCO_DELIVERY_RESERVATION_PREFIX = "pabco.delivery.reserved:";
const PABCO_DELIVERY_LEASE_MS = 5 * 60 * 1000;

export type PabcoNotificationPreference =
  typeof livestockNotificationPreferences.$inferSelect;

export async function listPabcoNotificationPreferences(
  organizationId: string,
  userEmail: string,
  fieldIds: string[],
): Promise<PabcoNotificationPreference[]> {
  if (fieldIds.length === 0) return [];
  return getDb()
    .select()
    .from(livestockNotificationPreferences)
    .where(
      and(
        eq(livestockNotificationPreferences.organizationId, organizationId),
        eq(
          livestockNotificationPreferences.userEmail,
          normalizeEmail(userEmail),
        ),
        inArray(livestockNotificationPreferences.fieldId, fieldIds),
      ),
    )
    .orderBy(asc(livestockNotificationPreferences.fieldId));
}

export async function savePabcoNotificationPreferences(input: {
  organizationId: string;
  userEmail: string;
  fieldIds: string[];
  emailEnabled: boolean;
  browserEnabled: boolean;
  reminderDays: number;
}): Promise<PabcoNotificationPreference[]> {
  const fieldIds = [...new Set(input.fieldIds)];
  if (fieldIds.length === 0) return [];
  const db = getDb();
  const client = db.$client;
  const now = new Date().toISOString();
  const email = normalizeEmail(input.userEmail);
  const reminderDays = clampReminderDays(input.reminderDays);
  const requestsJson = JSON.stringify(fieldIds.map((fieldId) => ({
    id: `notify-pref:${input.organizationId}:${fieldId}:${email}`,
    organizationId: input.organizationId,
    fieldId,
    userEmail: email,
    emailEnabled: input.emailEnabled ? 1 : 0,
    browserEnabled: input.browserEnabled ? 1 : 0,
    reminderDays,
    timezone: "America/Santiago",
    createdAt: now,
    updatedAt: now,
  })));
  try {
    const [mutationResult] = await client.batch([
      client.prepare(`
        INSERT INTO livestock_notification_preferences (
          id, organization_id, field_id, user_email, email_enabled,
          browser_enabled, reminder_days, timezone, created_at, updated_at
        )
        SELECT
          json_extract(request.value, '$.id'),
          json_extract(request.value, '$.organizationId'),
          json_extract(request.value, '$.fieldId'),
          json_extract(request.value, '$.userEmail'),
          json_extract(request.value, '$.emailEnabled'),
          json_extract(request.value, '$.browserEnabled'),
          json_extract(request.value, '$.reminderDays'),
          json_extract(request.value, '$.timezone'),
          json_extract(request.value, '$.createdAt'),
          json_extract(request.value, '$.updatedAt')
        FROM json_each(?) AS request
        JOIN fields AS scoped_field
          ON scoped_field.id = json_extract(request.value, '$.fieldId')
         AND scoped_field.organization_id = json_extract(request.value, '$.organizationId')
        JOIN organization_memberships AS membership
          ON membership.organization_id = json_extract(request.value, '$.organizationId')
         AND membership.normalized_email = json_extract(request.value, '$.userEmail')
         AND membership.status = 'active'
        LEFT JOIN membership_field_access AS field_access
          ON field_access.membership_id = membership.id
         AND field_access.field_id = scoped_field.id
        WHERE membership.role IN ('owner', 'admin') OR field_access.field_id IS NOT NULL
        ON CONFLICT(organization_id, field_id, user_email) DO UPDATE SET
          email_enabled = excluded.email_enabled,
          browser_enabled = excluded.browser_enabled,
          reminder_days = excluded.reminder_days,
          timezone = excluded.timezone,
          updated_at = excluded.updated_at
      `).bind(requestsJson),
      client.prepare(`
        SELECT CASE WHEN (
          changes() = json_array_length(?)
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(?) AS request
            LEFT JOIN fields AS scoped_field
              ON scoped_field.id = json_extract(request.value, '$.fieldId')
             AND scoped_field.organization_id = json_extract(request.value, '$.organizationId')
            LEFT JOIN organization_memberships AS membership
              ON membership.organization_id = json_extract(request.value, '$.organizationId')
             AND membership.normalized_email = json_extract(request.value, '$.userEmail')
             AND membership.status = 'active'
            LEFT JOIN membership_field_access AS field_access
              ON field_access.membership_id = membership.id
             AND field_access.field_id = scoped_field.id
            LEFT JOIN livestock_notification_preferences AS current_preference
              ON current_preference.organization_id = json_extract(request.value, '$.organizationId')
             AND current_preference.field_id = json_extract(request.value, '$.fieldId')
             AND current_preference.user_email = json_extract(request.value, '$.userEmail')
             AND current_preference.email_enabled IS json_extract(request.value, '$.emailEnabled')
             AND current_preference.browser_enabled IS json_extract(request.value, '$.browserEnabled')
             AND current_preference.reminder_days IS json_extract(request.value, '$.reminderDays')
             AND current_preference.timezone IS json_extract(request.value, '$.timezone')
             AND current_preference.updated_at IS json_extract(request.value, '$.updatedAt')
            WHERE scoped_field.id IS NULL
               OR membership.id IS NULL
               OR (
                 membership.role NOT IN ('owner', 'admin')
                 AND field_access.field_id IS NULL
               )
               OR current_preference.id IS NULL
          )
        ) THEN 1 ELSE json_extract('fundosmart_pabco_preference_scope_conflict', '$') END
          AS pabco_preference_postcondition
      `).bind(requestsJson, requestsJson),
    ]);
    if (mutationResult.meta.changes !== fieldIds.length) {
      throw pabcoPreferenceScopeConflict();
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("malformed JSON")) {
      throw pabcoPreferenceScopeConflict();
    }
    throw cause;
  }
  return listPabcoNotificationPreferences(
    input.organizationId,
    email,
    fieldIds,
  );
}

export async function runDuePabcoNotifications(
  emailBinding: SendEmail,
  options: { now?: Date; today?: string; appBaseUrl?: string; emailFrom?: string } = {},
): Promise<{ recipients: number; deliveries: number; failures: number }> {
  const db = getDb();
  const client = db.$client;
  const preferences = await db
    .select({
      id: livestockNotificationPreferences.id,
      organizationId: livestockNotificationPreferences.organizationId,
      fieldId: livestockNotificationPreferences.fieldId,
      userEmail: livestockNotificationPreferences.userEmail,
      emailEnabled: livestockNotificationPreferences.emailEnabled,
      browserEnabled: livestockNotificationPreferences.browserEnabled,
      reminderDays: livestockNotificationPreferences.reminderDays,
      timezone: livestockNotificationPreferences.timezone,
      createdAt: livestockNotificationPreferences.createdAt,
      updatedAt: livestockNotificationPreferences.updatedAt,
    })
    .from(livestockNotificationPreferences)
    .innerJoin(
      fields,
      and(
        eq(fields.id, livestockNotificationPreferences.fieldId),
        eq(fields.organizationId, livestockNotificationPreferences.organizationId),
      ),
    )
    .innerJoin(
      organizationMemberships,
      and(
        eq(
          organizationMemberships.organizationId,
          livestockNotificationPreferences.organizationId,
        ),
        eq(
          organizationMemberships.normalizedEmail,
          livestockNotificationPreferences.userEmail,
        ),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .leftJoin(
      membershipFieldAccess,
      and(
        eq(membershipFieldAccess.membershipId, organizationMemberships.id),
        eq(membershipFieldAccess.fieldId, livestockNotificationPreferences.fieldId),
      ),
    )
    .where(
      and(
        eq(livestockNotificationPreferences.emailEnabled, true),
        eq(fields.isDemo, false),
        or(
          inArray(organizationMemberships.role, ["owner", "admin"]),
          eq(membershipFieldAccess.fieldId, livestockNotificationPreferences.fieldId),
        ),
      ),
    );
  if (preferences.length === 0)
    return { recipients: 0, deliveries: 0, failures: 0 };

  const itemsByScope = new Map<
    string,
    Array<typeof pabcoComplianceItems.$inferSelect>
  >();
  const today = options.today ?? chileDate();
  let recipients = 0;
  let deliveries = 0;
  let failures = 0;

  for (const preference of preferences) {
    const scopeKey = `${preference.organizationId}:${preference.fieldId}`;
    let complianceItems = itemsByScope.get(scopeKey);
    if (!complianceItems) {
      complianceItems = await db
        .select()
        .from(pabcoComplianceItems)
        .where(
          and(
            eq(pabcoComplianceItems.organizationId, preference.organizationId),
            eq(pabcoComplianceItems.fieldId, preference.fieldId),
            ne(pabcoComplianceItems.status, "not_applicable"),
          ),
        );
      itemsByScope.set(scopeKey, complianceItems);
    }

    const candidates = selectDuePabcoReminderWorkItems(
      complianceItems,
      today,
      preference.reminderDays,
    );
    if (candidates.length === 0) continue;
    const claimNow = options.now ?? new Date();
    const unavailableKeys = await loadUnavailablePabcoDeliveryKeys(
      client,
      preference.id,
      claimNow.toISOString(),
    );
    const pending = candidates.filter(
      (item) => !unavailableKeys.has(`${item.id}:${item.dueDate}`),
    );
    if (pending.length === 0) continue;

    let claimToken: string | null;
    try {
      claimToken = await claimPabcoDeliveries(
        client,
        preference,
        pending,
        claimNow,
      );
    } catch (cause) {
      failures += 1;
      console.error(
        JSON.stringify({
          event: "pabco.notification.claim_failed",
          preferenceId: preference.id,
          error: errorMessage(cause).slice(0, 500),
        }),
      );
      continue;
    }
    if (!claimToken) continue;

    let emailAccepted = false;
    try {
      await emailBinding.send({
        to: preference.userEmail,
        from: { email: notificationEmailFrom(options.emailFrom), name: "FundoSmart" },
        subject: `FundoSmart · ${pending.length} recordatorio${pending.length === 1 ? "" : "s"} PABCO`,
        text: textDigest(pending),
        html: htmlDigest(pending, options.appBaseUrl),
      });
      emailAccepted = true;
      const sentAt = (options.now ?? new Date()).toISOString();
      await finalizePabcoDeliveries(
        client,
        preference.id,
        pending,
        claimToken,
        sentAt,
      );
      recipients += 1;
      deliveries += pending.length;
    } catch (cause) {
      failures += 1;
      const error = errorMessage(cause).slice(0, 500);
      if (!emailAccepted) {
        try {
          await releasePabcoDeliveryClaims(
            client,
            preference.id,
            pending,
            claimToken,
            `email_send_failed: ${error}`.slice(0, 500),
          );
        } catch (releaseCause) {
          console.error(
            JSON.stringify({
              event: "pabco.notification.claim_release_failed",
              preferenceId: preference.id,
              error: errorMessage(releaseCause).slice(0, 500),
            }),
          );
        }
      }
      console.error(
        JSON.stringify({
          event: emailAccepted
            ? "pabco.notification.ledger_unconfirmed"
            : "pabco.notification.email_failed",
          preferenceId: preference.id,
          error,
        }),
      );
    }
  }
  return { recipients, deliveries, failures };
}

type PabcoDeliveryClient = ReturnType<typeof getDb>["$client"];

async function loadUnavailablePabcoDeliveryKeys(
  client: PabcoDeliveryClient,
  preferenceId: string,
  now: string,
): Promise<Set<string>> {
  const result = await client.prepare(`
    SELECT work_item_id AS workItemId, due_date AS dueDate
    FROM livestock_notification_deliveries
    WHERE preference_id = ?
      AND channel = 'email'
      AND (status = 'sent' OR (lease_token IS NOT NULL AND lease_expires_at > ?))
  `).bind(preferenceId, now).all<{ workItemId: string; dueDate: string }>();
  return new Set(
    (result.results ?? []).map((entry) => `${entry.workItemId}:${entry.dueDate}`),
  );
}

async function claimPabcoDeliveries(
  client: PabcoDeliveryClient,
  preference: Pick<
    PabcoNotificationPreference,
    "id" | "organizationId" | "fieldId" | "userEmail"
  >,
  items: PabcoReminderWorkItem[],
  now: Date,
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const leaseExpiresAt = new Date(
    now.getTime() + PABCO_DELIVERY_LEASE_MS,
  ).toISOString();
  const claimError = `${PABCO_DELIVERY_RESERVATION_PREFIX}${claimToken}`;
  const payload = deliveryClaimPayload(
    preference.id,
    items,
    claimToken,
    claimError,
    claimedAt,
    leaseExpiresAt,
  );
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
        ) THEN 1 ELSE json_extract('fundosmart_pabco_delivery_claim_conflict', '$') END
          AS pabco_delivery_claim_postcondition
      `).bind(payload, payload),
    ]);
    return claimToken;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("malformed JSON")) {
      return null;
    }
    throw cause;
  }
}

async function finalizePabcoDeliveries(
  client: PabcoDeliveryClient,
  preferenceId: string,
  items: PabcoReminderWorkItem[],
  claimToken: string,
  sentAt: string,
): Promise<void> {
  const payload = deliveryClaimPayload(
    preferenceId,
    items,
    claimToken,
    `${PABCO_DELIVERY_RESERVATION_PREFIX}${claimToken}`,
    sentAt,
    sentAt,
  );
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
      ) THEN 1 ELSE json_extract('fundosmart_pabco_delivery_finalize_failed', '$') END
        AS pabco_delivery_finalize_postcondition
    `).bind(payload, payload, sentAt),
  ]);
}

async function releasePabcoDeliveryClaims(
  client: PabcoDeliveryClient,
  preferenceId: string,
  items: PabcoReminderWorkItem[],
  claimToken: string,
  error: string,
): Promise<void> {
  const payload = deliveryClaimPayload(
    preferenceId,
    items,
    claimToken,
    `${PABCO_DELIVERY_RESERVATION_PREFIX}${claimToken}`,
    new Date().toISOString(),
    new Date().toISOString(),
  );
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
  items: PabcoReminderWorkItem[],
  claimToken: string,
  claimError: string,
  claimedAt: string,
  leaseExpiresAt: string,
): string {
  return JSON.stringify(items.map((item) => ({
    id: deliveryId(preferenceId, item),
    preferenceId,
    workItemId: item.id,
    dueDate: item.dueDate,
    claimToken,
    claimError,
    claimedAt,
    leaseExpiresAt,
  })));
}

function pabcoPreferenceScopeConflict() {
  return new DomainRuleError(
    "Tu acceso a uno o más fundos cambió. Actualiza la página e inténtalo nuevamente.",
    "FIELD_SCOPE_CONFLICT",
  );
}

function textDigest(items: PabcoReminderWorkItem[]) {
  return `Recordatorios PABCO FundoSmart\n\n${items
    .map(
      (item) => `- ${item.title}: revisar el ${item.dueDate}. ${item.detail}`,
    )
    .join(
      "\n",
    )}\n\nAbre FundoSmart para revisar la evidencia y actualizar el checklist.`;
}

function htmlDigest(items: PabcoReminderWorkItem[], appBaseUrl?: string) {
  return `<div style="font-family:Arial,sans-serif;color:#17201c"><h1 style="color:#173b2d">Recordatorios PABCO</h1><p>Estos requisitos necesitan revisión:</p><ul>${items
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.title)}</strong>: revisar el ${item.dueDate}. ${escapeHtml(item.detail)}</li>`,
    )
    .join(
      "",
    )}</ul><p><a href="${new URL("/leche", notificationBaseUrl(appBaseUrl)).toString()}">Abrir FundoSmart</a></p></div>`;
}

function notificationBaseUrl(value?: string) {
  return value?.trim() || "http://localhost:3000";
}

function notificationEmailFrom(value?: string) {
  return value?.trim() || "notifications@localhost.invalid";
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function deliveryId(preferenceId: string, item: PabcoReminderWorkItem) {
  return `delivery:${preferenceId}:${item.id}:${item.dueDate}:email`;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function chileDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
