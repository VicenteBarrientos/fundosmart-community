import {
  PORTABLE_WORKSPACE_V2_D1_POLICY,
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
} from "./workspace-portable-v2-policy.mjs";

export const PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION = 2;
export const PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT = "ffd34ac6856f0feb";

export const PORTABLE_WORKSPACE_V2_SCOPE_STRATEGIES = Object.freeze([
  "field_root",
  "direct_field",
  "organization_field_pair",
  "through_paddock",
  "through_lot",
  "through_animal",
  "through_birth",
  "through_import_job",
  "through_import_job_and_row",
  "organization_expense",
  "organization_partner_reference",
  "lot_membership",
  "organization_audit",
]);

export const PORTABLE_WORKSPACE_V2_COLUMN_DECISION_REASONS = Object.freeze([
  "internal_object_key",
  "pseudonymization_policy_required",
  "target_section_not_projected",
  "source_profile_not_projected",
  "unbounded_json_policy_required",
  "unsafe_internal_error_text",
]);

export const PORTABLE_WORKSPACE_V2_RELATION_MATCHES = Object.freeze([
  "required",
  "optional",
  "referenced_by",
]);

export const PORTABLE_WORKSPACE_V2_SCOPE_REQUIREMENTS = Object.freeze([
  "all_relations_required",
  "animal_and_lactation_same_field",
  "animal_current_lot_same_organization",
  "animal_in_exact_snapshot",
  "animal_links_same_scope",
  "animal_same_field",
  "birth_in_exact_snapshot",
  "entity_reference_resolves_included_entity_when_supported",
  "exact_field_set",
  "field_in_exact_snapshot",
  "import_job_and_row_same_scope",
  "import_job_same_scope",
  "landmark_same_field",
  "last_operation_same_scope",
  "lot_same_field",
  "membership_lot_in_snapshot",
  "nullable_field_in_exact_snapshot",
  "optional_animal_same_scope",
  "optional_paddock_same_field",
  "optional_partner_and_lot_same_organization",
  "optional_recorded_lot_same_organization",
  "organization_field_pair_match",
  "organization_match",
  "organization_wide_events_require_included_import_lineage",
  "paddock_and_operations_same_scope",
  "paddock_same_field",
  "referenced_by_included_expense",
  "source_record_same_scope",
  "source_system_profile_required",
  "target_allowlist_resolves_included_entity",
]);

export const PORTABLE_WORKSPACE_V2_ACTIVATION_REQUIREMENTS = Object.freeze([
  "global_rows_gate",
  "owner_admin_authorization",
  "final_scope_reauthorization",
  "deterministic_snapshot",
  "relation_validation",
  "strict_json_parse",
  "unbounded_json_policy",
  "boolean_normalization",
  "pseudonymization_policy",
  "sensitive_content_authorization",
  "free_text_policy",
  "blocked_columns_resolved",
  "blocked_reference_targets_resolved",
  "omissions_declared_in_manifest",
]);

export const PORTABLE_WORKSPACE_V2_FILTER_OPERATORS = Object.freeze(["equals"]);

export const PORTABLE_WORKSPACE_V2_COOPRINSEM_IMPORT_SECTIONS = Object.freeze([
  "import_errors",
  "import_jobs",
  "import_rows",
  "source_records",
]);

export const PORTABLE_WORKSPACE_V2_COOPRINSEM_IMPORT_FILTER = deepFreeze({
  table: "import_jobs",
  column: "source_system",
  operator: "equals",
  value: "cooprinsem",
});

export const PORTABLE_WORKSPACE_V2_REFERENCE_UNKNOWN_HANDLINGS = Object.freeze([
  "reject_unknown",
  "require_direct_field_or_source_record_for_unknown",
]);

export const PORTABLE_WORKSPACE_V2_REFERENCE_DISPOSITIONS = Object.freeze([
  "projected",
  "blocked_target_section",
  "excluded_target_section",
]);

const COLUMN_REASONS = Object.freeze(Object.fromEntries(
  PORTABLE_WORKSPACE_V2_COLUMN_DECISION_REASONS.map((reason) => [reason, reason]),
));

export const PORTABLE_WORKSPACE_V2_AUDIT_ENTITY_TARGETS = deepFreeze({
  import_job: referenceTarget("import_jobs", "id", "projected"),
});

export const PORTABLE_WORKSPACE_V2_SOURCE_RECORD_TARGETS = deepFreeze({
  field_external_identifier: referenceTarget(
    "field_external_identifiers",
    "id",
    "projected",
  ),
  livestock_animal: referenceTarget("livestock_animals", "id", "projected"),
  livestock_animal_identifier: referenceTarget(
    "livestock_animal_identifiers",
    "id",
    "projected",
  ),
  livestock_lot_membership: referenceTarget(
    "livestock_lot_memberships",
    "id",
    "projected",
  ),
  livestock_milk_control: referenceTarget(
    "livestock_milk_controls",
    "id",
    "projected",
  ),
  livestock_reproductive_event: referenceTarget(
    "livestock_reproductive_events",
    "id",
    "projected",
  ),
  milk_quality_sample: referenceTarget(
    "milk_quality_samples",
    "id",
    "excluded_target_section",
  ),
});

