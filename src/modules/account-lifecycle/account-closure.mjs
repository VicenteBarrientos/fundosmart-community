export const ACCOUNT_CLOSURE_SCOPES = Object.freeze(["account", "organization"]);
export const ACCOUNT_CLOSURE_PERSISTED_STATUSES = Object.freeze(["grace", "revoked"]);
export const ACCOUNT_CLOSURE_GRACE_DAYS = 30;
export const ACCOUNT_CLOSURE_SNAPSHOT_VERSION = 1;

const GRACE_MILLISECONDS = ACCOUNT_CLOSURE_GRACE_DAYS * 24 * 60 * 60 * 1_000;
const REQUEST_INPUT_KEYS = Object.freeze([
  "actorIdentityId",
  "idFactory",
  "now",
  "requestId",
  "scope",
  "snapshot",
  "targetId",
]);
const REVOCATION_INPUT_KEYS = Object.freeze([
  "actorIdentityId",
  "current",
  "idFactory",
  "now",
  "requestId",
]);
const MAX_SNAPSHOT_BYTES = 1_000_000;

export class AccountClosureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AccountClosureError";
    this.code = code;
  }
}

export function createAccountClosureRequestPlan(input) {
  assertPlainRecord(input, "INVALID_CLOSURE_INPUT", "La solicitud de cierre no es válida.");
  assertExactKeys(input, REQUEST_INPUT_KEYS, "INVALID_CLOSURE_INPUT", "entrada");
  const scope = requiredScope(input.scope);
  const targetId = requiredToken(input.targetId, "INVALID_TARGET", 320);
  const actorIdentityId = requiredToken(input.actorIdentityId, "INVALID_ACTOR", 320);
  if (scope === "account" && targetId !== actorIdentityId) {
    fail("ACCOUNT_TARGET_MISMATCH", "Una cuenta solo puede solicitar su propio cierre.");
  }
  const requestId = requiredToken(input.requestId, "INVALID_REQUEST_ID", 160);
  const requestedAt = exactIsoTimestamp(input.now);
  const graceEndsAt = new Date(
    new Date(requestedAt).getTime() + GRACE_MILLISECONDS,
  ).toISOString();
  const snapshot = immutableSnapshot(input.snapshot);
  const snapshotJson = canonicalAccountClosureSnapshotJson(snapshot);
  if (new TextEncoder().encode(snapshotJson).byteLength > MAX_SNAPSHOT_BYTES) {
    fail("SNAPSHOT_TOO_LARGE", "La instantánea de cierre excede el límite permitido.");
  }
  assertIdFactory(input.idFactory);

  const closureRequest = deepFreeze({
    id: generatedId(input.idFactory, "closure"),
    scope,
    targetId,
    actorIdentityId,
    requestId,
    status: "grace",
    requestedAt,
    graceEndsAt,
    revokedAt: null,
    version: 1,
    snapshotVersion: ACCOUNT_CLOSURE_SNAPSHOT_VERSION,
    snapshot,
  });
  const event = deepFreeze({
    id: generatedId(input.idFactory, "event"),
    closureRequestId: closureRequest.id,
    actorIdentityId,
    requestId,
    action: "account.closure.requested",
    occurredAt: requestedAt,
    payload: {
      scope,
      targetId,
      graceEndsAt,
      snapshotVersion: ACCOUNT_CLOSURE_SNAPSHOT_VERSION,
    },
  });
  return deepFreeze({ closureRequest, event });
}

export function evaluateAccountClosure(current, now) {
  const record = normalizedClosureRecord(current);
  const evaluatedAt = exactIsoTimestamp(now);
  if (record.status === "revoked") {
    return deepFreeze({
      state: "revoked",
      accessSuspended: false,
      revocable: false,
      evaluatedAt,
    });
  }
  const withinGrace = evaluatedAt <= record.graceEndsAt;
  return deepFreeze({
    state: withinGrace ? "grace" : "expired",
    accessSuspended: true,
    revocable: withinGrace,
    evaluatedAt,
  });
}

