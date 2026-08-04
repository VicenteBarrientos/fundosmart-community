import type { IsolatedMemoryObjectStore } from "./isolated-recovery-processor.mjs";
import type { IsolatedRecoveryWorkspaceKeyring } from "./isolated-recovery-workspace-keyring.mjs";

type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { changes: number | bigint };
  };
};

export type IsolatedRecoveryOperatorAttestation = {
  operatorId: string;
  capability: "execute_isolated_recovery";
  issuedAt: string;
  expiresAt: string;
};

export type IsolatedRecoveryEnvironmentManifest = {
  format: "fundosmart.isolated-recovery-environment-manifest.v1";
  target: "isolated_sqlite_file_clone";
  sourceDatabaseSha256: string;
  recoveryJobSha256: string;
  operatorAttestationSha256: string;
  objectNamespaceSha256: string;
  schemaContract: "fundosmart.isolated-recovery-schema.v2";
  createdAt: string;
  expiresAt: string;
  productWritesEnabled: false;
  remoteWrites: false;
};

export type IsolatedRecoveryEnvironmentReceipt = {
  format: "fundosmart.isolated-recovery-environment-destruction.v1";
  manifestSha256: string;
  outcome: "succeeded" | "failed" | "cleanup_failed";
  objectCountDestroyed: number;
  localArtifactCountDestroyed: number;
  sourceDatabaseUnchanged: boolean;
  destructionVerified: boolean;
  destroyedAt: string;
  productWritesEnabled: false;
  remoteWrites: false;
};

export class IsolatedRecoveryEnvironmentExecutionError extends Error {
  constructor(receipt: IsolatedRecoveryEnvironmentReceipt);
  code: "isolated_environment_execution_failed";
  receipt: IsolatedRecoveryEnvironmentReceipt;
}

export class IsolatedRecoveryEnvironmentCleanupError extends Error {
  constructor(receipt: IsolatedRecoveryEnvironmentReceipt);
  code: "isolated_environment_cleanup_failed";
  receipt: IsolatedRecoveryEnvironmentReceipt;
}

export const EPHEMERAL_ENVIRONMENT_MANIFEST_FORMAT:
  "fundosmart.isolated-recovery-environment-manifest.v1";
export const EPHEMERAL_ENVIRONMENT_RECEIPT_FORMAT:
  "fundosmart.isolated-recovery-environment-destruction.v1";

export function runInIsolatedRecoveryEphemeralEnvironment<Result>(input: {
  sourceDatabasePath: string;
  expectedSourceDatabaseSha256: string;
  recoveryJobId: string;
  operator: IsolatedRecoveryOperatorAttestation;
  guard: IsolatedGuard;
  workspaceRootPath?: string;
  workspaceKeyring: IsolatedRecoveryWorkspaceKeyring;
}, execute: (runtime: {
  database: IsolatedSqlite;
  objectStore: IsolatedMemoryObjectStore;
  manifest: IsolatedRecoveryEnvironmentManifest;
  localWorkspacePath: string;
  guard: IsolatedGuard;
}) => Result | Promise<Result>): Promise<{
  manifest: IsolatedRecoveryEnvironmentManifest;
  result: Result;
  receipt: IsolatedRecoveryEnvironmentReceipt;
}>;
