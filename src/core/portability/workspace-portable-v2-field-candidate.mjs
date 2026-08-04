import {
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
} from "./workspace-portable-v2.mjs";
import {
  PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION,
  PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
} from "./workspace-portable-v2-projections.mjs";

export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FORMAT =
  "fundosmart.portable-workspace.v2.field-candidate";
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_VERSION = 1;
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_STATUS = "not_exportable";
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FAMILY = "field_roots_v1";
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS = 10_000;
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_COORDINATES = 100_000;

export const PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS = Object.freeze([
  "id",
  "organization_id",
  "name",
  "location",
  "is_demo",
  "area_hectares",
  "coordinates",
  "soil_report_filename",
  "soil_report_folio",
  "soil_sample_id",
  "soil_report_date",
  "created_at",
]);

export const PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS = Object.freeze([
  "global_rows_gate",
  "owner_admin_authorization",
  "final_scope_reauthorization",
  "deterministic_snapshot",
  "sensitive_content_authorization",
]);

export const PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS = Object.freeze([
  "strict_json_parse",
  "boolean_normalization",
]);

export const PORTABLE_WORKSPACE_V2_FIELD_NOT_MATERIALIZED_SECTIONS = Object.freeze(
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.filter((section) => section !== "fields"),
);

const INPUT_KEYS = Object.freeze(["fieldIds", "organizationId", "rows"]);
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
  "recordCount",
  "scope",
  "section",
  "sectionSha256",
  "satisfiedRequirements",
  "status",
  "unresolvedRequirements",
]);
const CATALOG_KEYS = Object.freeze(["policyFingerprint", "version"]);
const SCOPE_KEYS = Object.freeze(["fieldIds", "organizationId"]);
const FIELD_ACTIVATION_REQUIREMENTS = Object.freeze([
  "global_rows_gate",
  "owner_admin_authorization",
  "final_scope_reauthorization",
  "deterministic_snapshot",
  "strict_json_parse",
  "boolean_normalization",
  "sensitive_content_authorization",
]);
const NULLABLE_STRING_COLUMNS = Object.freeze([
  "soil_report_filename",
  "soil_report_folio",
  "soil_sample_id",
  "soil_report_date",
]);
const REQUIRED_STRING_COLUMNS = Object.freeze([
  "name",
  "location",
  "created_at",
]);
const FIELD_DESCRIPTOR = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS.fields;
const FIELD_DESCRIPTOR_CONTRACT = deepFreeze({
  activationRequirements: [...FIELD_ACTIVATION_REQUIREMENTS],
  blockedColumns: [],
  booleanColumns: ["is_demo"],
  columns: [...PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS],
  freeTextColumns: [],
  humanIdentityColumns: [],
  jsonColumns: {
    known: ["coordinates"],
    unbounded: [],
  },
  omittedColumns: [],
  orderBy: ["id"],
  primaryKey: ["id"],
  scope: {
    filters: [],
    polymorphicReferences: [],
    relations: [],
    requirements: ["exact_field_set", "organization_match"],
    strategy: "field_root",
  },
  sensitiveContentColumns: [
    "location",
    "coordinates",
    "soil_report_filename",
    "soil_report_folio",
    "soil_sample_id",
  ],
});
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 100_000;
const MAX_JSON_STRING_LENGTH = 8_000_000;

export class PortableWorkspaceV2FieldCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PortableWorkspaceV2FieldCandidateError";
    this.code = code;
  }
}

