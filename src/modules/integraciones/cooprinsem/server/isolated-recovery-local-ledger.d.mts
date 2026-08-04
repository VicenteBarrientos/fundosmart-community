export type IsolatedRecoveryLocalLedgerAnchor = Readonly<{
  format: "fundosmart.isolated-recovery-local-ledger-anchor.v1";
  workspaceRootSha256: string;
  ledgerIdSha256: string;
  sequence: number;
  entrySha256: string;
  signature: string;
}>;

export type IsolatedRecoveryLocalLedger = Readonly<{
  format: "fundosmart.isolated-recovery-local-ledger.v1";
  workspaceRootSha256: string;
  ledgerIdSha256: string;
  createdAt: string;
  productWritesEnabled: false;
  remoteWrites: false;
}>;

type WorkspaceKeyringDescriptor = Readonly<{
  format: "fundosmart.isolated-recovery-workspace-keyring.v1";
  workspaceRootSha256: string;
  activeKeyId: string;
  verificationKeys: ReadonlyArray<Readonly<{ keyId: string; verifyUntil: string }>>;
  maxWorkspaceTtlMs: 3_600_000;
  createdAt: string;
}>;

type OrphanReaperReceipt = Readonly<{
  format: "fundosmart.isolated-recovery-orphan-reaper.v2";
  workspaceRootSha256: string;
  activeKeyIdSha256: string;
  keyUsage: ReadonlyArray<Readonly<{
    keyIdSha256: string;
    authenticatedWorkspaceCount: number;
  }>>;
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
}>;

export type IsolatedRecoveryLocalLedgerAppendReceipt = Readonly<{
  format: "fundosmart.isolated-recovery-local-ledger-append.v1";
  kind: "workspace_sweep" | "keyring_rotation" | "keyring_prune";
  phase: "intent" | "result";
  sequence: number;
  payloadSha256: string;
  intentPayloadSha256: string;
  entrySha256: string;
  replayed: boolean;
  anchor: IsolatedRecoveryLocalLedgerAnchor;
  productWritesEnabled: false;
  remoteWrites: false;
}>;

export const ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT:
  "fundosmart.isolated-recovery-local-ledger.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_ANCHOR_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-anchor.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_ENTRY_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-entry.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_VERIFICATION_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-verification.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_APPEND_RECEIPT_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-append.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_INTENT_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-intent.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_RESULT_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-result.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_PENDING_FORMAT:
  "fundosmart.isolated-recovery-local-ledger-pending.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_FILE:
  ".fundosmart-isolated-recovery-ledger.sqlite3";

export function createIsolatedRecoveryLocalLedger(input: {
  workspaceRootPath: string;
  signingKey: Uint8Array;
}): Promise<IsolatedRecoveryLocalLedger>;

export function openIsolatedRecoveryLocalLedger(input: {
  workspaceRootPath: string;
  signingKey: Uint8Array;
  expectedAnchor: IsolatedRecoveryLocalLedgerAnchor;
}): Promise<IsolatedRecoveryLocalLedger>;

export function appendIsolatedRecoverySweepResult(
  ledger: IsolatedRecoveryLocalLedger,
  input: {
    intent: IsolatedRecoveryLocalLedgerAppendReceipt;
    reaperReceipt: OrphanReaperReceipt;
  },
): IsolatedRecoveryLocalLedgerAppendReceipt;

export function appendIsolatedRecoverySweepIntent(
  ledger: IsolatedRecoveryLocalLedger,
  input: {
    keyring: WorkspaceKeyringDescriptor;
    requestedAt?: string;
  },
): IsolatedRecoveryLocalLedgerAppendReceipt;

export function appendIsolatedRecoveryKeyringRotationIntent(
  ledger: IsolatedRecoveryLocalLedger,
  input: {
    previousKeyring: WorkspaceKeyringDescriptor;
    requestedAt?: string;
  },
): IsolatedRecoveryLocalLedgerAppendReceipt;

export function appendIsolatedRecoveryKeyringRotationResult(
  ledger: IsolatedRecoveryLocalLedger,
  input: {
    intent: IsolatedRecoveryLocalLedgerAppendReceipt;
    previousKeyring: WorkspaceKeyringDescriptor;
    nextKeyring: WorkspaceKeyringDescriptor;
  },
): IsolatedRecoveryLocalLedgerAppendReceipt;

export function appendIsolatedRecoveryKeyringPruneIntent(
  ledger: IsolatedRecoveryLocalLedger,
  input: {
    previousKeyring: WorkspaceKeyringDescriptor;
    reaperReceipt: OrphanReaperReceipt;
    requestedAt?: string;
  },
): IsolatedRecoveryLocalLedgerAppendReceipt;

export function appendIsolatedRecoveryKeyringPruneResult(
  ledger: IsolatedRecoveryLocalLedger,
  input: {
    intent: IsolatedRecoveryLocalLedgerAppendReceipt;
    previousKeyring: WorkspaceKeyringDescriptor;
    nextKeyring: WorkspaceKeyringDescriptor;
    reaperReceipt: OrphanReaperReceipt;
  },
): IsolatedRecoveryLocalLedgerAppendReceipt;

export function readPendingIsolatedRecoveryLocalIntents(
  ledger: IsolatedRecoveryLocalLedger,
): Readonly<{
  format: "fundosmart.isolated-recovery-local-ledger-pending.v1";
  workspaceRootSha256: string;
  ledgerIdSha256: string;
  pendingIntentCount: number;
  intents: ReadonlyArray<Readonly<{
    kind: "workspace_sweep" | "keyring_rotation" | "keyring_prune";
    operationIdSha256: string;
    intentPayloadSha256: string;
    requestedAt: string;
  }>>;
  productWritesEnabled: false;
  remoteWrites: false;
}>;

export function readIsolatedRecoveryLocalLedgerAnchor(
  ledger: IsolatedRecoveryLocalLedger,
): IsolatedRecoveryLocalLedgerAnchor;

export function verifyIsolatedRecoveryLocalLedger(
  ledger: IsolatedRecoveryLocalLedger,
  input?: { expectedAnchor?: IsolatedRecoveryLocalLedgerAnchor },
): Readonly<{
  format: "fundosmart.isolated-recovery-local-ledger-verification.v1";
  workspaceRootSha256: string;
  ledgerIdSha256: string;
  entryCount: number;
  eventCounts: Readonly<{
    workspaceSweepCount: number;
    keyringRotationCount: number;
    keyringPruneCount: number;
  }>;
  operationIntentCount: number;
  legacyResultCount: number;
  pendingIntentCount: number;
  pendingIntents: ReadonlyArray<Readonly<{
    kind: "workspace_sweep" | "keyring_rotation" | "keyring_prune";
    operationIdSha256: string;
    intentPayloadSha256: string;
    requestedAt: string;
  }>>;
  anchor: IsolatedRecoveryLocalLedgerAnchor;
  sqliteIntegrityVerified: true;
  appendOnlySchemaVerified: true;
  chainVerified: true;
  anchorVerified: true;
  productWritesEnabled: false;
  remoteWrites: false;
}>;

export function closeIsolatedRecoveryLocalLedger(
  ledger: IsolatedRecoveryLocalLedger,
): Readonly<{
  format: "fundosmart.isolated-recovery-local-ledger-close.v1";
  workspaceRootSha256: string;
  ledgerIdSha256: string;
  entryCount: number;
  anchor: IsolatedRecoveryLocalLedgerAnchor;
  closed: true;
  productWritesEnabled: false;
  remoteWrites: false;
}>;
