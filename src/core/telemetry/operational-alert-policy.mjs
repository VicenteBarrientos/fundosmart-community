export const OPERATIONAL_ALERT_SNAPSHOT_VERSION = "fundosmart.operational-alert-snapshot.v1";
export const OPERATIONAL_ALERT_POLICY_VERSION = "fundosmart.operational-alert-policy.v1";
export const OPERATIONAL_ALERT_CODES = Object.freeze([
  "HTTP_5XX_RATE",
  "WORKER_P95_DURATION",
  "INTEGRITY_SWEEP_FAILURES",
]);

const PROVENANCE = "caller_supplied_weighted_aggregate_unverified";
const REQUEST_WINDOW_MS = 15 * 60 * 1_000;
const INTEGRITY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion",
  "environment",
  "requestWindow",
  "integrityWindow",
]);
const REQUEST_WINDOW_FIELDS = Object.freeze([
  "startedAt",
  "endedAt",
  "weightedRequestCount",
  "weighted5xxCount",
  "weightedP95DurationMs",
]);
const INTEGRITY_WINDOW_FIELDS = Object.freeze([
  "startedAt",
  "endedAt",
  "weightedExecutionCount",
  "weightedFailureCount",
]);
const ENVIRONMENTS = new Set(["production", "staging"]);
const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export class OperationalAlertPolicyError extends TypeError {
  constructor(code) {
    super(`Invalid operational alert policy input (${code}).`);
    this.name = "OperationalAlertPolicyError";
    this.code = code;
  }
}

export function evaluateOperationalAlertPolicy(value) {
  const snapshot = readClosedRecord(value, SNAPSHOT_FIELDS, "snapshot_shape");
  if (snapshot.schemaVersion !== OPERATIONAL_ALERT_SNAPSHOT_VERSION) {
    fail("schema_version");
  }
  if (!ENVIRONMENTS.has(snapshot.environment)) fail("environment");

  const requestWindow = readWindow(
    snapshot.requestWindow,
    REQUEST_WINDOW_FIELDS,
    "request_window_shape",
    REQUEST_WINDOW_MS,
  );
  const integrityWindow = readWindow(
    snapshot.integrityWindow,
    INTEGRITY_WINDOW_FIELDS,
    "integrity_window_shape",
    INTEGRITY_WINDOW_MS,
  );
  if (requestWindow.endedAtMs !== integrityWindow.endedAtMs) {
    fail("window_alignment");
  }

  const requestMetrics = readRequestMetrics(requestWindow);
  const integrityMetrics = readIntegrityMetrics(integrityWindow);
  const requestOutputWindow = freezeWindow(requestWindow);
  const integrityOutputWindow = freezeWindow(integrityWindow);

  const hasRequests = requestMetrics.weightedRequestCount !== null
    && requestMetrics.weightedRequestCount > 0;
  const errorRate = hasRequests
    ? requestMetrics.weighted5xxCount / requestMetrics.weightedRequestCount
    : null;
  const errorRateFiring = hasRequests
    && BigInt(requestMetrics.weighted5xxCount) * 100n
      >= BigInt(requestMetrics.weightedRequestCount);
  const hasP95 = hasRequests && requestMetrics.weightedP95DurationMs !== null;
  const hasIntegrityExecutions = integrityMetrics.weightedExecutionCount !== null
    && integrityMetrics.weightedExecutionCount > 0;

  const evaluations = Object.freeze([
    freezeEvaluation({
      code: OPERATIONAL_ALERT_CODES[0],
      status: statusFor(hasRequests, errorRateFiring),
      value: errorRate,
      evidence: freezeEvidence({
        weightedRequestCount: requestMetrics.weightedRequestCount,
        weighted5xxCount: requestMetrics.weighted5xxCount,
      }),
      threshold: 0.01,
      unit: "ratio",
      window: requestOutputWindow,
    }),
    freezeEvaluation({
      code: OPERATIONAL_ALERT_CODES[1],
      status: statusFor(
        hasP95,
        hasP95 && requestMetrics.weightedP95DurationMs >= 2_000,
      ),
      value: hasP95 ? requestMetrics.weightedP95DurationMs : null,
      evidence: freezeEvidence({
        weightedRequestCount: requestMetrics.weightedRequestCount,
      }),
      threshold: 2_000,
      unit: "milliseconds",
      window: requestOutputWindow,
    }),
    freezeEvaluation({
      code: OPERATIONAL_ALERT_CODES[2],
      status: statusFor(
        hasIntegrityExecutions,
        hasIntegrityExecutions && integrityMetrics.weightedFailureCount >= 1,
      ),
      value: hasIntegrityExecutions
        ? integrityMetrics.weightedFailureCount
        : null,
      evidence: freezeEvidence({
        weightedExecutionCount: integrityMetrics.weightedExecutionCount,
        weightedFailureCount: integrityMetrics.weightedFailureCount,
      }),
      threshold: 1,
      unit: "weighted_failures",
      window: integrityOutputWindow,
    }),
  ]);

  return Object.freeze({
    contractVersion: OPERATIONAL_ALERT_POLICY_VERSION,
    environment: snapshot.environment,
    evaluatedAt: requestWindow.endedAt,
    provenance: PROVENANCE,
    evaluations,
  });
}