export function createAccountClosureRevocationPlan(input) {
  assertPlainRecord(input, "INVALID_REVOCATION_INPUT", "La revocación no es válida.");
  assertExactKeys(input, REVOCATION_INPUT_KEYS, "INVALID_REVOCATION_INPUT", "entrada");
  const current = normalizedClosureRecord(input.current);
  const actorIdentityId = requiredToken(input.actorIdentityId, "INVALID_ACTOR", 320);
  const requestId = requiredToken(input.requestId, "INVALID_REQUEST_ID", 160);
  const revokedAt = exactIsoTimestamp(input.now);
  const disposition = evaluateAccountClosure(current, revokedAt);
  if (!disposition.revocable) {
    fail(
      disposition.state === "expired" ? "GRACE_WINDOW_EXPIRED" : "CLOSURE_ALREADY_REVOKED",
      "La solicitud de cierre ya no puede revocarse.",
    );
  }
  assertIdFactory(input.idFactory);
  const revocation = deepFreeze({
    closureRequestId: current.id,
    actorIdentityId,
    requestId,
    expectedVersion: current.version,
    nextVersion: current.version + 1,
    revokedAt,
    preservedSnapshot: current.snapshot,
  });
  const event = deepFreeze({
    id: generatedId(input.idFactory, "event"),
    closureRequestId: current.id,
    actorIdentityId,
    requestId,
    action: "account.closure.revoked",
    occurredAt: revokedAt,
    payload: {
      scope: current.scope,
      targetId: current.targetId,
      restoredSnapshotVersion: current.snapshotVersion,
    },
  });
  return deepFreeze({ revocation, event });
}

export function canonicalAccountClosureSnapshotJson(value) {
  return JSON.stringify(portableClone(value, "snapshot"));
}

function normalizedClosureRecord(value) {
  assertPlainRecord(value, "INVALID_CLOSURE_RECORD", "El registro de cierre no es válido.");
  const status = value.status;
  if (!ACCOUNT_CLOSURE_PERSISTED_STATUSES.includes(status)) {
    fail("INVALID_CLOSURE_STATUS", "El estado de cierre no es válido.");
  }
  const requestedAt = exactIsoTimestamp(value.requestedAt);
  const graceEndsAt = exactIsoTimestamp(value.graceEndsAt);
  if (graceEndsAt <= requestedAt) {
    fail("INVALID_GRACE_WINDOW", "La ventana de gracia no es válida.");
  }
  const revokedAt = value.revokedAt === null ? null : exactIsoTimestamp(value.revokedAt);
  if (status === "grace" && revokedAt !== null) {
    fail("INVALID_CLOSURE_RECORD", "Un cierre en gracia no puede estar revocado.");
  }
  if (status === "revoked" && (revokedAt === null || revokedAt < requestedAt)) {
    fail("INVALID_CLOSURE_RECORD", "La fecha de revocación no es válida.");
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    fail("INVALID_CLOSURE_VERSION", "La versión del cierre no es válida.");
  }
  if (value.snapshotVersion !== ACCOUNT_CLOSURE_SNAPSHOT_VERSION) {
    fail("UNSUPPORTED_SNAPSHOT", "La versión de la instantánea no está soportada.");
  }
  return deepFreeze({
    id: requiredToken(value.id, "INVALID_CLOSURE_ID", 200),
    scope: requiredScope(value.scope),
    targetId: requiredToken(value.targetId, "INVALID_TARGET", 320),
    status,
    requestedAt,
    graceEndsAt,
    revokedAt,
    version: value.version,
    snapshotVersion: value.snapshotVersion,
    snapshot: immutableSnapshot(value.snapshot),
  });
}

