export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FORMAT:
  "fundosmart.portable-workspace.v2.field-candidate";
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_VERSION: 1;
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_STATUS: "not_exportable";
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FAMILY: "field_roots_v1";
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_ROWS: 10_000;
export const PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_MAX_COORDINATES: 100_000;

export const PORTABLE_WORKSPACE_V2_FIELD_SOURCE_COLUMNS: readonly [
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
];

export type PortableWorkspaceV2FieldUnresolvedRequirement =
  | "global_rows_gate"
  | "owner_admin_authorization"
  | "final_scope_reauthorization"
  | "deterministic_snapshot"
  | "sensitive_content_authorization";

export type PortableWorkspaceV2FieldSatisfiedRequirement =
  | "strict_json_parse"
  | "boolean_normalization";

export const PORTABLE_WORKSPACE_V2_FIELD_UNRESOLVED_REQUIREMENTS:
  readonly PortableWorkspaceV2FieldUnresolvedRequirement[];
export const PORTABLE_WORKSPACE_V2_FIELD_SATISFIED_REQUIREMENTS:
  readonly PortableWorkspaceV2FieldSatisfiedRequirement[];
export const PORTABLE_WORKSPACE_V2_FIELD_NOT_MATERIALIZED_SECTIONS:
  readonly string[];

export type PortableWorkspaceV2FieldCandidateRow = Readonly<{
  id: string;
  organization_id: string;
  name: string;
  location: string;
  is_demo: boolean;
  area_hectares: number;
  coordinates: readonly (readonly [number, number])[];
  soil_report_filename: string | null;
  soil_report_folio: string | null;
  soil_sample_id: string | null;
  soil_report_date: string | null;
  created_at: string;
}>;

export type PortableWorkspaceV2FieldCandidate = Readonly<{
  format: typeof PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FORMAT;
  candidateVersion: typeof PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_VERSION;
  status: typeof PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_STATUS;
  family: typeof PORTABLE_WORKSPACE_V2_FIELD_CANDIDATE_FAMILY;
  section: "fields";
  complete: false;
  portableRowsEnabled: false;
  catalog: Readonly<{
    version: number;
    policyFingerprint: string;
  }>;
  unresolvedRequirements: readonly PortableWorkspaceV2FieldUnresolvedRequirement[];
  satisfiedRequirements: readonly PortableWorkspaceV2FieldSatisfiedRequirement[];
  materializedSections: readonly ["fields"];
  notMaterializedSections: readonly string[];
  scope: Readonly<{
    organizationId: string;
    fieldIds: readonly string[];
  }>;
  recordCount: number;
  sectionSha256: string;
  candidateRows: readonly PortableWorkspaceV2FieldCandidateRow[];
}>;

export type PortableWorkspaceV2RawFieldRow = Readonly<Record<string, unknown>>;

export type PortableWorkspaceV2FieldCandidateInput = Readonly<{
  organizationId: string;
  fieldIds: readonly string[];
  rows: readonly PortableWorkspaceV2RawFieldRow[];
}>;

export class PortableWorkspaceV2FieldCandidateError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function createPortableWorkspaceV2FieldCandidate(
  input: PortableWorkspaceV2FieldCandidateInput,
): Promise<PortableWorkspaceV2FieldCandidate>;

export function validatePortableWorkspaceV2FieldCandidate(
  value: unknown,
): Promise<PortableWorkspaceV2FieldCandidate>;
