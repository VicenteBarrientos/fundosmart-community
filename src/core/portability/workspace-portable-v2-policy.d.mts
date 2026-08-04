export const PORTABLE_WORKSPACE_V2_FORMAT: "fundosmart.portable-workspace.v2";
export const PORTABLE_WORKSPACE_V2_CONTRACT_VERSION: 1;
export const PORTABLE_WORKSPACE_V2_SCHEMA_VERSION:
  "fundosmart.d1-104+r2-6.2026-07-29";
export const PORTABLE_WORKSPACE_V2_POLICY_VERSION: "2026-07-29.rows-1";
export const PORTABLE_WORKSPACE_V2_ROWS_ENABLED: true;

export type PortableWorkspaceV2ExportCode = "X0" | "X1" | "X2" | "X3" | "X4" | "X5";
export type PortableWorkspaceV2Disposition =
  | "excluded_control"
  | "projection_required"
  | "subject_download"
  | "pending_projection"
  | "reconstructible"
  | "aggregate_only";

export type PortableWorkspaceV2PolicyDecision = Readonly<{
  exportCode: PortableWorkspaceV2ExportCode;
  disposition: PortableWorkspaceV2Disposition;
}>;

export type PortableWorkspaceV2PolicyGroups = Readonly<{
  excludedControl: readonly string[];
  projectionRequired: readonly string[];
  subjectDownload: readonly string[];
  pendingProjection: readonly string[];
  reconstructible: readonly string[];
  aggregateOnly: readonly string[];
}>;

export const PORTABLE_WORKSPACE_V2_D1_POLICY:
  Readonly<Record<string, PortableWorkspaceV2PolicyDecision>>;
export const PORTABLE_WORKSPACE_V2_R2_POLICY:
  Readonly<Record<string, PortableWorkspaceV2PolicyDecision>>;
export const PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES: readonly string[];
export const PORTABLE_WORKSPACE_V2_POLICY: Readonly<{
  version: typeof PORTABLE_WORKSPACE_V2_POLICY_VERSION;
  d1: PortableWorkspaceV2PolicyGroups;
  r2: PortableWorkspaceV2PolicyGroups;
}>;
