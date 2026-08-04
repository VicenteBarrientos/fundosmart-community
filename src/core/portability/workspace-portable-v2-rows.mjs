import {
  PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION,
  PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
} from "./workspace-portable-v2-projections.mjs";
import {
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
} from "./workspace-portable-v2-policy.mjs";

export const PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS = 10_000;
export const PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS = 100_000;
export const PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES = 25 * 1024 * 1024;
export const PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES = 1024 * 1024;
const PORTABLE_WORKSPACE_V2_MAX_JSON_DEPTH = 64;
const PORTABLE_WORKSPACE_V2_MAX_JSON_NODES = 5_000_000;

const SOURCE_SCOPE_SENTINEL = "__scope_source_record_valid";
const SOURCE_SCOPE_SECTIONS = new Set([
  "livestock_births",
  "livestock_health_events",
  "livestock_lactations",
  "livestock_milk_controls",
  "livestock_reproductive_events",
]);
const STRUCTURAL_FORBIDDEN_KEY_NAMES = new Set([
  "constructor",
  "proto",
  "prototype",
]);

const ROW_SCHEMAS = Object.freeze({
  activities: rowSchema({
    number: words(`quantity cost_clp`),
    nullable: words(`quantity unit cost_clp deleted_at`),
  }),
  audit_log: rowSchema({
    nullable: words(`field_id`),
  }),
  field_external_identifiers: rowSchema({
    nullable: words(`valid_from valid_to`),
  }),
  field_landmark_operations: rowSchema({
    integer: words(`expected_version`),
    nullable: words(`expected_version`),
  }),
  field_landmarks: rowSchema({
    integer: words(`version`),
    number: words(`length_meters`),
    nullable: words(`deleted_at`),
  }),
  fields: rowSchema({
    number: words(`area_hectares`),
    nullable: words(
      `soil_report_filename soil_report_folio soil_sample_id soil_report_date`,
    ),
  }),
  import_errors: rowSchema({
    nullable: words(`field_name resolution_notes resolved_at`),
  }),
  import_jobs: rowSchema({
    integer: words(`
      file_size_bytes row_count valid_row_count warning_row_count error_row_count
      skipped_row_count file_issue_count
    `),
    nullable: words(
      `content_type effective_at started_at previewed_at confirmed_at completed_at`,
    ),
  }),
  import_rows: rowSchema({
    integer: words(`record_number warning_count error_count`),
    nullable: words(`source_key`),
  }),
  livestock_animal_identifiers: rowSchema({
    nullable: words(`valid_from valid_to`),
  }),
  livestock_animals: rowSchema({
    integer: words(`purchase_price_clp sale_price_clp`),
    number: words(`sale_weight_kg`),
    nullable: words(`
      status_date status_reason birth_date purchase_price_clp purchase_date
      sale_price_clp sale_buyer sale_weight_kg origin
    `),
  }),
  livestock_birth_offspring: rowSchema({
    number: words(`birth_weight_kg`),
    nullable: words(`animal_id birth_weight_kg`),
  }),
  livestock_births: rowSchema({
    nullable: words(`reproductive_event_id sire_identifier sire_animal_id`),
  }),
  livestock_expenses: rowSchema({
    integer: words(`amount_clp`),
    nullable: words(`field_id date paid_by_id lot_id`),
  }),
  livestock_feeding_plans: rowSchema({
    number: words(`kg_per_animal_day sack_weight_kg`),
  }),
  livestock_health_events: rowSchema({
    number: words(`dose_amount`),
    nullable: words(`
      condition product_name active_ingredient dose_amount dose_unit route
      withdrawal_milk_until withdrawal_meat_until professional
    `),
  }),
  livestock_lactations: rowSchema({
    integer: words(`sequence_number`),
    nullable: words(`calving_date ended_at dry_off_reason`),
  }),
  livestock_lot_external_identifiers: rowSchema({
    nullable: words(`valid_from valid_to`),
  }),
  livestock_lot_memberships: rowSchema({
    nullable: words(`ended_at`),
  }),
  livestock_lots: rowSchema({
    integer: words(`animal_count`),
    number: words(`average_weight_kg`),
    nullable: words(`paddock_id average_weight_kg owner_name`),
  }),
  livestock_milk_controls: rowSchema({
    integer: words(`somatic_cell_count`),
    number: words(`
      morning_liters afternoon_liters third_milking_liters total_liters fat_pct
      protein_pct
    `),
    nullable: words(`
      lactation_id morning_liters afternoon_liters third_milking_liters fat_pct
      protein_pct somatic_cell_count
    `),
  }),
  livestock_partners: rowSchema({
    nullable: words(`email`),
  }),
  livestock_reproductive_events: rowSchema({
    nullable: words(`method result sire_identifier sire_animal_id`),
  }),
  livestock_weighings: rowSchema({
    number: words(`weight_kg`),
    nullable: words(`lot_id`),
  }),
  milk_settlements: rowSchema({
    integer: words(`net_amount_clp tax_amount_clp gross_amount_clp`),
    number: words(`
      liters_first_half liters_second_half total_liters net_price_per_liter_clp
      gross_price_per_liter_clp
    `),
    nullable: words(`
      generated_at liters_first_half liters_second_half
      gross_price_per_liter_clp source_document_name
    `),
  }),
  paddock_cell_operations: rowSchema({}),
  paddock_cells: rowSchema({
    integer: words(`cell_index version`),
    number: words(
      `area_square_meters start_distance_meters end_distance_meters`,
    ),
    nullable: words(`active_to closed_by_operation_id`),
  }),
  paddock_ndvi: rowSchema({
    integer: words(`sample_count no_data_count valid_sample_count`),
    number: words(`mean_ndvi cloud_pct`),
    nullable: words(`mean_ndvi no_data_reason cloud_pct observed_at`),
  }),
  paddock_rotation_setting_operations: rowSchema({
    integer: words(`expected_version`),
    nullable: words(`expected_version`),
  }),
  paddock_rotation_settings: rowSchema({
    integer: words(`recent_days long_rest_days version`),
  }),
  potreros: rowSchema({
    number: words(`
      area_hectares grazeable_area_hectares soil_ph soil_nitrogen
      soil_phosphorus soil_potassium
    `),
    nullable: words(`
      grazeable_area_hectares soil_ph soil_nitrogen soil_phosphorus
      soil_potassium deleted_at archived_at archive_reason
    `),
  }),
  source_records: rowSchema({
    nullable: words(`source_key`),
  }),
  subdivision_drafts: rowSchema({}),
});

