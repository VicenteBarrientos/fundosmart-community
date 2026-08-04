const CONTRACT_VERSION = "fundosmart.staff-authorization.v1";

export const STAFF_AUTHORIZATION_CONTRACT_VERSION = CONTRACT_VERSION;

/**
 * Catálogo cerrado de capacidades. El orden y los valores son el mismo contrato
 * que la restricción `platform_staff_capability_grants_capability_check`.
 */
export const STAFF_CAPABILITIES = Object.freeze([
  "support:read",
  "tenants:manage",
  "flags:manage",
  "audit:read",
  "operations:sensitive",
  "staff:manage",
]);

/**
 * Capacidades que exigen elevación vigente además del grant activo.
 */
export const ELEVATION_REQUIRED_CAPABILITIES = Object.freeze([
  "operations:sensitive",
  "staff:manage",
]);

/**
 * Techo de vida de una elevación, idéntico al CHECK de
 * `platform_staff_elevations_lifetime_check`.
 */
export const MAXIMUM_ELEVATION_LIFETIME_SECONDS = 900;

/**
 * Plantillas de alta. No son herencia: cada capacidad se concede explícitamente
 * como un grant propio, y `kind = owner` no implica ninguna capacidad oculta.
 */
export const STAFF_CAPABILITY_PROFILES = Object.freeze({
  "owner-initial": Object.freeze([...STAFF_CAPABILITIES]),
  "platform-operator": Object.freeze([
    "support:read",
    "tenants:manage",
    "flags:manage",
    "audit:read",
  ]),
  support: Object.freeze(["support:read"]),
});

/**
 * Códigos públicos. Una denegación nunca revela SQL, tablas, bindings ni el
 * motivo interno exacto; el motivo detallado queda del lado del servidor.
 */
export const STAFF_PUBLIC_ACCESS_CODES = Object.freeze([
  "STAFF_REQUIRED",
  "STAFF_ELEVATION_REQUIRED",
  "STAFF_ACCESS_CHANGED",
]);

const CAPABILITY_SET = new Set(STAFF_CAPABILITIES);
const ELEVATION_REQUIRED_SET = new Set(ELEVATION_REQUIRED_CAPABILITIES);
const PROFILE_KEYS = Object.freeze(Object.keys(STAFF_CAPABILITY_PROFILES));

const DECISION_FIELDS = Object.freeze([
  "capability",
  "principal",
  "grants",
  "elevation",
  "authSessionTokenHash",
  "now",
]);
const PRINCIPAL_FIELDS = Object.freeze([
  "id",
  "authIdentityId",
  "status",
  "kind",
  "version",
]);
const GRANT_FIELDS = Object.freeze([
  "id",
  "principalId",
  "capability",
  "status",
  "version",
]);
const ELEVATION_FIELDS = Object.freeze([
  "principalId",
  "authSessionTokenHash",
  "createdAt",
  "expiresAt",
  "revokedAt",
]);
const SNAPSHOT_FIELDS = Object.freeze([
  "capability",
  "principalId",
  "principalVersion",
  "principalStatus",
  "grantId",
  "grantVersion",
]);

/**
 * Motivos que no nacen de la decisión pura sino de la capa de persistencia.
 * Se declaran aquí para que exista un solo vocabulario de denegación.
 */
export const STAFF_INFRASTRUCTURE_REASON_CODES = Object.freeze([
  "BACKEND_UNAVAILABLE",
  "ROW_SHAPE_INVALID",
  "STAFF_ACCESS_CHANGED",
]);

const INFRASTRUCTURE_REASON_SET = new Set(STAFF_INFRASTRUCTURE_REASON_CODES);

const ELEVATION_REASON_CODES = new Set([
  "ELEVATION_MISSING",
  "ELEVATION_REVOKED",
  "ELEVATION_EXPIRED",
  "ELEVATION_NOT_YET_VALID",
  "ELEVATION_LIFETIME_INVALID",
  "ELEVATION_SESSION_MISMATCH",
  "ELEVATION_PRINCIPAL_MISMATCH",
]);

export function isStaffCapability(value) {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}

export function requiresElevation(capability) {
  return typeof capability === "string" && ELEVATION_REQUIRED_SET.has(capability);
}

export function capabilitiesForProfile(profileKey) {
  if (typeof profileKey !== "string") return null;
  if (!Object.hasOwn(STAFF_CAPABILITY_PROFILES, profileKey)) return null;
  return STAFF_CAPABILITY_PROFILES[profileKey];
}

export function staffCapabilityProfileKeys() {
  return PROFILE_KEYS;
}

