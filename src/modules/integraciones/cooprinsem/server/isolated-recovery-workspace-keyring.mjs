import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT =
  "fundosmart.isolated-recovery-workspace-keyring.v1";
export const ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS = 60 * 60 * 1_000;

const ORPHAN_REAPER_RECEIPT_FORMAT = "fundosmart.isolated-recovery-orphan-reaper.v2";
const MAX_KEY_COUNT = 4;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_]{2,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const keyringState = new WeakMap();

export async function createIsolatedRecoveryWorkspaceKeyring(input) {
  const workspaceRootPath = await canonicalWorkspaceRoot(input?.workspaceRootPath);
  const active = {
    keyId: validKeyId(input?.activeKeyId, "activeKeyId"),
    key: normalizeSecret(input?.activeKey, "activeKey"),
  };
  const verification = normalizeVerificationKeys(input?.verificationKeys ?? []);
  assertDistinctKeyIds(active, verification);
  assertKeyCount(verification.length + 1);
  return createKeyringDescriptor({
    active,
    verification,
    workspaceRootSha256: sha256Text(workspaceRootPath),
    createdAt: new Date().toISOString(),
  });
}

export function rotateIsolatedRecoveryWorkspaceKeyring(keyring, input) {
  const current = requiredState(keyring);
  const nextActive = {
    keyId: validKeyId(input?.nextKeyId, "nextKeyId"),
    key: normalizeSecret(input?.nextKey, "nextKey"),
  };
  if ([current.active, ...current.verification].some((entry) => entry.keyId === nextActive.keyId)) {
    throw new Error("nextKeyId no puede reutilizar un keyId todavia retenido.");
  }
  assertKeyCount(current.verification.length + 2);
  const rotatedAt = new Date().toISOString();
  const previousActive = {
    keyId: current.active.keyId,
    key: Uint8Array.from(current.active.key),
    verifyUntil: new Date(
      Date.parse(rotatedAt) + ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
    ).toISOString(),
  };
  return createKeyringDescriptor({
    active: nextActive,
    verification: [
      ...current.verification.map(copyVerificationEntry),
      previousActive,
    ],
    workspaceRootSha256: current.workspaceRootSha256,
    createdAt: rotatedAt,
  });
}

export function pruneIsolatedRecoveryWorkspaceKeyring(keyring, input) {
  const current = requiredState(keyring);
  const receipt = normalizeReaperReceipt(input?.reaperReceipt, current.workspaceRootSha256);
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const sweptAtMs = Date.parse(receipt.sweptAt);
  const retained = current.verification.filter((entry) => {
    if (Date.parse(entry.verifyUntil) > nowMs) return true;
    if (sweptAtMs < Date.parse(entry.verifyUntil)) return true;
    return receipt.keyUsage.get(sha256Text(entry.keyId)) !== 0;
  });
  return createKeyringDescriptor({
    active: {
      keyId: current.active.keyId,
      key: Uint8Array.from(current.active.key),
    },
    verification: retained.map(copyVerificationEntry),
    workspaceRootSha256: current.workspaceRootSha256,
    createdAt: now,
  });
}

export function readActiveIsolatedRecoveryWorkspaceKey(keyring, expectedWorkspaceRootSha256) {
  const state = requiredState(keyring);
  assertWorkspaceRoot(state, expectedWorkspaceRootSha256);
  return Object.freeze({
    keyId: state.active.keyId,
    key: Uint8Array.from(state.active.key),
  });
}

export function readIsolatedRecoveryWorkspaceVerificationKeys(
  keyring,
  expectedWorkspaceRootSha256,
) {
  const state = requiredState(keyring);
  assertWorkspaceRoot(state, expectedWorkspaceRootSha256);
  return Object.freeze([
    Object.freeze({
      keyId: state.active.keyId,
      key: Uint8Array.from(state.active.key),
      mode: "active",
      verifyUntil: null,
    }),
    ...state.verification.map((entry) => Object.freeze({
      keyId: entry.keyId,
      key: Uint8Array.from(entry.key),
      mode: "verify_only",
      verifyUntil: entry.verifyUntil,
    })),
  ]);
}

function createKeyringDescriptor(state) {
  const verification = state.verification.map(copyVerificationEntry);
  const descriptor = Object.freeze({
    format: ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT,
    workspaceRootSha256: state.workspaceRootSha256,
    activeKeyId: state.active.keyId,
    verificationKeys: Object.freeze(verification.map((entry) => Object.freeze({
      keyId: entry.keyId,
      verifyUntil: entry.verifyUntil,
    }))),
    maxWorkspaceTtlMs: ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
    createdAt: state.createdAt,
  });
  keyringState.set(descriptor, {
    active: {
      keyId: state.active.keyId,
      key: Uint8Array.from(state.active.key),
    },
    verification,
    workspaceRootSha256: state.workspaceRootSha256,
  });
  return descriptor;
}

function normalizeVerificationKeys(value) {
  if (!Array.isArray(value)) throw new Error("verificationKeys debe ser una lista local.");
  return value.map((entry, index) => ({
    keyId: validKeyId(entry?.keyId, `verificationKeys[${index}].keyId`),
    key: normalizeSecret(entry?.key, `verificationKeys[${index}].key`),
    verifyUntil: canonicalIso(entry?.verifyUntil, `verificationKeys[${index}].verifyUntil`),
  }));
}

function normalizeReaperReceipt(value, workspaceRootSha256) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== ORPHAN_REAPER_RECEIPT_FORMAT
    || value.workspaceRootSha256 !== workspaceRootSha256
    || value.destructionVerified !== true
    || value.failedWorkspaceCount !== 0
    || !Array.isArray(value.keyUsage)) {
    throw new Error("El recibo del recolector no autoriza podar el keyring.");
  }
  const sweptAt = canonicalIso(value.sweptAt, "reaperReceipt.sweptAt");
  if (Date.parse(sweptAt) > Date.now() + 5_000) {
    throw new Error("El recibo del recolector no puede venir del futuro.");
  }
  const keyUsage = new Map();
  for (const [index, usage] of value.keyUsage.entries()) {
    const keyIdSha256 = validSha256(
      usage?.keyIdSha256,
      `reaperReceipt.keyUsage[${index}].keyIdSha256`,
    );
    if (!Number.isSafeInteger(usage?.authenticatedWorkspaceCount)
      || usage.authenticatedWorkspaceCount < 0 || keyUsage.has(keyIdSha256)) {
      throw new Error("El uso de claves del recibo no es valido.");
    }
    keyUsage.set(keyIdSha256, usage.authenticatedWorkspaceCount);
  }
  return { sweptAt, keyUsage };
}