export const PORTABLE_WORKSPACE_V2_ROW_PROJECTION = deepFreeze({
  enabled: true,
  requirement: "explicit-column-allowlists",
  catalogVersion: PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION,
  policyFingerprint: PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
  columnDecisions: Object.fromEntries(
    Object.entries(PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS).map(
      ([section, descriptor]) => [
        section,
        {
          omitted: descriptor.omittedColumns,
          excluded: descriptor.blockedColumns,
        },
      ],
    ),
  ),
  rowExclusions: {
    audit_log: [
      {
        reason: "organization_wide_hidden_lineage_not_self_verifiable",
        predicate: "entity_type <> import_job AND field_id IS NULL",
      },
      {
        reason: "import_job_not_in_cooprinsem_projection",
        predicate: "entity_type = import_job AND no exact eligible Cooprinsem job",
      },
    ],
    import_errors: [{
      reason: "parent_import_job_not_in_cooprinsem_projection",
      predicate: "import_job.source_system <> cooprinsem",
    }],
    import_jobs: [{
      reason: "source_profile_not_projected",
      predicate: "source_system <> cooprinsem",
    }],
    import_rows: [{
      reason: "parent_import_job_not_in_cooprinsem_projection",
      predicate: "import_job.source_system <> cooprinsem",
    }],
    livestock_partners: [{
      reason: "unreferenced_partner_not_required_by_projected_expenses",
      predicate: "no projected organization expense references partner",
    }],
    source_records: [
      {
        reason: "parent_import_job_not_in_cooprinsem_projection",
        predicate: "import_job.source_system <> cooprinsem",
      },
      {
        reason: "target_section_not_projected",
        predicate: "target_entity = milk_quality_sample",
      },
    ],
  },
});

export class PortableWorkspaceV2RowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PortableWorkspaceV2RowError";
    this.code = code;
  }
}

assertRowSchemaCoverage();