function immutableSnapshot(value) {
  assertPlainRecord(value, "INVALID_SNAPSHOT", "La instantánea de cierre no es válida.");
  assertExactKeys(value, ["memberships"], "INVALID_SNAPSHOT", "snapshot");
  if (!Array.isArray(value.memberships)) {
    fail("INVALID_SNAPSHOT", "La instantánea debe contener membresías.");
  }
  const membershipIds = new Set();
  const memberships = value.memberships.map((entry, index) => {
    assertPlainRecord(
      entry,
      "INVALID_SNAPSHOT",
      `snapshot.memberships[${index}] no es válido.`,
    );
    assertExactKeys(
      entry,
      ["fieldIds", "id", "organizationId", "role", "status"],
      "INVALID_SNAPSHOT",
      `snapshot.memberships[${index}]`,
    );
    const id = requiredToken(entry.id, "INVALID_SNAPSHOT", 200);
    if (membershipIds.has(id)) {
      fail("INVALID_SNAPSHOT", "La instantánea repite una membresía.");
    }
    membershipIds.add(id);
    const organizationId = requiredToken(
      entry.organizationId,
      "INVALID_SNAPSHOT",
      200,
    );
    if (!["owner", "admin", "manager", "operator", "viewer"].includes(entry.role)) {
      fail("INVALID_SNAPSHOT", "La instantánea contiene un rol inválido.");
    }
    if (!["active", "suspended"].includes(entry.status)) {
      fail("INVALID_SNAPSHOT", "La instantánea contiene un estado inválido.");
    }
    if (!Array.isArray(entry.fieldIds)) {
      fail("INVALID_SNAPSHOT", "La instantánea contiene un alcance inválido.");
    }
    const fieldIds = entry.fieldIds.map((fieldId) =>
      requiredToken(fieldId, "INVALID_SNAPSHOT", 200));
    if (new Set(fieldIds).size !== fieldIds.length) {
      fail("INVALID_SNAPSHOT", "La instantánea repite un fundo.");
    }
    return {
      id,
      organizationId,
      role: entry.role,
      status: entry.status,
      fieldIds: fieldIds.sort(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze({ memberships });
}

function requiredScope(value) {
  if (!ACCOUNT_CLOSURE_SCOPES.includes(value)) {
    fail("INVALID_CLOSURE_SCOPE", "El alcance de cierre no es válido.");
  }
  return value;
}

function exactIsoTimestamp(value) {
  if (typeof value !== "string") fail("INVALID_TIMESTAMP", "La fecha debe usar formato ISO.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("INVALID_TIMESTAMP", "La fecha debe usar formato ISO exacto.");
  }
  return value;
}

function requiredToken(value, code, maxLength) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
  ) {
    fail(code, "El identificador no es válido.");
  }
  return value;
}

function assertIdFactory(value) {
  if (typeof value !== "function") {
    fail("INVALID_ID_FACTORY", "La fábrica de identificadores no es válida.");
  }
}

function generatedId(factory, label) {
  return requiredToken(factory(label), "INVALID_GENERATED_ID", 200);
}

function portableClone(value, path, ancestors = []) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_SNAPSHOT", `${path} contiene un número no finito.`);
    return value;
  }
  if (typeof value !== "object" || ancestors.includes(value)) {
    fail("INVALID_SNAPSHOT", `${path} no es JSON portable.`);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      portableClone(entry, `${path}[${index}]`, [...ancestors, value]));
  }
  assertPlainRecord(value, "INVALID_SNAPSHOT", `${path} no es un objeto simple.`);
  const clone = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key.toLowerCase())) {
      fail("INVALID_SNAPSHOT", `${path}.${key} no es una clave segura.`);
    }
    clone[key] = portableClone(value[key], `${path}.${key}`, [...ancestors, value]);
  }
  return clone;
}

function assertExactKeys(value, expected, code, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${label} no coincide con el contrato esperado.`);
  }
}

function assertPlainRecord(value, code, message) {
  if (!isPlainRecord(value)) fail(code, message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code, message) {
  throw new AccountClosureError(code, message);
}