const CATALOG_INPUT = {
  activities: projection({
    columns: words(`
      id paddock_id type occurred_at description quantity unit cost_clp
      created_at updated_at deleted_at
    `),
    freeTextColumns: ["description"],
    scope: scope("through_paddock", [
      relation("activities", "paddock_id", "potreros", "id"),
      relation("potreros", "field_id", "fields", "id"),
    ], ["all_relations_required", "field_in_exact_snapshot"]),
    orderBy: ["paddock_id", "occurred_at", "id"],
  }),
  audit_log: projection({
    columns: words(`
      id organization_id field_id action entity_type entity_id occurred_at
    `),
    blockedColumns: blocked({
      actor: COLUMN_REASONS.pseudonymization_policy_required,
      before: COLUMN_REASONS.unbounded_json_policy_required,
      after: COLUMN_REASONS.unbounded_json_policy_required,
      source_record_id: COLUMN_REASONS.source_profile_not_projected,
    }),
    jsonColumns: {
      unbounded: ["before", "after"],
    },
    humanIdentityColumns: ["actor"],
    sensitiveContentColumns: ["before", "after"],
    scope: scope("organization_audit", [
      relation("audit_log", "field_id", "fields", "id", "optional"),
      relation("audit_log", "source_record_id", "source_records", "id", "optional"),
      relation("source_records", "import_job_id", "import_jobs", "id"),
      relation("import_jobs", "field_id", "fields", "id"),
      relation("import_jobs", "organization_id", "fields", "organization_id"),
    ], [
      "organization_match",
      "nullable_field_in_exact_snapshot",
      "organization_wide_events_require_included_import_lineage",
      "entity_reference_resolves_included_entity_when_supported",
    ], [], [
      polymorphicReference(
        "entity_type",
        "entity_id",
        "require_direct_field_or_source_record_for_unknown",
        PORTABLE_WORKSPACE_V2_AUDIT_ENTITY_TARGETS,
      ),
    ]),
    orderBy: ["occurred_at", "id"],
  }),
  field_external_identifiers: projection({
    columns: words(`
      id organization_id field_id source_system kind value normalized_value
      valid_from valid_to created_at updated_at
    `),
    sensitiveContentColumns: ["value", "normalized_value"],
    scope: organizationFieldScope("field_external_identifiers"),
    orderBy: ["field_id", "id"],
  }),
  field_landmark_operations: projection({
    columns: words(`
      id organization_id field_id landmark_id kind request_hash expected_version
      request result committed_at
    `),
    blockedColumns: blocked({
      actor: COLUMN_REASONS.pseudonymization_policy_required,
    }),
    jsonColumns: {
      known: ["request", "result"],
    },
    humanIdentityColumns: ["actor"],
    sensitiveContentColumns: ["request", "result"],
    scope: scope("organization_field_pair", [
      relation("field_landmark_operations", "field_id", "fields", "id"),
      relation("field_landmark_operations", "organization_id", "fields", "organization_id"),
      relation("field_landmark_operations", "landmark_id", "field_landmarks", "id"),
    ], ["organization_field_pair_match", "landmark_same_field"]),
    orderBy: ["field_id", "committed_at", "id"],
  }),
  field_landmarks: projection({
    columns: words(`
      id field_id kind geometry_type geometry name notes length_meters created_at
      updated_at deleted_at version last_operation_id
    `),
    jsonColumns: {
      known: ["geometry"],
    },
    freeTextColumns: ["notes"],
    sensitiveContentColumns: ["geometry"],
    scope: scope("direct_field", [
      relation("field_landmarks", "field_id", "fields", "id"),
      relation("field_landmarks", "last_operation_id", "field_landmark_operations", "id"),
    ], ["field_in_exact_snapshot", "last_operation_same_scope"]),
    orderBy: ["field_id", "created_at", "id"],
  }),
  fields: projection({
    columns: words(`
      id organization_id name location is_demo area_hectares coordinates
      soil_report_filename soil_report_folio soil_sample_id soil_report_date created_at
    `),
    jsonColumns: {
      known: ["coordinates"],
    },
    booleanColumns: ["is_demo"],
    sensitiveContentColumns: [
      "location",
      "coordinates",
      "soil_report_filename",
      "soil_report_folio",
      "soil_sample_id",
    ],
    scope: scope("field_root", [], ["exact_field_set", "organization_match"]),
    orderBy: ["id"],
  }),
  import_errors: projection({
    columns: words(`
      id import_job_id import_row_id field_name rule_code severity message status
      resolution_notes resolved_at created_at updated_at
    `),
    blockedColumns: blocked({
      source_value: COLUMN_REASONS.unbounded_json_policy_required,
      resolved_by: COLUMN_REASONS.pseudonymization_policy_required,
    }),
    jsonColumns: {
      unbounded: ["source_value"],
    },
    humanIdentityColumns: ["resolved_by"],
    freeTextColumns: ["message", "resolution_notes"],
    sensitiveContentColumns: ["field_name", "source_value"],
    scope: importJobAndRowScope("import_errors", "import_row_id"),
    orderBy: ["import_job_id", "import_row_id", "id"],
  }),
  import_jobs: projection({
    columns: words(`
      id organization_id field_id source_system source_format source_table
      original_filename content_type file_size_bytes sha256 mapping_version effective_at
      status is_dry_run row_count valid_row_count warning_row_count error_row_count
      skipped_row_count file_issue_count started_at previewed_at confirmed_at completed_at
      created_at updated_at
    `),
    omittedColumns: omitted({
      object_key: COLUMN_REASONS.internal_object_key,
    }),
    blockedColumns: blocked({
      requested_by: COLUMN_REASONS.pseudonymization_policy_required,
      failure_message: COLUMN_REASONS.unsafe_internal_error_text,
    }),
    booleanColumns: ["is_dry_run"],
    humanIdentityColumns: ["requested_by"],
    freeTextColumns: ["original_filename", "failure_message"],
    sensitiveContentColumns: ["original_filename"],
    scope: organizationFieldScope("import_jobs", [
      predicate("import_jobs", "source_system", "equals", "cooprinsem"),
    ]),
    orderBy: ["field_id", "created_at", "id"],
  }),
  import_rows: projection({
    columns: words(`
      id import_job_id record_number source_key status warning_count error_count
      created_at updated_at
    `),
    blockedColumns: blocked({
      raw_record: COLUMN_REASONS.unbounded_json_policy_required,
      normalized_record: COLUMN_REASONS.unbounded_json_policy_required,
    }),
    jsonColumns: {
      unbounded: ["raw_record", "normalized_record"],
    },
    sensitiveContentColumns: ["source_key", "raw_record", "normalized_record"],
    scope: importJobScope("import_rows"),
    orderBy: ["import_job_id", "record_number", "id"],
  }),
  livestock_animal_identifiers: projection({
    columns: words(`
      id field_id animal_id source_system kind value normalized_value valid_from
      valid_to is_primary created_at updated_at
    `),
    booleanColumns: ["is_primary"],
    sensitiveContentColumns: ["value", "normalized_value"],
    scope: scope("direct_field", [
      relation("livestock_animal_identifiers", "field_id", "fields", "id"),
      relation("livestock_animal_identifiers", "animal_id", "livestock_animals", "id"),
      relation("livestock_animals", "lot_id", "livestock_lots", "id"),
      relation("livestock_lots", "field_id", "fields", "id"),
    ], ["field_in_exact_snapshot", "animal_same_field"]),
    orderBy: ["field_id", "animal_id", "id"],
  }),
  livestock_animals: projection({
    columns: words(`
      id lot_id tag sex status status_date status_reason birth_date purchase_price_clp
      purchase_date sale_price_clp sale_buyer sale_weight_kg origin notes source
      created_at updated_at
    `),
    freeTextColumns: ["status_reason", "origin", "notes"],
    sensitiveContentColumns: ["tag", "sale_buyer"],
    scope: scope("through_lot", [
      relation("livestock_animals", "lot_id", "livestock_lots", "id"),
      relation("livestock_lots", "field_id", "fields", "id"),
    ], ["all_relations_required", "field_in_exact_snapshot"]),
    orderBy: ["lot_id", "id"],
  }),
  livestock_birth_offspring: projection({
    columns: words(`
      id birth_id animal_id temporary_identifier sex outcome birth_weight_kg notes
      created_at updated_at
    `),
    freeTextColumns: ["notes"],
    sensitiveContentColumns: ["temporary_identifier"],
    scope: scope("through_birth", [
      relation("livestock_birth_offspring", "birth_id", "livestock_births", "id"),
      relation("livestock_births", "field_id", "fields", "id"),
      relation("livestock_birth_offspring", "animal_id", "livestock_animals", "id", "optional"),
    ], ["birth_in_exact_snapshot", "optional_animal_same_scope"]),
    orderBy: ["birth_id", "id"],
  }),
  livestock_births: projection({
    columns: words(`
      id field_id dam_animal_id reproductive_event_id occurred_at calving_type difficulty
      outcome sire_identifier notes source created_at updated_at sire_animal_id
    `),
    blockedColumns: blocked({
      created_by: COLUMN_REASONS.pseudonymization_policy_required,
      source_record_id: COLUMN_REASONS.source_profile_not_projected,
    }),
    humanIdentityColumns: ["created_by"],
    freeTextColumns: ["notes"],
    sensitiveContentColumns: ["sire_identifier"],
    scope: scope("direct_field", [
      relation("livestock_births", "field_id", "fields", "id"),
      relation("livestock_births", "dam_animal_id", "livestock_animals", "id"),
      relation("livestock_births", "reproductive_event_id", "livestock_reproductive_events", "id", "optional"),
      relation("livestock_births", "sire_animal_id", "livestock_animals", "id", "optional"),
      relation("livestock_births", "source_record_id", "source_records", "id", "optional"),
    ], ["field_in_exact_snapshot", "animal_links_same_scope", "source_record_same_scope"]),
    orderBy: ["field_id", "occurred_at", "dam_animal_id", "id"],
  }),
  livestock_expenses: projection({
    columns: words(`
      id organization_id field_id date description category amount_clp payment_source
      paid_by_id lot_id created_at
    `),
    freeTextColumns: ["description"],
    scope: scope("organization_expense", [
      relation("livestock_expenses", "field_id", "fields", "id", "optional"),
      relation("livestock_expenses", "paid_by_id", "livestock_partners", "id", "optional"),
      relation("livestock_expenses", "lot_id", "livestock_lots", "id", "optional"),
    ], [
      "organization_match",
      "nullable_field_in_exact_snapshot",
      "optional_partner_and_lot_same_organization",
    ]),
    orderBy: ["field_id", "date", "id"],
  }),
  livestock_feeding_plans: projection({
    columns: words(`
      id lot_id product_name kg_per_animal_day sack_weight_kg notes created_at updated_at
    `),
    freeTextColumns: ["notes"],
    scope: scope("through_lot", [
      relation("livestock_feeding_plans", "lot_id", "livestock_lots", "id"),
      relation("livestock_lots", "field_id", "fields", "id"),
    ], ["all_relations_required", "field_in_exact_snapshot"]),
    orderBy: ["lot_id", "id"],
  }),
  livestock_health_events: projection({
    columns: words(`
      id field_id animal_id event_type occurred_at status condition product_name
      active_ingredient dose_amount dose_unit route withdrawal_milk_until
      withdrawal_meat_until professional notes source created_at updated_at
    `),
    blockedColumns: blocked({
      metadata: COLUMN_REASONS.unbounded_json_policy_required,
      created_by: COLUMN_REASONS.pseudonymization_policy_required,
      source_record_id: COLUMN_REASONS.source_profile_not_projected,
    }),
    jsonColumns: {
      unbounded: ["metadata"],
    },
    humanIdentityColumns: ["created_by"],
    freeTextColumns: ["condition", "notes"],
    sensitiveContentColumns: ["professional", "metadata"],
    scope: scope("direct_field", [
      relation("livestock_health_events", "field_id", "fields", "id"),
      relation("livestock_health_events", "animal_id", "livestock_animals", "id"),
      relation("livestock_health_events", "source_record_id", "source_records", "id", "optional"),
    ], ["field_in_exact_snapshot", "animal_same_field", "source_record_same_scope"]),
    orderBy: ["field_id", "occurred_at", "animal_id", "id"],
  }),
  livestock_lactations: projection({
    columns: words(`
      id field_id animal_id sequence_number calving_date started_at ended_at status
      dry_off_reason source created_at updated_at
    `),
    blockedColumns: blocked({
      created_by: COLUMN_REASONS.pseudonymization_policy_required,
      source_record_id: COLUMN_REASONS.source_profile_not_projected,
    }),
    humanIdentityColumns: ["created_by"],
    freeTextColumns: ["dry_off_reason"],
    scope: scope("direct_field", [
      relation("livestock_lactations", "field_id", "fields", "id"),
      relation("livestock_lactations", "animal_id", "livestock_animals", "id"),
      relation("livestock_lactations", "source_record_id", "source_records", "id", "optional"),
    ], ["field_in_exact_snapshot", "animal_same_field", "source_record_same_scope"]),
    orderBy: ["field_id", "animal_id", "sequence_number", "id"],
  }),
  livestock_lot_external_identifiers: projection({
    columns: words(`
      id field_id lot_id source_system kind value normalized_value valid_from valid_to
      created_at updated_at
    `),
    sensitiveContentColumns: ["value", "normalized_value"],
    scope: scope("direct_field", [
      relation("livestock_lot_external_identifiers", "field_id", "fields", "id"),
      relation("livestock_lot_external_identifiers", "lot_id", "livestock_lots", "id"),
    ], ["field_in_exact_snapshot", "lot_same_field"]),
    orderBy: ["field_id", "lot_id", "id"],
  }),
  livestock_lot_memberships: projection({
    columns: words(`
      id animal_id lot_id started_at ended_at source_system created_at updated_at
    `),
    scope: scope("lot_membership", [
      relation("livestock_lot_memberships", "lot_id", "livestock_lots", "id"),
      relation("livestock_lot_memberships", "animal_id", "livestock_animals", "id"),
      relation("livestock_animals", "lot_id", "livestock_lots", "id"),
      relation("livestock_lots", "field_id", "fields", "id"),
    ], ["membership_lot_in_snapshot", "animal_current_lot_same_organization"]),
    orderBy: ["lot_id", "animal_id", "started_at", "id"],
  }),
  livestock_lots: projection({
    columns: words(`
      id field_id paddock_id name category animal_count average_weight_kg entry_date
      status notes created_at updated_at owner_name tracking_mode
    `),
    freeTextColumns: ["notes"],
    sensitiveContentColumns: ["owner_name"],
    scope: scope("direct_field", [
      relation("livestock_lots", "field_id", "fields", "id"),
      relation("livestock_lots", "paddock_id", "potreros", "id", "optional"),
    ], ["field_in_exact_snapshot", "optional_paddock_same_field"]),
    orderBy: ["field_id", "id"],
  }),
  livestock_milk_controls: projection({
    columns: words(`
      id field_id animal_id lactation_id control_date morning_liters afternoon_liters
      third_milking_liters total_liters fat_pct protein_pct somatic_cell_count notes
      source created_at updated_at
    `),
    blockedColumns: blocked({
      created_by: COLUMN_REASONS.pseudonymization_policy_required,
      source_record_id: COLUMN_REASONS.source_profile_not_projected,
    }),
    humanIdentityColumns: ["created_by"],
    freeTextColumns: ["notes"],
    scope: scope("direct_field", [
      relation("livestock_milk_controls", "field_id", "fields", "id"),
      relation("livestock_milk_controls", "animal_id", "livestock_animals", "id"),
      relation("livestock_milk_controls", "lactation_id", "livestock_lactations", "id", "optional"),
      relation("livestock_milk_controls", "source_record_id", "source_records", "id", "optional"),
    ], [
      "field_in_exact_snapshot",
      "animal_and_lactation_same_field",
      "source_record_same_scope",
    ]),
    orderBy: ["field_id", "control_date", "animal_id", "id"],
  }),
  livestock_partners: projection({
    columns: words(`
      id organization_id name email created_at
    `),
    sensitiveContentColumns: ["name", "email"],
    scope: scope("organization_partner_reference", [
      relation("livestock_expenses", "paid_by_id", "livestock_partners", "id", "referenced_by"),
      relation("livestock_expenses", "field_id", "fields", "id", "optional"),
    ], ["organization_match", "referenced_by_included_expense"]),
    orderBy: ["organization_id", "id"],
  }),
  livestock_reproductive_events: projection({
    columns: words(`
      id field_id animal_id event_type occurred_at method result sire_identifier notes
      source created_at updated_at sire_animal_id
    `),
    blockedColumns: blocked({
      metadata: COLUMN_REASONS.unbounded_json_policy_required,
      created_by: COLUMN_REASONS.pseudonymization_policy_required,
      source_record_id: COLUMN_REASONS.source_profile_not_projected,
    }),
    jsonColumns: {
      unbounded: ["metadata"],
    },
    humanIdentityColumns: ["created_by"],
    freeTextColumns: ["method", "result", "notes"],
    sensitiveContentColumns: ["sire_identifier", "metadata"],
    scope: scope("direct_field", [
      relation("livestock_reproductive_events", "field_id", "fields", "id"),
      relation("livestock_reproductive_events", "animal_id", "livestock_animals", "id"),
      relation("livestock_reproductive_events", "sire_animal_id", "livestock_animals", "id", "optional"),
      relation("livestock_reproductive_events", "source_record_id", "source_records", "id", "optional"),
    ], ["field_in_exact_snapshot", "animal_links_same_scope", "source_record_same_scope"]),
    orderBy: ["field_id", "occurred_at", "animal_id", "id"],
  }),
  livestock_weighings: projection({
    columns: words(`
      id animal_id recorded_at weight_kg notes source created_at lot_id
    `),
    freeTextColumns: ["notes"],
    scope: scope("through_animal", [
      relation("livestock_weighings", "animal_id", "livestock_animals", "id"),
      relation("livestock_animals", "lot_id", "livestock_lots", "id"),
      relation("livestock_lots", "field_id", "fields", "id"),
      relation("livestock_weighings", "lot_id", "livestock_lots", "id", "optional"),
    ], ["animal_in_exact_snapshot", "optional_recorded_lot_same_organization"]),
    orderBy: ["animal_id", "recorded_at", "id"],
  }),
  milk_settlements: projection({
    columns: words(`
      id field_id period generated_at plant purchase_order producer_code producer_name
      buyer_name liters_first_half liters_second_half total_liters net_amount_clp
      tax_amount_clp gross_amount_clp net_price_per_liter_clp gross_price_per_liter_clp
      source_document_name notes line_items created_at updated_at
    `),
    jsonColumns: {
      known: ["line_items"],
    },
    freeTextColumns: ["notes"],
    sensitiveContentColumns: [
      "purchase_order",
      "producer_code",
      "producer_name",
      "buyer_name",
      "source_document_name",
      "line_items",
    ],
    scope: directFieldScope("milk_settlements"),
    orderBy: ["field_id", "period", "id"],
  }),
  paddock_cell_operations: projection({
    columns: words(`
      id organization_id field_id paddock_id kind request_hash snapshot_token
      request result committed_at
    `),
    blockedColumns: blocked({
      actor: COLUMN_REASONS.pseudonymization_policy_required,
    }),
    jsonColumns: {
      known: ["request", "result"],
    },
    humanIdentityColumns: ["actor"],
    sensitiveContentColumns: ["request", "result"],
    scope: scope("organization_field_pair", [
      relation("paddock_cell_operations", "field_id", "fields", "id"),
      relation("paddock_cell_operations", "organization_id", "fields", "organization_id"),
      relation("paddock_cell_operations", "paddock_id", "potreros", "id"),
    ], ["organization_field_pair_match", "paddock_same_field"]),
    orderBy: ["field_id", "paddock_id", "committed_at", "id"],
  }),
  paddock_cells: projection({
    columns: words(`
      id field_id paddock_id name cell_index coordinates area_square_meters
      start_distance_meters end_distance_meters active_from active_to created_at
      updated_at version created_by_operation_id closed_by_operation_id
    `),
    jsonColumns: {
      known: ["coordinates"],
    },
    sensitiveContentColumns: ["coordinates"],
    scope: scope("direct_field", [
      relation("paddock_cells", "field_id", "fields", "id"),
      relation("paddock_cells", "paddock_id", "potreros", "id"),
      relation("paddock_cells", "created_by_operation_id", "paddock_cell_operations", "id"),
      relation("paddock_cells", "closed_by_operation_id", "paddock_cell_operations", "id", "optional"),
    ], ["field_in_exact_snapshot", "paddock_and_operations_same_scope"]),
    orderBy: ["field_id", "paddock_id", "active_from", "cell_index", "id"],
  }),
  paddock_ndvi: projection({
    columns: words(`
      id organization_id field_id paddock_id month status mean_ndvi no_data_reason
      cloud_pct cloud_pct_is_approximate interval_from interval_to observed_at
      sample_count no_data_count valid_sample_count computed_at geometry_snapshot
      paddock_snapshot geometry_snapshot_token
    `),
    jsonColumns: {
      known: ["geometry_snapshot", "paddock_snapshot"],
    },
    booleanColumns: ["cloud_pct_is_approximate"],
    sensitiveContentColumns: ["geometry_snapshot", "paddock_snapshot"],
    scope: scope("organization_field_pair", [
      relation("paddock_ndvi", "field_id", "fields", "id"),
      relation("paddock_ndvi", "organization_id", "fields", "organization_id"),
      relation("paddock_ndvi", "paddock_id", "potreros", "id"),
    ], ["organization_field_pair_match", "paddock_same_field"]),
    orderBy: ["field_id", "paddock_id", "month", "id"],
  }),
  paddock_rotation_setting_operations: projection({
    columns: words(`
      id organization_id field_id request_hash expected_version result committed_at
    `),
    blockedColumns: blocked({
      actor: COLUMN_REASONS.pseudonymization_policy_required,
    }),
    jsonColumns: {
      known: ["result"],
    },
    humanIdentityColumns: ["actor"],
    scope: organizationFieldScope("paddock_rotation_setting_operations"),
    orderBy: ["field_id", "committed_at", "id"],
  }),
  paddock_rotation_settings: projection({
    columns: words(`
      field_id recent_days long_rest_days created_at updated_at version
    `),
    primaryKey: ["field_id"],
    scope: directFieldScope("paddock_rotation_settings"),
    orderBy: ["field_id"],
  }),
  potreros: projection({
    columns: words(`
      id field_id name sector area_hectares coordinates grazeable_area_hectares
      land_use hole_kinds soil_ph soil_nitrogen soil_phosphorus soil_potassium
      last_activity status created_at updated_at deleted_at archived_at archive_reason
    `),
    blockedColumns: blocked({
      created_by_operation_id: COLUMN_REASONS.target_section_not_projected,
      archived_by_operation_id: COLUMN_REASONS.target_section_not_projected,
    }),
    jsonColumns: {
      known: ["coordinates", "hole_kinds"],
    },
    sensitiveContentColumns: ["coordinates", "hole_kinds"],
    scope: directFieldScope("potreros"),
    orderBy: ["field_id", "id"],
  }),
  source_records: projection({
    columns: words(`
      id import_job_id import_row_id source_system source_table source_key
      target_entity target_id created_at
    `),
    sensitiveContentColumns: ["source_key", "target_id"],
    scope: scope("through_import_job_and_row", [
      relation("source_records", "import_job_id", "import_jobs", "id"),
      relation("source_records", "import_row_id", "import_rows", "id"),
      relation("import_rows", "import_job_id", "import_jobs", "id"),
      relation("import_jobs", "field_id", "fields", "id"),
      relation("import_jobs", "organization_id", "fields", "organization_id"),
    ], [
      "import_job_and_row_same_scope",
      "target_allowlist_resolves_included_entity",
      "source_system_profile_required",
    ], [
      predicate("import_jobs", "source_system", "equals", "cooprinsem"),
    ], [
      polymorphicReference(
        "target_entity",
        "target_id",
        "reject_unknown",
        PORTABLE_WORKSPACE_V2_SOURCE_RECORD_TARGETS,
      ),
    ]),
    orderBy: ["import_job_id", "import_row_id", "id"],
  }),
  subdivision_drafts: projection({
    columns: words(`
      field_id history line updated_at
    `),
    primaryKey: ["field_id"],
    jsonColumns: {
      known: ["history", "line"],
    },
    sensitiveContentColumns: ["history", "line"],
    scope: directFieldScope("subdivision_drafts"),
    orderBy: ["field_id"],
  }),
};