export function emptyPortableWorkspaceV2Sections() {
  return Object.fromEntries(
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map((section) => [section, []]),
  );
}

export function normalizePortableWorkspaceV2Sections(
  value,
  scope,
  options = {},
) {
  assertPlainRecord(value, "INVALID_SECTIONS", "Las secciones deben ser un objeto.");
  assertExactKeys(
    value,
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
    "INVALID_SECTIONS",
    "data",
  );
  const organizationId = requiredText(scope?.organizationId, "organizationId");
  const fieldIds = uniqueSortedText(scope?.fieldIds, "fieldIds");
  const requireScopeSentinels = options.requireScopeSentinels === true;
  const normalized = {};
  let totalRecordCount = 0;

  for (const section of PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES) {
    const rows = ownDataValue(value, section, "INVALID_SECTIONS", `data.${section}`);
    assertDenseArray(rows, "INVALID_SECTION", `data.${section}`);
    if (rows.length > PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS) {
      fail(
        "SECTION_TOO_LARGE",
        `${section} supera ${PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS} registros.`,
      );
    }
    totalRecordCount += rows.length;
    if (totalRecordCount > PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS) {
      fail(
        "WORKSPACE_TOO_LARGE",
        `El espacio supera ${PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS} registros.`,
      );
    }
    normalized[section] = rows.map((row, index) =>
      normalizeRow(section, row, index, requireScopeSentinels));
    assertCanonicalOrder(section, normalized[section]);
  }

  validateScope(normalized, { organizationId, fieldIds });
  validateProjectionFilters(normalized);
  validateCompositeScope(normalized);
  return deepFreeze(normalized);
}

export function clonePortableWorkspaceJson(value, path = "value") {
  return cloneJsonValue(value, path, {
    ancestors: [],
    bytes: 0,
    nodes: 0,
  }, 0);
}

function cloneJsonValue(value, path, state, depth) {
  if (depth > PORTABLE_WORKSPACE_V2_MAX_JSON_DEPTH) {
    fail(
      "JSON_DEPTH_EXCEEDED",
      `${path} supera la profundidad JSON portable.`,
    );
  }
  state.nodes += 1;
  if (state.nodes > PORTABLE_WORKSPACE_V2_MAX_JSON_NODES) {
    fail(
      "JSON_NODE_LIMIT_EXCEEDED",
      `${path} supera la cantidad de nodos JSON portable.`,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    accountJsonBytes(state, JSON.stringify(value), path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("INVALID_JSON_VALUE", `${path} contiene un número no finito.`);
    }
    accountJsonBytes(state, JSON.stringify(value), path);
    return value;
  }
  if (typeof value !== "object") {
    fail("INVALID_JSON_VALUE", `${path} contiene un valor no JSON.`);
  }
  if (state.ancestors.includes(value)) {
    fail("CYCLIC_JSON_VALUE", `${path} contiene un ciclo.`);
  }
  state.ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, "INVALID_JSON_VALUE", path);
      accountJsonBytes(state, 2 + Math.max(0, value.length - 1), path);
      return value.map((_, index) =>
        cloneJsonValue(
          ownDataValue(value, String(index), "INVALID_JSON_VALUE", `${path}[${index}]`),
          `${path}[${index}]`,
          state,
          depth + 1,
        ));
    }
    assertPlainRecord(
      value,
      "INVALID_JSON_VALUE",
      `${path} debe contener solo objetos JSON simples.`,
    );
    const clone = Object.create(null);
    const keys = ownStringKeys(value, "INVALID_JSON_VALUE", path);
    accountJsonBytes(state, 2 + Math.max(0, keys.length - 1), path);
    for (const key of keys.sort(compareCodePoint)) {
      if (STRUCTURAL_FORBIDDEN_KEY_NAMES.has(normalizedKeyName(key))) {
        fail("FORBIDDEN_KEY", `${path}.${key} contiene una clave insegura.`);
      }
      accountJsonBytes(state, `${JSON.stringify(key)}:`, `${path}.${key}`);
      clone[key] = cloneJsonValue(
        ownDataValue(value, key, "INVALID_JSON_VALUE", `${path}.${key}`),
        `${path}.${key}`,
        state,
        depth + 1,
      );
    }
    return clone;
  } finally {
    state.ancestors.pop();
  }
}