function requiredState(keyring) {
  const state = keyringState.get(keyring);
  if (!state) throw new Error("workspaceKeyring debe crearse con el contrato local versionado.");
  return state;
}

function assertWorkspaceRoot(state, expected) {
  if (state.workspaceRootSha256 !== validSha256(expected, "workspaceRootSha256")) {
    throw new Error("El keyring no pertenece a la raiz efimera solicitada.");
  }
}

function assertDistinctKeyIds(active, verification) {
  const ids = [active.keyId, ...verification.map((entry) => entry.keyId)];
  if (new Set(ids).size !== ids.length) throw new Error("Cada keyId del keyring debe ser unico.");
}

function assertKeyCount(count) {
  if (count > MAX_KEY_COUNT) {
    throw new Error("El keyring admite como maximo cuatro claves no retiradas.");
  }
}

function copyVerificationEntry(entry) {
  return {
    keyId: entry.keyId,
    key: Uint8Array.from(entry.key),
    verifyUntil: entry.verifyUntil,
  };
}

function normalizeSecret(value, name) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 4_096) {
    throw new Error(`${name} debe contener entre 32 y 4096 bytes locales.`);
  }
  return Uint8Array.from(value);
}

function validKeyId(value, name) {
  const text = String(value ?? "");
  if (!KEY_ID_PATTERN.test(text)) {
    throw new Error(`${name} debe usar 3 a 32 caracteres minusculos, numeros o guion bajo.`);
  }
  return text;
}

function validSha256(value, name) {
  const text = String(value ?? "");
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser SHA-256 hexadecimal.`);
  return text;
}

function canonicalIso(value, name) {
  const text = String(value ?? "");
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${name} debe ser una fecha ISO canonica.`);
  }
  return text;
}

async function canonicalWorkspaceRoot(value) {
  const requested = path.resolve(value === undefined ? tmpdir() : requiredText(value, "workspaceRootPath"));
  const info = await stat(requested);
  if (!info.isDirectory()) throw new Error("workspaceRootPath debe ser un directorio local.");
  const canonical = await realpath(requested);
  if (pathsEqual(canonical, path.parse(canonical).root)) {
    throw new Error("workspaceRootPath no puede ser la raiz del sistema de archivos.");
  }
  return canonical;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function pathsEqual(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
