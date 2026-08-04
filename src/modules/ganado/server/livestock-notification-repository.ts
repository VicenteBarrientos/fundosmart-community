import { getDb } from "@/db";
import { livestockNotificationPreferences } from "@/db/schema";
import type { HerdWorkItem } from "../domain/operations";
import { listLivestockAnimals } from "./livestock-animal-repository";
import { listHerdOperations } from "./herd-operations-repository";
import { listLivestockLots } from "./livestock-repository";
import { listLivestockWeighings } from "./livestock-weighing-repository";
import { and, asc, eq, inArray } from "drizzle-orm";

const LIVESTOCK_DELIVERY_RESERVATION_PREFIX = "livestock.delivery.reserved:";
const LIVESTOCK_DELIVERY_LEASE_MS = 5 * 60 * 1000;

export type LivestockNotificationPreference = typeof livestockNotificationPreferences.$inferSelect;

type LivestockDeliveryClient = ReturnType<typeof getDb>["$client"];
type EligibleLivestockPreference = Pick<
  LivestockNotificationPreference,
  "id" | "organizationId" | "fieldId" | "userEmail" | "reminderDays"
>;

export async function listNotificationPreferences(organizationId: string, userEmail: string, fieldIds: string[]): Promise<LivestockNotificationPreference[]> {
  if (!fieldIds.length) return [];
  return getDb().select().from(livestockNotificationPreferences).where(and(
    eq(livestockNotificationPreferences.organizationId, organizationId),
    eq(livestockNotificationPreferences.userEmail, normalizeEmail(userEmail)),
    inArray(livestockNotificationPreferences.fieldId, fieldIds),
  )).orderBy(asc(livestockNotificationPreferences.fieldId));
}

export async function saveNotificationPreferences(input: { organizationId: string; userEmail: string; fieldIds: string[]; emailEnabled: boolean; browserEnabled: boolean; reminderDays: number }): Promise<LivestockNotificationPreference[]> {
  const db = getDb();
  const now = new Date().toISOString();
  const email = normalizeEmail(input.userEmail);
  const statements = input.fieldIds.map((fieldId) => db.insert(livestockNotificationPreferences).values({
    id: `notify-pref:${input.organizationId}:${fieldId}:${email}`,
    organizationId: input.organizationId, fieldId, userEmail: email,
    emailEnabled: input.emailEnabled, browserEnabled: input.browserEnabled,
    reminderDays: Math.max(0, Math.min(60, Math.round(input.reminderDays))), timezone: "America/Santiago",
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [livestockNotificationPreferences.organizationId, livestockNotificationPreferences.fieldId, livestockNotificationPreferences.userEmail],
    set: { emailEnabled: input.emailEnabled, browserEnabled: input.browserEnabled, reminderDays: Math.max(0, Math.min(60, Math.round(input.reminderDays))), updatedAt: now },
  }));
  for (const statement of statements) await statement;
  return listNotificationPreferences(input.organizationId, email, input.fieldIds);
}