function accountJsonBytes(state, token, path) {
  const bytes = typeof token === "number"
    ? token
    : new TextEncoder().encode(token).byteLength;
  state.bytes += bytes;
  if (state.bytes > PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES) {
    fail(
      "WORKSPACE_TOO_LARGE",
      `${path} supera ${PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES} bytes.`,
    );
  }
}

function normalizeRow(section, value, index, requireScopeSentinels) {
  const label = `data.${section}[${index}]`;
  assertPlainRecord(value, "INVALID_ROW", `${label} debe ser un objeto simple.`);
  const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
  const schema = ROW_SCHEMAS[section];
  if (!descriptor || !schema) {
    fail("ROW_SCHEMA_MISSING", `${section} no tiene un esquema de filas sellado.`);
  }
  const hiddenKeys = SOURCE_SCOPE_SECTIONS.has(section)
    ? [SOURCE_SCOPE_SENTINEL]
    : [];
  const expectedKeys = requireScopeSentinels
    ? [...descriptor.columns, ...hiddenKeys]
    : descriptor.columns;
  assertExactKeys(value, expectedKeys, "INVALID_ROW_COLUMNS", label);
  if (
    requireScopeSentinels
    && hiddenKeys.length > 0
    && ownDataValue(value, SOURCE_SCOPE_SENTINEL, "INVALID_SCOPE_SENTINEL", label) !== 1
  ) {
    fail("INVALID_SCOPE_SENTINEL", `${label} no confirmó su linaje oculto.`);
  }

  const normalized = {};
  for (const column of descriptor.columns) {
    const raw = ownDataValue(value, column, "INVALID_ROW", `${label}.${column}`);
    normalized[column] = normalizeColumn(section, column, raw, schema, label);
  }
  return normalized;
}

function normalizeColumn(section, column, value, schema, label) {
  if (value === null) {
    if (!schema.nullable.has(column)) {
      fail("NULL_NOT_ALLOWED", `${label}.${column} no admite null.`);
    }
    return null;
  }
  const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
  if (descriptor.booleanColumns.includes(column)) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    fail("INVALID_BOOLEAN", `${label}.${column} debe ser booleano.`);
  }
  if (descriptor.jsonColumns.known.includes(column)) {
    let parsed = value;
    if (typeof value === "string") {
      if (
        value.includes("\u0000")
        || new TextEncoder().encode(value).byteLength
          > PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES
      ) {
        fail(
          "INVALID_JSON_COLUMN",
          `${label}.${column} excede la política JSON portable.`,
        );
      }
      try {
        parsed = JSON.parse(value);
      } catch {
        fail("INVALID_JSON_COLUMN", `${label}.${column} no contiene JSON válido.`);
      }
    }
    return clonePortableWorkspaceJson(parsed, `${label}.${column}`);
  }
  if (schema.integer.has(column)) {
    if (!Number.isSafeInteger(value)) {
      fail("INVALID_INTEGER", `${label}.${column} debe ser un entero seguro.`);
    }
    return value;
  }
  if (schema.number.has(column)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("INVALID_NUMBER", `${label}.${column} debe ser un número finito.`);
    }
    return value;
  }
  if (typeof value !== "string") {
    fail("INVALID_TEXT", `${label}.${column} debe ser texto.`);
  }
  if (
    value.includes("\u0000")
    || new TextEncoder().encode(value).byteLength > PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES
  ) {
    fail("INVALID_TEXT", `${label}.${column} excede la política de texto portable.`);
  }
  return value;
}

function validateScope(sections, scope) {
  const fields = sections.fields;
  const actualFieldIds = fields.map((row) => row.id).sort(compareCodePoint);
  if (!sameStringArray(actualFieldIds, scope.fieldIds)) {
    fail("FIELD_SCOPE_MISMATCH", "El conjunto de fundos no coincide con el manifiesto.");
  }
  for (const row of fields) {
    if (row.organization_id !== scope.organizationId) {
      fail("ORGANIZATION_SCOPE_MISMATCH", "Un fundo pertenece a otra organización.");
    }
  }
  for (const [section, descriptor] of Object.entries(
    PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
  )) {
    if (!descriptor.columns.includes("organization_id")) continue;
    for (const row of sections[section]) {
      if (row.organization_id !== scope.organizationId) {
        fail(
          "ORGANIZATION_SCOPE_MISMATCH",
          `${section} contiene una fila de otra organización.`,
        );
      }
    }
  }

  const validatedRelations = new Set();
  for (const descriptor of Object.values(PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS)) {
    for (const relation of descriptor.scope.relations) {
      const signature = JSON.stringify(relation);
      if (validatedRelations.has(signature)) continue;
      validatedRelations.add(signature);
      validateRelation(sections, relation);
    }
  }
  validateSourceRecordTargets(sections);
  validateAuditTargets(sections);
}