export const PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS = deepFreeze(
  Object.fromEntries(
    Object.entries(CATALOG_INPUT).sort(([left], [right]) => compareCodePoint(left, right)),
  ),
);

export const PORTABLE_WORKSPACE_V2_MANIFEST_PROJECTION_POLICY = deepFreeze({
  generatedBy: {
    handling: "identity_sha256_pseudonym",
    source: "authenticated_actor",
  },
});

const DESCRIPTOR_KEYS = Object.freeze([
  "activationRequirements",
  "blockedColumns",
  "booleanColumns",
  "columns",
  "freeTextColumns",
  "humanIdentityColumns",
  "jsonColumns",
  "omittedColumns",
  "orderBy",
  "primaryKey",
  "scope",
  "sensitiveContentColumns",
]);
const JSON_COLUMN_KEYS = Object.freeze(["known", "unbounded"]);
const SCOPE_KEYS = Object.freeze([
  "filters",
  "polymorphicReferences",
  "relations",
  "requirements",
  "strategy",
]);
const RELATION_KEYS = Object.freeze(["from", "match", "to"]);
const ENDPOINT_KEYS = Object.freeze(["column", "table"]);
const DECISION_KEYS = Object.freeze(["name", "reason"]);
const FILTER_KEYS = Object.freeze(["column", "operator", "table", "value"]);
const POLYMORPHIC_REFERENCE_KEYS = Object.freeze([
  "discriminatorColumn",
  "idColumn",
  "targets",
  "unknownHandling",
]);
const REFERENCE_TARGET_KEYS = Object.freeze(["column", "disposition", "table"]);

