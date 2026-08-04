export const PORTABLE_WORKSPACE_V2_PROJECTION_CATALOG_VERSION: 2;
export const PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT: string;

export type PortableWorkspaceV2ScopeStrategy =
  | "field_root"
  | "direct_field"
  | "organization_field_pair"
  | "through_paddock"
  | "through_lot"
  | "through_animal"
  | "through_birth"
  | "through_import_job"
  | "through_import_job_and_row"
  | "organization_expense"
  | "organization_partner_reference"
  | "lot_membership"
  | "organization_audit";

export type PortableWorkspaceV2ColumnDecisionReason =
  | "internal_object_key"
  | "pseudonymization_policy_required"
  | "target_section_not_projected"
  | "source_profile_not_projected"
  | "unbounded_json_policy_required"
  | "unsafe_internal_error_text";

export type PortableWorkspaceV2ScopeRequirement =
  | "all_relations_required"
  | "animal_and_lactation_same_field"
  | "animal_current_lot_same_organization"
  | "animal_in_exact_snapshot"
  | "animal_links_same_scope"
  | "animal_same_field"
  | "birth_in_exact_snapshot"
  | "entity_reference_resolves_included_entity_when_supported"
  | "exact_field_set"
  | "field_in_exact_snapshot"
  | "import_job_and_row_same_scope"
  | "import_job_same_scope"
  | "landmark_same_field"
  | "last_operation_same_scope"
  | "lot_same_field"
  | "membership_lot_in_snapshot"
  | "nullable_field_in_exact_snapshot"
  | "optional_animal_same_scope"
  | "optional_paddock_same_field"
  | "optional_partner_and_lot_same_organization"
  | "optional_recorded_lot_same_organization"
  | "organization_field_pair_match"
  | "organization_match"
  | "organization_wide_events_require_included_import_lineage"
  | "paddock_and_operations_same_scope"
  | "paddock_same_field"
  | "referenced_by_included_expense"
  | "source_record_same_scope"
  | "source_system_profile_required"
  | "target_allowlist_resolves_included_entity";

export type PortableWorkspaceV2ColumnDecision = Readonly<{
  name: string;
  reason: PortableWorkspaceV2ColumnDecisionReason;
}>;

export type PortableWorkspaceV2RelationEndpoint = Readonly<{
  table: string;
  column: string;
}>;

export type PortableWorkspaceV2ScopeRelation = Readonly<{
  from: PortableWorkspaceV2RelationEndpoint;
  to: PortableWorkspaceV2RelationEndpoint;
  match: "required" | "optional" | "referenced_by";
}>;

export type PortableWorkspaceV2ProjectionFilter = Readonly<{
  table: string;
  column: string;
  operator: "equals";
  value: string;
}>;

export type PortableWorkspaceV2ReferenceUnknownHandling =
  | "reject_unknown"
  | "require_direct_field_or_source_record_for_unknown";

export type PortableWorkspaceV2ReferenceDisposition =
  | "projected"
  | "blocked_target_section"
  | "excluded_target_section";

export type PortableWorkspaceV2ReferenceTarget = Readonly<{
  table: string;
  column: string;
  disposition: PortableWorkspaceV2ReferenceDisposition;
}>;

export type PortableWorkspaceV2PolymorphicReference = Readonly<{
  discriminatorColumn: string;
  idColumn: string;
  unknownHandling: PortableWorkspaceV2ReferenceUnknownHandling;
  targets: Readonly<Record<string, PortableWorkspaceV2ReferenceTarget>>;
}>;

export type PortableWorkspaceV2ActivationRequirement =
  | "global_rows_gate"
  | "owner_admin_authorization"
  | "final_scope_reauthorization"
  | "deterministic_snapshot"
  | "relation_validation"
  | "strict_json_parse"
  | "unbounded_json_policy"
  | "boolean_normalization"
  | "pseudonymization_policy"
  | "sensitive_content_authorization"
  | "free_text_policy"
  | "blocked_columns_resolved"
  | "blocked_reference_targets_resolved"
  | "omissions_declared_in_manifest";

export type PortableWorkspaceV2ProjectionDescriptor = Readonly<{
  columns: readonly string[];
  omittedColumns: readonly PortableWorkspaceV2ColumnDecision[];
  blockedColumns: readonly PortableWorkspaceV2ColumnDecision[];
  jsonColumns: Readonly<{
    known: readonly string[];
    unbounded: readonly string[];
  }>;
  booleanColumns: readonly string[];
  humanIdentityColumns: readonly string[];
  sensitiveContentColumns: readonly string[];
  freeTextColumns: readonly string[];
  scope: Readonly<{
    strategy: PortableWorkspaceV2ScopeStrategy;
    relations: readonly PortableWorkspaceV2ScopeRelation[];
    requirements: readonly PortableWorkspaceV2ScopeRequirement[];
    filters: readonly PortableWorkspaceV2ProjectionFilter[];
    polymorphicReferences: readonly PortableWorkspaceV2PolymorphicReference[];
  }>;
  orderBy: readonly string[];
  primaryKey: readonly string[];
  activationRequirements: readonly PortableWorkspaceV2ActivationRequirement[];
}>;

export const PORTABLE_WORKSPACE_V2_SCOPE_STRATEGIES: readonly PortableWorkspaceV2ScopeStrategy[];
export const PORTABLE_WORKSPACE_V2_COLUMN_DECISION_REASONS:
  readonly PortableWorkspaceV2ColumnDecisionReason[];
export const PORTABLE_WORKSPACE_V2_RELATION_MATCHES:
  readonly PortableWorkspaceV2ScopeRelation["match"][];
export const PORTABLE_WORKSPACE_V2_SCOPE_REQUIREMENTS:
  readonly PortableWorkspaceV2ScopeRequirement[];
export const PORTABLE_WORKSPACE_V2_ACTIVATION_REQUIREMENTS:
  readonly PortableWorkspaceV2ActivationRequirement[];
export const PORTABLE_WORKSPACE_V2_FILTER_OPERATORS:
  readonly PortableWorkspaceV2ProjectionFilter["operator"][];
export const PORTABLE_WORKSPACE_V2_COOPRINSEM_IMPORT_SECTIONS: readonly [
  "import_errors",
  "import_jobs",
  "import_rows",
  "source_records",
];
export const PORTABLE_WORKSPACE_V2_COOPRINSEM_IMPORT_FILTER:
  PortableWorkspaceV2ProjectionFilter;
export const PORTABLE_WORKSPACE_V2_REFERENCE_UNKNOWN_HANDLINGS:
  readonly PortableWorkspaceV2ReferenceUnknownHandling[];
export const PORTABLE_WORKSPACE_V2_REFERENCE_DISPOSITIONS:
  readonly PortableWorkspaceV2ReferenceDisposition[];
export const PORTABLE_WORKSPACE_V2_AUDIT_ENTITY_TARGETS:
  Readonly<Record<string, PortableWorkspaceV2ReferenceTarget>>;
export const PORTABLE_WORKSPACE_V2_SOURCE_RECORD_TARGETS:
  Readonly<Record<string, PortableWorkspaceV2ReferenceTarget>>;
export const PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS: Readonly<
  Record<string, PortableWorkspaceV2ProjectionDescriptor>
>;
export const PORTABLE_WORKSPACE_V2_MANIFEST_PROJECTION_POLICY: Readonly<{
  generatedBy: Readonly<{
    handling: "identity_sha256_pseudonym";
    source: "authenticated_actor";
  }>;
}>;

export function validatePortableWorkspaceV2ProjectionCatalog(catalog?: unknown): true;