function validateRelation(sections, relation) {
  const sourceDescriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[relation.from.table];
  const targetDescriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[relation.to.table];
  if (!sourceDescriptor || !targetDescriptor) {
    fail("RELATION_SCHEMA_MISSING", "Una relación portable no tiene sección.");
  }
  if (!sourceDescriptor.columns.includes(relation.from.column)) {
    if (
      relation.from.column === "source_record_id"
      && SOURCE_SCOPE_SECTIONS.has(relation.from.table)
    ) {
      return;
    }
    if (relation.from.table === "audit_log" && relation.from.column === "source_record_id") {
      return;
    }
    fail(
      "RELATION_COLUMN_HIDDEN",
      `${relation.from.table}.${relation.from.column} no puede validarse.`,
    );
  }
  if (!targetDescriptor.columns.includes(relation.to.column)) {
    fail(
      "RELATION_COLUMN_HIDDEN",
      `${relation.to.table}.${relation.to.column} no puede validarse.`,
    );
  }
  const sourceRows = sections[relation.from.table];
  const targetRows = sections[relation.to.table];
  const targetValues = new Set(targetRows.map((row) => row[relation.to.column]));
  if (relation.match === "referenced_by") {
    const sourceValues = new Set(sourceRows.map((row) => row[relation.from.column]));
    for (const target of targetRows) {
      if (!sourceValues.has(target[relation.to.column])) {
        fail(
          "UNRESOLVED_REFERENCE",
          `${relation.to.table} contiene una fila no referenciada.`,
        );
      }
    }
    return;
  }
  for (const row of sourceRows) {
    const value = row[relation.from.column];
    if (value === null && relation.match === "optional") continue;
    if (value === null || !targetValues.has(value)) {
      fail(
        "UNRESOLVED_REFERENCE",
        `${relation.from.table}.${relation.from.column} no resuelve dentro del archivo.`,
      );
    }
  }
}

function validateSourceRecordTargets(sections) {
  const targets = {
    field_external_identifier: ["field_external_identifiers", "id"],
    livestock_animal: ["livestock_animals", "id"],
    livestock_animal_identifier: ["livestock_animal_identifiers", "id"],
    livestock_lot_membership: ["livestock_lot_memberships", "id"],
    livestock_milk_control: ["livestock_milk_controls", "id"],
    livestock_reproductive_event: ["livestock_reproductive_events", "id"],
  };
  const indexes = Object.fromEntries(
    Object.entries(targets).map(([entity, [section, column]]) => [
      entity,
      new Set(sections[section].map((row) => row[column])),
    ]),
  );
  for (const row of sections.source_records) {
    const index = indexes[row.target_entity];
    if (!index || !index.has(row.target_id)) {
      fail(
        "UNRESOLVED_POLYMORPHIC_REFERENCE",
        "source_records contiene un objetivo no incluido.",
      );
    }
  }
}

function validateAuditTargets(sections) {
  const importJobs = indexRows(sections.import_jobs);
  const fieldIds = new Set(sections.fields.map((row) => row.id));
  for (const row of sections.audit_log) {
    if (row.entity_type === "import_job") {
      const importJob = requiredIndexed(
        importJobs,
        row.entity_id,
        "import_jobs",
      );
      if (row.field_id !== null) {
        assertSame(
          row.field_id,
          importJob.field_id,
          "audit_log.entity_id",
        );
      }
      continue;
    }
    if (row.field_id === null || !fieldIds.has(row.field_id)) {
      fail(
        "UNRESOLVED_POLYMORPHIC_REFERENCE",
        "audit_log no tiene un fundo verificable dentro del archivo.",
      );
    }
  }
}

