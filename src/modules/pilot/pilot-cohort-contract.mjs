export const PILOT_COHORT_CONTRACT_VERSION = "fundosmart.pilot-cohort.v1";

const MAX_PARTICIPANTS = 100;
const MAX_OBSERVATION_WEEKS = 52;
const MAX_INCIDENTS = 100_000;
const MAX_SUPPORT_MINUTES_PER_WEEK = 10_080;
const MAX_SUPPORT_SAMPLES = MAX_PARTICIPANTS * MAX_OBSERVATION_WEEKS;

const STAGE_TARGETS = Object.freeze({
  discovery: Object.freeze({
    count: 2,
    unit: "users",
    mustPrecedeProductChanges: true,
  }),
  assisted: Object.freeze({
    count: 3,
    unit: "pilot_organizations",
  }),
  semiAutonomous: Object.freeze({
    count: 5,
    unit: "pilot_organizations",
    minimumObservationWeeks: 4,
  }),
});

const ACCEPTANCE_THRESHOLDS = Object.freeze({
  activationWithin24HoursPercentMinimum: 60,
  week4RetentionPercentMinimum: 50,
  openP0Maximum: 0,
  openP1Maximum: 0,
  medianSupportMinutesExclusiveMaximum: 30,
  valueLossConfirmedUsersMinimum: 3,
});

const OPERATING_PROTOCOL = Object.freeze({
  consentRequiredBeforeObservation: true,
  contactPermissionIsNotPilotConsent: true,
  approvedConsentRevisionRequired: true,
  weeklyInterviewMinutes: 20,
  issueRegisterDimensions: Object.freeze(["severity", "frequency", "segment"]),
  aggregateEvidenceOnly: true,
  week4WindowHours: Object.freeze({
    startInclusive: 672,
    endExclusive: 840,
  }),
  separateG0ReviewRequiredBeforeInvitation: true,
  humanDecisionRequired: true,
});

export const PILOT_COHORT_1_CONTRACT = Object.freeze({
  contractVersion: PILOT_COHORT_CONTRACT_VERSION,
  evidenceKinds: Object.freeze(["synthetic", "observed"]),
  stages: STAGE_TARGETS,
  acceptance: ACCEPTANCE_THRESHOLDS,
  protocol: OPERATING_PROTOCOL,
});

const ROOT_FIELDS = Object.freeze([
  "contractVersion",
  "evidenceKind",
  "stages",
  "activation",
  "retention",
  "incidents",
  "support",
  "valueLoss",
]);
const STAGE_FIELDS = Object.freeze([
  "discoveryParticipants",
  "discoveryCompletedBeforeProductChanges",
  "assistedOrganizations",
  "semiAutonomousOrganizations",
  "semiAutonomousObservationWeeks",
]);
const ACTIVATION_FIELDS = Object.freeze([
  "eligibleOrganizations",
  "activatedWithin24Hours",
]);
const RETENTION_FIELDS = Object.freeze([
  "activatedOrganizationsEligibleAtWeek4",
  "retainedOrganizationsAtWeek4",
]);
const INCIDENT_FIELDS = Object.freeze([
  "snapshotComplete",
  "openP0",
  "openP1",
]);
const SUPPORT_FIELDS = Object.freeze(["minutesPerOrganizationWeek"]);
const VALUE_LOSS_FIELDS = Object.freeze([
  "respondents",
  "organizationsRepresented",
  "confirmedUsers",
]);
const EVIDENCE_KINDS = new Set(PILOT_COHORT_1_CONTRACT.evidenceKinds);

const INSUFFICIENT_EVIDENCE_BLOCKERS = new Set([
  "DISCOVERY_STAGE_INCOMPLETE",
  "DISCOVERY_ORDER_UNCONFIRMED",
  "ASSISTED_STAGE_INCOMPLETE",
  "SEMI_AUTONOMOUS_STAGE_INCOMPLETE",
  "OBSERVATION_WINDOW_INCOMPLETE",
  "ACTIVATION_COHORT_INCOMPLETE",
  "WEEK4_MATURITY_INCOMPLETE",
  "INCIDENT_SNAPSHOT_INCOMPLETE",
  "SUPPORT_COVERAGE_INCOMPLETE",
  "VALUE_LOSS_EVIDENCE_INCOMPLETE",
]);

export class PilotCohortContractError extends TypeError {
  constructor(code) {
    super(`Invalid pilot cohort aggregate (${code}).`);
    this.name = "PilotCohortContractError";
    this.code = code;
  }
}

