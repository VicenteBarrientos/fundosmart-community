import {
  OPERATIONAL_ALERT_SNAPSHOT_VERSION,
} from "./operational-alert-policy.mjs";

export const OPERATIONAL_ALERT_DATASETS = Object.freeze({
  production: "fundosmart_community_observability",
  staging: "fundosmart_community_staging_observability",
});

const REQUEST_WINDOW_MS = 15 * 60 * 1_000;
const INTEGRITY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const BUILD_INPUT_KEYS = Object.freeze(["environment", "endedAt"]);
const PARSE_INPUT_KEYS = Object.freeze([
  "environment",
  "endedAt",
  "requestResponse",
  "integrityResponse",
]);
const RESPONSE_KEYS = Object.freeze(["meta", "data", "rows"]);
const META_KEYS = Object.freeze(["name", "type"]);
const REQUEST_COLUMNS = Object.freeze([
  Object.freeze({ name: "weighted_request_count", type: "UInt64" }),
  Object.freeze({ name: "weighted_5xx_count", type: "UInt64" }),
  Object.freeze({ name: "weighted_p95_duration_ms", type: "Float64" }),
]);
const INTEGRITY_COLUMNS = Object.freeze([
  Object.freeze({ name: "weighted_execution_count", type: "UInt64" }),
  Object.freeze({ name: "weighted_failure_count", type: "UInt64" }),
]);
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_METRIC = /^(?:-1|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?)$/u;
const CANONICAL_ENDED_AT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/u;
const MIN_ENDED_AT_MS = Date.parse("2000-01-02T00:00:00.000Z");
const MAX_ENDED_AT_MS = Date.parse("2099-12-31T23:59:59.000Z");
const MAX_RESPONSE_BYTES = 16 * 1_024;
const KNOWN_ERROR_CODES = new Set([
  "input_shape",
  "environment",
  "ended_at",
  "response_json",
  "response_shape",
  "meta_shape",
  "data_shape",
  "row_count",
  "row_shape",
  "numeric_value",
  "row_invariants",
]);

export class OperationalAlertQueryError extends TypeError {
  constructor(code) {
    super(`Invalid operational alert query input (${code}).`);
    this.name = "OperationalAlertQueryError";
    this.code = code;
  }
}

export function buildOperationalAlertQueries(input) {
  try {
    const options = exactRecord(input, BUILD_INPUT_KEYS, "input_shape");
    const context = readContext(options.environment, options.endedAt);
    const requestStartedAt = subtractWindow(
      context.endedAtMs,
      REQUEST_WINDOW_MS,
    );
    const integrityStartedAt = subtractWindow(
      context.endedAtMs,
      INTEGRITY_WINDOW_MS,
    );

    return Object.freeze({
      environment: context.environment,
      endedAt: context.endedAt,
      request: freezeQuery({
        startedAt: requestStartedAt,
        endedAt: context.endedAt,
        sql: requestQuery(
          context.dataset,
          context.environment,
          requestStartedAt,
          context.endedAt,
        ),
      }),
      integrity: freezeQuery({
        startedAt: integrityStartedAt,
        endedAt: context.endedAt,
        sql: integrityQuery(
          context.dataset,
          context.environment,
          integrityStartedAt,
          context.endedAt,
        ),
      }),
    });
  } catch (error) {
    normalizeError(error, "input_shape");
  }
}

export function parseOperationalAlertQueryResponses(input) {
  try {
    const options = exactRecord(input, PARSE_INPUT_KEYS, "input_shape");
    const context = readContext(options.environment, options.endedAt);
    const request = parseAggregateResponse(
      options.requestResponse,
      REQUEST_COLUMNS,
    );
    const integrity = parseAggregateResponse(
      options.integrityResponse,
      INTEGRITY_COLUMNS,
    );

    const weightedRequestCount = readCount(
      request.weighted_request_count,
    );
    const weighted5xxCount = readCount(request.weighted_5xx_count);
    const rawP95DurationMs = readMetric(
      request.weighted_p95_duration_ms,
    );
    const weightedExecutionCount = readCount(
      integrity.weighted_execution_count,
    );
    const weightedFailureCount = readCount(
      integrity.weighted_failure_count,
    );

    if (
      weighted5xxCount > weightedRequestCount
      || weightedFailureCount > weightedExecutionCount
    ) {
      fail("row_invariants");
    }
    if (
      (weightedRequestCount === 0 && rawP95DurationMs !== -1)
      || (weightedRequestCount > 0 && rawP95DurationMs < 0)
    ) {
      fail("row_invariants");
    }
    const hasObservedIntegrityFailure = weightedFailureCount > 0;

    return Object.freeze({
      schemaVersion: OPERATIONAL_ALERT_SNAPSHOT_VERSION,
      environment: context.environment,
      requestWindow: Object.freeze({
        startedAt: subtractWindow(context.endedAtMs, REQUEST_WINDOW_MS),
        endedAt: context.endedAt,
        weightedRequestCount,
        weighted5xxCount,
        weightedP95DurationMs:
          weightedRequestCount === 0 ? null : rawP95DurationMs,
      }),
      integrityWindow: Object.freeze({
        startedAt: subtractWindow(context.endedAtMs, INTEGRITY_WINDOW_MS),
        endedAt: context.endedAt,
        weightedExecutionCount:
          hasObservedIntegrityFailure ? weightedExecutionCount : null,
        weightedFailureCount:
          hasObservedIntegrityFailure ? weightedFailureCount : null,
      }),
    });
  } catch (error) {
    normalizeError(error, "response_shape");
  }
}

