import {
  PORTABLE_WORKSPACE_V2_CONTRACT_VERSION,
  PORTABLE_WORKSPACE_V2_D1_POLICY,
  PORTABLE_WORKSPACE_V2_FORMAT,
  PORTABLE_WORKSPACE_V2_POLICY,
  PORTABLE_WORKSPACE_V2_POLICY_VERSION,
  PORTABLE_WORKSPACE_V2_R2_POLICY,
  PORTABLE_WORKSPACE_V2_ROWS_ENABLED,
  PORTABLE_WORKSPACE_V2_SCHEMA_VERSION,
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
} from "./workspace-portable-v2-policy.mjs";
import {
  PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS,
  PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTION,
  clonePortableWorkspaceJson,
  emptyPortableWorkspaceV2Sections as emptyPortableRows,
  normalizePortableWorkspaceV2Sections,
} from "./workspace-portable-v2-rows.mjs";

export {
  PORTABLE_WORKSPACE_V2_CONTRACT_VERSION,
  PORTABLE_WORKSPACE_V2_D1_POLICY,
  PORTABLE_WORKSPACE_V2_FORMAT,
  PORTABLE_WORKSPACE_V2_POLICY,
  PORTABLE_WORKSPACE_V2_POLICY_VERSION,
  PORTABLE_WORKSPACE_V2_R2_POLICY,
  PORTABLE_WORKSPACE_V2_ROWS_ENABLED,
  PORTABLE_WORKSPACE_V2_SCHEMA_VERSION,
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
  PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS,
  PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTION,
};

export const PORTABLE_WORKSPACE_V2_INTEGRITY = deepFreeze({
  algorithm: "SHA-256",
  authenticated: false,
  workspaceHashScope: "canonical-manifest-without-workspaceSha256-and-data",
});

const PORTABLE_WORKSPACE_KEYS = Object.freeze(["data", "manifest"]);
const MANIFEST_KEYS = Object.freeze([
  "contractVersion",
  "encoding",
  "format",
  "generatedAt",
  "generatedBy",
  "integrity",
  "policy",
  "recordCounts",
  "rowProjection",
  "schemaVersion",
  "scope",
  "sectionOrder",
  "sectionSha256",
  "totalRecordCount",
  "workspaceSha256",
]);
const SCOPE_KEYS = Object.freeze([
  "fieldIds",
  "organizationId",
  "organizationName",
  "type",
]);
const CREATE_INPUT_KEYS = Object.freeze([
  "fieldIds",
  "generatedAt",
  "generatedBy",
  "organization",
  "sections",
]);
const ORGANIZATION_KEYS = Object.freeze(["id", "name"]);
const POLICY_KEYS = Object.freeze(["d1", "r2", "version"]);
const POLICY_GROUP_KEYS = Object.freeze([
  "aggregateOnly",
  "excludedControl",
  "pendingProjection",
  "projectionRequired",
  "reconstructible",
  "subjectDownload",
]);
const ROW_PROJECTION_KEYS = Object.freeze([
  "catalogVersion",
  "columnDecisions",
  "enabled",
  "policyFingerprint",
  "requirement",
  "rowExclusions",
]);
const INTEGRITY_KEYS = Object.freeze([
  "algorithm",
  "authenticated",
  "workspaceHashScope",
]);
const GENERATED_BY_PATTERN = /^identity-sha256:[a-f0-9]{64}$/u;

export class PortableWorkspaceV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PortableWorkspaceV2Error";
    this.code = code;
  }
}

export function emptyPortableWorkspaceV2Sections() {
  return emptyPortableRows();
}

