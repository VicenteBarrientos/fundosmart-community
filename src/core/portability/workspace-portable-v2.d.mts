import type {
  PortableWorkspaceV2PolicyDecision,
  PortableWorkspaceV2PolicyGroups,
} from "./workspace-portable-v2-policy.mjs";
import type {
  PortableWorkspaceV2Row,
  PortableWorkspaceV2Sections,
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
} from "./workspace-portable-v2-policy.mjs";
export {
  PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS,
  PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTION,
} from "./workspace-portable-v2-rows.mjs";

export type PortableWorkspaceV2ExportCode =
  import("./workspace-portable-v2-policy.mjs").PortableWorkspaceV2ExportCode;
export type PortableWorkspaceV2Disposition =
  import("./workspace-portable-v2-policy.mjs").PortableWorkspaceV2Disposition;
export type { PortableWorkspaceV2PolicyDecision, PortableWorkspaceV2PolicyGroups };
export type { PortableWorkspaceV2Row, PortableWorkspaceV2Sections };

export type PortableWorkspaceJson =
  | null
  | boolean
  | number
  | string
  | PortableWorkspaceJson[]
  | { [key: string]: PortableWorkspaceJson };

export type PortableWorkspaceV2 = Readonly<{
  manifest: Readonly<{
    format: "fundosmart.portable-workspace.v2";
    contractVersion: 1;
    schemaVersion: "fundosmart.d1-104+r2-6.2026-07-29";
    generatedAt: string;
    generatedBy: string;
    encoding: "UTF-8 canonical JSON";
    scope: Readonly<{
      type: "organization";
      organizationId: string;
      organizationName: string;
      fieldIds: readonly string[];
    }>;
    policy: Readonly<{
      version: "2026-07-29.rows-1";
      d1: PortableWorkspaceV2PolicyGroups;
      r2: PortableWorkspaceV2PolicyGroups;
    }>;
    rowProjection: typeof import(
      "./workspace-portable-v2-rows.mjs"
    ).PORTABLE_WORKSPACE_V2_ROW_PROJECTION;
    integrity: typeof PORTABLE_WORKSPACE_V2_INTEGRITY;
    sectionOrder: readonly string[];
    recordCounts: Readonly<Record<string, number>>;
    sectionSha256: Readonly<Record<string, string>>;
    totalRecordCount: number;
    workspaceSha256: string;
  }>;
  data: PortableWorkspaceV2Sections;
}>;

export const PORTABLE_WORKSPACE_V2_INTEGRITY: Readonly<{
  algorithm: "SHA-256";
  authenticated: false;
  workspaceHashScope: "canonical-manifest-without-workspaceSha256-and-data";
}>;

export class PortableWorkspaceV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function emptyPortableWorkspaceV2Sections(): PortableWorkspaceV2Sections;
export function createPortableWorkspaceV2(input: {
  generatedAt: string;
  generatedBy: string;
  organization: { id: string; name: string };
  fieldIds: string[];
  sections: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
}): Promise<PortableWorkspaceV2>;
export function validatePortableWorkspaceV2(value: unknown): Promise<PortableWorkspaceV2>;
export function canonicalPortableWorkspaceJson(
  value: PortableWorkspaceJson | PortableWorkspaceV2 | unknown,
): string;
export function portableWorkspaceSha256(
  value: string | PortableWorkspaceJson | PortableWorkspaceV2 | unknown,
): Promise<string>;