export function evaluatePilotCohortAggregate(input) {
  const evidence = normalizeEvidence(input);
  const blockers = [];

  const stagesMet = evaluateStages(evidence.stages, blockers);
  const activation = evaluateRate({
    numerator: evidence.activation.activatedWithin24Hours,
    denominator: evidence.activation.eligibleOrganizations,
    thresholdPercent: ACCEPTANCE_THRESHOLDS.activationWithin24HoursPercentMinimum,
    measured: (
      evidence.activation.eligibleOrganizations > 0
      && evidence.activation.eligibleOrganizations
        === evidence.stages.semiAutonomousOrganizations
    ),
  });
  if (!activation.measured) {
    blockers.push("ACTIVATION_COHORT_INCOMPLETE");
  } else if (!activation.met) {
    blockers.push("ACTIVATION_BELOW_TARGET");
  }

  const retentionCoverageComplete = (
    evidence.retention.activatedOrganizationsEligibleAtWeek4
    === evidence.activation.activatedWithin24Hours
  );
  const retention = evaluateRate({
    numerator: evidence.retention.retainedOrganizationsAtWeek4,
    denominator: evidence.retention.activatedOrganizationsEligibleAtWeek4,
    thresholdPercent: ACCEPTANCE_THRESHOLDS.week4RetentionPercentMinimum,
    measured: (
      retentionCoverageComplete
      && evidence.retention.activatedOrganizationsEligibleAtWeek4 > 0
    ),
  });
  if (!retentionCoverageComplete) {
    blockers.push("WEEK4_MATURITY_INCOMPLETE");
  } else if (retention.measured && !retention.met) {
    blockers.push("WEEK4_RETENTION_BELOW_TARGET");
  }

  const incidents = Object.freeze({
    measured: evidence.incidents.snapshotComplete,
    openP0: evidence.incidents.openP0,
    openP1: evidence.incidents.openP1,
    met: (
      evidence.incidents.snapshotComplete
      && evidence.incidents.openP0 === ACCEPTANCE_THRESHOLDS.openP0Maximum
      && evidence.incidents.openP1 === ACCEPTANCE_THRESHOLDS.openP1Maximum
    ),
  });
  if (!incidents.measured) {
    blockers.push("INCIDENT_SNAPSHOT_INCOMPLETE");
  }
  if (incidents.openP0 > 0) blockers.push("OPEN_P0_INCIDENTS");
  if (incidents.openP1 > 0) blockers.push("OPEN_P1_INCIDENTS");

  const expectedSupportSamples = (
    evidence.stages.semiAutonomousOrganizations
    * evidence.stages.semiAutonomousObservationWeeks
  );
  const supportMeasured = (
    expectedSupportSamples > 0
    && evidence.supportMinutes.length === expectedSupportSamples
  );
  const medianSupportMinutes = supportMeasured
    ? median(evidence.supportMinutes)
    : null;
  const support = Object.freeze({
    measured: supportMeasured,
    sampleCount: evidence.supportMinutes.length,
    expectedSampleCount: expectedSupportSamples,
    medianMinutesPerOrganizationWeek: medianSupportMinutes,
    exclusiveMaximumMinutes: ACCEPTANCE_THRESHOLDS.medianSupportMinutesExclusiveMaximum,
    met: (
      medianSupportMinutes !== null
      && medianSupportMinutes
        < ACCEPTANCE_THRESHOLDS.medianSupportMinutesExclusiveMaximum
    ),
  });
  if (!support.measured) {
    blockers.push("SUPPORT_COVERAGE_INCOMPLETE");
  } else if (!support.met) {
    blockers.push("SUPPORT_MEDIAN_AT_OR_ABOVE_LIMIT");
  }

  const valueLossMeasured = (
    evidence.valueLoss.organizationsRepresented > 0
    && evidence.valueLoss.organizationsRepresented
      === evidence.stages.semiAutonomousOrganizations
  );
  const valueLoss = Object.freeze({
    measured: valueLossMeasured,
    respondents: evidence.valueLoss.respondents,
    organizationsRepresented: evidence.valueLoss.organizationsRepresented,
    confirmedUsers: evidence.valueLoss.confirmedUsers,
    minimumConfirmedUsers: ACCEPTANCE_THRESHOLDS.valueLossConfirmedUsersMinimum,
    met: (
      valueLossMeasured
      && evidence.valueLoss.confirmedUsers
      >= ACCEPTANCE_THRESHOLDS.valueLossConfirmedUsersMinimum
    ),
  });
  if (!valueLoss.measured) {
    blockers.push("VALUE_LOSS_EVIDENCE_INCOMPLETE");
  } else if (!valueLoss.met) {
    blockers.push("VALUE_LOSS_BELOW_TARGET");
  }

  const frozenBlockers = Object.freeze([...blockers]);
  const hasInsufficientEvidence = frozenBlockers.some(
    (blocker) => INSUFFICIENT_EVIDENCE_BLOCKERS.has(blocker),
  );
  const aggregateAcceptanceMetricsMet = (
    stagesMet
    && activation.met
    && (evidence.activation.activatedWithin24Hours === 0 || retention.met)
    && incidents.met
    && support.met
    && valueLoss.met
  );
  const fs10AcceptanceMetricsMet = (
    evidence.evidenceKind === "observed"
    && aggregateAcceptanceMetricsMet
    && frozenBlockers.length === 0
  );

  let assessment = "acceptance_metrics_not_met";
  if (evidence.evidenceKind === "synthetic") {
    assessment = "synthetic_only";
  } else if (hasInsufficientEvidence) {
    assessment = "insufficient_evidence";
  } else if (fs10AcceptanceMetricsMet) {
    assessment = "acceptance_metrics_met";
  }

  return Object.freeze({
    contractVersion: PILOT_COHORT_CONTRACT_VERSION,
    evidenceKind: evidence.evidenceKind,
    evidenceAttestation: "caller_supplied_aggregate_unverified",
    assessment,
    aggregateAcceptanceMetricsMet,
    fs10AcceptanceMetricsMet,
    humanDecisionRequired: true,
    separateG0ReviewRequiredBeforeInvitation: true,
    externalPilotInvitationAuthorized: false,
    g0Evaluated: false,
    g1Evaluated: false,
    saleAuthorized: false,
    metrics: Object.freeze({
      activation,
      retention,
      incidents,
      support,
      valueLoss,
    }),
    blockers: frozenBlockers,
  });
}

