import {
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
} from "./workspace-portable-v2.mjs";
import {
  PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_COORDINATES,
  PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS,
  PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS,
  PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS,
  PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS,
  createPortableWorkspaceV2FieldCandidate,
  validatePortableWorkspaceV2FieldCandidate,
} from "./workspace-portable-v2-field-candidate.mjs";
import {
  PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION,
  PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
} from "./workspace-portable-v2-projections.mjs";

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FORMAT =
  "fundosmart.portable-workspace.v2.field-settings-candidate";
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_VERSION = 1;
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_STATUS = "not_exportable";
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FAMILY =
  "field_roots_with_current_rotation_settings_v1";
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_MAX_ROWS =
  PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS;

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SOURCE_COLUMNS = Object.freeze([
  "field_id",
  "recent_days",
  "long_rest_days",
  "created_at",
  "updated_at",
  "version",
]);

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS = Object.freeze([
  "fields",
  "paddock_rotation_settings",
]);

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_NOT_MATERIALIZED_SECTIONS = Object.freeze(
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.filter(
    (section) => !PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS.includes(section),
  ),
);

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_UNRESOLVED_REQUIREMENTS = Object.freeze([
  "global_rows_gate",
  "owner_admin_authorization",
  "final_scope_reauthorization",
  "deterministic_snapshot",
  "sensitive_content_authorization",
]);

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SATISFIED_REQUIREMENTS = Object.freeze([
  "strict_json_parse",
  "boolean_normalization",
  "relation_validation",
]);

const INPUT_KEYS = Object.freeze(["fieldCandidate", "settingsRows"]);
const CANDIDATE_KEYS = Object.freeze([
  "candidateRows",
  "candidateVersion",
  "catalog",
  "complete",
  "family",
  "format",
  "materializedSections",
  "notMaterializedSections",
  "portableRowsEnabled",
  "recordCounts",
  "scope",
  "sectionSha256s",
  "satisfiedRequirements",
  "status",
  "unresolvedRequirements",
]);
const CATALOG_KEYS = Object.freeze(["policyFingerprint", "version"]);
const SCOPE_KEYS = Object.freeze(["fieldIds", "organizationId"]);
const MATERIALIZED_SECTION_KEYS = PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS;
const FIELD_SETTINGS_ACTIVATION_REQUIREMENTS = Object.freeze([
  "global_rows_gate",
  "owner_admin_authorization",
  "final_scope_reauthorization",
  "deterministic_snapshot",
  "relation_validation",
]);
const FIELD_SETTINGS_DESCRIPTOR = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS
  .paddock_rotation_settings;
const FIELD_SETTINGS_DESCRIPTOR_CONTRACT = deepFreeze({
  activationRequirements: [...FIELD_SETTINGS_ACTIVATION_REQUIREMENTS],
  blockedColumns: [],
  booleanColumns: [],
  columns: [...PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SOURCE_COLUMNS],
  freeTextColumns: [],
  humanIdentityColumns: [],
  jsonColumns: {
    known: [],
    unbounded: [],
  },
  omittedColumns: [],
  orderBy: ["field_id"],
  primaryKey: ["field_id"],
  scope: {
    filters: [],
    polymorphicReferences: [],
    relations: [
      {
        from: { table: "paddock_rotation_settings", column: "field_id" },
        to: { table: "fields", column: "id" },
        match: "required",
      },
    ],
    requirements: ["field_in_exact_snapshot"],
    strategy: "direct_field",
  },
  sensitiveContentColumns: [],
});
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 100_000;

export class PortableWorkspaceV2FieldSettingsCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PortableWorkspaceV2FieldSettingsCandidateError";
    this.code = code;
  }
}