/**
 * Decide una autorización de staff a partir de datos ya leídos de D1. La
 * función es pura: no consulta, no lanza y siempre devuelve una decisión
 * congelada. Cualquier forma inesperada deniega.
 */
export function decideStaffAuthorization(input) {
  let candidate;
  try {
    candidate = readClosedRecord(input, DECISION_FIELDS);
  } catch {
    return denial("INPUT_SHAPE_INVALID", null);
  }

  const capability = candidate.capability;
  if (!isStaffCapability(capability)) return denial("CAPABILITY_INVALID", null);
  if (!isEpochSeconds(candidate.now)) return denial("INPUT_SHAPE_INVALID", capability);
  if (!isTokenHash(candidate.authSessionTokenHash)) {
    return denial("INPUT_SHAPE_INVALID", capability);
  }

  if (candidate.principal === null) return denial("PRINCIPAL_MISSING", capability);
  const principal = readPrincipal(candidate.principal);
  if (!principal) return denial("PRINCIPAL_INVALID", capability);
  if (principal.status !== "active") return denial("PRINCIPAL_SUSPENDED", capability);

  const grants = readGrants(candidate.grants);
  if (!grants) return denial("GRANT_INVALID", capability);
  if (grants.some((grant) => grant.principalId !== principal.id)) {
    return denial("GRANT_PRINCIPAL_MISMATCH", capability);
  }

  const matching = grants.filter(
    (grant) => grant.capability === capability && grant.status === "active",
  );
  if (matching.length === 0) return denial("GRANT_MISSING", capability);
  if (matching.length > 1) return denial("GRANT_AMBIGUOUS", capability);
  const grant = matching[0];

  const elevationRequired = ELEVATION_REQUIRED_SET.has(capability);
  const elevation = evaluateElevation(
    candidate.elevation,
    principal.id,
    candidate.authSessionTokenHash,
    candidate.now,
  );
  if (elevation.reasonCode === "INPUT_SHAPE_INVALID") {
    return denial("INPUT_SHAPE_INVALID", capability);
  }
  if (elevationRequired && !elevation.confirmed) {
    return denial(elevation.reasonCode, capability, {
      principal,
      grant,
      elevationRequired: true,
    });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    allowed: true,
    capability,
    reasonCode: null,
    publicCode: null,
    principalId: principal.id,
    principalKind: principal.kind,
    principalVersion: principal.version,
    grantId: grant.id,
    grantVersion: grant.version,
    elevationRequired,
    elevationConfirmed: elevation.confirmed,
    snapshot: Object.freeze({
      capability,
      principalId: principal.id,
      principalVersion: principal.version,
      principalStatus: principal.status,
      grantId: grant.id,
      grantVersion: grant.version,
    }),
  });
}

/**
 * Barrera de respuesta: compara el snapshot tomado antes de cargar datos con el
 * releído justo antes de serializar. Cualquier diferencia o forma inválida
 * devuelve `false`; el llamador responde `STAFF_ACCESS_CHANGED` sin payload.
 */
export function matchesAuthorizationSnapshot(before, after) {
  let first;
  let second;
  try {
    first = readClosedRecord(before, SNAPSHOT_FIELDS);
    second = readClosedRecord(after, SNAPSHOT_FIELDS);
  } catch {
    return false;
  }

  if (!isStaffCapability(first.capability)) return false;
  if (first.principalStatus !== "active" || second.principalStatus !== "active") {
    return false;
  }
  if (!isIdentifier(first.principalId) || !isIdentifier(first.grantId)) return false;
  if (!isPositiveInteger(first.principalVersion) || !isPositiveInteger(first.grantVersion)) {
    return false;
  }

  return SNAPSHOT_FIELDS.every((field) => first[field] === second[field]);
}

/**
 * Construye una denegación con la misma forma congelada que
 * `decideStaffAuthorization`, para que la capa de persistencia no invente su
 * propio contrato cuando D1 falla o devuelve filas inesperadas.
 */
export function denyStaffAuthorization(reasonCode, capability) {
  const code = INFRASTRUCTURE_REASON_SET.has(reasonCode)
    ? reasonCode
    : "BACKEND_UNAVAILABLE";
  return denial(code, isStaffCapability(capability) ? capability : null);
}

/**
 * Traduce el motivo interno a uno de los tres códigos publicables.
 */
