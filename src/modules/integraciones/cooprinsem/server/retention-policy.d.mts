export type OriginalRetentionGateCode =
  | "retention_period_approved"
  | "separate_delete_capability"
  | "portable_backup_attested"
  | "restore_rehearsal_attested"
  | "human_confirmation_bound"
  | "before_after_audit_ready"
  | "recovery_window_approved"
  | "integrity_clear";

export type OriginalRetentionSimulation = {
  fieldId: string;
  fieldName: string;
  organizationId: string;
  evaluatedAt: string;
  status: "empty" | "retain_all";
  policy: {
    id: string;
    version: number;
    mode: "retain_only";
    deletionEnabled: false;
    approvedRetentionDays: null;
    lifecycleExpirationEnabled: false;
  };
  inventory: {
    oldestImportedAt: string | null;
    newestImportedAt: string | null;
  };
  totals: {
    originalCount: number;
    totalSizeBytes: number;
    retainCount: number;
    eligibleForDeletionCount: 0;
    openIntegrityIncidentCount: number;
  };
  gates: Array<{
    code: OriginalRetentionGateCode;
    label: string;
    satisfied: boolean;
    detail: string;
  }>;
};

export declare const ORIGINAL_RETENTION_POLICY: Readonly<OriginalRetentionSimulation["policy"]>;

export declare function simulateOriginalRetention(input: {
  fieldId: string;
  fieldName: string;
  organizationId: string;
  evaluatedAt: string;
  originalCount: number;
  totalSizeBytes: number;
  openIntegrityIncidentCount: number;
  oldestImportedAt?: string | null;
  newestImportedAt?: string | null;
}): OriginalRetentionSimulation;