export async function createPortableWorkspaceV2FieldSettingsCandidate(input) {
  assertSafeAsyncPrototype();
  assertCatalogContract();
  assertPlainRecord(input, "INVALID_INPUT", "La entrada compuesta debe ser un objeto.");
  assertExactKeys(input, INPUT_KEYS, "INVALID_INPUT", "entrada");

  const fieldCandidate = await revalidateFieldCandidate(
    ownDataValue(input, "fieldCandidate", "INVALID_INPUT", "fieldCandidate"),
  );
  const settingsSourceRows = denseArray(
    ownDataValue(input, "settingsRows", "INVALID_INPUT", "settingsRows"),
    "INVALID_SETTINGS_ROWS",
    "settingsRows",
    PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_MAX_ROWS,
  );
  const fieldIds = fieldCandidate.scope.fieldIds;
  const expectedFieldIds = new Set(fieldIds);
  const seenFieldIds = new Set();
  const settingsRows = settingsSourceRows.map((row, index) => {
    const normalized = normalizeSettingsRow(row, index, expectedFieldIds);
    if (seenFieldIds.has(normalized.field_id)) {
      fail("DUPLICATE_SETTINGS_ROW", `La fila ${index} repite una PK de settings.`);
    }
    seenFieldIds.add(normalized.field_id);
    return normalized;
  }).sort((left, right) => compareCodePoint(left.field_id, right.field_id));
  const settingsSha256 = await candidateSha256(settingsRows);

  return deepFreeze(Object.assign(Object.create(null), {
    format: PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FORMAT,
    candidateVersion: PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_VERSION,
    status: PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_STATUS,
    family: PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FAMILY,
    complete: false,
    portableRowsEnabled: false,
    catalog: {
      version: PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION,
      policyFingerprint: PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
    },
    unresolvedRequirements: [
      ...PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_UNRESOLVED_REQUIREMENTS,
    ],
    satisfiedRequirements: [
      ...PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SATISFIED_REQUIREMENTS,
    ],
    materializedSections: [
      ...PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS,
    ],
    notMaterializedSections: [
      ...PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_NOT_MATERIALIZED_SECTIONS,
    ],
    scope: {
      organizationId: fieldCandidate.scope.organizationId,
      fieldIds,
    },
    recordCounts: {
      fields: fieldCandidate.recordCount,
      paddock_rotation_settings: settingsRows.length,
    },
    sectionSha256s: {
      fields: fieldCandidate.sectionSha256,
      paddock_rotation_settings: settingsSha256,
    },
    candidateRows: {
      fields: fieldCandidate.candidateRows,
      paddock_rotation_settings: settingsRows,
    },
  }));
}