function requestQuery(dataset, environment, startedAt, endedAt) {
  return `SELECT
  sum(_sample_interval) AS weighted_request_count,
  sumIf(
    _sample_interval,
    double2 >= 500 AND double2 < 600
  ) AS weighted_5xx_count,
  if(
    sum(_sample_interval) = 0,
    -1,
    quantileExactWeighted(0.95)(double1, _sample_interval)
  ) AS weighted_p95_duration_ms
FROM ${dataset}
WHERE timestamp >= ${sqlTimestamp(startedAt)}
  AND timestamp < ${sqlTimestamp(endedAt)}
  AND index1 = '${environment}'
  AND blob1 != 'map.tile_usage'
  AND blob2 != 'SCHEDULED'
FORMAT JSON`;
}

function integrityQuery(dataset, environment, startedAt, endedAt) {
  return `SELECT
  sum(_sample_interval) AS weighted_execution_count,
  sumIf(_sample_interval, blob4 = 'failure') AS weighted_failure_count
FROM ${dataset}
WHERE timestamp >= ${sqlTimestamp(startedAt)}
  AND timestamp < ${sqlTimestamp(endedAt)}
  AND index1 = '${environment}'
  AND blob1 = 'job.integrity-sweep'
  AND blob1 != 'map.tile_usage'
  AND blob2 = 'SCHEDULED'
FORMAT JSON`;
}

function sqlTimestamp(timestamp) {
  return `toDateTime('${timestamp.slice(0, 19).replace("T", " ")}', 'Etc/UTC')`;
}

function readContext(environment, endedAt) {
  if (
    typeof environment !== "string"
    || !Object.hasOwn(OPERATIONAL_ALERT_DATASETS, environment)
  ) {
    fail("environment");
  }
  if (typeof endedAt !== "string" || !CANONICAL_ENDED_AT.test(endedAt)) {
    fail("ended_at");
  }
  const endedAtMs = Date.parse(endedAt);
  if (
    !Number.isFinite(endedAtMs)
    || new Date(endedAtMs).toISOString() !== endedAt
    || endedAtMs < MIN_ENDED_AT_MS
    || endedAtMs > MAX_ENDED_AT_MS
  ) {
    fail("ended_at");
  }
  return {
    environment,
    endedAt,
    endedAtMs,
    dataset: OPERATIONAL_ALERT_DATASETS[environment],
  };
}

function subtractWindow(endedAtMs, durationMs) {
  return new Date(endedAtMs - durationMs).toISOString();
}

function parseAggregateResponse(raw, columns) {
  if (
    typeof raw !== "string"
    || raw.length === 0
    || raw.length > MAX_RESPONSE_BYTES
  ) {
    fail("response_json");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("response_json");
  }

  const root = exactRecord(parsed, RESPONSE_KEYS, "response_shape");
  const meta = exactArray(root.meta, columns.length, "meta_shape");
  const data = exactArray(root.data, 1, "data_shape");
  if (readCount(root.rows) !== 1) fail("row_count");

  for (let index = 0; index < columns.length; index += 1) {
    const entry = exactRecord(meta[index], META_KEYS, "meta_shape");
    if (
      entry.name !== columns[index].name
      || entry.type !== columns[index].type
    ) {
      fail("meta_shape");
    }
  }

  return exactRecord(
    data[0],
    columns.map(({ name }) => name),
    "row_shape",
  );
}

function readCount(value) {
  const normalized = (
    typeof value === "string"
    && value.length <= 32
    && CANONICAL_INTEGER.test(value)
  )
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(normalized)
    || normalized < 0
    || Object.is(normalized, -0)
  ) {
    fail("numeric_value");
  }
  return normalized;
}

function readMetric(value) {
  const normalized = (
    typeof value === "string"
    && value.length <= 32
    && CANONICAL_METRIC.test(value)
  )
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isFinite(normalized)
    || normalized < -1
    || Object.is(normalized, -0)
  ) {
    fail("numeric_value");
  }
  return normalized;
}

function freezeQuery(query) {
  return Object.freeze(query);
}

function exactRecord(value, expectedKeys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string")
  ) {
    fail(code);
  }

  const result = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value, expectedLength, code) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== expectedLength
  ) {
    fail(code);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedLength + 1 || !keys.includes("length")) {
    fail(code);
  }
  const entries = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
    entries.push(descriptor.value);
  }
  return entries;
}

function normalizeError(error, fallbackCode) {
  if (
    error instanceof OperationalAlertQueryError
    && KNOWN_ERROR_CODES.has(error.code)
  ) {
    fail(error.code);
  }
  fail(fallbackCode);
}

function fail(code) {
  throw new OperationalAlertQueryError(code);
}
