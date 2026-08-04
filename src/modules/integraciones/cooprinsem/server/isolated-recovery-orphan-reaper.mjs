import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
  readActiveIsolatedRecoveryWorkspaceKey,
  readIsolatedRecoveryWorkspaceVerificationKeys,
} from "./isolated-recovery-workspace-keyring.mjs";

export const ISOLATED_RECOVERY_WORKSPACE_MARKER_FORMAT =
  "fundosmart.isolated-recovery-workspace-marker.v2";
export const ISOLATED_RECOVERY_ORPHAN_REAPER_RECEIPT_FORMAT =
  "fundosmart.isolated-recovery-orphan-reaper.v2";
export const ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE =
  ".fundosmart-recovery-workspace.json";

const LEGACY_WORKSPACE_MARKER_FORMAT = "fundosmart.isolated-recovery-workspace-marker.v1";
const WORKSPACE_CANDIDATE_PREFIX = "fundosmart-isolated-recovery-v";
const WORKSPACE_NAME_PREFIX = "fundosmart-isolated-recovery-v2-";
const LEGACY_WORKSPACE_NAME_PATTERN = new RegExp(
  "^fundosmart-isolated-recovery-v1-(\\d{13})-(\\d{13})-(\\d{1,10})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-f0-9]{64})$",
);
const WORKSPACE_NAME_PATTERN = new RegExp(
  `^${WORKSPACE_NAME_PREFIX}([a-z0-9][a-z0-9_]{2,31})-(\\d{13})-(\\d{13})-(\\d{1,10})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-f0-9]{64})$`,
);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MARKER_BYTES = 4_096;
const LEGACY_MARKER_KEYS = [
  "createdAt",
  "expiresAt",
  "format",
  "manifestSha256",
  "ownerPid",
  "signature",
  "workspaceId",
  "workspaceName",
  "workspaceRootSha256",
].sort();
const MARKER_KEYS = [...LEGACY_MARKER_KEYS, "keyId"].sort();