function normalizeEvidence(input) {
  try {
    const root = readClosedRecord(input, ROOT_FIELDS, "root_fields");
    if (root.contractVersion !== PILOT_COHORT_CONTRACT_VERSION) {
      fail("contract_version");
    }
    if (!EVIDENCE_KINDS.has(root.evidenceKind)) fail("evidence_kind");

    const stages = readClosedRecord(root.stages, STAGE_FIELDS, "stage_fields");
    const normalizedStages = Object.freeze({
      discoveryParticipants: count(stages.discoveryParticipants, "discovery_participants"),
      discoveryCompletedBeforeProductChanges: boolean(
        stages.discoveryCompletedBeforeProductChanges,
        "discovery_order",
      ),
      assistedOrganizations: count(stages.assistedOrganizations, "assisted_organizations"),
      semiAutonomousOrganizations: count(
        stages.semiAutonomousOrganizations,
        "semi_autonomous_organizations",
      ),
      semiAutonomousObservationWeeks: count(
        stages.semiAutonomousObservationWeeks,
        "observation_weeks",
        MAX_OBSERVATION_WEEKS,
      ),
    });

    const activation = readClosedRecord(
      root.activation,
      ACTIVATION_FIELDS,
      "activation_fields",
    );
    const normalizedActivation = Object.freeze({
      eligibleOrganizations: count(
        activation.eligibleOrganizations,
        "activation_eligible",
      ),
      activatedWithin24Hours: count(
        activation.activatedWithin24Hours,
        "activation_count",
      ),
    });
    if (
      normalizedActivation.eligibleOrganizations
        > normalizedStages.semiAutonomousOrganizations
      || normalizedActivation.activatedWithin24Hours
        > normalizedActivation.eligibleOrganizations
    ) {
      fail("activation_relationship");
    }

    const retention = readClosedRecord(
      root.retention,
      RETENTION_FIELDS,
      "retention_fields",
    );
    const normalizedRetention = Object.freeze({
      activatedOrganizationsEligibleAtWeek4: count(
        retention.activatedOrganizationsEligibleAtWeek4,
        "retention_eligible",
      ),
      retainedOrganizationsAtWeek4: count(
        retention.retainedOrganizationsAtWeek4,
        "retention_count",
      ),
    });
    if (
      normalizedRetention.activatedOrganizationsEligibleAtWeek4
        > normalizedActivation.activatedWithin24Hours
      || normalizedRetention.retainedOrganizationsAtWeek4
        > normalizedRetention.activatedOrganizationsEligibleAtWeek4
    ) {
      fail("retention_relationship");
    }

    const incidents = readClosedRecord(root.incidents, INCIDENT_FIELDS, "incident_fields");
    const normalizedIncidents = Object.freeze({
      snapshotComplete: boolean(incidents.snapshotComplete, "incident_snapshot"),
      openP0: count(incidents.openP0, "incident_p0", MAX_INCIDENTS),
      openP1: count(incidents.openP1, "incident_p1", MAX_INCIDENTS),
    });

    const support = readClosedRecord(root.support, SUPPORT_FIELDS, "support_fields");
    const supportMinutes = numberArray(
      support.minutesPerOrganizationWeek,
      "support_samples",
      MAX_SUPPORT_SAMPLES,
      MAX_SUPPORT_MINUTES_PER_WEEK,
    );
    const maximumSupportSamples = (
      normalizedStages.semiAutonomousOrganizations
      * normalizedStages.semiAutonomousObservationWeeks
    );
    if (supportMinutes.length > maximumSupportSamples) {
      fail("support_relationship");
    }

    const valueLoss = readClosedRecord(root.valueLoss, VALUE_LOSS_FIELDS, "value_loss_fields");
    const normalizedValueLoss = Object.freeze({
      respondents: count(valueLoss.respondents, "value_loss_respondents"),
      organizationsRepresented: count(
        valueLoss.organizationsRepresented,
        "value_loss_organizations",
      ),
      confirmedUsers: count(valueLoss.confirmedUsers, "value_loss_confirmed"),
    });
    if (
      normalizedValueLoss.organizationsRepresented
        > normalizedStages.semiAutonomousOrganizations
      || normalizedValueLoss.organizationsRepresented
        > normalizedValueLoss.respondents
      || normalizedValueLoss.confirmedUsers > normalizedValueLoss.respondents
    ) {
      fail("value_loss_relationship");
    }

    return Object.freeze({
      evidenceKind: root.evidenceKind,
      stages: normalizedStages,
      activation: normalizedActivation,
      retention: normalizedRetention,
      incidents: normalizedIncidents,
      supportMinutes,
      valueLoss: normalizedValueLoss,
    });
  } catch (error) {
    if (error instanceof PilotCohortContractError) throw error;
    fail("evidence_access");
  }
}