validatePortableWorkspaceV2ProjectionCatalog();

export function validatePortableWorkspaceV2ProjectionCatalog(
  catalog = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
) {
  assertPlainRecord(catalog, "INVALID_CATALOG", "The projection catalog must be a plain object.");
  assertSameSet(
    Object.keys(catalog),
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
    "CATALOG_SECTION_MISMATCH",
  );

  for (const [section, descriptor] of Object.entries(catalog)) {
    assertPlainRecord(descriptor, "INVALID_DESCRIPTOR", `${section} must be a plain descriptor.`);
    assertExactKeys(descriptor, DESCRIPTOR_KEYS, "INVALID_DESCRIPTOR", section);
    for (const property of [
      "columns",
      "booleanColumns",
      "humanIdentityColumns",
      "sensitiveContentColumns",
      "freeTextColumns",
      "orderBy",
      "primaryKey",
      "activationRequirements",
    ]) {
      assertStringArray(descriptor[property], "INVALID_DESCRIPTOR", `${section}.${property}`);
    }
    assertDecisionArray(descriptor.omittedColumns, `${section}.omittedColumns`);
    assertDecisionArray(descriptor.blockedColumns, `${section}.blockedColumns`);
    assertPlainRecord(
      descriptor.jsonColumns,
      "INVALID_DESCRIPTOR",
      `${section}.jsonColumns must be a plain object.`,
    );
    assertExactKeys(
      descriptor.jsonColumns,
      JSON_COLUMN_KEYS,
      "INVALID_DESCRIPTOR",
      `${section}.jsonColumns`,
    );
    assertStringArray(
      descriptor.jsonColumns.known,
      "INVALID_DESCRIPTOR",
      `${section}.jsonColumns.known`,
    );
    assertStringArray(
      descriptor.jsonColumns.unbounded,
      "INVALID_DESCRIPTOR",
      `${section}.jsonColumns.unbounded`,
    );
    assertPlainRecord(descriptor.scope, "INVALID_SCOPE", `${section}.scope must be a plain object.`);
    assertExactKeys(descriptor.scope, SCOPE_KEYS, "INVALID_SCOPE", `${section}.scope`);
    assertStringArray(
      descriptor.scope.requirements,
      "INVALID_SCOPE",
      `${section}.scope.requirements`,
    );
    if (!Array.isArray(descriptor.scope.relations)) {
      fail("INVALID_SCOPE", `${section}.scope.relations must be an array.`);
    }
    if (!Array.isArray(descriptor.scope.filters)) {
      fail("INVALID_SCOPE", `${section}.scope.filters must be an array.`);
    }
    if (!Array.isArray(descriptor.scope.polymorphicReferences)) {
      fail("INVALID_SCOPE", `${section}.scope.polymorphicReferences must be an array.`);
    }

    const omittedNames = descriptor.omittedColumns.map(({ name }) => name);
    const blockedNames = descriptor.blockedColumns.map(({ name }) => name);
    const classifiedColumns = [...descriptor.columns, ...omittedNames, ...blockedNames];
    assertUnique(classifiedColumns, `${section} classifies a physical column more than once.`);
    if (classifiedColumns.length === 0) fail("EMPTY_PROJECTION", `${section} has no classified columns.`);
    assertUnique(descriptor.orderBy, `${section} repeats an ordering column.`);
    assertUnique(descriptor.primaryKey, `${section} repeats a primary-key column.`);
    if (descriptor.primaryKey.length === 0) {
      fail("MISSING_PRIMARY_KEY", `${section} has no declared primary key.`);
    }
    for (const primaryColumn of descriptor.primaryKey) {
      if (
        !classifiedColumns.includes(primaryColumn)
        || !descriptor.orderBy.includes(primaryColumn)
      ) {
        fail(
          "INVALID_PRIMARY_KEY_ORDER",
          `${section}.${primaryColumn} must be classified and included in orderBy.`,
        );
      }
    }
    for (const orderColumn of descriptor.orderBy) {
      if (!classifiedColumns.includes(orderColumn)) {
        fail("INVALID_ORDER", `${section}.${orderColumn} is not a classified column.`);
      }
    }
    for (const [category, columns] of Object.entries({
      booleanColumns: descriptor.booleanColumns,
      humanIdentityColumns: descriptor.humanIdentityColumns,
      sensitiveContentColumns: descriptor.sensitiveContentColumns,
      freeTextColumns: descriptor.freeTextColumns,
      knownJsonColumns: descriptor.jsonColumns.known,
      unboundedJsonColumns: descriptor.jsonColumns.unbounded,
    })) {
      assertUnique(columns, `${section}.${category} repeats a column.`);
      for (const column of columns) {
        if (!classifiedColumns.includes(column)) {
          fail("UNKNOWN_CLASSIFIED_COLUMN", `${section}.${column} is not a physical column.`);
        }
      }
    }
    if (!PORTABLE_WORKSPACE_V2_SCOPE_STRATEGIES.includes(descriptor.scope.strategy)) {
      fail("INVALID_SCOPE_STRATEGY", `${section} has an unknown scope strategy.`);
    }
    if (descriptor.scope.requirements.length === 0) {
      fail("MISSING_SCOPE_REQUIREMENT", `${section} has no fail-closed scope requirement.`);
    }
    assertUnique(descriptor.scope.requirements, `${section} repeats a scope requirement.`);
    for (const requirement of descriptor.scope.requirements) {
      if (!PORTABLE_WORKSPACE_V2_SCOPE_REQUIREMENTS.includes(requirement)) {
        fail("INVALID_SCOPE_REQUIREMENT", `${section} has unknown requirement ${requirement}.`);
      }
    }
    assertUnique(
      descriptor.activationRequirements,
      `${section} repeats an activation requirement.`,
    );
    for (const requirement of descriptor.activationRequirements) {
      if (!PORTABLE_WORKSPACE_V2_ACTIVATION_REQUIREMENTS.includes(requirement)) {
        fail("INVALID_ACTIVATION_REQUIREMENT", `${section} has unknown activation requirement ${requirement}.`);
      }
    }
    if (!sameStringArray(
      descriptor.activationRequirements,
      activationRequirementsFor(descriptor),
    )) {
      fail(
        "ACTIVATION_REQUIREMENT_MISMATCH",
        `${section} activation requirements do not match its classified risks.`,
      );
    }
    for (const required of [
      "global_rows_gate",
      "owner_admin_authorization",
      "final_scope_reauthorization",
      "deterministic_snapshot",
    ]) {
      if (!descriptor.activationRequirements.includes(required)) {
        fail("MISSING_ACTIVATION_REQUIREMENT", `${section} is missing ${required}.`);
      }
    }
    for (const [columns, requirement] of [
      [descriptor.jsonColumns.known, "strict_json_parse"],
      [descriptor.jsonColumns.unbounded, "unbounded_json_policy"],
      [descriptor.booleanColumns, "boolean_normalization"],
      [descriptor.humanIdentityColumns, "pseudonymization_policy"],
      [descriptor.sensitiveContentColumns, "sensitive_content_authorization"],
      [descriptor.freeTextColumns, "free_text_policy"],
      [descriptor.blockedColumns, "blocked_columns_resolved"],
      [descriptor.omittedColumns, "omissions_declared_in_manifest"],
    ]) {
      if (columns.length > 0 && !descriptor.activationRequirements.includes(requirement)) {
        fail("MISSING_ACTIVATION_REQUIREMENT", `${section} is missing ${requirement}.`);
      }
    }
    for (const relationEntry of descriptor.scope.relations) {
      assertPlainRecord(
        relationEntry,
        "INVALID_RELATION",
        `${section} contains an invalid relation.`,
      );
      assertExactKeys(relationEntry, RELATION_KEYS, "INVALID_RELATION", `${section}.relation`);
      if (!PORTABLE_WORKSPACE_V2_RELATION_MATCHES.includes(relationEntry.match)) {
        fail("INVALID_RELATION_MATCH", `${section} has unknown relation match ${relationEntry.match}.`);
      }
      for (const endpoint of ["from", "to"]) {
        assertPlainRecord(
          relationEntry[endpoint],
          "INVALID_RELATION",
          `${section}.${endpoint} must be an endpoint.`,
        );
        assertExactKeys(
          relationEntry[endpoint],
          ENDPOINT_KEYS,
          "INVALID_RELATION",
          `${section}.${endpoint}`,
        );
        const { table, column } = relationEntry[endpoint];
        requiredToken(table, "INVALID_RELATION", `${section}.${endpoint}.table`);
        requiredToken(column, "INVALID_RELATION", `${section}.${endpoint}.column`);
        const target = catalog[table];
        if (!target) fail("UNKNOWN_RELATION_TABLE", `${section} references unknown table ${table}.`);
        const targetColumns = physicalColumnNames(target);
        if (!targetColumns.includes(column)) {
          fail("UNKNOWN_RELATION_COLUMN", `${section} references unknown column ${table}.${column}.`);
        }
      }
    }
    for (const filter of descriptor.scope.filters) {
      assertPlainRecord(filter, "INVALID_FILTER", `${section} contains an invalid filter.`);
      assertExactKeys(filter, FILTER_KEYS, "INVALID_FILTER", `${section}.filter`);
      requiredToken(filter.table, "INVALID_FILTER", `${section}.filter.table`);
      requiredToken(filter.column, "INVALID_FILTER", `${section}.filter.column`);
      const target = catalog[filter.table];
      if (!target) fail("UNKNOWN_FILTER_TABLE", `${section} filters unknown table ${filter.table}.`);
      if (!physicalColumnNames(target).includes(filter.column)) {
        fail("UNKNOWN_FILTER_COLUMN", `${section} filters unknown column ${filter.table}.${filter.column}.`);
      }
      if (
        !PORTABLE_WORKSPACE_V2_FILTER_OPERATORS.includes(filter.operator)
        || typeof filter.value !== "string"
        || filter.value.length === 0
      ) {
        fail("INVALID_FILTER", `${section} has an invalid projection filter.`);
      }
    }
    assertExactCooprinsemImportPolicy(section, descriptor.scope);
    for (const reference of descriptor.scope.polymorphicReferences) {
      validatePolymorphicReference(section, reference, descriptor, catalog);
    }
    if (section === "audit_log") {
      assertExactReferencePolicy(
        section,
        descriptor.scope.polymorphicReferences,
        "entity_type",
        "entity_id",
        "require_direct_field_or_source_record_for_unknown",
        PORTABLE_WORKSPACE_V2_AUDIT_ENTITY_TARGETS,
      );
    }
    if (section === "source_records") {
      assertExactReferencePolicy(
        section,
        descriptor.scope.polymorphicReferences,
        "target_entity",
        "target_id",
        "reject_unknown",
        PORTABLE_WORKSPACE_V2_SOURCE_RECORD_TARGETS,
      );
    }
    if (section !== "fields" && !hasScopePath(section, "fields", descriptor.scope.relations)) {
      fail("INCOMPLETE_SCOPE_PATH", `${section} has no declared relation path to fields.`);
    }
  }
  const fingerprint = projectionPolicyFingerprint(catalog);
  if (fingerprint !== PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT) {
    fail(
      "PROJECTION_POLICY_FINGERPRINT_MISMATCH",
      `The projection policy fingerprint changed: ${fingerprint}.`,
    );
  }
  return true;
}