export async function runDueLivestockNotifications(
  emailBinding: SendEmail,
  options: { now?: Date; today?: string; appBaseUrl?: string; emailFrom?: string } = {},
): Promise<{ recipients: number; deliveries: number; failures: number }> {
  const db = getDb();
  const client = db.$client;
  const preferences = await loadEligibleLivestockPreferences(client);
  if (!preferences.length) return { recipients: 0, deliveries: 0, failures: 0 };
  const operationsByField = new Map<string, Awaited<ReturnType<typeof listHerdOperations>>>();
  const today = options.today ?? chileDate(options.now ?? new Date());
  let recipients = 0; let deliveries = 0; let failures = 0;
  for (const preference of preferences) {
    const scopeKey = `${preference.organizationId}:${preference.fieldId}`;
    let operations = operationsByField.get(scopeKey);
    if (!operations) {
      const scope = { organizationId: preference.organizationId, fieldIds: [preference.fieldId] };
      const [lots, animals, weighings] = await Promise.all([
        listLivestockLots(scope),
        listLivestockAnimals(scope),
        listLivestockWeighings(scope),
      ]);
      operations = await listHerdOperations({ fieldIds: scope.fieldIds, lots, animals, weighings, expenses: [] });
      operationsByField.set(scopeKey, operations);
    }
    const horizon = addDays(today, preference.reminderDays);
    const candidates = operations.workItems.filter((item) => item.dueDate <= horizon);
    if (!candidates.length) continue;
    const claimNow = options.now ?? new Date();
    const unavailable = await loadUnavailableLivestockDeliveryKeys(client, preference.id, claimNow.toISOString());
    const pending = candidates.filter((entry) => !unavailable.has(`${entry.id}:${entry.dueDate}`));
    if (!pending.length) continue;

    let claimToken: string | null;
    try {
      claimToken = await claimLivestockDeliveries(client, preference, pending, claimNow);
    } catch (cause) {
      failures += 1;
      logLivestockNotificationFailure("livestock.notification.claim_failed", preference.id, cause);
      continue;
    }
    if (!claimToken) continue;

    let emailAccepted = false;
    try {
      await emailBinding.send({
        to: preference.userEmail,
        from: { email: notificationEmailFrom(options.emailFrom), name: "FundoSmart" },
        subject: `FundoSmart · ${pending.length} tarea${pending.length === 1 ? "" : "s"} de ganado`,
        text: textDigest(pending), html: htmlDigest(pending, options.appBaseUrl),
      });
      emailAccepted = true;
      const sentAt = (options.now ?? new Date()).toISOString();
      await finalizeLivestockDeliveries(client, preference, pending, claimToken, sentAt);
      recipients += 1; deliveries += pending.length;
    } catch (cause) {
      failures += 1;
      if (!emailAccepted) {
        try {
          await releaseLivestockDeliveryClaims(
            client,
            preference.id,
            pending,
            claimToken,
            `email_send_failed: ${errorMessage(cause)}`.slice(0, 500),
          );
        } catch (releaseCause) {
          logLivestockNotificationFailure("livestock.notification.claim_release_failed", preference.id, releaseCause);
        }
      }
      logLivestockNotificationFailure(
        emailAccepted ? "livestock.notification.ledger_unconfirmed" : "livestock.notification.email_failed",
        preference.id,
        cause,
      );
    }
  }
  return { recipients, deliveries, failures };
}

async function loadEligibleLivestockPreferences(
  client: LivestockDeliveryClient,
): Promise<EligibleLivestockPreference[]> {
  const result = await client.prepare(`
    SELECT DISTINCT
      preference.id,
      preference.organization_id AS organizationId,
      preference.field_id AS fieldId,
      preference.user_email AS userEmail,
      preference.reminder_days AS reminderDays
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
          AND current_member.role IN ('owner', 'admin', 'manager', 'operator')
          AND (
            current_member.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_access
              WHERE current_access.membership_id = current_member.id
                AND current_access.field_id = preference.field_id
            )
          )
      )
    ORDER BY preference.id
  `).all<EligibleLivestockPreference>();
  return result.results ?? [];
}

async function loadUnavailableLivestockDeliveryKeys(
  client: LivestockDeliveryClient,
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
  return new Set((result.results ?? []).map((entry) => `${entry.workItemId}:${entry.dueDate}`));
}