export async function createPortableWorkspaceV2(input) {
  const safeInput = cloneWorkspaceValue(input, "input");
  assertPlainRecord(safeInput, "INVALID_INPUT", "La entrada debe ser un objeto.");
  assertExactKeys(safeInput, CREATE_INPUT_KEYS, "INVALID_INPUT", "entrada");
  assertPlainRecord(
    safeInput.organization,
    "INVALID_SCOPE",
    "La organización debe ser un objeto.",
  );
  assertExactKeys(
    safeInput.organization,
    ORGANIZATION_KEYS,
    "INVALID_SCOPE",
    "organización",
  );

  const organizationId = requiredString(
    safeInput.organization.id,
    "INVALID_SCOPE",
    "organization.id",
    200,
  );
  const organizationName = requiredString(
    safeInput.organization.name,
    "INVALID_SCOPE",
    "organization.name",
    300,
  );
  const generatedAt = exactIsoTimestamp(safeInput.generatedAt);
  const generatedBy = pseudonymousGeneratedBy(
    safeInput.generatedBy,
  );
  const fieldIds = uniqueSortedStrings(
    safeInput.fieldIds,
    "INVALID_SCOPE",
    "fieldIds",
    200,
  );
  const data = normalizeSections(
    safeInput.sections,
    { organizationId, fieldIds },
    { requireScopeSentinels: true },
  );
  assertCanonicalByteLimit(data);
  const evidence = await sectionEvidence(data);
  const manifestWithoutWorkspaceHash = buildManifest({
    evidence,
    fieldIds,
    generatedAt,
    generatedBy,
    organizationId,
    organizationName,
  });
  const workspaceSha256 = await portableWorkspaceSha256({
    manifest: manifestWithoutWorkspaceHash,
    data,
  });
  const portable = deepFreeze({
    manifest: {
      ...manifestWithoutWorkspaceHash,
      workspaceSha256,
    },
    data,
  });
  assertCanonicalByteLimit(portable);
  return portable;
}

export async function validatePortableWorkspaceV2(value) {
  const safeValue = cloneWorkspaceValue(value, "portable");
  assertPlainRecord(safeValue, "INVALID_ENVELOPE", "El portable debe ser un objeto.");
  assertExactKeys(
    safeValue,
    PORTABLE_WORKSPACE_KEYS,
    "INVALID_ENVELOPE",
    "portable",
  );
  assertPlainRecord(
    safeValue.manifest,
    "INVALID_MANIFEST",
    "El manifiesto debe ser un objeto.",
  );
  assertExactKeys(
    safeValue.manifest,
    MANIFEST_KEYS,
    "INVALID_MANIFEST",
    "manifest",
  );
  assertPlainRecord(
    safeValue.manifest.scope,
    "INVALID_SCOPE",
    "El alcance debe ser un objeto.",
  );
  assertExactKeys(
    safeValue.manifest.scope,
    SCOPE_KEYS,
    "INVALID_SCOPE",
    "manifest.scope",
  );

  if (safeValue.manifest.format !== PORTABLE_WORKSPACE_V2_FORMAT) {
    fail("UNSUPPORTED_FORMAT", "El formato portable no corresponde a workspace v2.");
  }
  if (
    safeValue.manifest.contractVersion
    !== PORTABLE_WORKSPACE_V2_CONTRACT_VERSION
  ) {
    fail("UNSUPPORTED_CONTRACT", "La versión del contrato portable no está soportada.");
  }
  if (safeValue.manifest.schemaVersion !== PORTABLE_WORKSPACE_V2_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA", "La versión del inventario portable no está soportada.");
  }
  if (safeValue.manifest.encoding !== "UTF-8 canonical JSON") {
    fail("INVALID_MANIFEST", "La codificación declarada no es válida.");
  }
  if (safeValue.manifest.scope.type !== "organization") {
    fail("INVALID_SCOPE", "El portable debe tener alcance de organización.");
  }

  const organizationId = requiredString(
    safeValue.manifest.scope.organizationId,
    "INVALID_SCOPE",
    "manifest.scope.organizationId",
    200,
  );
  const organizationName = requiredString(
    safeValue.manifest.scope.organizationName,
    "INVALID_SCOPE",
    "manifest.scope.organizationName",
    300,
  );
  const fieldIds = uniqueSortedStrings(
    safeValue.manifest.scope.fieldIds,
    "INVALID_SCOPE",
    "manifest.scope.fieldIds",
    200,
  );
  if (!sameStringArray(fieldIds, safeValue.manifest.scope.fieldIds)) {
    fail("NON_CANONICAL_SCOPE", "Los fundos del alcance deben estar ordenados.");
  }
  const generatedAt = exactIsoTimestamp(safeValue.manifest.generatedAt);
  const generatedBy = pseudonymousGeneratedBy(
    safeValue.manifest.generatedBy,
  );

  validatePolicy(safeValue.manifest.policy);
  validateRowProjection(safeValue.manifest.rowProjection);
  validateIntegrity(safeValue.manifest.integrity);
  if (
    !sameStringArray(
      safeValue.manifest.sectionOrder,
      PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
    )
  ) {
    fail("INVALID_MANIFEST", "El orden de secciones no coincide con el contrato.");
  }

  const data = normalizeSections(
    safeValue.data,
    { organizationId, fieldIds },
  );
  assertCanonicalByteLimit(data);
  const evidence = await sectionEvidence(data);
  validateEvidence(safeValue.manifest, evidence);
  const manifestWithoutWorkspaceHash = buildManifest({
    evidence,
    fieldIds,
    generatedAt,
    generatedBy,
    organizationId,
    organizationName,
  });
  const expectedWorkspaceSha256 = await portableWorkspaceSha256({
    manifest: manifestWithoutWorkspaceHash,
    data,
  });
  if (
    typeof safeValue.manifest.workspaceSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(safeValue.manifest.workspaceSha256)
    || safeValue.manifest.workspaceSha256 !== expectedWorkspaceSha256
  ) {
    fail("WORKSPACE_HASH_MISMATCH", "La huella integral del workspace no coincide.");
  }

  const portable = deepFreeze({
    manifest: {
      ...manifestWithoutWorkspaceHash,
      workspaceSha256: expectedWorkspaceSha256,
    },
    data,
  });
  assertCanonicalByteLimit(portable);
  return portable;
}

