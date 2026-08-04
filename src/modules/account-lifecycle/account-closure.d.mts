export type AccountClosureScope = "account" | "organization";
export type AccountClosurePersistedStatus = "grace" | "revoked";
export type AccountClosureDerivedState = AccountClosurePersistedStatus | "expired";
export type AccountClosureSnapshot = Readonly<{
  memberships: readonly Readonly<{
    id: string;
    organizationId: string;
    role: "owner" | "admin" | "manager" | "operator" | "viewer";
    status: "active" | "suspended";
    fieldIds: readonly string[];
  }>[];
}>;

export type AccountClosureRecord = Readonly<{
  id: string;
  scope: AccountClosureScope;
  targetId: string;
  status: AccountClosurePersistedStatus;
  requestedAt: string;
  graceEndsAt: string;
  revokedAt: string | null;
  version: number;
  snapshotVersion: 1;
  snapshot: AccountClosureSnapshot;
}>;

export const ACCOUNT_CLOSURE_SCOPES: readonly AccountClosureScope[];
export const ACCOUNT_CLOSURE_PERSISTED_STATUSES: readonly AccountClosurePersistedStatus[];
export const ACCOUNT_CLOSURE_GRACE_DAYS: 30;
export const ACCOUNT_CLOSURE_SNAPSHOT_VERSION: 1;

export class AccountClosureError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function createAccountClosureRequestPlan(input: {
  actorIdentityId: string;
  idFactory: (label: string) => string;
  now: string;
  requestId: string;
  scope: AccountClosureScope;
  snapshot: AccountClosureSnapshot;
  targetId: string;
}): Readonly<{
  closureRequest: Readonly<{
    id: string;
    scope: AccountClosureScope;
    targetId: string;
    actorIdentityId: string;
    requestId: string;
    status: "grace";
    requestedAt: string;
    graceEndsAt: string;
    revokedAt: null;
    version: 1;
    snapshotVersion: 1;
    snapshot: AccountClosureSnapshot;
  }>;
  event: Readonly<{
    id: string;
    closureRequestId: string;
    actorIdentityId: string;
    requestId: string;
    action: "account.closure.requested";
    occurredAt: string;
    payload: Readonly<Record<string, unknown>>;
  }>;
}>;

export function evaluateAccountClosure(
  current: AccountClosureRecord,
  now: string,
): Readonly<{
  state: AccountClosureDerivedState;
  accessSuspended: boolean;
  revocable: boolean;
  evaluatedAt: string;
}>;

export function createAccountClosureRevocationPlan(input: {
  actorIdentityId: string;
  current: AccountClosureRecord;
  idFactory: (label: string) => string;
  now: string;
  requestId: string;
}): Readonly<{
  revocation: Readonly<{
    closureRequestId: string;
    actorIdentityId: string;
    requestId: string;
    expectedVersion: number;
    nextVersion: number;
    revokedAt: string;
    preservedSnapshot: AccountClosureSnapshot;
  }>;
  event: Readonly<{
    id: string;
    closureRequestId: string;
    actorIdentityId: string;
    requestId: string;
    action: "account.closure.revoked";
    occurredAt: string;
    payload: Readonly<Record<string, unknown>>;
  }>;
}>;

export function canonicalAccountClosureSnapshotJson(value: unknown): string;