async function claimLivestockDeliveries(
  client: LivestockDeliveryClient,
  preference: EligibleLivestockPreference,
  items: HerdWorkItem[],
  now: Date,
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + LIVESTOCK_DELIVERY_LEASE_MS).toISOString();
  const claimError = `${LIVESTOCK_DELIVERY_RESERVATION_PREFIX}${claimToken}`;
  const payload = livestockDeliveryClaimPayload(preference.id, items, claimToken, claimError, claimedAt, leaseExpiresAt);
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
          'email', 'failed',
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
                AND current_member.role IN ('owner', 'admin', 'manager', 'operator')
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
      `).bind(payload, preference.organizationId, preference.fieldId, preference.userEmail),
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
        ) THEN 1 ELSE json_extract('fundosmart_livestock_delivery_claim_conflict', '$') END
          AS livestock_delivery_claim_postcondition
      `).bind(payload, payload),
    ]);
    return claimToken;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("malformed JSON")) return null;
    throw cause;
  }
}

async function finalizeLivestockDeliveries(
  client: LivestockDeliveryClient,
  preference: EligibleLivestockPreference,
  items: HerdWorkItem[],
  claimToken: string,
  sentAt: string,
): Promise<void> {
  const payload = livestockDeliveryClaimPayload(
    preference.id,
    items,
    claimToken,
    `${LIVESTOCK_DELIVERY_RESERVATION_PREFIX}${claimToken}`,
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
        AND EXISTS (
          SELECT 1
          FROM livestock_notification_preferences AS current_preference
          INNER JOIN fields AS current_field
            ON current_field.organization_id = current_preference.organization_id
           AND current_field.id = current_preference.field_id
          WHERE current_preference.id = livestock_notification_deliveries.preference_id
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
                AND current_member.role IN ('owner', 'admin', 'manager', 'operator')
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
    `).bind(
      sentAt,
      preference.id,
      claimToken,
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
      ) THEN 1 ELSE json_extract('fundosmart_livestock_delivery_finalize_failed', '$') END
        AS livestock_delivery_finalize_postcondition
    `).bind(payload, payload, sentAt),
  ]);
}

async function releaseLivestockDeliveryClaims(
  client: LivestockDeliveryClient,
  preferenceId: string,
  items: HerdWorkItem[],
  claimToken: string,
  error: string,
): Promise<void> {
  const releasedAt = new Date().toISOString();
  const payload = livestockDeliveryClaimPayload(
    preferenceId,
    items,
    claimToken,
    `${LIVESTOCK_DELIVERY_RESERVATION_PREFIX}${claimToken}`,
    releasedAt,
    releasedAt,
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

function livestockDeliveryClaimPayload(
  preferenceId: string,
  items: HerdWorkItem[],
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

function textDigest(items: HerdWorkItem[]) { return `Agenda de ganado FundoSmart\n\n${items.map((item) => `- ${item.title}: ${item.animalTag} (${item.lotName}), vence ${item.dueDate}. ${item.detail}`).join("\n")}\n\nAbre FundoSmart para revisar y registrar avances.`; }
function htmlDigest(items: HerdWorkItem[], appBaseUrl?: string) { return `<div style="font-family:Arial,sans-serif;color:#17201c"><h1 style="color:#173b2d">Agenda de ganado</h1><p>Estas tareas requieren revisión:</p><ul>${items.map((item) => `<li><strong>${escapeHtml(item.title)} · ${escapeHtml(item.animalTag)}</strong> (${escapeHtml(item.lotName)}), vence ${item.dueDate}. ${escapeHtml(item.detail)}</li>`).join("")}</ul><p><a href="${new URL("/ganado", notificationBaseUrl(appBaseUrl)).toString()}">Abrir FundoSmart</a></p></div>`; }
function notificationBaseUrl(value?: string) { return value?.trim() || "http://localhost:3000"; }
function notificationEmailFrom(value?: string) { return value?.trim() || "notifications@localhost.invalid"; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function deliveryId(preferenceId: string, item: HerdWorkItem) { return `delivery:${preferenceId}:${item.id}:${item.dueDate}:email`; }
function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
function chileDate(now: Date) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
function addDays(value: string, days: number) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
function logLivestockNotificationFailure(event: string, preferenceId: string, cause: unknown) {
  console.error(JSON.stringify({ event, preferenceId, error: errorMessage(cause).slice(0, 500) }));
}
