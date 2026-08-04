import type { PortableWorkspaceJson } from "./workspace-portable-v2.mjs";

export const PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS: 10000;
export const PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS: 100000;
export const PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES: number;
export const PORTABLE_WORKSPACE_V2_MAX_TEXT_BYTES: number;

export type PortableWorkspaceV2Row = Readonly<Record<string, PortableWorkspaceJson>>;
export type PortableWorkspaceV2Sections = Readonly<
  Record<string, readonly PortableWorkspaceV2Row[]>
>;

export const PORTABLE_WORKSPACE_V2_ROW_PROJECTION: Readonly<{
  enabled: true;
  requirement: "explicit-column-allowlists";
  catalogVersion: 2;
  policyFingerprint: string;
  columnDecisions: Readonly<Record<string, Readonly<{
    omitted: readonly Readonly<{ name: string; reason: string }>[];
    excluded: readonly Readonly<{ name: string; reason: string }>[];
  }>>>;
  rowExclusions: Readonly<Record<string, readonly Readonly<{
    reason: string;
    predicate: string;
  }>[]>>;
}>;

export class PortableWorkspaceV2RowError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function emptyPortableWorkspaceV2Sections(): PortableWorkspaceV2Sections;
export function normalizePortableWorkspaceV2Sections(
  value: unknown,
  scope: { organizationId: string; fieldIds: readonly string[] },
  options?: { requireScopeSentinels?: boolean },
): PortableWorkspaceV2Sections;
export function clonePortableWorkspaceJson(
  value: unknown,
  path?: string,
): PortableWorkspaceJson;