function validateProjectionFilters(sections) {
  const filters = new Set();
  for (const descriptor of Object.values(PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS)) {
    for (const filter of descriptor.scope.filters) {
      filters.add(JSON.stringify(filter));
    }
  }
  for (const serialized of filters) {
    const filter = JSON.parse(serialized);
    if (filter.operator !== "equals" || !sections[filter.table]) {
      fail("FILTER_SCHEMA_MISSING", "Un filtro portable no puede verificarse.");
    }
    for (const row of sections[filter.table]) {
      if (row[filter.column] !== filter.value) {
        fail(
          "FILTER_MISMATCH",
          `${filter.table}.${filter.column} queda fuera del perfil portable.`,
        );
      }
    }
  }
}

function validateCompositeScope(sections) {
  const fields = indexRows(sections.fields);
  const paddocks = indexRows(sections.potreros);
  const lots = indexRows(sections.livestock_lots);
  const animals = indexRows(sections.livestock_animals);
  const landmarks = indexRows(sections.field_landmarks);
  const landmarkOperations = indexRows(sections.field_landmark_operations);
  const cellOperations = indexRows(sections.paddock_cell_operations);
  const births = indexRows(sections.livestock_births);
  const lactations = indexRows(sections.livestock_lactations);
  const animalIdentifiers = indexRows(sections.livestock_animal_identifiers);
  const fieldExternalIdentifiers = indexRows(sections.field_external_identifiers);
  const lotMemberships = indexRows(sections.livestock_lot_memberships);
  const milkControls = indexRows(sections.livestock_milk_controls);
  const reproductiveEvents = indexRows(sections.livestock_reproductive_events);
  const importJobs = indexRows(sections.import_jobs);
  const importRows = indexRows(sections.import_rows);

  const lotField = (lotId) => requiredIndexed(lots, lotId, "livestock_lots").field_id;
  const animalField = (animalId) =>
    lotField(requiredIndexed(animals, animalId, "livestock_animals").lot_id);

  for (const row of sections.field_landmark_operations) {
    assertSame(
      row.field_id,
      requiredIndexed(landmarks, row.landmark_id, "field_landmarks").field_id,
      "field_landmark_operations.landmark_id",
    );
  }
  for (const row of sections.field_landmarks) {
    const lastOperation = requiredIndexed(
      landmarkOperations,
      row.last_operation_id,
      "field_landmark_operations",
    );
    assertSame(
      row.field_id,
      lastOperation.field_id,
      "field_landmarks.last_operation_id",
    );
    assertSame(
      row.id,
      lastOperation.landmark_id,
      "field_landmarks.last_operation_id",
    );
  }
  for (const row of sections.paddock_cell_operations) {
    const paddock = requiredIndexed(paddocks, row.paddock_id, "potreros");
    assertSame(row.field_id, paddock.field_id, "paddock_cell_operations.paddock_id");
  }
  for (const row of sections.paddock_cells) {
    const paddock = requiredIndexed(paddocks, row.paddock_id, "potreros");
    assertSame(row.field_id, paddock.field_id, "paddock_cells.paddock_id");
    assertCellOperationScope(row, "created_by_operation_id", cellOperations);
    if (row.closed_by_operation_id !== null) {
      assertCellOperationScope(row, "closed_by_operation_id", cellOperations);
    }
  }
  for (const row of sections.paddock_ndvi) {
    assertSame(
      row.field_id,
      requiredIndexed(paddocks, row.paddock_id, "potreros").field_id,
      "paddock_ndvi.paddock_id",
    );
  }
  for (const row of sections.livestock_lots) {
    if (row.paddock_id !== null) {
      assertSame(
        row.field_id,
        requiredIndexed(paddocks, row.paddock_id, "potreros").field_id,
        "livestock_lots.paddock_id",
      );
    }
  }
  for (const row of sections.livestock_animal_identifiers) {
    assertSame(
      row.field_id,
      animalField(row.animal_id),
      "livestock_animal_identifiers.animal_id",
    );
  }
  for (const row of sections.livestock_lot_external_identifiers) {
    assertSame(
      row.field_id,
      lotField(row.lot_id),
      "livestock_lot_external_identifiers.lot_id",
    );
  }
  for (const row of sections.livestock_births) {
    assertSame(row.field_id, animalField(row.dam_animal_id), "livestock_births.dam");
    if (row.sire_animal_id !== null) {
      assertSame(row.field_id, animalField(row.sire_animal_id), "livestock_births.sire");
    }
    if (row.reproductive_event_id !== null) {
      const event = requiredIndexed(
        reproductiveEvents,
        row.reproductive_event_id,
        "livestock_reproductive_events",
      );
      assertSame(row.field_id, event.field_id, "livestock_births.reproductive_event_id");
      assertSame(row.dam_animal_id, event.animal_id, "livestock_births.reproductive_event_id");
      assertSame("calving", event.event_type, "livestock_births.reproductive_event_id");
      assertSame(row.occurred_at, event.occurred_at, "livestock_births.reproductive_event_id");
    }
  }
  for (const row of sections.livestock_birth_offspring) {
    const birthField = requiredIndexed(births, row.birth_id, "livestock_births").field_id;
    if (row.animal_id !== null) {
      assertSame(
        birthField,
        animalField(row.animal_id),
        "livestock_birth_offspring.animal_id",
      );
    }
  }
  for (const row of sections.livestock_health_events) {
    assertSame(row.field_id, animalField(row.animal_id), "livestock_health_events.animal_id");
  }
  for (const row of sections.livestock_lactations) {
    assertSame(row.field_id, animalField(row.animal_id), "livestock_lactations.animal_id");
  }
  for (const row of sections.livestock_milk_controls) {
    assertSame(row.field_id, animalField(row.animal_id), "livestock_milk_controls.animal_id");
    if (row.lactation_id !== null) {
      const lactation = requiredIndexed(
        lactations,
        row.lactation_id,
        "livestock_lactations",
      );
      assertSame(
        row.field_id,
        lactation.field_id,
        "livestock_milk_controls.lactation_id",
      );
      assertSame(
        row.animal_id,
        lactation.animal_id,
        "livestock_milk_controls.lactation_id",
      );
    }
  }
  for (const row of sections.livestock_reproductive_events) {
    assertSame(
      row.field_id,
      animalField(row.animal_id),
      "livestock_reproductive_events.animal_id",
    );
    if (row.sire_animal_id !== null) {
      assertSame(
        row.field_id,
        animalField(row.sire_animal_id),
        "livestock_reproductive_events.sire_animal_id",
      );
    }
  }
  for (const row of sections.import_rows) {
    requiredIndexed(importJobs, row.import_job_id, "import_jobs");
  }
  for (const row of sections.import_errors) {
    const importRow = requiredIndexed(importRows, row.import_row_id, "import_rows");
    assertSame(row.import_job_id, importRow.import_job_id, "import_errors.import_row_id");
  }
  for (const row of sections.source_records) {
    const importRow = requiredIndexed(importRows, row.import_row_id, "import_rows");
    assertSame(row.import_job_id, importRow.import_job_id, "source_records.import_row_id");
    const importJob = requiredIndexed(importJobs, row.import_job_id, "import_jobs");
    assertSame(
      row.source_system,
      importJob.source_system,
      "source_records.source_system",
    );
    assertSame(
      row.source_table,
      importJob.source_table,
      "source_records.source_table",
    );
    let targetFieldId;
    if (row.target_entity === "field_external_identifier") {
      targetFieldId = requiredIndexed(
        fieldExternalIdentifiers,
        row.target_id,
        "field_external_identifiers",
      ).field_id;
    } else if (row.target_entity === "livestock_animal") {
      targetFieldId = animalField(row.target_id);
    } else if (row.target_entity === "livestock_animal_identifier") {
      targetFieldId = requiredIndexed(
        animalIdentifiers,
        row.target_id,
        "livestock_animal_identifiers",
      ).field_id;
    } else if (row.target_entity === "livestock_lot_membership") {
      targetFieldId = lotField(
        requiredIndexed(
          lotMemberships,
          row.target_id,
          "livestock_lot_memberships",
        ).lot_id,
      );
    } else if (row.target_entity === "livestock_milk_control") {
      targetFieldId = requiredIndexed(
        milkControls,
        row.target_id,
        "livestock_milk_controls",
      ).field_id;
    } else if (row.target_entity === "livestock_reproductive_event") {
      targetFieldId = requiredIndexed(
        reproductiveEvents,
        row.target_id,
        "livestock_reproductive_events",
      ).field_id;
    } else {
      fail(
        "UNRESOLVED_POLYMORPHIC_REFERENCE",
        "source_records contiene un objetivo no verificable.",
      );
    }
    assertSame(
      importJob.field_id,
      targetFieldId,
      "source_records.target_id",
    );
  }
  for (const row of sections.fields) {
    requiredIndexed(fields, row.id, "fields");
  }
}

