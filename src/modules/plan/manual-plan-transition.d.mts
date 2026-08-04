import type { PlanKey, PlanResourceQuotas } from "./catalog.d.mts";

export const MANUAL_PLAN_TRANSITION_CONTRACT_VERSION:
  "fundosmart.manual-plan-transition.v1";
export const MANUAL_PLAN_TRANSITION_APPROVAL_ATTESTATION:
  "caller_supplied_manual_unverified";

export type ManualPlanUsage = Readonly<{
  fields: number;
  paddocks: number;
  members: number;
  monthlyExports: number;
}>;

export type ManualPlanTransitionRequest = Readonly<{
  operationId: string;
  scopePseudonym: `scope:v1:${string}`;
  expectedCatalogVersion: "fundosmart.plan-catalog.v1";
  currentPlanKey: PlanKey;
  targetPlanKey: PlanKey;
  usage: ManualPlanUsage;
  approvalAttestation: "caller_supplied_manual_unverified";
}>;

export type ManualPlanTransitionKind =
  | "no_op"
  | "upgrade"
  | "downgrade"
  | "legacy_migration";

export type ManualPlanResourceProjection = Readonly<{
  resourceKey: keyof PlanResourceQuotas;
  kind: "count" | "feature";
  currentLimit: number | null;
  targetLimit: number | null;
  currentEnabled: boolean | null;
  targetEnabled: boolean | null;
  currentUsage: number | null;
  change: "unchanged" | "expanded" | "contracted";
  targetAllowsAdditionalUsageUnderCatalog: boolean;
}>;

export type ManualPlanTransitionReceipt = Readonly<{
  contractVersion: "fundosmart.manual-plan-transition.v1";
  catalogVersion: "fundosmart.plan-catalog.v1";
  receiptId: `mpr:v1:${string}`;
  request: ManualPlanTransitionRequest;
  transitionKind: ManualPlanTransitionKind;
  hasCapabilityContractions: boolean;
  resourceProjections: readonly ManualPlanResourceProjection[];
  approval: Readonly<{
    required: boolean;
    evaluated: false;
    approved: false;
    attestation: "caller_supplied_manual_unverified";
  }>;
  preservation: Readonly<{
    existingDataPreserved: true;
    readAccessPreserved: true;
    historyPreserved: true;
    deletionAuthorized: false;
    truncationAuthorized: false;
    hidingAuthorized: false;
  }>;
  execution: Readonly<{
    submitted: false;
    persisted: false;
    planApplied: false;
    limitsApplied: false;
    writesRestricted: false;
    billingCreated: false;
    paymentCollected: false;
    invoiceIssued: false;
    saleAuthorized: false;
  }>;
  prerequisites: Readonly<{
    reauthorizationRequired: true;
    currentPlanComparisonRequired: true;
    usageRefreshRequired: true;
    atomicPersistenceRequired: true;
    costlyWritePolicyRequiredBeforeCommit: true;
  }>;
  attestation: Readonly<{
    scope: "caller_supplied_pseudonym_unverified";
    currentPlan: "caller_supplied_unverified";
    usage: "caller_supplied_unverified";
    approval: "caller_supplied_unverified";
    existingReceipt: "caller_supplied_unverified";
  }>;
}>;

export class ManualPlanTransitionError extends TypeError {
  readonly code: string;
}

export function createManualPlanTransitionReceipt(
  request: ManualPlanTransitionRequest,
  existingReceipt?: ManualPlanTransitionReceipt | null,
): ManualPlanTransitionReceipt;
