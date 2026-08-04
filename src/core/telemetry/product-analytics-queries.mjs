export const PRODUCT_ANALYTICS_WINDOW_DAYS = 90;
export const PRODUCT_ANALYTICS_MAX_COHORTS = 32;
export const PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT = 5;

export const PRODUCT_ANALYTICS_QUERY_NAMES = Object.freeze([
  "activation_funnel",
  "median_time_to_first_value",
  "weekly_retention",
]);

export const PRODUCT_ANALYTICS_DATASETS = Object.freeze({
  production: "fundosmart_community_product_events",
  staging: "fundosmart_community_staging_product_events",
});

const RESPONSE_KEYS = Object.freeze(["meta", "data", "rows"]);
const META_KEYS = Object.freeze(["name", "type"]);
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_NUMBER = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const COHORT_WEEK = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const META_TYPE = /^[A-Za-z][A-Za-z0-9(), ]{0,127}$/u;
const PARSE_ERROR_CODES = new Set([
  "response_shape",
  "meta_shape",
  "data_shape",
  "row_count",
  "row_shape",
  "cohort_week",
  "numeric_value",
  "cohort_order",
  "row_invariants",
]);

const QUERY_CONTRACTS = Object.freeze({
  activation_funnel: contract([
    "cohort_week",
    "eligible_organizations",
    "workspace_organizations",
    "field_organizations",
    "activated_organizations",
  ], parseActivationRow),
  median_time_to_first_value: contract([
    "cohort_week",
    "activated_organizations",
    "median_hours_to_first_value",
  ], parseMedianRow),
  weekly_retention: contract([
    "cohort_week",
    "activated_organizations",
    "week_1_eligible_organizations",
    "retained_week_1",
    "week_4_eligible_organizations",
    "retained_week_4",
  ], parseRetentionRow),
});

export class ProductAnalyticsQueryError extends TypeError {
  constructor(code) {
    super(`Invalid product analytics query result (${code}).`);
    this.name = "ProductAnalyticsQueryError";
    this.code = code;
  }
}

export function buildProductAnalyticsQuery(queryName, environment) {
  const query = requireQueryContract(queryName);
  if (
    typeof environment !== "string"
    || !Object.hasOwn(PRODUCT_ANALYTICS_DATASETS, environment)
  ) {
    fail("environment");
  }
  const dataset = PRODUCT_ANALYTICS_DATASETS[environment];

  if (query === QUERY_CONTRACTS.activation_funnel) {
    return activationFunnelQuery(dataset, environment);
  }
  if (query === QUERY_CONTRACTS.median_time_to_first_value) {
    return medianTimeQuery(dataset, environment);
  }
  return weeklyRetentionQuery(dataset, environment);
}