export function publicStaffAccessCode(reasonCode) {
  if (typeof reasonCode !== "string" || reasonCode.length === 0) {
    return "STAFF_REQUIRED";
  }
  if (reasonCode === "STAFF_ACCESS_CHANGED") return "STAFF_ACCESS_CHANGED";
  if (ELEVATION_REASON_CODES.has(reasonCode)) return "STAFF_ELEVATION_REQUIRED";
  return "STAFF_REQUIRED";
}

function evaluateElevation(value, principalId, authSessionTokenHash, now) {
  if (value === null) return { confirmed: false, reasonCode: "ELEVATION_MISSING" };

  let elevation;
  try {
    elevation = readClosedRecord(value, ELEVATION_FIELDS);
  } catch {
    return { confirmed: false, reasonCode: "INPUT_SHAPE_INVALID" };
  }

  if (!isIdentifier(elevation.principalId)) {
    return { confirmed: false, reasonCode: "INPUT_SHAPE_INVALID" };
  }
  if (!isTokenHash(elevation.authSessionTokenHash)) {
    return { confirmed: false, reasonCode: "INPUT_SHAPE_INVALID" };
  }
  if (!isEpochSeconds(elevation.createdAt) || !isEpochSeconds(elevation.expiresAt)) {
    return { confirmed: false, reasonCode: "INPUT_SHAPE_INVALID" };
  }
  if (elevation.revokedAt !== null && !isEpochSeconds(elevation.revokedAt)) {
    return { confirmed: false, reasonCode: "INPUT_SHAPE_INVALID" };
  }

  if (elevation.principalId !== principalId) {
    return { confirmed: false, reasonCode: "ELEVATION_PRINCIPAL_MISMATCH" };
  }
  if (elevation.authSessionTokenHash !== authSessionTokenHash) {
    return { confirmed: false, reasonCode: "ELEVATION_SESSION_MISMATCH" };
  }
  if (
    elevation.expiresAt <= elevation.createdAt
    || elevation.expiresAt - elevation.createdAt > MAXIMUM_ELEVATION_LIFETIME_SECONDS
  ) {
    return { confirmed: false, reasonCode: "ELEVATION_LIFETIME_INVALID" };
  }
  if (elevation.revokedAt !== null) {
    return { confirmed: false, reasonCode: "ELEVATION_REVOKED" };
  }
  if (now < elevation.createdAt) {
    return { confirmed: false, reasonCode: "ELEVATION_NOT_YET_VALID" };
  }
  if (now >= elevation.expiresAt) {
    return { confirmed: false, reasonCode: "ELEVATION_EXPIRED" };
  }

  return { confirmed: true, reasonCode: null };
}

function denial(reasonCode, capability, context) {
  const principal = context?.principal ?? null;
  const grant = context?.grant ?? null;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    allowed: false,
    capability: capability ?? null,
    reasonCode,
    publicCode: publicStaffAccessCode(reasonCode),
    principalId: principal?.id ?? null,
    principalKind: principal?.kind ?? null,
    principalVersion: principal?.version ?? null,
    grantId: grant?.id ?? null,
    grantVersion: grant?.version ?? null,
    elevationRequired: context?.elevationRequired ?? false,
    elevationConfirmed: false,
    snapshot: null,
  });
}

function readPrincipal(value) {
  let principal;
  try {
    principal = readClosedRecord(value, PRINCIPAL_FIELDS);
  } catch {
    return null;
  }

  if (!isIdentifier(principal.id)) return null;
  if (!isIdentifier(principal.authIdentityId)) return null;
  if (principal.status !== "active" && principal.status !== "suspended") return null;
  if (principal.kind !== "owner" && principal.kind !== "staff") return null;
  if (!isPositiveInteger(principal.version)) return null;
  return principal;
}

function readGrants(value) {
  if (!Array.isArray(value)) return null;

  const grants = [];
  for (const entry of value) {
    let grant;
    try {
      grant = readClosedRecord(entry, GRANT_FIELDS);
    } catch {
      return null;
    }
    if (!isIdentifier(grant.id)) return null;
    if (!isIdentifier(grant.principalId)) return null;
    if (!isStaffCapability(grant.capability)) return null;
    if (grant.status !== "active" && grant.status !== "revoked") return null;
    if (!isPositiveInteger(grant.version)) return null;
    grants.push(grant);
  }

  const identifiers = new Set(grants.map((grant) => grant.id));
  if (identifiers.size !== grants.length) return null;
  return grants;
}

function isIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && value.trim() === value;
}

function isTokenHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isEpochSeconds(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function readClosedRecord(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid_record");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("invalid_record");
  }

  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError("invalid_record");
  }

  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw new TypeError("invalid_record");
    }
    result[field] = descriptor.value;
  }
  return result;
}