function projection(input) {
  const descriptor = {
    columns: input.columns,
    omittedColumns: input.omittedColumns ?? [],
    blockedColumns: input.blockedColumns ?? [],
    jsonColumns: {
      known: input.jsonColumns?.known ?? [],
      unbounded: input.jsonColumns?.unbounded ?? [],
    },
    booleanColumns: input.booleanColumns ?? [],
    humanIdentityColumns: input.humanIdentityColumns ?? [],
    sensitiveContentColumns: input.sensitiveContentColumns ?? [],
    freeTextColumns: input.freeTextColumns ?? [],
    scope: input.scope,
    orderBy: input.orderBy,
    primaryKey: input.primaryKey ?? ["id"],
  };
  return {
    ...descriptor,
    activationRequirements: activationRequirementsFor(descriptor),
  };
}

function activationRequirementsFor(descriptor) {
  const requirements = [
    "global_rows_gate",
    "owner_admin_authorization",
    "final_scope_reauthorization",
    "deterministic_snapshot",
  ];
  if (descriptor.scope.relations.length > 0) requirements.push("relation_validation");
  if (descriptor.jsonColumns.known.length > 0) requirements.push("strict_json_parse");
  if (descriptor.jsonColumns.unbounded.length > 0) requirements.push("unbounded_json_policy");
  if (descriptor.booleanColumns.length > 0) requirements.push("boolean_normalization");
  if (descriptor.humanIdentityColumns.length > 0) requirements.push("pseudonymization_policy");
  if (descriptor.sensitiveContentColumns.length > 0) {
    requirements.push("sensitive_content_authorization");
  }
  if (descriptor.freeTextColumns.length > 0) requirements.push("free_text_policy");
  if (descriptor.blockedColumns.length > 0) requirements.push("blocked_columns_resolved");
  if (descriptor.scope.polymorphicReferences.some((reference) => (
    Object.values(reference.targets).some(
      (target) => target.disposition === "blocked_target_section",
    )
  ))) {
    requirements.push("blocked_reference_targets_resolved");
  }
  if (descriptor.omittedColumns.length > 0) requirements.push("omissions_declared_in_manifest");
  return requirements;
}