export function parseProductAnalyticsResponse(queryName, response) {
  const query = requireQueryContract(queryName);
  try {
    const root = exactRecord(response, RESPONSE_KEYS, "response_shape");
    const meta = exactArray(root.meta, query.columns.length, "meta_shape");
    const data = boundedArray(root.data, PRODUCT_ANALYTICS_MAX_COHORTS, "data_shape");
    const rows = nonnegativeInteger(root.rows, "row_count");

    if (rows !== data.length) fail("row_count");
    for (let index = 0; index < query.columns.length; index += 1) {
      const entry = exactRecord(meta[index], META_KEYS, "meta_shape");
      if (entry.name !== query.columns[index]) fail("meta_shape");
      if (typeof entry.type !== "string" || !META_TYPE.test(entry.type)) fail("meta_shape");
    }

    const parsed = [];
    let previousCohort = null;
    for (const value of data) {
      const row = query.parse(value, query.columns);
      if (previousCohort !== null && row.cohortWeek <= previousCohort) {
        fail("cohort_order");
      }
      previousCohort = row.cohortWeek;
      parsed.push(Object.freeze(row));
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (
      error instanceof ProductAnalyticsQueryError
      && PARSE_ERROR_CODES.has(error.code)
    ) {
      throw error;
    }
    fail("response_shape");
  }
}

function contract(columns, parse) {
  return Object.freeze({
    columns: Object.freeze(columns),
    parse,
  });
}

function requireQueryContract(queryName) {
  if (typeof queryName !== "string" || !Object.hasOwn(QUERY_CONTRACTS, queryName)) {
    fail("query_name");
  }
  return QUERY_CONTRACTS[queryName];
}

function organizationFacts(dataset, environment, { retention = false } = {}) {
  const retentionColumns = retention
    ? `,
    sumIf(
      _sample_interval,
      blob1 = 'sync_completed'
        AND double2 >= 168
        AND double2 < 336
        AND double3 > 0
    ) AS week_1_syncs,
    sumIf(
      _sample_interval,
      blob1 = 'sync_completed'
        AND double2 >= 672
        AND double2 < 840
        AND double3 > 0
    ) AS week_4_syncs`
    : "";

  return `SELECT
    index1 AS organization_key,
    blob9 AS cohort_week,
    sumIf(_sample_interval, blob1 = 'signup_completed') AS signup_events,
    sumIf(
      _sample_interval,
      blob1 = 'workspace_created' AND double2 BETWEEN 0 AND 24
    ) AS workspace_events,
    sumIf(
      _sample_interval,
      blob1 = 'field_created' AND double2 BETWEEN 0 AND 24
    ) AS field_events,
    sumIf(
      _sample_interval,
      blob1 = 'first_action_completed' AND double2 BETWEEN 0 AND 24
    ) AS first_action_events,
    sumIf(
      _sample_interval,
      blob1 = 'sync_completed'
        AND double2 BETWEEN 0 AND 24
        AND double3 > 0
    ) AS activation_sync_events,
    min(if(blob1 = 'signup_completed', double1, 9999999999)) AS signup_at,
    min(if(
      blob1 = 'workspace_created' AND double2 BETWEEN 0 AND 24,
      double1,
      9999999999
    )) AS workspace_at,
    min(if(
      blob1 = 'field_created' AND double2 BETWEEN 0 AND 24,
      double1,
      9999999999
    )) AS field_at,
    min(if(
      blob1 = 'first_action_completed' AND double2 BETWEEN 0 AND 24,
      double1,
      9999999999
    )) AS first_action_at,
    min(if(
      blob1 = 'sync_completed'
        AND double2 BETWEEN 0 AND 24
        AND double3 > 0,
      double1,
      9999999999
    )) AS activation_sync_at,
    min(if(
      blob1 = 'first_action_completed' AND double2 BETWEEN 0 AND 24,
      double2,
      1000000
    )) AS first_action_age_hours,
    1 AS organization_weight${retentionColumns}
  FROM ${dataset}
  WHERE timestamp >= now() - INTERVAL '${PRODUCT_ANALYTICS_WINDOW_DAYS}' DAY
    AND blob2 = '1'
    AND blob3 = '${environment}'
    AND blob5 = 'customer'
    AND blob9 != 'none'
    AND index1 LIKE 'org:v1:%'
  GROUP BY organization_key, cohort_week`;
}

function activationFunnelQuery(dataset, environment) {
  return `SELECT
  cohort_week,
  count() AS eligible_organizations,
  countIf(
    workspace_events > 0
      AND workspace_at >= signup_at
  ) AS workspace_organizations,
  countIf(
    workspace_events > 0
      AND field_events > 0
      AND workspace_at >= signup_at
      AND field_at >= workspace_at
  ) AS field_organizations,
  countIf(
    workspace_events > 0
      AND field_events > 0
      AND first_action_events > 0
      AND activation_sync_events > 0
      AND workspace_at >= signup_at
      AND field_at >= workspace_at
      AND first_action_at >= field_at
      AND activation_sync_at >= first_action_at
  ) AS activated_organizations
FROM (
  ${organizationFacts(dataset, environment)}
)
WHERE signup_events > 0
GROUP BY cohort_week
ORDER BY cohort_week ASC
LIMIT ${PRODUCT_ANALYTICS_MAX_COHORTS}
FORMAT JSON`;
}

function medianTimeQuery(dataset, environment) {
  return `SELECT
  cohort_week,
  count() AS activated_organizations,
  quantileExactWeighted(0.5)(
    first_action_age_hours,
    organization_weight
  ) AS median_hours_to_first_value
FROM (
  ${organizationFacts(dataset, environment)}
)
WHERE signup_events > 0
  AND workspace_events > 0
  AND field_events > 0
  AND first_action_events > 0
  AND activation_sync_events > 0
  AND workspace_at >= signup_at
  AND field_at >= workspace_at
  AND first_action_at >= field_at
  AND activation_sync_at >= first_action_at
GROUP BY cohort_week
ORDER BY cohort_week ASC
LIMIT ${PRODUCT_ANALYTICS_MAX_COHORTS}
FORMAT JSON`;
}

function weeklyRetentionQuery(dataset, environment) {
  return `SELECT
  cohort_week,
  count() AS activated_organizations,
  countIf(
    signup_at <= toUnixTimestamp(now() - INTERVAL '14' DAY)
  ) AS week_1_eligible_organizations,
  countIf(
    signup_at <= toUnixTimestamp(now() - INTERVAL '14' DAY)
      AND week_1_syncs > 0
  ) AS retained_week_1,
  countIf(
    signup_at <= toUnixTimestamp(now() - INTERVAL '35' DAY)
  ) AS week_4_eligible_organizations,
  countIf(
    signup_at <= toUnixTimestamp(now() - INTERVAL '35' DAY)
      AND week_4_syncs > 0
  ) AS retained_week_4
FROM (
  ${organizationFacts(dataset, environment, { retention: true })}
)
WHERE signup_events > 0
  AND workspace_events > 0
  AND field_events > 0
  AND first_action_events > 0
  AND activation_sync_events > 0
  AND workspace_at >= signup_at
  AND field_at >= workspace_at
  AND first_action_at >= field_at
  AND activation_sync_at >= first_action_at
GROUP BY cohort_week
ORDER BY cohort_week ASC
LIMIT ${PRODUCT_ANALYTICS_MAX_COHORTS}
FORMAT JSON`;
}

function parseActivationRow(value, columns) {
  const row = exactRecord(value, columns, "row_shape");
  const cohortWeek = mondayCohort(row.cohort_week);
  const eligibleOrganizations = nonnegativeInteger(
    row.eligible_organizations,
    "numeric_value",
  );
  const workspaceOrganizations = nonnegativeInteger(
    row.workspace_organizations,
    "numeric_value",
  );
  const fieldOrganizations = nonnegativeInteger(
    row.field_organizations,
    "numeric_value",
  );
  const activatedOrganizations = nonnegativeInteger(
    row.activated_organizations,
    "numeric_value",
  );

  if (
    eligibleOrganizations === 0
    || workspaceOrganizations > eligibleOrganizations
    || fieldOrganizations > workspaceOrganizations
    || activatedOrganizations > fieldOrganizations
  ) {
    fail("row_invariants");
  }

  return {
    cohortWeek,
    eligibleOrganizations,
    workspaceOrganizations,
    fieldOrganizations,
    activatedOrganizations,
    publishable: eligibleOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
  };
}

function parseMedianRow(value, columns) {
  const row = exactRecord(value, columns, "row_shape");
  const cohortWeek = mondayCohort(row.cohort_week);
  const activatedOrganizations = nonnegativeInteger(
    row.activated_organizations,
    "numeric_value",
  );
  const medianHoursToFirstValue = nonnegativeNumber(
    row.median_hours_to_first_value,
    "numeric_value",
  );
  if (activatedOrganizations === 0 || medianHoursToFirstValue > 24) {
    fail("row_invariants");
  }

  return {
    cohortWeek,
    activatedOrganizations,
    medianHoursToFirstValue,
    publishable: activatedOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
  };
}

function parseRetentionRow(value, columns) {
  const row = exactRecord(value, columns, "row_shape");
  const cohortWeek = mondayCohort(row.cohort_week);
  const activatedOrganizations = nonnegativeInteger(
    row.activated_organizations,
    "numeric_value",
  );
  const week1EligibleOrganizations = nonnegativeInteger(
    row.week_1_eligible_organizations,
    "numeric_value",
  );
  const retainedWeek1 = nonnegativeInteger(row.retained_week_1, "numeric_value");
  const week4EligibleOrganizations = nonnegativeInteger(
    row.week_4_eligible_organizations,
    "numeric_value",
  );
  const retainedWeek4 = nonnegativeInteger(row.retained_week_4, "numeric_value");

  if (
    activatedOrganizations === 0
    || week1EligibleOrganizations > activatedOrganizations
    || week4EligibleOrganizations > week1EligibleOrganizations
    || retainedWeek1 > week1EligibleOrganizations
    || retainedWeek4 > week4EligibleOrganizations
  ) {
    fail("row_invariants");
  }

  return {
    cohortWeek,
    activatedOrganizations,
    week1EligibleOrganizations,
    retainedWeek1,
    week4EligibleOrganizations,
    retainedWeek4,
    week1Publishable:
      week1EligibleOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
    week4Publishable:
      week4EligibleOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
  };
}

function exactRecord(value, expectedKeys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== "string")
  ) {
    fail(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value, expectedLength, code) {
  const entries = boundedArray(value, expectedLength, code);
  if (entries.length !== expectedLength) fail(code);
  return entries;
}

function boundedArray(value, maximumLength, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  if (!Number.isSafeInteger(value.length) || value.length > maximumLength) fail(code);

  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) fail(code);
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(code);
    entries.push(descriptor.value);
  }
  return entries;
}

function mondayCohort(value) {
  if (typeof value !== "string" || !COHORT_WEEK.test(value)) fail("cohort_week");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== value
    || date.getUTCDay() !== 1
  ) {
    fail("cohort_week");
  }
  return value;
}

function nonnegativeInteger(value, code) {
  const number = typeof value === "string"
    && value.length <= 32
    && CANONICAL_INTEGER.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number < 0) fail(code);
  return number;
}

function nonnegativeNumber(value, code) {
  const number = typeof value === "string"
    && value.length <= 32
    && CANONICAL_NUMBER.test(value)
    ? Number(value)
    : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) fail(code);
  return number;
}

function fail(code) {
  throw new ProductAnalyticsQueryError(code);
}
