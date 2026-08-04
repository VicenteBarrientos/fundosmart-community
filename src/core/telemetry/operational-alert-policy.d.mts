export const OPERATIONAL_ALERT_SNAPSHOT_VERSION: "fundosmart.operational-alert-snapshot.v1";
export const OPERATIONAL_ALERT_POLICY_VERSION: "fundosmart.operational-alert-policy.v1";
export const OPERATIONAL_ALERT_CODES: readonly [
  "HTTP_5XX_RATE",
  "WORKER_P95_DURATION",
  "INTEGRITY_SWEEP_FAILURES",
];

export class OperationalAlertPolicyError extends TypeError {
  readonly code: string;
  constructor(code: string);
}

export type OperationalAlertEnvironment = "production" | "staging";
export type OperationalAlertStatus =
  | "within_threshold"
  | "triggered"
  | "unavailable";
export type OperationalAlertCode = typeof OPERATIONAL_ALERT_CODES[number];
export type OperationalAlertUnit =
  | "ratio"
  | "milliseconds"
  | "weighted_failures";

export type OperationalAlertWindow = Readonly<{
  startedAt: string;
  endedAt: string;
}>;

export type OperationalAlertSnapshotV1 = Readonly<{
  schemaVersion: typeof OPERATIONAL_ALERT_SNAPSHOT_VERSION;
  environment: OperationalAlertEnvironment;
  requestWindow: Readonly<{
    startedAt: string;
    endedAt: string;
    weightedRequestCount: number | null;
    weighted5xxCount: number | null;
    weightedP95DurationMs: number | null;
  }>;
  integrityWindow: Readonly<{
    startedAt: string;
    endedAt: string;
    weightedExecutionCount: number | null;
    weightedFailureCount: number | null;
  }>;
}>;

export type OperationalAlertEvaluation = Readonly<{
  code: OperationalAlertCode;
  status: OperationalAlertStatus;
  value: number | null;
  evidence:
    | Readonly<{
        weightedRequestCount: number | null;
        weighted5xxCount: number | null;
      }>
    | Readonly<{
        weightedRequestCount: number | null;
      }>
    | Readonly<{
        weightedExecutionCount: number | null;
        weightedFailureCount: number | null;
      }>;
  threshold: number;
  unit: OperationalAlertUnit;
  window: OperationalAlertWindow;
}>;

export type OperationalAlertPolicyResult = Readonly<{
  contractVersion: typeof OPERATIONAL_ALERT_POLICY_VERSION;
  environment: OperationalAlertEnvironment;
  evaluatedAt: string;
  provenance: "caller_supplied_weighted_aggregate_unverified";
  evaluations: readonly OperationalAlertEvaluation[];
}>;

export function evaluateOperationalAlertPolicy(
  snapshot: OperationalAlertSnapshotV1,
): OperationalAlertPolicyResult;