function directFieldScope(section) {
  return scope("direct_field", [
    relation(section, "field_id", "fields", "id"),
  ], ["field_in_exact_snapshot"]);
}

function organizationFieldScope(section, filters = []) {
  const requirements = ["organization_field_pair_match", "field_in_exact_snapshot"];
  if (filters.length > 0) requirements.push("source_system_profile_required");
  return scope("organization_field_pair", [
    relation(section, "field_id", "fields", "id"),
    relation(section, "organization_id", "fields", "organization_id"),
  ], requirements, filters);
}

function importJobScope(section) {
  return scope("through_import_job", [
    relation(section, "import_job_id", "import_jobs", "id"),
    relation("import_jobs", "field_id", "fields", "id"),
    relation("import_jobs", "organization_id", "fields", "organization_id"),
  ], ["import_job_same_scope", "source_system_profile_required"], [
    predicate("import_jobs", "source_system", "equals", "cooprinsem"),
  ]);
}

function importJobAndRowScope(section, rowColumn) {
  return scope("through_import_job_and_row", [
    relation(section, "import_job_id", "import_jobs", "id"),
    relation(section, rowColumn, "import_rows", "id"),
    relation("import_rows", "import_job_id", "import_jobs", "id"),
    relation("import_jobs", "field_id", "fields", "id"),
    relation("import_jobs", "organization_id", "fields", "organization_id"),
  ], ["import_job_and_row_same_scope", "source_system_profile_required"], [
    predicate("import_jobs", "source_system", "equals", "cooprinsem"),
  ]);
}