export async function createAuthenticatedIsolatedRecoveryWorkspace(input) {
  const workspaceRootPath = await canonicalWorkspaceRoot(input?.workspaceRootPath);
  const workspaceRootSha256 = sha256Text(workspaceRootPath);
  const activeKey = readActiveIsolatedRecoveryWorkspaceKey(
    input?.workspaceKeyring,
    workspaceRootSha256,
  );
  const workspaceId = validUuid(input?.workspaceId, "workspaceId");
  const manifestSha256 = validSha256(input?.manifestSha256, "manifestSha256");
  const createdAt = canonicalIso(input?.createdAt, "createdAt");
  const expiresAt = canonicalIso(input?.expiresAt, "expiresAt");
  const workspaceTtlMs = Date.parse(expiresAt) - Date.parse(createdAt);
  if (workspaceTtlMs <= 0 || workspaceTtlMs > ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS) {
    throw new Error("El workspace efimero debe durar como maximo una hora.");
  }
  const workspaceName = authenticatedWorkspaceName({
    workspaceId,
    keyId: activeKey.keyId,
    createdAt,
    expiresAt,
    ownerPid: process.pid,
    workspaceRootSha256,
  }, activeKey.key);
  const workspacePath = path.join(workspaceRootPath, workspaceName);
  await mkdir(workspacePath, { recursive: false, mode: 0o700 });
  try {
    const payload = {
      format: ISOLATED_RECOVERY_WORKSPACE_MARKER_FORMAT,
      keyId: activeKey.keyId,
      workspaceName,
      workspaceId,
      workspaceRootSha256,
      manifestSha256,
      createdAt,
      expiresAt,
      ownerPid: process.pid,
    };
    const marker = { ...payload, signature: signMarker(payload, activeKey.key) };
    const markerHandle = await open(
      path.join(workspacePath, ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE),
      "wx",
      0o600,
    );
    try {
      await markerHandle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await markerHandle.sync();
    } finally {
      await markerHandle.close();
    }
  } catch {
    try {
      await rm(workspacePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
    } catch {
      // El nombre autenticado permite distinguir este residuo en una inspeccion manual.
    }
    throw new Error("No se pudo inicializar el marcador del workspace efimero.");
  }
  return Object.freeze({ workspacePath, workspaceRootPath });
}

export async function destroyAuthenticatedIsolatedRecoveryWorkspace(input) {
  const workspaceRootPath = await canonicalWorkspaceRoot(input?.workspaceRootPath);
  const verificationKeys = readIsolatedRecoveryWorkspaceVerificationKeys(
    input?.workspaceKeyring,
    sha256Text(workspaceRootPath),
  );
  const workspacePath = path.resolve(requiredText(input?.workspacePath, "workspacePath"));
  assertDirectChild(workspaceRootPath, workspacePath);
  const inspection = await inspectWorkspace(workspaceRootPath, workspacePath, verificationKeys);
  if (!inspection.authenticated) {
    throw new Error("El workspace efimero no tiene pertenencia autenticada.");
  }
  const localArtifactCountDestroyed = (await readdir(workspacePath)).length;
  await rm(workspacePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  if (await pathExists(workspacePath)) {
    throw new Error("El workspace efimero sigue presente despues de destruirlo.");
  }
  return Object.freeze({ localArtifactCountDestroyed });
}

export async function sweepIsolatedRecoveryOrphanWorkspaces(input) {
  const workspaceRootPath = await canonicalWorkspaceRoot(input?.workspaceRootPath);
  const workspaceRootSha256 = sha256Text(workspaceRootPath);
  const verificationKeys = readIsolatedRecoveryWorkspaceVerificationKeys(
    input?.workspaceKeyring,
    workspaceRootSha256,
  );
  const activeKeyId = input.workspaceKeyring.activeKeyId;
  const keyUsage = new Map(verificationKeys.map((entry) => [entry.keyId, 0]));
  const sweptAt = new Date().toISOString();
  const sweptAtMs = Date.parse(sweptAt);
  const entries = await readdir(workspaceRootPath, { withFileTypes: true });
  let candidateWorkspaceCount = 0;
  let authenticatedWorkspaceCount = 0;
  let unauthenticatedWorkspaceCount = 0;
  let markerMissingCount = 0;
  let markerInvalidCount = 0;
  let unknownKeyIdWorkspaceCount = 0;
  let legacyWorkspaceCount = 0;
  let unexpiredWorkspaceCount = 0;
  let expiredWorkspaceCount = 0;
  let liveWorkspaceCount = 0;
  let destroyedWorkspaceCount = 0;
  let failedWorkspaceCount = 0;
  let localArtifactCountDestroyed = 0;

  for (const entry of entries) {
    if (!entry.name.startsWith(WORKSPACE_CANDIDATE_PREFIX)) continue;
    candidateWorkspaceCount += 1;
    const workspacePath = path.join(workspaceRootPath, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      unauthenticatedWorkspaceCount += 1;
      continue;
    }
    const inspection = await inspectWorkspace(workspaceRootPath, workspacePath, verificationKeys);
    if (!inspection.authenticated) {
      unauthenticatedWorkspaceCount += 1;
      if (inspection.reason === "unknown_key_id") unknownKeyIdWorkspaceCount += 1;
      continue;
    }
    authenticatedWorkspaceCount += 1;
    keyUsage.set(inspection.marker.keyId, keyUsage.get(inspection.marker.keyId) + 1);
    if (inspection.marker.legacy) legacyWorkspaceCount += 1;
    if (inspection.markerStatus === "missing") markerMissingCount += 1;
    if (inspection.markerStatus === "invalid") markerInvalidCount += 1;
    if (Date.parse(inspection.marker.expiresAt) > sweptAtMs) {
      unexpiredWorkspaceCount += 1;
      continue;
    }
    expiredWorkspaceCount += 1;
    if (processIsAlive(inspection.marker.ownerPid)) {
      liveWorkspaceCount += 1;
      continue;
    }
    try {
      const destroyed = await destroyAuthenticatedIsolatedRecoveryWorkspace({
        workspaceRootPath,
        workspacePath,
        workspaceKeyring: input.workspaceKeyring,
      });
      destroyedWorkspaceCount += 1;
      localArtifactCountDestroyed += destroyed.localArtifactCountDestroyed;
    } catch {
      failedWorkspaceCount += 1;
    }
  }

  return Object.freeze({
    format: ISOLATED_RECOVERY_ORPHAN_REAPER_RECEIPT_FORMAT,
    workspaceRootSha256,
    activeKeyIdSha256: sha256Text(activeKeyId),
    keyUsage: Object.freeze([...keyUsage.entries()]
      .map(([keyId, authenticatedWorkspaceCount]) => Object.freeze({
        keyIdSha256: sha256Text(keyId),
        authenticatedWorkspaceCount,
      }))
      .sort((left, right) => left.keyIdSha256.localeCompare(right.keyIdSha256))),
    candidateWorkspaceCount,
    authenticatedWorkspaceCount,
    unauthenticatedWorkspaceCount,
    markerMissingCount,
    markerInvalidCount,
    unknownKeyIdWorkspaceCount,
    legacyWorkspaceCount,
    unexpiredWorkspaceCount,
    expiredWorkspaceCount,
    liveWorkspaceCount,
    destroyedWorkspaceCount,
    failedWorkspaceCount,
    localArtifactCountDestroyed,
    destructionVerified: failedWorkspaceCount === 0,
    sweptAt,
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

async function inspectWorkspace(workspaceRootPath, workspacePath, verificationKeys) {
  try {
    assertDirectChild(workspaceRootPath, workspacePath);
    const workspaceInfo = await lstat(workspacePath);
    if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
      return { authenticated: false, reason: "workspace_invalid" };
    }
    const canonicalWorkspacePath = await realpath(workspacePath);
    if (!pathsEqual(canonicalWorkspacePath, workspacePath)) {
      return { authenticated: false, reason: "workspace_invalid" };
    }
    const parsedName = parseAuthenticatedWorkspaceName(
      path.basename(workspacePath),
      sha256Text(workspaceRootPath),
      verificationKeys,
    );
    if (!parsedName || parsedName.reason) {
      return { authenticated: false, reason: parsedName?.reason ?? "name_invalid" };
    }
    const markerStatus = await readAndVerifyMarker(
      workspacePath,
      parsedName,
      sha256Text(workspaceRootPath),
    );
    const marker = {
      keyId: parsedName.keyId,
      workspaceId: parsedName.workspaceId,
      createdAt: parsedName.createdAt,
      expiresAt: parsedName.expiresAt,
      ownerPid: parsedName.ownerPid,
      legacy: parsedName.legacy,
    };
    return {
      authenticated: true,
      marker: Object.freeze(marker),
      markerStatus,
    };
  } catch {
    return { authenticated: false, reason: "workspace_invalid" };
  }
}

async function readAndVerifyMarker(workspacePath, parsedName, workspaceRootSha256) {
  const markerPath = path.join(workspacePath, ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE);
  let markerInfo;
  try {
    markerInfo = await lstat(markerPath);
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "invalid";
  }
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > MAX_MARKER_BYTES) {
    return "invalid";
  }
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const expectedKeys = parsedName.legacy ? LEGACY_MARKER_KEYS : MARKER_KEYS;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)
      || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(expectedKeys)) {
      return "invalid";
    }
    const payload = {
      format: marker.format,
      ...(parsedName.legacy ? {} : { keyId: marker.keyId }),
      workspaceName: marker.workspaceName,
      workspaceId: marker.workspaceId,
      workspaceRootSha256: marker.workspaceRootSha256,
      manifestSha256: marker.manifestSha256,
      createdAt: marker.createdAt,
      expiresAt: marker.expiresAt,
      ownerPid: marker.ownerPid,
    };
    if (payload.format !== parsedName.markerFormat
      || (!parsedName.legacy && payload.keyId !== parsedName.keyId)
      || payload.workspaceName !== path.basename(workspacePath)
      || validUuid(payload.workspaceId, "workspaceId") !== parsedName.workspaceId
      || validSha256(payload.workspaceRootSha256, "workspaceRootSha256") !== workspaceRootSha256
      || !SHA256_PATTERN.test(String(payload.manifestSha256 ?? ""))
      || canonicalIso(payload.createdAt, "createdAt") !== parsedName.createdAt
      || canonicalIso(payload.expiresAt, "expiresAt") !== parsedName.expiresAt
      || payload.ownerPid !== parsedName.ownerPid
      || !safeEqualHex(marker.signature, signMarker(payload, parsedName.key))) {
      return "invalid";
    }
    return "valid";
  } catch {
    return "invalid";
  }
}

