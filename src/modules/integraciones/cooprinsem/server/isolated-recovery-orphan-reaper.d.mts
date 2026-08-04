import type { IsolatedRecoveryWorkspaceKeyring } from "./isolated-recovery-workspace-keyring.mjs";

export type IsolatedRecoveryOrphanReaperReceipt = {
  format: "fundosmart.isolated-recovery-orphan-reaper.v2";
  workspaceRootSha256: string;
  activeKeyIdSha256: string;
  keyUsage: ReadonlyArray<{
    keyIdSha256: string;
    authenticatedWorkspaceCount: number;
  }>;
  candidateWorkspaceCount: number;
  authenticatedWorkspaceCount: number;
  unauthenticatedWorkspaceCount: number;
  markerMissingCount: number;
  markerInvalidCount: number;
  unknownKeyIdWorkspaceCount: number;
  legacyWorkspaceCount: number;
  unexpiredWorkspaceCount: number;
  expiredWorkspaceCount: number;
  liveWorkspaceCount: number;
  destroyedWorkspaceCount: number;
  failedWorkspaceCount: number;
  localArtifactCountDestroyed: number;
  destructionVerified: boolean;
  sweptAt: string;
  productWritesEnabled: false;
  remoteWrites: false;
};

type WorkspaceAuthentication = {
  workspaceRootPath?: string;
  workspaceKeyring: IsolatedRecoveryWorkspaceKeyring;
};

export const ISOLATED_RECOVERY_WORKSPACE_MARKER_FORMAT:
  "fundosmart.isolated-recovery-workspace-marker.v2";
export const ISOLATED_RECOVERY_ORPHAN_REAPER_RECEIPT_FORMAT:
  "fundosmart.isolated-recovery-orphan-reaper.v2";
export const ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE:
  ".fundosmart-recovery-workspace.json";

export function createAuthenticatedIsolatedRecoveryWorkspace(
  input: WorkspaceAuthentication & {
    workspaceId: string;
    manifestSha256: string;
    createdAt: string;
    expiresAt: string;
  },
): Promise<{ workspacePath: string; workspaceRootPath: string }>;

export function destroyAuthenticatedIsolatedRecoveryWorkspace(
  input: WorkspaceAuthentication & { workspacePath: string },
): Promise<{ localArtifactCountDestroyed: number }>;

export function sweepIsolatedRecoveryOrphanWorkspaces(
  input: WorkspaceAuthentication,
): Promise<IsolatedRecoveryOrphanReaperReceipt>;