export async function validatePortableWorkspaceV2FieldSettingsCandidate(value) {
  assertSafeAsyncPrototype();
  assertCatalogContract();
  assertPlainRecord(value, "INVALID_CANDIDATE", "El candidato compuesto debe ser un objeto.");
  assertExactKeys(value, CANDIDATE_KEYS, "INVALID_CANDIDATE", "candidato");

  const catalog = ownDataValue(value, "catalog", "INVALID_CANDIDATE", "catalog");
  const scope = ownDataValue(value, "scope", "INVALID_CANDIDATE", "scope");
  const recordCounts = ownDataValue(
    value,
    "recordCounts",
    "INVALID_CANDIDATE",
    "recordCounts",
  );
  const sectionSha256s = ownDataValue(
    value,
    "sectionSha256s",
    "INVALID_CANDIDATE",
    "sectionSha256s",
  );
  const candidateRows = ownDataValue(
    value,
    "candidateRows",
    "INVALID_CANDIDATE",
    "candidateRows",
  );
  for (const [record, keys, label] of [
    [catalog, CATALOG_KEYS, "catalog"],
    [scope, SCOPE_KEYS, "scope"],
    [recordCounts, MATERIALIZED_SECTION_KEYS, "recordCounts"],
    [sectionSha256s, MATERIALIZED_SECTION_KEYS, "sectionSha256s"],
    [candidateRows, MATERIALIZED_SECTION_KEYS, "candidateRows"],
  ]) {
    assertPlainRecord(record, "INVALID_CANDIDATE", `${label} debe ser un objeto.`);
    assertExactKeys(record, keys, "INVALID_CANDIDATE", label);
  }

  if (
    ownDataValue(value, "format", "INVALID_CANDIDATE", "format")
      !== PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FORMAT
    || ownDataValue(value, "candidateVersion", "INVALID_CANDIDATE", "candidateVersion")
      !== PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_VERSION
    || ownDataValue(value, "status", "INVALID_CANDIDATE", "status")
      !== PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_STATUS
    || ownDataValue(value, "family", "INVALID_CANDIDATE", "family")
      !== PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FAMILY
    || ownDataValue(value, "complete", "INVALID_CANDIDATE", "complete") !== false
    || ownDataValue(
      value,
      "portableRowsEnabled",
      "INVALID_CANDIDATE",
      "portableRowsEnabled",
    ) !== false
    || ownDataValue(catalog, "version", "INVALID_CANDIDATE", "catalog.version")
      !== PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION
    || ownDataValue(
      catalog,
      "policyFingerprint",
      "INVALID_CANDIDATE",
      "catalog.policyFingerprint",
    ) !== PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT
  ) {
    fail("INVALID_CANDIDATE", "La identidad o los gates del candidato no coinciden.");
  }

  if (
    !sameStringArray(
      denseArray(
        ownDataValue(
          value,
          "unresolvedRequirements",
          "INVALID_CANDIDATE",
          "unresolvedRequirements",
        ),
        "INVALID_CANDIDATE",
        "unresolvedRequirements",
        PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_UNRESOLVED_REQUIREMENTS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_UNRESOLVED_REQUIREMENTS,
    )
    || !sameStringArray(
      denseArray(
        ownDataValue(
          value,
          "satisfiedRequirements",
          "INVALID_CANDIDATE",
          "satisfiedRequirements",
        ),
        "INVALID_CANDIDATE",
        "satisfiedRequirements",
        PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SATISFIED_REQUIREMENTS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SATISFIED_REQUIREMENTS,
    )
    || !sameStringArray(
      denseArray(
        ownDataValue(
          value,
          "materializedSections",
          "INVALID_CANDIDATE",
          "materializedSections",
        ),
        "INVALID_CANDIDATE",
        "materializedSections",
        PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS,
    )
    || !sameStringArray(
      denseArray(
        ownDataValue(
          value,
          "notMaterializedSections",
          "INVALID_CANDIDATE",
          "notMaterializedSections",
        ),
        "INVALID_CANDIDATE",
        "notMaterializedSections",
        PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_NOT_MATERIALIZED_SECTIONS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_NOT_MATERIALIZED_SECTIONS,
    )
  ) {
    fail("INVALID_CANDIDATE", "Las secciones o requisitos del candidato no coinciden.");
  }

  for (const section of MATERIALIZED_SECTION_KEYS) {
    const count = ownDataValue(
      recordCounts,
      section,
      "INVALID_CANDIDATE_EVIDENCE",
      `recordCounts.${section}`,
    );
    const sha256 = ownDataValue(
      sectionSha256s,
      section,
      "INVALID_CANDIDATE_EVIDENCE",
      `sectionSha256s.${section}`,
    );
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || Object.is(count, -0)
      || typeof sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(sha256)
    ) {
      fail("INVALID_CANDIDATE_EVIDENCE", "La evidencia compuesta no tiene una forma válida.");
    }
  }

  const fieldRows = denseArray(
    ownDataValue(candidateRows, "fields", "INVALID_CANDIDATE", "candidateRows.fields"),
    "INVALID_CANDIDATE",
    "candidateRows.fields",
    PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS,
  ).map((row, index) => candidateFieldRowAsRawD1(row, index));
  const settingsRows = denseArray(
    ownDataValue(
      candidateRows,
      "paddock_rotation_settings",
      "INVALID_CANDIDATE",
      "candidateRows.paddock_rotation_settings",
    ),
    "INVALID_CANDIDATE",
    "candidateRows.paddock_rotation_settings",
    PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_MAX_ROWS,
  );
  const fieldCandidate = await createBaseFieldCandidate({
    organizationId: ownDataValue(
      scope,
      "organizationId",
      "INVALID_CANDIDATE",
      "scope.organizationId",
    ),
    fieldIds: ownDataValue(scope, "fieldIds", "INVALID_CANDIDATE", "scope.fieldIds"),
    rows: fieldRows,
  });
  const rebuilt = await createPortableWorkspaceV2FieldSettingsCandidate({
    fieldCandidate,
    settingsRows,
  });
  if (canonicalCandidateJson(rebuilt) !== canonicalCandidateJson(value)) {
    fail("INVALID_CANDIDATE_EVIDENCE", "La evidencia compuesta no coincide con sus filas.");
  }
  return rebuilt;
}

function normalizeSettingsRow(row, index, expectedFieldIds) {
  assertPlainRecord(row, "INVALID_SETTINGS_ROW", `La fila ${index} debe ser un objeto.`);
  assertExactKeys(
    row,
    PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SOURCE_COLUMNS,
    "SETTINGS_SCHEMA_MISMATCH",
    `fila ${index}`,
  );
  const fieldId = requiredToken(
    ownDataValue(row, "field_id", "INVALID_SETTINGS_ROW", `fila ${index}.field_id`),
    "INVALID_SETTINGS_ROW",
    `fila ${index}.field_id`,
    MAX_ID_LENGTH,
  );
  if (!expectedFieldIds.has(fieldId)) {
    fail("SETTINGS_SCOPE_MISMATCH", `La fila ${index} no pertenece al snapshot solicitado.`);
  }

  const recentDays = safeInteger(
    ownDataValue(row, "recent_days", "INVALID_SETTINGS_ROW", `fila ${index}.recent_days`),
    index,
    "recent_days",
  );
  const longRestDays = safeInteger(
    ownDataValue(
      row,
      "long_rest_days",
      "INVALID_SETTINGS_ROW",
      `fila ${index}.long_rest_days`,
    ),
    index,
    "long_rest_days",
  );
  const version = safeInteger(
    ownDataValue(row, "version", "INVALID_SETTINGS_ROW", `fila ${index}.version`),
    index,
    "version",
  );
  if (recentDays < 0 || recentDays >= longRestDays) {
    fail(
      "INVALID_SETTINGS_THRESHOLDS",
      `La fila ${index} no cumple los umbrales físicos de settings.`,
    );
  }
  if (version < 1) {
    fail("INVALID_SETTINGS_VERSION", `La fila ${index} no contiene una versión física válida.`);
  }

  const normalized = Object.create(null);
  normalized.field_id = fieldId;
  normalized.recent_days = recentDays;
  normalized.long_rest_days = longRestDays;
  normalized.created_at = boundedString(
    ownDataValue(row, "created_at", "INVALID_SETTINGS_ROW", `fila ${index}.created_at`),
    "INVALID_SETTINGS_ROW",
    `fila ${index}.created_at`,
  );
  normalized.updated_at = boundedString(
    ownDataValue(row, "updated_at", "INVALID_SETTINGS_ROW", `fila ${index}.updated_at`),
    "INVALID_SETTINGS_ROW",
    `fila ${index}.updated_at`,
  );
  normalized.version = version;
  return Object.fromEntries(
    PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SOURCE_COLUMNS.map(
      (column) => [column, normalized[column]],
    ),
  );
}

function candidateFieldRowAsRawD1(row, rowIndex) {
  assertPlainRecord(row, "INVALID_CANDIDATE", `candidateRows.fields[${rowIndex}] inválida.`);
  assertExactKeys(
    row,
    PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS,
    "INVALID_CANDIDATE",
    `candidateRows.fields[${rowIndex}]`,
  );
  const raw = Object.create(null);
  for (const column of PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS) {
    raw[column] = ownDataValue(
      row,
      column,
      "INVALID_CANDIDATE",
      `candidateRows.fields[${rowIndex}].${column}`,
    );
  }
  if (typeof raw.is_demo !== "boolean") {
    fail("INVALID_CANDIDATE", `candidateRows.fields[${rowIndex}].is_demo inválido.`);
  }
  raw.is_demo = raw.is_demo ? 1 : 0;
  try {
    raw.coordinates = canonicalCandidateJson(
      raw.coordinates,
      `candidateRows.fields[${rowIndex}].coordinates`,
    );
  } catch {
    fail(
      "INVALID_FIELD_CANDIDATE",
      "Las coordenadas fields no reconstruyen un candidato válido.",
    );
  }
  return raw;
}

async function revalidateFieldCandidate(value) {
  try {
    return await validatePortableWorkspaceV2FieldCandidate(value);
  } catch {
    fail("INVALID_FIELD_CANDIDATE", "El field-candidate base no supera su validación.");
  }
}

async function createBaseFieldCandidate(input) {
  try {
    return await createPortableWorkspaceV2FieldCandidate(input);
  } catch {
    fail("INVALID_FIELD_CANDIDATE", "Las filas fields no reconstruyen un candidato válido.");
  }
}

function assertSafeAsyncPrototype() {
  if (
    Reflect.has(Object.prototype, "then")
    || Reflect.has(Array.prototype, "then")
  ) {
    fail(
      "UNSAFE_RUNTIME_PROTOTYPE",
      "El candidato rechaza un prototipo global con asimilación async.",
    );
  }
}

function assertCatalogContract() {
  if (
    !FIELD_SETTINGS_DESCRIPTOR
    || canonicalCandidateJson(FIELD_SETTINGS_DESCRIPTOR)
      !== canonicalCandidateJson(FIELD_SETTINGS_DESCRIPTOR_CONTRACT)
    || !sameStringArray(
      PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS,
      PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_UNRESOLVED_REQUIREMENTS,
    )
    || !sameStringArray(
      PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS,
      PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SATISFIED_REQUIREMENTS.slice(0, -1),
    )
  ) {
    fail("SETTINGS_CATALOG_MISMATCH", "El contrato compuesto cambió y requiere revisión.");
  }
}

function canonicalCandidateJson(value, path = "value", ancestors = []) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("INVALID_CANONICAL_VALUE", `${path} debe contener solo números finitos.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail("INVALID_CANONICAL_VALUE", `${path} debe contener solo valores JSON.`);
  }
  if (ancestors.includes(value)) {
    fail("INVALID_CANONICAL_VALUE", `${path} no puede contener ciclos.`);
  }

  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const entries = denseArray(
        value,
        "INVALID_CANONICAL_VALUE",
        path,
        PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_COORDINATES,
      );
      return `[${entries.map(
        (entry, index) => canonicalCandidateJson(entry, `${path}[${index}]`, ancestors),
      ).join(",")}]`;
    }
    assertPlainRecord(
      value,
      "INVALID_CANONICAL_VALUE",
      `${path} debe contener solo objetos simples.`,
    );
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail("INVALID_CANONICAL_VALUE", `${path} no puede contener claves simbólicas.`);
    }
    return `{${keys.sort(compareCodePoint).map((key) => (
      `${JSON.stringify(key)}:${canonicalCandidateJson(
        ownDataValue(value, key, "INVALID_CANONICAL_VALUE", `${path}.${key}`),
        `${path}.${key}`,
        ancestors,
      )}`
    )).join(",")}}`;
  } finally {
    ancestors.pop();
  }
}

async function candidateSha256(value) {
  const bytes = new TextEncoder().encode(canonicalCandidateJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function denseArray(value, code, label, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail(code, `${label} debe ser un arreglo acotado.`);
  }
  const elementKeys = Array.from({ length: value.length }, (_, index) => String(index));
  const expectedOwnKeys = [...elementKeys, "length"].sort(compareCodePoint);
  const actualOwnKeys = Reflect.ownKeys(value);
  if (
    actualOwnKeys.some((key) => typeof key !== "string")
    || !sameStringArray(actualOwnKeys.sort(compareCodePoint), expectedOwnKeys)
  ) {
    fail(code, `${label} debe ser un arreglo denso sin propiedades adicionales.`);
  }
  return elementKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      fail(code, `${label} no puede contener accesores.`);
    }
    return descriptor.value;
  });
}

function assertPlainRecord(value, code, message) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    fail(code, message);
  }
}

function assertExactKeys(value, expected, code, label) {
  const actual = Reflect.ownKeys(value);
  const sortedExpected = [...expected].sort(compareCodePoint);
  if (
    actual.some((key) => typeof key !== "string")
    || !sameStringArray(actual.sort(compareCodePoint), sortedExpected)
  ) {
    fail(code, `${label} no coincide con el esquema exacto esperado.`);
  }
  for (const key of expected) ownDataValue(value, key, code, `${label}.${key}`);
}

function ownDataValue(value, key, code, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    fail(code, `${label} debe ser una propiedad de datos.`);
  }
  return descriptor.value;
}

function requiredToken(value, code, label, maxLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code, `${label} debe ser un identificador válido.`);
  }
  return value;
}

function boundedString(value, code, label) {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    fail(code, `${label} debe ser texto acotado.`);
  }
  return value;
}

function safeInteger(value, rowIndex, column) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    fail(
      "INVALID_SETTINGS_INTEGER",
      `La fila ${rowIndex}.${column} debe ser un entero D1 seguro.`,
    );
  }
  return value;
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
  throw new PortableWorkspaceV2FieldSettingsCandidateError(code, message);
}