function evaluateStages(stages, blockers) {
  let met = true;
  if (stages.discoveryParticipants < STAGE_TARGETS.discovery.count) {
    blockers.push("DISCOVERY_STAGE_INCOMPLETE");
    met = false;
  }
  if (!stages.discoveryCompletedBeforeProductChanges) {
    blockers.push("DISCOVERY_ORDER_UNCONFIRMED");
    met = false;
  }
  if (stages.assistedOrganizations < STAGE_TARGETS.assisted.count) {
    blockers.push("ASSISTED_STAGE_INCOMPLETE");
    met = false;
  }
  if (stages.semiAutonomousOrganizations < STAGE_TARGETS.semiAutonomous.count) {
    blockers.push("SEMI_AUTONOMOUS_STAGE_INCOMPLETE");
    met = false;
  }
  if (
    stages.semiAutonomousObservationWeeks
    < STAGE_TARGETS.semiAutonomous.minimumObservationWeeks
  ) {
    blockers.push("OBSERVATION_WINDOW_INCOMPLETE");
    met = false;
  }
  return met;
}

function evaluateRate({
  numerator,
  denominator,
  thresholdPercent,
  measured,
}) {
  const met = measured && numerator * 100 >= denominator * thresholdPercent;
  return Object.freeze({
    measured,
    numerator,
    denominator,
    percent: measured ? Math.round((numerator * 10_000) / denominator) / 100 : null,
    minimumPercent: thresholdPercent,
    met,
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function readClosedRecord(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);

  const allowed = new Set(fields);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    fail(code);
  }

  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function numberArray(value, code, maximumLength, maximumValue) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumLength
  ) {
    fail(code);
  }

  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) fail(code);

  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    copy.push(count(descriptor.value, code, maximumValue));
  }
  return Object.freeze(copy);
}

function count(value, code, maximum = MAX_PARTICIPANTS) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code);
  return value;
}

function boolean(value, code) {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function fail(code) {
  throw new PilotCohortContractError(code);
}