export async function createPortableWorkspaceV2FieldCandidate(input) {
  assertSafeAsyncPrototype();
  assertFieldCatalogContract();
  assertPlainRecord(input, "INVALID_INPUT", "La entrada del candidato debe ser un objeto.");
  assertExactKeys(input, INPUT_KEYS, "INVALID_INPUT", "entrada");

  const organizationId = requiredToken(
    ownDataValue(input, "organizationId", "INVALID_INPUT", "organizationId"),
    "INVALID_SCOPE",
    "organizationId",
    MAX_ID_LENGTH,
  );
  const fieldIds = uniqueSortedFieldIds(
    ownDataValue(input, "fieldIds", "INVALID_INPUT", "fieldIds"),
  );
  const sourceRows = denseArray(
    ownDataValue(input, "rows", "INVALID_INPUT", "rows"),
    "INVALID_ROWS",
    "rows",
    PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS,
  );
  if (sourceRows.length !== fieldIds.length) {
    fail(
      "INCOMPLETE_FIELD_SNAPSHOT",
      "La cantidad de filas no coincide con el snapshot exacto de fundos.",
    );
  }

  const expectedFieldIds = new Set(fieldIds);
  const seenFieldIds = new Set();
  const candidateRows = sourceRows.map((row, index) => {
    const candidate = normalizeFieldRow(row, index, organizationId, expectedFieldIds);
    if (seenFieldIds.has(candidate.id)) {
      fail("DUPLICATE_FIELD_ROW", `La fila ${index} repite un fundo del snapshot.`);
    }
    seenFieldIds.add(candidate.id);
    return candidate;
  }).sort((left, right) => compareCodePoint(left.id, right.id));

  if (!sameStringArray(candidateRows.map(({ id }) => id), fieldIds)) {
    fail("INCOMPLETE_FIELD_SNAPSHOT", "Las filas no cubren exactamente el snapshot de fundos.");
  }
  const sectionSha256 = await fieldCandidateSha256(candidateRows);

  return deepFreeze(Object.assign(Object.create(null), {
    format: PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FORMAT,
    candidateVersion: PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_VERSION,
    status: PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_STATUS,
    family: PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FAMILY,
    section: "fields",
    complete: false,
    portableRowsEnabled: false,
    catalog: {
      version: PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION,
      policyFingerprint: PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
    },
    unresolvedRequirements: [...PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS],
    satisfiedRequirements: [...PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS],
    materializedSections: ["fields"],
    notMaterializedSections: [...PORTABLE_WORKSPACE_V2_FIELD_NOT_MATERIALIZED_SECTIONS],
    scope: {
      organizationId,
      fieldIds,
    },
    recordCount: candidateRows.length,
    sectionSha256,
    candidateRows,
  }));
}