function assertCellOperationScope(row, column, operations) {
  const operation = requiredIndexed(operations, row[column], "paddock_cell_operations");
  assertSame(row.field_id, operation.field_id, `paddock_cells.${column}`);
  assertSame(row.paddock_id, operation.paddock_id, `paddock_cells.${column}`);
}

function assertRowSchemaCoverage() {
  const catalogSections = [...PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES]
    .sort(compareCodePoint);
  const schemaSections = Object.keys(ROW_SCHEMAS).sort(compareCodePoint);
  if (!sameStringArray(catalogSections, schemaSections)) {
    fail(
      "ROW_SCHEMA_MISSING",
      "El catálogo portable y sus esquemas de filas no coinciden exactamente.",
    );
  }
}

function indexRows(rows) {
  return new Map(rows.map((row) => [row.id ?? row.field_id, row]));
}

function requiredIndexed(index, id, section) {
  const row = index.get(id);
  if (!row) fail("UNRESOLVED_REFERENCE", `${section} no contiene ${String(id)}.`);
  return row;
}

function assertSame(left, right, label) {
  if (left !== right) {
    fail("CROSS_SCOPE_REFERENCE", `${label} cruza el alcance portable.`);
  }
}

function assertCanonicalOrder(section, rows) {
  const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
  const primaryKeys = new Set();
  let previous = null;
  for (const row of rows) {
    const primaryKey = JSON.stringify(
      descriptor.primaryKey.map((column) => row[column]),
    );
    if (primaryKeys.has(primaryKey)) {
      fail("DUPLICATE_PRIMARY_KEY", `${section} repite una clave primaria.`);
    }
    primaryKeys.add(primaryKey);
    if (previous && compareRows(previous, row, descriptor.orderBy) > 0) {
      fail("NON_CANONICAL_ROW_ORDER", `${section} no está ordenada canónicamente.`);
    }
    previous = row;
  }
}