function authenticatedWorkspaceName(payload, signingKey) {
  const createdMs = Date.parse(payload.createdAt);
  const expiresMs = Date.parse(payload.expiresAt);
  const signature = signName(payload, signingKey);
  return `${WORKSPACE_NAME_PREFIX}${payload.keyId}-${createdMs}-${expiresMs}-${payload.ownerPid}-${payload.workspaceId}-${signature}`;
}

function parseAuthenticatedWorkspaceName(workspaceName, workspaceRootSha256, verificationKeys) {
  const match = WORKSPACE_NAME_PATTERN.exec(workspaceName);
  if (match) {
    const [, keyId, createdMsText, expiresMsText, ownerPidText, workspaceId, signature] = match;
    const verificationKey = verificationKeys.find((entry) => entry.keyId === keyId);
    if (!verificationKey) return { reason: "unknown_key_id" };
    return parsedSignedName({
      keyId,
      createdMsText,
      expiresMsText,
      ownerPidText,
      workspaceId,
      signature,
      workspaceRootSha256,
      markerFormat: ISOLATED_RECOVERY_WORKSPACE_MARKER_FORMAT,
      key: verificationKey.key,
      legacy: false,
    });
  }
  const legacyMatch = LEGACY_WORKSPACE_NAME_PATTERN.exec(workspaceName);
  if (!legacyMatch) return null;
  const [, createdMsText, expiresMsText, ownerPidText, workspaceId, signature] = legacyMatch;
  for (const verificationKey of verificationKeys) {
    const parsed = parsedSignedName({
      keyId: verificationKey.keyId,
      createdMsText,
      expiresMsText,
      ownerPidText,
      workspaceId,
      signature,
      workspaceRootSha256,
      markerFormat: LEGACY_WORKSPACE_MARKER_FORMAT,
      key: verificationKey.key,
      legacy: true,
    });
    if (parsed) return parsed;
  }
  return null;
}