export async function validatePortableWorkspaceV2FieldCandidate(value) {
  assertSafeAsyncPrototype();
  assertFieldCatalogContract();
  assertPlainRecord(value, "INVALID_CANDIDATE", "El candidato debe ser un objeto.");
  assertExactKeys(value, CANDIDATE_KEYS, "INVALID_CANDIDATE", "candidato");
  assertPlainRecord(value.catalog, "INVALID_CANDIDATE", "catalog debe ser un objeto.");
  assertExactKeys(value.catalog, CATALOG_KEYS, "INVALID_CANDIDATE", "catalog");
  assertPlainRecord(value.scope, "INVALID_CANDIDATE", "scope debe ser un objeto.");
  assertExactKeys(value.scope, SCOPE_KEYS, "INVALID_CANDIDATE", "scope");

  if (
    value.format !== PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FORMAT
    || value.candidateVersion !== PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_VERSION
    || value.status !== PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_STATUS
    || value.family !== PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FAMILY
    || value.section !== "fields"
    || value.complete !== false
    || value.portableRowsEnabled !== false
    || value.catalog.version !== PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION
    || value.catalog.policyFingerprint !== PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT
  ) {
    fail("INVALID_CANDIDATE", "La identidad o los gates del candidato no coinciden.");
  }
  if (
    !sameStringArray(
      denseArray(
        value.unresolvedRequirements,
        "INVALID_CANDIDATE",
        "unresolvedRequirements",
        PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS,
    )
    || !sameStringArray(
      denseArray(
        value.satisfiedRequirements,
        "INVALID_CANDIDATE",
        "satisfiedRequirements",
        PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS,
    )
    || !sameStringArray(
      denseArray(value.materializedSections, "INVALID_CANDIDATE", "materializedSections", 1),
      ["fields"],
    )
    || !sameStringArray(
      denseArray(
        value.notMaterializedSections,
        "INVALID_CANDIDATE",
        "notMaterializedSections",
        PORTABLE_WORKSPACE_V2_FIELD_NOT_MATERIALIZED_SECTIONS.length,
      ),
      PORTABLE_WORKSPACE_V2_FIELD_NOT_MATERIALIZED_SECTIONS,
    )
  ) {
    fail("INVALID_CANDIDATE", "Las secciones o requisitos del candidato no coinciden.");
  }
  if (
    !Number.isSafeInteger(value.recordCount)
    || value.recordCount < 0
    || typeof value.sectionSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.sectionSha256)
  ) {
    fail("INVALID_CANDIDATE_EVIDENCE", "La evidencia fields no tiene una forma válida.");
  }

  const candidateRows = denseArray(
    ownDataValue(value, "candidateRows", "INVALID_CANDIDATE", "candidateRows"),
    "INVALID_CANDIDATE",
    "candidateRows",
    PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS,
  ).map((row, index) => candidateRowAsRawD1(row, index));
  const rebuilt = await createPortableWorkspaceV2FieldCandidate({
    organizationId: ownDataValue(value.scope, "organizationId", "INVALID_CANDIDATE", "scope.organizationId"),
    fieldIds: ownDataValue(value.scope, "fieldIds", "INVALID_CANDIDATE", "scope.fieldIds"),
    rows: candidateRows,
  });
  if (canonicalFieldCandidateJson(rebuilt) !== canonicalFieldCandidateJson(value)) {
    fail("INVALID_CANDIDATE_EVIDENCE", "La evidencia fields no coincide con sus filas.");
  }
  return rebuilt;
}

function normalizeFieldRow(row, index, organizationId, expectedFieldIds) {
  assertPlainRecord(row, "INVALID_FIELD_ROW", `La fila ${index} debe ser un objeto.`);
  assertExactKeys(row, PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS, "FIELD_SCHEMA_MISMATCH", `fila ${index}`);

  const id = requiredToken(
    ownDataValue(row, "id", "INVALID_FIELD_ROW", `fila ${index}.id`),
    "INVALID_FIELD_ROW",
    `fila ${index}.id`,
    MAX_ID_LENGTH,
  );
  const rowOrganizationId = requiredToken(
    ownDataValue(row, "organization_id", "INVALID_FIELD_ROW", `fila ${index}.organization_id`),
    "INVALID_FIELD_ROW",
    `fila ${index}.organization_id`,
    MAX_ID_LENGTH,
  );
  if (rowOrganizationId !== organizationId || !expectedFieldIds.has(id)) {
    fail("FIELD_SCOPE_MISMATCH", `La fila ${index} no pertenece al snapshot solicitado.`);
  }

  const isDemo = normalizeBoolean(
    ownDataValue(row, "is_demo", "INVALID_FIELD_ROW", `fila ${index}.is_demo`),
    index,
  );
  const candidate = Object.create(null);
  candidate.id = id;
  candidate.organization_id = rowOrganizationId;
  for (const column of REQUIRED_STRING_COLUMNS) {
    candidate[column] = boundedString(
      ownDataValue(row, column, "INVALID_FIELD_ROW", `fila ${index}.${column}`),
      "INVALID_FIELD_ROW",
      `fila ${index}.${column}`,
      MAX_TEXT_LENGTH,
    );
  }
  candidate.is_demo = isDemo;
  candidate.area_hectares = finiteNumber(
    ownDataValue(row, "area_hectares", "INVALID_FIELD_ROW", `fila ${index}.area_hectares`),
    index,
    "area_hectares",
  );
  candidate.coordinates = normalizeCoordinates(
    ownDataValue(row, "coordinates", "INVALID_FIELD_ROW", `fila ${index}.coordinates`),
    index,
  );
  for (const column of NULLABLE_STRING_COLUMNS) {
    candidate[column] = nullableBoundedString(
      ownDataValue(row, column, "INVALID_FIELD_ROW", `fila ${index}.${column}`),
      index,
      column,
    );
  }
  return Object.fromEntries(
    PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS.map((column) => [column, candidate[column]]),
  );
}

function normalizeCoordinates(value, rowIndex) {
  if (typeof value !== "string" || value.length > MAX_JSON_STRING_LENGTH) {
    fail("INVALID_FIELD_COORDINATES", `La fila ${rowIndex} debe contener JSON D1 acotado.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("INVALID_FIELD_COORDINATES", `La fila ${rowIndex} contiene JSON inválido.`);
  }
  return normalizeCoordinateArray(parsed, rowIndex);
}

function normalizeCoordinateArray(parsed, rowIndex) {
  const coordinates = denseArray(
    parsed,
    "INVALID_FIELD_COORDINATES",
    `fila ${rowIndex}.coordinates`,
    PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_COORDINATES,
  );
  return coordinates.map((coordinate, coordinateIndex) => {
    const pair = denseArray(
      coordinate,
      "INVALID_FIELD_COORDINATES",
      `fila ${rowIndex}.coordinates[${coordinateIndex}]`,
      2,
    );
    if (pair.length !== 2) {
      fail(
        "INVALID_FIELD_COORDINATES",
        `La coordenada ${coordinateIndex} de la fila ${rowIndex} no es un par.`,
      );
    }
    return [
      finiteNumber(pair[0], rowIndex, "coordinates", "INVALID_FIELD_COORDINATES"),
      finiteNumber(pair[1], rowIndex, "coordinates", "INVALID_FIELD_COORDINATES"),
    ];
  });
}

function candidateRowAsRawD1(row, rowIndex) {
  assertPlainRecord(row, "INVALID_CANDIDATE", `candidateRows[${rowIndex}] debe ser un objeto.`);
  assertExactKeys(
    row,
    PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS,
    "INVALID_CANDIDATE",
    `candidateRows[${rowIndex}]`,
  );
  const raw = Object.fromEntries(PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS.map((column) => [
    column,
    ownDataValue(row, column, "INVALID_CANDIDATE", `candidateRows[${rowIndex}].${column}`),
  ]));
  if (typeof raw.is_demo !== "boolean") {
    fail("INVALID_CANDIDATE", `candidateRows[${rowIndex}].is_demo debe ser booleano.`);
  }
  raw.is_demo = raw.is_demo ? 1 : 0;
  raw.coordinates = canonicalFieldCandidateJson(
    normalizeCoordinateArray(raw.coordinates, rowIndex),
    `candidateRows[${rowIndex}].coordinates`,
  );
  return raw;
}

function normalizeBoolean(value, rowIndex) {
  if (value === 0) return false;
  if (value === 1) return true;
  fail("INVALID_FIELD_BOOLEAN", `La fila ${rowIndex} contiene un booleano D1 inválido.`);
}

function finiteNumber(value, rowIndex, column, code = "INVALID_FIELD_NUMBER") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(code, `La fila ${rowIndex}.${column} debe ser un número finito.`);
  }
  return value;
}

function nullableBoundedString(value, rowIndex, column) {
  if (value === null) return null;
  return boundedString(
    value,
    "INVALID_FIELD_ROW",
    `fila ${rowIndex}.${column}`,
    MAX_TEXT_LENGTH,
  );
}

function boundedString(value, code, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) {
    fail(code, `${label} debe ser texto acotado.`);
  }
  return value;
}

function uniqueSortedFieldIds(value) {
  const fieldIds = denseArray(
    value,
    "INVALID_SCOPE",
    "fieldIds",
    PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS,
  ).map((fieldId, index) => requiredToken(
    fieldId,
    "INVALID_SCOPE",
    `fieldIds[${index}]`,
    MAX_ID_LENGTH,
  ));
  if (new Set(fieldIds).size !== fieldIds.length) {
    fail("INVALID_SCOPE", "fieldIds no puede contener duplicados.");
  }
  return fieldIds.sort(compareCodePoint);
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

function canonicalFieldCandidateJson(value, path = "value", ancestors = []) {
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
        (entry, index) => canonicalFieldCandidateJson(entry, `${path}[${index}]`, ancestors),
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
      `${JSON.stringify(key)}:${canonicalFieldCandidateJson(
        ownDataValue(value, key, "INVALID_CANONICAL_VALUE", `${path}.${key}`),
        `${path}.${key}`,
        ancestors,
      )}`
    )).join(",")}}`;
  } finally {
    ancestors.pop();
  }
}

async function fieldCandidateSha256(value) {
  const bytes = new TextEncoder().encode(canonicalFieldCandidateJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertFieldCatalogContract() {
  if (
    !FIELD_DESCRIPTOR
    || canonicalFieldCandidateJson(FIELD_DESCRIPTOR)
      !== canonicalFieldCandidateJson(FIELD_DESCRIPTOR_CONTRACT)
  ) {
    fail("FIELD_CATALOG_MISMATCH", "El contrato fields cambió y requiere revisión del candidato.");
  }
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
  throw new PortableWorkspaceV2FieldCandidateError(code, message);
}