function compareRows(left, right, orderBy) {
  for (const column of orderBy) {
    const comparison = compareSqliteValues(left[column], right[column]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareSqliteValues(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === false ? -1 : 1;
  }
  return compareCodePoint(String(left), String(right));
}

function rowSchema(input) {
  return Object.freeze({
    integer: new Set(input.integer ?? []),
    number: new Set(input.number ?? []),
    nullable: new Set(input.nullable ?? []),
  });
}

function words(value) {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function requiredText(value, label) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > 300
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("INVALID_SCOPE", `${label} no es texto portable válido.`);
  }
  return value;
}

function uniqueSortedText(value, label) {
  assertDenseArray(value, "INVALID_SCOPE", label);
  const normalized = value.map((entry, index) =>
    requiredText(entry, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("INVALID_SCOPE", `${label} contiene duplicados.`);
  }
  return normalized.sort(compareCodePoint);
}

function assertDenseArray(value, code, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, `${label} debe ser un arreglo simple.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string")
    || ownKeys.length !== value.length + 1
    || !ownKeys.includes("length")
  ) {
    fail(code, `${label} debe ser un arreglo denso sin propiedades extra.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) {
      fail(code, `${label} no puede contener posiciones vacías.`);
    }
  }
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
  const actual = ownStringKeys(value, code, label).sort(compareCodePoint);
  const sortedExpected = [...expected].sort(compareCodePoint);
  if (!sameStringArray(actual, sortedExpected)) {
    fail(code, `${label} contiene columnas inesperadas o incompletas.`);
  }
}

function ownStringKeys(value, code, label) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(code, `${label} contiene claves no textuales.`);
  }
  return keys;
}

function ownDataValue(value, key, code, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
    fail(code, `${label} debe ser una propiedad de datos enumerable.`);
  }
  return descriptor.value;
}

function normalizedKeyName(value) {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
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
  throw new PortableWorkspaceV2RowError(code, message);
}
