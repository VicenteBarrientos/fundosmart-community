export const PILOT_COHORT_CONTRACT_VERSION: "fundosmart.pilot-cohort.v1";

export type PilotEvidenceKind = "synthetic" | "observed";
export type PilotGateAssessment =
  | "synthetic_only"
  | "insufficient_evidence"
  | "acceptance_metrics_not_met"
  | "acceptance_metrics_met";

export type PilotCohortAggregateInput = {
  contractVersion: typeof PILOT_COHORT_CONTRACT_VERSION;
  evidenceKind: PilotEvidenceKind;
  stages: {
    discoveryParticipants: number;
    discoveryCompletedBeforeProductChanges: boolean;
    assistedOrganizations: number;
    semiAutonomousOrganizations: number;
    semiAutonomousObservationWeeks: number;
  };
  activation: {
    eligibleOrganizations: number;
    activatedWithin24Hours: number;
  };
  retention: {
    activatedOrganizationsEligibleAtWeek4: number;
    retainedOrganizationsAtWeek4: number;
  };
  incidents: {
    snapshotComplete: boolean;
    openP0: number;
    openP1: number;
  };
  support: {
    minutesPerOrganizationWeek: readonly number[];
  };
  valueLoss: {
    respondents: number;
    organizationsRepresented: number;
    confirmedUsers: number;
  };
};

export type PilotRateMetric = Readonly<{
  measured: boolean;
  numerator: number;
  denominator: number;
  percent: number | null;
  minimumPercent: number;
  met: boolean;
}>;

export type PilotIncidentMetric = Readonly<{
  measured: boolean;
  openP0: number;
  openP1: number;
  met: boolean;
}>;

export type PilotSupportMetric = Readonly<{
  measured: boolean;
  sampleCount: number;
  expectedSampleCount: number;
  medianMinutesPerOrganizationWeek: number | null;
  exclusiveMaximumMinutes: number;
  met: boolean;
}>;

export type PilotValueLossMetric = Readonly<{
  measured: boolean;
  respondents: number;
  organizationsRepresented: number;
  confirmedUsers: number;
  minimumConfirmedUsers: number;
  met: boolean;
}>;

export type PilotCohortBlocker =
  | "DISCOVERY_STAGE_INCOMPLETE"
  | "DISCOVERY_ORDER_UNCONFIRMED"
  | "ASSISTED_STAGE_INCOMPLETE"
  | "SEMI_AUTONOMOUS_STAGE_INCOMPLETE"
  | "OBSERVATION_WINDOW_INCOMPLETE"
  | "ACTIVATION_COHORT_INCOMPLETE"
  | "ACTIVATION_BELOW_TARGET"
  | "WEEK4_MATURITY_INCOMPLETE"
  | "WEEK4_RETENTION_BELOW_TARGET"
  | "INCIDENT_SNAPSHOT_INCOMPLETE"
  | "OPEN_P0_INCIDENTS"
  | "OPEN_P1_INCIDENTS"
  | "SUPPORT_COVERAGE_INCOMPLETE"
  | "SUPPORT_MEDIAN_AT_OR_ABOVE_LIMIT"
  | "VALUE_LOSS_EVIDENCE_INCOMPLETE"
  | "VALUE_LOSS_BELOW_TARGET";

export type PilotCohortAssessment = Readonly<{
  contractVersion: typeof PILOT_COHORT_CONTRACT_VERSION;
  evidenceKind: PilotEvidenceKind;
  evidenceAttestation: "caller_supplied_aggregate_unverified";
  assessment: PilotGateAssessment;
  aggregateAcceptanceMetricsMet: boolean;
  fs10AcceptanceMetricsMet: boolean;
  humanDecisionRequired: true;
  separateG0ReviewRequiredBeforeInvitation: true;
  externalPilotInvitationAuthorized: false;
  g0Evaluated: false;
  g1Evaluated: false;
  saleAuthorized: false;
  metrics: Readonly<{
    activation: PilotRateMetric;
    retention: PilotRateMetric;
    incidents: PilotIncidentMetric;
    support: PilotSupportMetric;
    valueLoss: PilotValueLossMetric;
  }>;
  blockers: readonly PilotCohortBlocker[];
}>;

export const PILOT_COHORT_1_CONTRACT: Readonly<{
  contractVersion: typeof PILOT_COHORT_CONTRACT_VERSION;
  evidenceKinds: readonly ["synthetic", "observed"];
  stages: Readonly<{
    discovery: Readonly<{
      count: 2;
      unit: "users";
      mustPrecedeProductChanges: true;
    }>;
    assisted: Readonly<{
      count: 3;
      unit: "pilot_organizations";
    }>;
    semiAutonomous: Readonly<{
      count: 5;
      unit: "pilot_organizations";
      minimumObservationWeeks: 4;
    }>;
  }>;
  acceptance: Readonly<{
    activationWithin24HoursPercentMinimum: 60;
    week4RetentionPercentMinimum: 50;
    openP0Maximum: 0;
    openP1Maximum: 0;
    medianSupportMinutesExclusiveMaximum: 30;
    valueLossConfirmedUsersMinimum: 3;
  }>;
  protocol: Readonly<{
    consentRequiredBeforeObservation: true;
    contactPermissionIsNotPilotConsent: true;
    approvedConsentRevisionRequired: true;
    weeklyInterviewMinutes: 20;
    issueRegisterDimensions: readonly ["severity", "frequency", "segment"];
    aggregateEvidenceOnly: true;
    week4WindowHours: Readonly<{
      startInclusive: 672;
      endExclusive: 840;
    }>;
    separateG0ReviewRequiredBeforeInvitation: true;
    humanDecisionRequired: true;
  }>;
}>;

export class PilotCohortContractError extends TypeError {
  constructor(code: string);
  code: string;
}

export function evaluatePilotCohortAggregate(
  input: PilotCohortAggregateInput,
): PilotCohortAssessment;
