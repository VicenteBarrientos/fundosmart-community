import type {
  PortableWorkspaceV2FieldCandidate,
  PortableWorkspaceV2FieldCandidateRow,
} from "./workspace-portable-v2-field-candidate.mjs";

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FORMAT:
  "fundosmart.portable-workspace.v2.field-settings-candidate";
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_VERSION: 1;
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_STATUS: "not_exportable";
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FAMILY:
  "field_roots_with_current_rotation_settings_v1";
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_MAX_ROWS: 10_000;

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SOURCE_COLUMNS: readonly [
  "field_id",
  "recent_days",
  "long_rest_days",
  "created_at",
  "updated_at",
  "version",
];

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_MATERIALIZED_SECTIONS: readonly [
  "fields",
  "paddock_rotation_settings",
];
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_NOT_MATERIALIZED_SECTIONS:
  readonly string[];

export type PortableWorkspaceV2FieldSettingsUnresolvedRequirement =
  | "global_rows_gate"
  | "owner_admin_authorization"
  | "final_scope_reauthorization"
  | "deterministic_snapshot"
  | "sensitive_content_authorization";

export type PortableWorkspaceV2FieldSettingsSatisfiedRequirement =
  | "strict_json_parse"
  | "boolean_normalization"
  | "relation_validation";

export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_UNRESOLVED_REQUIREMENTS:
  readonly PortableWorkspaceV2FieldSettingsUnresolvedRequirement[];
export const PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_SATISFIED_REQUIREMENTS:
  readonly PortableWorkspaceV2FieldSettingsSatisfiedRequirement[];

export type PortableWorkspaceV2FieldSettingsCandidateRow = Readonly<{
  field_id: string;
  recent_days: number;
  long_rest_days: number;
  created_at: string;
  updated_at: string;
  version: number;
}>;

export type PortableWorkspaceV2FieldSettingsCandidate = Readonly<{
  format: typeof PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FORMAT;
  candidateVersion: typeof PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_VERSION;
  status: typeof PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_STATUS;
  family: typeof PORTABLE_WORKSPACE_V2_FIELD_SETTINGS_CANDIDATE_FAMILY;
  complete: false;
  portableRowsEnabled: false;
  catalog: Readonly<{
    version: number;
    policyFingerprint: string;
  }>;
  unresolvedRequirements: readonly PortableWorkspaceV2FieldSettingsUnresolvedRequirement[];
  satisfiedRequirements: readonly PortableWorkspaceV2FieldSettingsSatisfiedRequirement[];
  materializedSections: readonly ["fields", "paddock_rotation_settings"];
  notMaterializedSections: readonly string[];
  scope: Readonly<{
    organizationId: string;
    fieldIds: readonly string[];
  }>;
  recordCounts: Readonly<{
    fields: number;
    paddock_rotation_settings: number;
  }>;
  sectionSha256s: Readonly<{
    fields: string;
    paddock_rotation_settings: string;
  }>;
  candidateRows: Readonly<{
    fields: readonly PortableWorkspaceV2FieldCandidateRow[];
    paddock_rotation_settings: readonly PortableWorkspaceV2FieldSettingsCandidateRow[];
  }>;
}>;

export type PortableWorkspaceV2RawFieldSettingsRow = Readonly<Record<string, unknown>>;

export type PortableWorkspaceV2FieldSettingsCandidateInput = Readonly<{
  fieldCandidate: PortableWorkspaceV2FieldCandidate;
  settingsRows: readonly PortableWorkspaceV2RawFieldSettingsRow[];
}>;

export class PortableWorkspaceV2FieldSettingsCandidateError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function createPortableWorkspaceV2FieldSettingsCandidate(
  input: PortableWorkspaceV2FieldSettingsCandidateInput,
): Promise<PortableWorkspaceV2FieldSettingsCandidate>;

export function validatePortableWorkspaceV2FieldSettingsCandidate(
  value: unknown,
): Promise<PortableWorkspaceV2FieldSettingsCandidate>;
