export type InboxAddressStatus = "active" | "revoked";

export type InboxQuarantineReason =
  | "unauthorized_sender"
  | "no_valid_attachments"
  | "attachment_too_large"
  | "processing_error";

export type InboxQuarantineStatus = "quarantined" | "resolved" | "dismissed";

export interface InboxAddressRecord {
  id: string;
  organizationId: string;
  fieldId: string;
  addressToken: string;
  emailAddress: string;
  status: InboxAddressStatus;
  createdByEmail: string;
  revokedByEmail: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboxSenderWhitelistRecord {
  id: string;
  organizationId: string;
  senderEmail: string;
  normalizedSenderEmail: string;
  label: string | null;
  createdByEmail: string;
  createdAt: string;
}

export interface InboxQuarantineRecord {
  id: string;
  organizationId: string;
  fieldId: string;
  inboxAddressId: string;
  senderEmail: string;
  subject: string | null;
  messageId: string | null;
  attachmentCount: number;
  reason: InboxQuarantineReason;
  status: InboxQuarantineStatus;
  receivedAt: string;
  createdAt: string;
}

export interface InboxIncomingMessageRecord {
  id: string;
  organizationId: string;
  fieldId: string;
  inboxAddressId: string;
  messageId: string;
  attachmentSha256: string;
  importJobId: string | null;
  senderEmail: string;
  subject: string | null;
  receivedAt: string;
  createdAt: string;
}

export interface EmailAttachmentInput {
  filename: string;
  contentType?: string;
  data: Uint8Array;
}

export interface ProcessIncomingEmailInput {
  recipientAddress: string;
  senderEmail: string;
  subject?: string;
  messageId?: string;
  receivedAt?: string;
  attachments: EmailAttachmentInput[];
}

export interface ProcessIncomingEmailResult {
  outcome: "staged" | "quarantined" | "duplicate" | "invalid_recipient" | "no_attachments";
  organizationId?: string;
  fieldId?: string;
  importJobIds?: string[];
  quarantineId?: string;
  reason?: string;
}
