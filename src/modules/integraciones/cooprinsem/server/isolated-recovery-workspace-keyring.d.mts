export type IsolatedRecoveryWorkspaceKeyring = {
  format: "fundosmart.isolated-recovery-workspace-keyring.v1";
  workspaceRootSha256: string;
  activeKeyId: string;
  verificationKeys: ReadonlyArray<{ keyId: string; verifyUntil: string }>;
  maxWorkspaceTtlMs: 3_600_000;
  createdAt: string;
};

type VerificationKeyInput = {
  keyId: string;
  key: Uint8Array;
  verifyUntil: string;
};

type KeyringPruneReceipt = {
  format: "fundosmart.isolated-recovery-orphan-reaper.v2";
  workspaceRootSha256: string;
  destructionVerified: boolean;
  failedWorkspaceCount: number;
  sweptAt: string;
  keyUsage: ReadonlyArray<{
    keyIdSha256: string;
    authenticatedWorkspaceCount: number;
  }>;
};

export const ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT:
  "fundosmart.isolated-recovery-workspace-keyring.v1";
export const ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS: 3_600_000;

export function createIsolatedRecoveryWorkspaceKeyring(input: {
  workspaceRootPath?: string;
  activeKeyId: string;
  activeKey: Uint8Array;
  verificationKeys?: VerificationKeyInput[];
}): Promise<IsolatedRecoveryWorkspaceKeyring>;

export function rotateIsolatedRecoveryWorkspaceKeyring(
  keyring: IsolatedRecoveryWorkspaceKeyring,
  input: { nextKeyId: string; nextKey: Uint8Array },
): IsolatedRecoveryWorkspaceKeyring;

export function pruneIsolatedRecoveryWorkspaceKeyring(
  keyring: IsolatedRecoveryWorkspaceKeyring,
  input: { reaperReceipt: KeyringPruneReceipt },
): IsolatedRecoveryWorkspaceKeyring;

export function readActiveIsolatedRecoveryWorkspaceKey(
  keyring: IsolatedRecoveryWorkspaceKeyring,
  expectedWorkspaceRootSha256: string,
): { keyId: string; key: Uint8Array };

export function readIsolatedRecoveryWorkspaceVerificationKeys(
  keyring: IsolatedRecoveryWorkspaceKeyring,
  expectedWorkspaceRootSha256: string,
): ReadonlyArray<{
  keyId: string;
  key: Uint8Array;
  mode: "active" | "verify_only";
  verifyUntil: string | null;
}>;