function parsedSignedName(input) {
  const {
    keyId,
    createdMsText,
    expiresMsText,
    ownerPidText,
    workspaceId,
    signature,
    workspaceRootSha256,
    markerFormat,
    key,
    legacy,
  } = input;
  const createdAt = new Date(Number(createdMsText)).toISOString();
  const expiresAt = new Date(Number(expiresMsText)).toISOString();
  const ownerPid = Number(ownerPidText);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)
    || !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > 2_147_483_647) {
    return null;
  }
  const expected = signName({
    format: markerFormat,
    ...(legacy ? {} : { keyId }),
    workspaceId,
    workspaceRootSha256,
    createdAt,
    expiresAt,
    ownerPid,
  }, key);
  if (!safeEqualHex(signature, expected)) return null;
  return {
    keyId,
    workspaceId,
    createdAt,
    expiresAt,
    ownerPid,
    markerFormat,
    key,
    legacy,
  };
}

function signName(payload, signingKey) {
  return hmacHex(signingKey, JSON.stringify({
    format: payload.format ?? ISOLATED_RECOVERY_WORKSPACE_MARKER_FORMAT,
    ...(payload.keyId === undefined ? {} : { keyId: payload.keyId }),
    workspaceId: payload.workspaceId,
    workspaceRootSha256: payload.workspaceRootSha256,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    ownerPid: payload.ownerPid,
  }));
}

function signMarker(payload, signingKey) {
  return hmacHex(signingKey, JSON.stringify({
    format: payload.format,
    ...(payload.keyId === undefined ? {} : { keyId: payload.keyId }),
    workspaceName: payload.workspaceName,
    workspaceId: payload.workspaceId,
    workspaceRootSha256: payload.workspaceRootSha256,
    manifestSha256: payload.manifestSha256,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    ownerPid: payload.ownerPid,
  }));
}

function hmacHex(signingKey, value) {
  return createHmac("sha256", signingKey).update(value).digest("hex");
}

function safeEqualHex(actual, expected) {
  const text = String(actual ?? "");
  if (!SHA256_PATTERN.test(text) || !SHA256_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(text, "hex"), Buffer.from(expected, "hex"));
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

function assertDirectChild(workspaceRootPath, workspacePath) {
  if (!pathsEqual(path.dirname(workspacePath), workspaceRootPath)
    || !path.basename(workspacePath).startsWith(WORKSPACE_CANDIDATE_PREFIX)) {
    throw new Error("El workspace no es hijo directo de la raiz efimera.");
  }
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function pathsEqual(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validUuid(value, name) {
  const text = String(value ?? "");
  if (!UUID_V4_PATTERN.test(text)) throw new Error(`${name} debe ser UUID v4.`);
  return text;
}

function validSha256(value, name) {
  const text = String(value ?? "");
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser SHA-256 hexadecimal.`);
  return text;
}

function canonicalIso(value, name) {
  const text = requiredText(value, name);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${name} debe ser una fecha ISO canonica.`);
  }
  return text;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