function scope(strategy, relations, requirements, filters = [], polymorphicReferences = []) {
  return {
    strategy,
    relations,
    requirements,
    filters,
    polymorphicReferences,
  };
}

function relation(fromTable, fromColumn, toTable, toColumn, match = "required") {
  return {
    from: { table: fromTable, column: fromColumn },
    to: { table: toTable, column: toColumn },
    match,
  };
}

function predicate(table, column, operator, value) {
  return { table, column, operator, value };
}

function polymorphicReference(
  discriminatorColumn,
  idColumn,
  unknownHandling,
  targets,
) {
  return { discriminatorColumn, idColumn, unknownHandling, targets };
}

function referenceTarget(table, column, disposition) {
  return { table, column, disposition };
}

function omitted(entries) {
  return decisions(entries);
}

function blocked(entries) {
  return decisions(entries);
}

function decisions(entries) {
  return Object.entries(entries).map(([name, reason]) => ({ name, reason }));
}

function words(value) {
  return value.trim().split(/\s+/u);
}

function physicalColumnNames(descriptor) {
  return [
    ...descriptor.columns,
    ...descriptor.omittedColumns.map(({ name }) => name),
    ...descriptor.blockedColumns.map(({ name }) => name),
  ];
}

function validatePolymorphicReference(section, reference, descriptor, catalog) {
  assertPlainRecord(
    reference,
    "INVALID_POLYMORPHIC_REFERENCE",
    `${section} contains an invalid polymorphic reference.`,
  );
  assertExactKeys(
    reference,
    POLYMORPHIC_REFERENCE_KEYS,
    "INVALID_POLYMORPHIC_REFERENCE",
    `${section}.polymorphicReference`,
  );
  const physical = physicalColumnNames(descriptor);
  for (const property of ["discriminatorColumn", "idColumn"]) {
    requiredToken(
      reference[property],
      "INVALID_POLYMORPHIC_REFERENCE",
      `${section}.${property}`,
    );
    if (!physical.includes(reference[property])) {
      fail(
        "UNKNOWN_POLYMORPHIC_COLUMN",
        `${section}.${reference[property]} is not a physical column.`,
      );
    }
  }
  if (!PORTABLE_WORKSPACE_V2_REFERENCE_UNKNOWN_HANDLINGS.includes(reference.unknownHandling)) {
    fail(
      "INVALID_REFERENCE_UNKNOWN_HANDLING",
      `${section} has unknown reference handling ${reference.unknownHandling}.`,
    );
  }
  assertPlainRecord(
    reference.targets,
    "INVALID_POLYMORPHIC_REFERENCE",
    `${section}.targets must be a plain object.`,
  );
  if (Object.keys(reference.targets).length === 0) {
    fail("EMPTY_REFERENCE_TARGETS", `${section} has no polymorphic reference targets.`);
  }
  for (const [value, target] of Object.entries(reference.targets)) {
    requiredToken(value, "INVALID_REFERENCE_TARGET", `${section}.target value`);
    assertPlainRecord(
      target,
      "INVALID_REFERENCE_TARGET",
      `${section}.${value} must be a reference target.`,
    );
    assertExactKeys(
      target,
      REFERENCE_TARGET_KEYS,
      "INVALID_REFERENCE_TARGET",
      `${section}.${value}`,
    );
    requiredToken(target.table, "INVALID_REFERENCE_TARGET", `${section}.${value}.table`);
    requiredToken(target.column, "INVALID_REFERENCE_TARGET", `${section}.${value}.column`);
    if (!PORTABLE_WORKSPACE_V2_REFERENCE_DISPOSITIONS.includes(target.disposition)) {
      fail(
        "INVALID_REFERENCE_DISPOSITION",
        `${section}.${value} has unknown disposition ${target.disposition}.`,
      );
    }
    if (target.disposition === "projected") {
      const targetDescriptor = catalog[target.table];
      if (!targetDescriptor || !physicalColumnNames(targetDescriptor).includes(target.column)) {
        fail(
          "UNKNOWN_REFERENCE_TARGET",
          `${section}.${value} does not resolve to a projected column.`,
        );
      }
    } else {
      const policy = PORTABLE_WORKSPACE_V2_D1_POLICY[target.table];
      if (
        catalog[target.table]
        || !policy
        || policy.disposition === "projection_required"
      ) {
        fail(
          "INVALID_BLOCKED_REFERENCE_TARGET",
          `${section}.${value} must resolve to a non-X1 D1 section.`,
        );
      }
    }
  }
}

