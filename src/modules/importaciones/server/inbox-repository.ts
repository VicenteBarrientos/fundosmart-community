import crypto from "node:crypto";
import { getDb } from "@/db";
import {
  inboxAddresses,
  inboxIncomingMessages,
  inboxQuarantine,
  inboxSenderWhitelists,
} from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { createStoredImportJob } from "@/src/modules/integraciones/cooprinsem/server/intake-repository";
import {
  assertCurrentImportActorAccess,
  type ImportActorAccess,
} from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import type { ImportFormat } from "../domain/types";
import type {
  EmailAttachmentInput,
  InboxAddressRecord,
  InboxQuarantineReason,
  InboxQuarantineRecord,
  InboxQuarantineStatus,
  InboxSenderWhitelistRecord,
  ProcessIncomingEmailInput,
  ProcessIncomingEmailResult,
} from "../domain/inbox-types";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateAddressToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildInboxEmailAddress(token: string, domain = "localhost.invalid"): string {
  return `inbox-${token}@${domain}`;
}

export async function getActiveInboxAddress({
  access,
  fieldId,
}: {
  access: ImportActorAccess;
  fieldId: string;
}): Promise<InboxAddressRecord | null> {
  await assertCurrentImportActorAccess(access, [fieldId]);
  const db = getDb();

  const [row] = await db
    .select()
    .from(inboxAddresses)
    .where(
      and(
        eq(inboxAddresses.organizationId, access.organizationId),
        eq(inboxAddresses.fieldId, fieldId),
        eq(inboxAddresses.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    fieldId: row.fieldId,
    addressToken: row.addressToken,
    emailAddress: row.emailAddress,
    status: row.status as "active" | "revoked",
    createdByEmail: row.createdByEmail,
    revokedByEmail: row.revokedByEmail,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createOrGetActiveInboxAddress({
  access,
  fieldId,
  domain = "localhost.invalid",
}: {
  access: ImportActorAccess;
  fieldId: string;
  domain?: string;
}): Promise<InboxAddressRecord> {
  await assertCurrentImportActorAccess(access, [fieldId]);
  const existing = await getActiveInboxAddress({ access, fieldId });
  if (existing) return existing;

  const db = getDb();
  const token = generateAddressToken();
  const emailAddress = buildInboxEmailAddress(token, domain);
  const id = `inbox-addr-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await db.insert(inboxAddresses).values({
    id,
    organizationId: access.organizationId,
    fieldId,
    addressToken: token,
    emailAddress,
    status: "active",
    createdByEmail: access.email,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: access.organizationId,
    fieldId,
    addressToken: token,
    emailAddress,
    status: "active",
    createdByEmail: access.email,
    revokedByEmail: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function rotateInboxAddress({
  access,
  fieldId,
  domain = "localhost.invalid",
}: {
  access: ImportActorAccess;
  fieldId: string;
  domain?: string;
}): Promise<InboxAddressRecord> {
  await assertCurrentImportActorAccess(access, [fieldId]);
  const db = getDb();
  const now = new Date().toISOString();

  const active = await getActiveInboxAddress({ access, fieldId });
  if (active) {
    await db
      .update(inboxAddresses)
      .set({
        status: "revoked",
        revokedByEmail: access.email,
        revokedAt: now,
        updatedAt: now,
      })
      .where(eq(inboxAddresses.id, active.id));
  }

  const token = generateAddressToken();
  const emailAddress = buildInboxEmailAddress(token, domain);
  const newId = `inbox-addr-${crypto.randomUUID()}`;

  await db.insert(inboxAddresses).values({
    id: newId,
    organizationId: access.organizationId,
    fieldId,
    addressToken: token,
    emailAddress,
    status: "active",
    createdByEmail: access.email,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id: newId,
    organizationId: access.organizationId,
    fieldId,
    addressToken: token,
    emailAddress,
    status: "active",
    createdByEmail: access.email,
    revokedByEmail: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listWhitelistedSenders({
  access,
}: {
  access: ImportActorAccess;
}): Promise<InboxSenderWhitelistRecord[]> {
  await assertCurrentImportActorAccess(access, access.fieldIds);
  const db = getDb();

  const rows = await db
    .select()
    .from(inboxSenderWhitelists)
    .where(eq(inboxSenderWhitelists.organizationId, access.organizationId))
    .orderBy(desc(inboxSenderWhitelists.createdAt));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    senderEmail: r.senderEmail,
    normalizedSenderEmail: r.normalizedSenderEmail,
    label: r.label,
    createdByEmail: r.createdByEmail,
    createdAt: r.createdAt,
  }));
}

export async function addWhitelistedSender({
  access,
  senderEmail,
  label,
}: {
  access: ImportActorAccess;
  senderEmail: string;
  label?: string;
}): Promise<InboxSenderWhitelistRecord> {
  await assertCurrentImportActorAccess(access, access.fieldIds);
  const db = getDb();
  const normalized = normalizeEmail(senderEmail);
  const id = `inbox-white-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await db.insert(inboxSenderWhitelists).values({
    id,
    organizationId: access.organizationId,
    senderEmail: senderEmail.trim(),
    normalizedSenderEmail: normalized,
    label: label?.trim() || null,
    createdByEmail: access.email,
    createdAt: now,
  });

  return {
    id,
    organizationId: access.organizationId,
    senderEmail: senderEmail.trim(),
    normalizedSenderEmail: normalized,
    label: label?.trim() || null,
    createdByEmail: access.email,
    createdAt: now,
  };
}

export async function removeWhitelistedSender({
  access,
  senderId,
}: {
  access: ImportActorAccess;
  senderId: string;
}): Promise<void> {
  await assertCurrentImportActorAccess(access, access.fieldIds);
  const db = getDb();

  await db
    .delete(inboxSenderWhitelists)
    .where(
      and(
        eq(inboxSenderWhitelists.id, senderId),
        eq(inboxSenderWhitelists.organizationId, access.organizationId),
      ),
    );
}

export async function listQuarantineMessages({
  access,
  fieldId,
}: {
  access: ImportActorAccess;
  fieldId: string;
}): Promise<InboxQuarantineRecord[]> {
  await assertCurrentImportActorAccess(access, [fieldId]);
  const db = getDb();

  const rows = await db
    .select()
    .from(inboxQuarantine)
    .where(
      and(
        eq(inboxQuarantine.organizationId, access.organizationId),
        eq(inboxQuarantine.fieldId, fieldId),
      ),
    )
    .orderBy(desc(inboxQuarantine.createdAt));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    fieldId: r.fieldId,
    inboxAddressId: r.inboxAddressId,
    senderEmail: r.senderEmail,
    subject: r.subject,
    messageId: r.messageId,
    attachmentCount: r.attachmentCount,
    reason: r.reason as InboxQuarantineReason,
    status: r.status as InboxQuarantineStatus,
    receivedAt: r.receivedAt,
    createdAt: r.createdAt,
  }));
}

function detectSourceFormat(filename: string): ImportFormat {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  return "dbf";
}

/**
 * Core processing function for incoming email messages from Worker or test harness.
 */
export async function processIncomingEmailMessage(
  input: ProcessIncomingEmailInput,
  _options?: { fileBucket?: R2Bucket },
): Promise<ProcessIncomingEmailResult> {
  const db = getDb();
  const recipientNormalized = normalizeEmail(input.recipientAddress);
  const senderNormalized = normalizeEmail(input.senderEmail);

  // 1. Look up active recipient address
  const [addr] = await db
    .select()
    .from(inboxAddresses)
    .where(
      and(
        eq(inboxAddresses.emailAddress, recipientNormalized),
        eq(inboxAddresses.status, "active"),
      ),
    )
    .limit(1);

  if (!addr) {
    return { outcome: "invalid_recipient", reason: "Recipient inbox address not found or revoked" };
  }

  const organizationId = addr.organizationId;
  const fieldId = addr.fieldId;

  // Check if email has attachments
  if (!input.attachments || input.attachments.length === 0) {
    return { outcome: "no_attachments", reason: "Email message contained no attachments" };
  }

  // 2. Sender Whitelist Check
  const [whitelisted] = await db
    .select()
    .from(inboxSenderWhitelists)
    .where(
      and(
        eq(inboxSenderWhitelists.organizationId, organizationId),
        eq(inboxSenderWhitelists.normalizedSenderEmail, senderNormalized),
      ),
    )
    .limit(1);

  if (!whitelisted) {
    const qId = `quarantine-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await db.insert(inboxQuarantine).values({
      id: qId,
      organizationId,
      fieldId,
      inboxAddressId: addr.id,
      senderEmail: input.senderEmail,
      subject: input.subject || null,
      messageId: input.messageId || null,
      attachmentCount: input.attachments.length,
      reason: "unauthorized_sender",
      status: "quarantined",
      receivedAt: now,
      createdAt: now,
    });

    return {
      outcome: "quarantined",
      quarantineId: qId,
      reason: "unauthorized_sender",
    };
  }

  // 3. Process attachments with deduplication
  const stagedJobIds: string[] = [];
  const effectiveMessageId = input.messageId || `msg-${crypto.randomUUID()}`;

  // Find active membership in organization_memberships
  const [orgMember] = await (getDb().$client.prepare(`
    SELECT id, user_email FROM organization_memberships
    WHERE organization_id = ? AND status = 'active'
    ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END
    LIMIT 1
  `).bind(organizationId).all() as Promise<{ results?: { id: string; user_email: string }[] }>).then((res) => res.results ?? []);

  const membershipId = orgMember?.id || `inbox-system-${organizationId}`;
  const requestedBy = orgMember?.user_email || input.senderEmail;

  for (const attachment of input.attachments) {
    const dataBuffer = attachment.data.buffer.slice(
      attachment.data.byteOffset,
      attachment.data.byteOffset + attachment.data.byteLength,
    ) as ArrayBuffer;

    // Compute SHA-256
    const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
    const sha256 = Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");

    // Check idempotency (Message-ID + SHA-256)
    const [existing] = await db
      .select()
      .from(inboxIncomingMessages)
      .where(
        and(
          eq(inboxIncomingMessages.organizationId, organizationId),
          eq(inboxIncomingMessages.messageId, effectiveMessageId),
          eq(inboxIncomingMessages.attachmentSha256, sha256),
        ),
      )
      .limit(1);

    if (existing) {
      continue; // Duplicate attachment skip
    }

    const jobId = crypto.randomUUID();
    const sourceFormat = detectSourceFormat(attachment.filename);

    const created = await createStoredImportJob({
      id: jobId,
      bytes: dataBuffer,
      membershipId,
      organizationId,
      fieldId,
      fieldIds: [fieldId],
      sourceSystem: "generic",
      sourceFormat,
      sourceTable: "email_inbox",
      originalFilename: attachment.filename,
      contentType: attachment.contentType || null,
      fileSizeBytes: attachment.data.byteLength,
      sha256,
      mappingVersion: "email_inbox:v1",
      effectiveAt: null,
      requestedBy,
    });

    stagedJobIds.push(created.job.id);

    // Record incoming message for dedupe
    const msgRecId = `inbox-msg-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await db.insert(inboxIncomingMessages).values({
      id: msgRecId,
      organizationId,
      fieldId,
      inboxAddressId: addr.id,
      messageId: effectiveMessageId,
      attachmentSha256: sha256,
      importJobId: created.job.id,
      senderEmail: input.senderEmail,
      subject: input.subject || null,
      receivedAt: input.receivedAt || now,
      createdAt: now,
    });
  }

  if (stagedJobIds.length === 0) {
    return { outcome: "duplicate", organizationId, fieldId, reason: "All attachments were duplicates" };
  }

  return {
    outcome: "staged",
    organizationId,
    fieldId,
    importJobIds: stagedJobIds,
  };
}
