import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantConfirmationTokenError,
  openAssistantConfirmation,
  sealAssistantConfirmation,
} from "../src/modules/asistente/server/assistant-confirmation-token.ts";

const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const action = {
  kind: "create_activity",
  id: "assistant-activity-11111111-1111-4111-8111-111111111111",
  fieldId: "field-one",
  fieldName: "Fundo Uno",
  paddockId: "paddock-secret-target",
  paddockName: "Potrero Uno",
  activityType: "grazing",
  activityLabel: "Pastoreo",
  occurredAt: "2026-07-21",
  description: "Registrado por Asistente FundoSmart: pastoreo hoy",
  quantity: null,
  unit: null,
  costClp: null,
  createdAt: "2026-07-21T12:00:00.000Z",
};
const subject = {
  membershipId: "membership-one",
  organizationId: "org-one",
  actor: "persona@example.com",
};
const issuedAt = Date.parse("2026-07-21T12:00:00.000Z");

test("cifra la tarea y la abre solo para el sujeto autorizado", async () => {
  const token = await sealAssistantConfirmation(action, subject, secret, issuedAt);
  assert.match(token, /^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(token, /paddock-secret-target|field-one|persona/);
  assert.deepEqual(await openAssistantConfirmation(token, subject, secret, issuedAt + 60_000), action);
  assert.deepEqual(
    await openAssistantConfirmation(token, { ...subject, actor: " PERSONA@EXAMPLE.COM " }, secret, issuedAt + 60_000),
    action,
  );
});

test("rechaza alteración, otro sujeto, vencimiento y secretos inválidos", async () => {
  const token = await sealAssistantConfirmation(action, subject, secret, issuedAt);
  const [version, iv, ciphertext] = token.split(".");
  const alteredCiphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
  const altered = [version, iv, alteredCiphertext].join(".");
  await assert.rejects(openAssistantConfirmation(altered, subject, secret, issuedAt), tokenError("INVALID"));
  await assert.rejects(
    openAssistantConfirmation(token, { ...subject, organizationId: "org-two" }, secret, issuedAt),
    tokenError("SUBJECT_MISMATCH"),
  );
  await assert.rejects(
    openAssistantConfirmation(token, { ...subject, membershipId: "membership-replacement" }, secret, issuedAt),
    tokenError("SUBJECT_MISMATCH"),
  );
  await assert.rejects(openAssistantConfirmation(token, subject, secret, issuedAt + 15 * 60_000 + 1), tokenError("EXPIRED"));
  await assert.rejects(sealAssistantConfirmation(action, subject, "corto", issuedAt), tokenError("CONFIGURATION"));
});

test("rechaza tokens v1 porque no pueden acreditar la membresía exacta", async () => {
  const legacy = await sealLegacyV1(action, subject, secret, issuedAt);
  await assert.rejects(
    openAssistantConfirmation(legacy, subject, secret, issuedAt + 60_000),
    tokenError("INVALID"),
  );
});

async function sealLegacyV1(value, legacySubject, legacySecret, now) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(legacySecret),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope = {
    action: value,
    actor: legacySubject.actor.trim().toLowerCase(),
    expiresAt: now + 15 * 60_000,
    issuedAt: now,
    organizationId: legacySubject.organizationId,
    version: 1,
  };
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode("fundosmart-assistant-confirmation:v1"),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

function fromBase64Url(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function tokenError(code) {
  return (error) => error instanceof AssistantConfirmationTokenError && error.code === code;
}