function assertExactReferencePolicy(
  section,
  references,
  discriminatorColumn,
  idColumn,
  unknownHandling,
  targets,
) {
  if (references.length !== 1) {
    fail("REFERENCE_POLICY_MISMATCH", `${section} must declare exactly one reference policy.`);
  }
  const [reference] = references;
  if (
    reference.discriminatorColumn !== discriminatorColumn
    || reference.idColumn !== idColumn
    || reference.unknownHandling !== unknownHandling
  ) {
    fail("REFERENCE_POLICY_MISMATCH", `${section} reference policy metadata changed.`);
  }
  assertSameSet(
    Object.keys(reference.targets),
    Object.keys(targets),
    "REFERENCE_POLICY_MISMATCH",
    `${section} reference target values changed.`,
  );
  for (const [value, expected] of Object.entries(targets)) {
    const actual = reference.targets[value];
    if (
      actual.table !== expected.table
      || actual.column !== expected.column
      || actual.disposition !== expected.disposition
    ) {
      fail("REFERENCE_POLICY_MISMATCH", `${section}.${value} reference target changed.`);
    }
  }
}

function assertExactCooprinsemImportPolicy(section, scopeEntry) {
  const requiresProfile = scopeEntry.requirements.includes("source_system_profile_required");
  const isCooprinsemSection = PORTABLE_WORKSPACE_V2_COOPRINSEM_IMPORT_SECTIONS.includes(section);
  if (requiresProfile !== isCooprinsemSection) {
    fail(
      "IMPORT_SOURCE_PROFILE_MISMATCH",
      `${section} has an inconsistent source-system profile requirement.`,
    );
  }
  if (!isCooprinsemSection) return;
  if (scopeEntry.filters.length !== 1) {
    fail(
      "IMPORT_SOURCE_PROFILE_MISMATCH",
      `${section} must declare exactly the Cooprinsem import filter.`,
    );
  }
  const [filter] = scopeEntry.filters;
  for (const key of FILTER_KEYS) {
    if (filter[key] !== PORTABLE_WORKSPACE_V2_COOPRINSEM_IMPORT_FILTER[key]) {
      fail(
        "IMPORT_SOURCE_PROFILE_MISMATCH",
        `${section} changed the Cooprinsem import filter.`,
      );
    }
  }
}

function hasScopePath(start, destination, relations) {
  const edges = new Map();
  for (const relationEntry of relations) {
    const from = relationEntry.match === "referenced_by"
      ? relationEntry.to.table
      : relationEntry.from.table;
    const to = relationEntry.match === "referenced_by"
      ? relationEntry.from.table
      : relationEntry.to.table;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  }
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === destination) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of edges.get(current) ?? []) pending.push(target);
  }
  return false;
}

function assertDecisionArray(value, label) {
  if (!Array.isArray(value)) fail("INVALID_COLUMN_DECISIONS", `${label} must be an array.`);
  for (const decision of value) {
    assertPlainRecord(
      decision,
      "INVALID_COLUMN_DECISION",
      `${label} contains an invalid decision.`,
    );
    assertExactKeys(decision, DECISION_KEYS, "INVALID_COLUMN_DECISION", label);
    requiredToken(decision.name, "INVALID_COLUMN_DECISION", `${label}.name`);
    if (!PORTABLE_WORKSPACE_V2_COLUMN_DECISION_REASONS.includes(decision.reason)) {
      fail("INVALID_COLUMN_REASON", `${label} has unknown reason ${decision.reason}.`);
    }
  }
}

function assertStringArray(value, code, label) {
  if (!Array.isArray(value)) fail(code, `${label} must be an array.`);
  for (const entry of value) requiredToken(entry, code, label);
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
  const actual = Object.keys(value).sort(compareCodePoint);
  const sortedExpected = [...expected].sort(compareCodePoint);
  if (
    actual.length !== sortedExpected.length
    || actual.some((entry, index) => entry !== sortedExpected[index])
  ) {
    fail(code, `${label} must contain exactly: ${sortedExpected.join(", ")}.`);
  }
}

function requiredToken(value, code, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code, `${label} must be a non-empty token.`);
  }
  return value;
}

function assertSameSet(
  left,
  right,
  code,
  message = "The projection catalog does not match the X1 section candidates.",
) {
  const leftSorted = [...left].sort(compareCodePoint);
  const rightSorted = [...right].sort(compareCodePoint);
  if (
    leftSorted.length !== rightSorted.length
    || leftSorted.some((value, index) => value !== rightSorted[index])
  ) {
    fail(code, message);
  }
}

function assertUnique(values, message) {
  if (new Set(values).size !== values.length) fail("DUPLICATE_COLUMN", message);
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function projectionPolicyFingerprint(value) {
  const canonical = canonicalJson(value);
  let hash = 14695981039346656037n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareCodePoint)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
  const error = new Error(message);
  error.name = "PortableWorkspaceV2ProjectionCatalogError";
  error.code = code;
  throw error;
}
