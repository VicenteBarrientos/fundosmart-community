import type { AssistantActivityAction } from "../domain/assistant-engine.mjs";

const TOKEN_VERSION = "v2";
const PURPOSE = new TextEncoder().encode("fundosmart-assistant-confirmation:v2");

export class AssistantConfirmationTokenError extends Error {
  readonly code: "INVALID" | "EXPIRED" | "SUBJECT_MISMATCH" | "CONFIGURATION";

  constructor(
    message: string,
    code: "INVALID" | "EXPIRED" | "SUBJECT_MISMATCH" | "CONFIGURATION",
  ) {
    super(message);
    this.name = "AssistantConfirmationTokenError";
    this.code = code;
  }
}

type ConfirmationSubject = {
  membershipId: string;
  organizationId: string;
  actor: string;
};

type ConfirmationEnvelope = ConfirmationSubject & {
  action: AssistantActivityAction;
  expiresAt: number;
  issuedAt: number;
  version: 2;
};

export async function sealAssistantConfirmation(
  action: AssistantActivityAction,
  subject: ConfirmationSubject,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const key = await importSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope: ConfirmationEnvelope = {
    action,
    actor: normalizeActor(subject.actor),
    expiresAt: now + 15 * 60_000,
    issuedAt: now,
    membershipId: subject.membershipId,
    organizationId: subject.organizationId,
    version: 2,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: PURPOSE, tagLength: 128 },
    key,
    plaintext,
  );
  return `${TOKEN_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openAssistantConfirmation(
  token: string,
  subject: ConfirmationSubject,
  secret: string,
  now = Date.now(),
): Promise<AssistantActivityAction> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || token.length > 4_000) {
    throw invalidToken();
  }
  const key = await importSecret(secret);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(fromBase64Url(parts[1])),
        additionalData: PURPOSE,
        tagLength: 128,
      },
      key,
      asArrayBuffer(fromBase64Url(parts[2])),
    );
  } catch {
    throw invalidToken();
  }
  let envelope: ConfirmationEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(plaintext)) as ConfirmationEnvelope;
  } catch {
    throw invalidToken();
  }
  if (
    envelope.version !== 2
    || typeof envelope.membershipId !== "string"
    || !envelope.membershipId
    || !Number.isFinite(envelope.issuedAt)
    || !Number.isFinite(envelope.expiresAt)
  ) {
    throw invalidToken();
  }
  if (
    envelope.membershipId !== subject.membershipId
    || envelope.organizationId !== subject.organizationId
    || envelope.actor !== normalizeActor(subject.actor)
  ) {
    throw new AssistantConfirmationTokenError("La propuesta pertenece a otra sesión o membresía.", "SUBJECT_MISMATCH");
  }
  if (envelope.issuedAt > now + 60_000) throw invalidToken();
  if (envelope.expiresAt < now || envelope.expiresAt - envelope.issuedAt > 15 * 60_000) {
    throw new AssistantConfirmationTokenError("La propuesta venció. Pídele al asistente que la prepare nuevamente.", "EXPIRED");
  }
  return envelope.action;
}

async function importSecret(secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(secret);
  } catch {
    throw configurationError();
  }
  if (bytes.length !== 32) throw configurationError();
  return crypto.subtle.importKey("raw", asArrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function normalizeActor(value: string): string {
  return value.trim().toLowerCase();
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidToken();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function invalidToken(): AssistantConfirmationTokenError {
  return new AssistantConfirmationTokenError("La confirmación no es válida.", "INVALID");
}

function configurationError(): AssistantConfirmationTokenError {
  return new AssistantConfirmationTokenError("La confirmación segura no está configurada.", "CONFIGURATION");
}