function readWindow(value, fields, shapeCode, expectedDurationMs) {
  const window = readClosedRecord(value, fields, shapeCode);
  const startedAtMs = parseUtcTimestamp(window.startedAt);
  const endedAtMs = parseUtcTimestamp(window.endedAt);
  if (endedAtMs - startedAtMs !== expectedDurationMs) {
    fail("window_duration");
  }
  return { ...window, startedAtMs, endedAtMs };
}

function readRequestMetrics(window) {
  const weightedRequestCount = nullableCount(window.weightedRequestCount);
  const weighted5xxCount = nullableCount(window.weighted5xxCount);
  const weightedP95DurationMs = nullableMetric(window.weightedP95DurationMs);

  if ((weightedRequestCount === null) !== (weighted5xxCount === null)) {
    fail("metric_availability");
  }
  if (
    weightedRequestCount === null
    && weightedP95DurationMs !== null
  ) {
    fail("metric_availability");
  }
  if (
    weightedRequestCount !== null
    && weighted5xxCount > weightedRequestCount
  ) {
    fail("metric_invariants");
  }
  if (weightedRequestCount === 0 && weightedP95DurationMs !== null) {
    fail("metric_availability");
  }

  return {
    weightedRequestCount,
    weighted5xxCount,
    weightedP95DurationMs,
  };
}

function readIntegrityMetrics(window) {
  const weightedExecutionCount = nullableCount(window.weightedExecutionCount);
  const weightedFailureCount = nullableCount(window.weightedFailureCount);

  if ((weightedExecutionCount === null) !== (weightedFailureCount === null)) {
    fail("metric_availability");
  }
  if (
    weightedExecutionCount !== null
    && weightedFailureCount > weightedExecutionCount
  ) {
    fail("metric_invariants");
  }

  return { weightedExecutionCount, weightedFailureCount };
}

function nullableCount(value) {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    fail("metric_value");
  }
  return value;
}

function nullableMetric(value) {
  if (value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    fail("metric_value");
  }
  return value;
}

function parseUtcTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) {
    fail("window_timestamp");
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== value
  ) {
    fail("window_timestamp");
  }
  return timestamp;
}

function statusFor(available, firing) {
  if (!available) return "unavailable";
  return firing ? "triggered" : "within_threshold";
}

function freezeWindow(window) {
  return Object.freeze({
    startedAt: window.startedAt,
    endedAt: window.endedAt,
  });
}

function freezeEvaluation(evaluation) {
  return Object.freeze(evaluation);
}

function freezeEvidence(evidence) {
  return Object.freeze(evidence);
}

function readClosedRecord(value, fields, code) {
  try {
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

    const copy = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) {
        fail(code);
      }
      copy[field] = descriptor.value;
    }
    return copy;
  } catch {
    fail(code);
  }
}

function fail(code) {
  throw new OperationalAlertPolicyError(code);
}