export function canonicalPortableWorkspaceJson(value) {
  return JSON.stringify(clonePortableWorkspaceJson(value));
}

export async function portableWorkspaceSha256(value) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new TextEncoder().encode(canonicalPortableWorkspaceJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildManifest(input) {
  return {
    format: PORTABLE_WORKSPACE_V2_FORMAT,
    contractVersion: PORTABLE_WORKSPACE_V2_CONTRACT_VERSION,
    schemaVersion: PORTABLE_WORKSPACE_V2_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    encoding: "UTF-8 canonical JSON",
    scope: {
      type: "organization",
      organizationId: input.organizationId,
      organizationName: input.organizationName,
      fieldIds: input.fieldIds,
    },
    policy: PORTABLE_WORKSPACE_V2_POLICY,
    rowProjection: PORTABLE_WORKSPACE_V2_ROW_PROJECTION,
    integrity: PORTABLE_WORKSPACE_V2_INTEGRITY,
    sectionOrder: PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
    recordCounts: input.evidence.recordCounts,
    sectionSha256: input.evidence.sectionSha256,
    totalRecordCount: input.evidence.totalRecordCount,
  };
}

function normalizeSections(value, scope, options) {
  try {
    return normalizePortableWorkspaceV2Sections(value, scope, options);
  } catch (cause) {
    if (
      cause
      && typeof cause === "object"
      && typeof cause.code === "string"
      && typeof cause.message === "string"
    ) {
      throw new PortableWorkspaceV2Error(cause.code, cause.message);
    }
    throw cause;
  }
}

function cloneWorkspaceValue(value, path) {
  try {
    return clonePortableWorkspaceJson(value, path);
  } catch (cause) {
    if (
      cause
      && typeof cause === "object"
      && typeof cause.code === "string"
      && typeof cause.message === "string"
    ) {
      throw new PortableWorkspaceV2Error(cause.code, cause.message);
    }
    throw cause;
  }
}

async function sectionEvidence(data) {
  const recordCounts = {};
  const sectionSha256 = {};
  let totalRecordCount = 0;
  for (const section of PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES) {
    const rows = data[section];
    recordCounts[section] = rows.length;
    totalRecordCount += rows.length;
    sectionSha256[section] = await portableWorkspaceSha256(rows);
  }
  return deepFreeze({ recordCounts, sectionSha256, totalRecordCount });
}

function validatePolicy(value) {
  assertPlainRecord(value, "INVALID_POLICY", "La política portable debe ser un objeto.");
  assertExactKeys(value, POLICY_KEYS, "INVALID_POLICY", "manifest.policy");
  if (value.version !== PORTABLE_WORKSPACE_V2_POLICY_VERSION) {
    fail("INVALID_POLICY", "La versión de política portable no coincide.");
  }
  for (const area of ["d1", "r2"]) {
    assertPlainRecord(
      value[area],
      "INVALID_POLICY",
      `manifest.policy.${area} debe ser un objeto.`,
    );
    assertExactKeys(
      value[area],
      POLICY_GROUP_KEYS,
      "INVALID_POLICY",
      `manifest.policy.${area}`,
    );
  }
  if (
    canonicalPortableWorkspaceJson(value)
    !== canonicalPortableWorkspaceJson(PORTABLE_WORKSPACE_V2_POLICY)
  ) {
    fail("INVALID_POLICY", "La clasificación de portabilidad fue modificada.");
  }
}

function validateRowProjection(value) {
  assertPlainRecord(
    value,
    "INVALID_ROW_PROJECTION",
    "La declaración de proyección debe ser un objeto.",
  );
  assertExactKeys(
    value,
    ROW_PROJECTION_KEYS,
    "INVALID_ROW_PROJECTION",
    "manifest.rowProjection",
  );
  if (
    canonicalPortableWorkspaceJson(value)
    !== canonicalPortableWorkspaceJson(PORTABLE_WORKSPACE_V2_ROW_PROJECTION)
  ) {
    fail("INVALID_ROW_PROJECTION", "La proyección de filas no coincide con el contrato.");
  }
}

function validateIntegrity(value) {
  assertPlainRecord(
    value,
    "INVALID_INTEGRITY",
    "La declaración de integridad debe ser un objeto.",
  );
  assertExactKeys(
    value,
    INTEGRITY_KEYS,
    "INVALID_INTEGRITY",
    "manifest.integrity",
  );
  if (
    canonicalPortableWorkspaceJson(value)
    !== canonicalPortableWorkspaceJson(PORTABLE_WORKSPACE_V2_INTEGRITY)
  ) {
    fail("INVALID_INTEGRITY", "El modelo de integridad no coincide con el contrato.");
  }
}

function validateEvidence(manifest, expected) {
  assertPlainRecord(
    manifest.recordCounts,
    "INVALID_MANIFEST",
    "recordCounts debe ser un objeto.",
  );
  assertPlainRecord(
    manifest.sectionSha256,
    "INVALID_MANIFEST",
    "sectionSha256 debe ser un objeto.",
  );
  assertExactKeys(
    manifest.recordCounts,
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
    "INVALID_MANIFEST",
    "manifest.recordCounts",
  );
  assertExactKeys(
    manifest.sectionSha256,
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
    "INVALID_MANIFEST",
    "manifest.sectionSha256",
  );
  for (const section of PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES) {
    if (manifest.recordCounts[section] !== expected.recordCounts[section]) {
      fail("SECTION_COUNT_MISMATCH", `El conteo de ${section} no coincide.`);
    }
    if (
      typeof manifest.sectionSha256[section] !== "string"
      || !/^[a-f0-9]{64}$/u.test(manifest.sectionSha256[section])
      || manifest.sectionSha256[section] !== expected.sectionSha256[section]
    ) {
      fail("SECTION_HASH_MISMATCH", `La huella de ${section} no coincide.`);
    }
  }
  if (manifest.totalRecordCount !== expected.totalRecordCount) {
    fail("TOTAL_COUNT_MISMATCH", "El conteo total no coincide.");
  }
}

function assertCanonicalByteLimit(value) {
  const bytes = new TextEncoder().encode(canonicalPortableWorkspaceJson(value));
  if (bytes.byteLength > PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES) {
    fail(
      "WORKSPACE_TOO_LARGE",
      `El portable supera ${PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES} bytes.`,
    );
  }
}

function uniqueSortedStrings(value, code, label, maxLength) {
  if (!Array.isArray(value)) fail(code, `${label} debe ser un arreglo.`);
  const normalized = value.map((entry, index) =>
    requiredString(entry, code, `${label}[${index}]`, maxLength));
  if (new Set(normalized).size !== normalized.length) {
    fail(code, `${label} contiene duplicados.`);
  }
  return normalized.sort(compareCodePoint);
}

function requiredString(value, code, label, maxLength) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code, `${label} no es una cadena portable válida.`);
  }
  return value;
}

function exactIsoTimestamp(value) {
  const timestamp = requiredString(value, "INVALID_TIMESTAMP", "generatedAt", 40);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail("INVALID_TIMESTAMP", "generatedAt debe ser UTC ISO-8601 canónico.");
  }
  return timestamp;
}

function pseudonymousGeneratedBy(value) {
  const generatedBy = requiredString(
    value,
    "INVALID_ACTOR",
    "generatedBy",
    320,
  );
  if (!GENERATED_BY_PATTERN.test(generatedBy)) {
    fail(
      "INVALID_ACTOR",
      "generatedBy debe contener únicamente el seudónimo SHA-256 de la identidad.",
    );
  }
  return generatedBy;
}

function assertPlainRecord(value, code, message) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    fail(code, message);
  }
}

function assertExactKeys(value, expected, code, label) {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail(code, `${label} contiene claves no textuales.`);
  }
  const sortedActual = actual.sort(compareCodePoint);
  const sortedExpected = [...expected].sort(compareCodePoint);
  if (!sameStringArray(sortedActual, sortedExpected)) {
    fail(code, `${label} contiene propiedades inesperadas o incompletas.`);
  }
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code, message) {
  throw new PortableWorkspaceV2Error(code, message);
}
