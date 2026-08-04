import {
  PRODUCT_ANALYTICS_MAX_COHORTS,
  PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
  PRODUCT_ANALYTICS_WINDOW_DAYS,
} from "./product-analytics-queries.mjs";
import { assertProductEventV1 } from "./product-events.mjs";

export const PRODUCT_ANALYTICS_REFERENCE_MAX_EVENTS = 100_000;

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const ACTIVATION_END_HOURS = 24;
const WEEK_1_START_HOURS = 168;
const WEEK_1_END_HOURS = 336;
const WEEK_4_START_HOURS = 672;
const WEEK_4_END_HOURS = 840;
const REFERENCE_ENVIRONMENTS = new Set(["production", "staging"]);
const OPTIONS_FIELDS = Object.freeze(["environment", "asOf"]);
const EVENT_FIELDS = Object.freeze([
  "eventId",
  "eventName",
  "schemaVersion",
  "occurredAt",
  "environment",
  "release",
  "audience",
  "source",
  "partitionKey",
  "organizationPseudonym",
  "journeyPseudonym",
  "cohortWeek",
  "organizationAgeHours",
  "variant",
  "detail",
  "count",
  "secondaryCount",
]);
const UTC_AS_OF = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{3}))?Z$/u;

export class ProductAnalyticsReferenceError extends TypeError {
  constructor(code) {
    super(`Invalid product analytics reference input (${code}).`);
    this.name = "ProductAnalyticsReferenceError";
    this.code = code;
  }
}

export function evaluateProductAnalyticsReference(events, options) {
  const { environment, asOfMs } = normalizeOptions(options);
  const uniqueEvents = normalizeAndDeduplicateEvents(events);
  const windowStartMs = asOfMs - PRODUCT_ANALYTICS_WINDOW_DAYS * DAY_MS;
  const organizations = new Map();

  for (const event of uniqueEvents) {
    const occurredAtMs = Date.parse(event.occurredAt);
    if (
      event.environment !== environment
      || event.audience !== "customer"
      || event.organizationPseudonym === null
      || occurredAtMs < windowStartMs
      || occurredAtMs > asOfMs
    ) {
      continue;
    }

    const organizationKey = event.organizationPseudonym;
    let organization = organizations.get(organizationKey);
    if (!organization) {
      organization = createOrganizationAggregate(event.cohortWeek);
      organizations.set(organizationKey, organization);
    } else if (organization.cohortWeek !== event.cohortWeek) {
      fail("cohort_conflict");
    }

    applyEvent(organization, event, occurredAtMs);
  }

  return buildReferenceResult(organizations, asOfMs);
}

function normalizeOptions(options) {
  const normalized = readClosedRecord(options, OPTIONS_FIELDS, "options_shape");
  if (!REFERENCE_ENVIRONMENTS.has(normalized.environment)) fail("environment");

  return {
    environment: normalized.environment,
    asOfMs: parseAsOf(normalized.asOf),
  };
}

function normalizeAndDeduplicateEvents(value) {
  const fixtures = readDenseArray(value);
  const unique = new Map();

  for (const fixture of fixtures) {
    let event;
    try {
      event = readClosedRecord(fixture, EVENT_FIELDS, "event_invalid");
      assertProductEventV1(event);
    } catch (error) {
      if (error instanceof ProductAnalyticsReferenceError) throw error;
      fail("event_invalid");
    }

    const fingerprint = JSON.stringify(EVENT_FIELDS.map((field) => event[field]));
    const existing = unique.get(event.eventId);
    if (existing && existing.fingerprint !== fingerprint) {
      fail("event_id_conflict");
    }
    if (!existing) unique.set(event.eventId, { event, fingerprint });
  }

  return Array.from(unique.values(), ({ event }) => event);
}

function createOrganizationAggregate(cohortWeek) {
  return {
    cohortWeek,
    signupAt: Number.POSITIVE_INFINITY,
    workspaceAt: Number.POSITIVE_INFINITY,
    fieldAt: Number.POSITIVE_INFINITY,
    firstActionAt: Number.POSITIVE_INFINITY,
    firstActionAgeHours: Number.POSITIVE_INFINITY,
    activationSyncAt: Number.POSITIVE_INFINITY,
    retainedWeek1: false,
    retainedWeek4: false,
  };
}

function applyEvent(organization, event, occurredAtMs) {
  const withinActivationWindow = event.organizationAgeHours <= ACTIVATION_END_HOURS;

  switch (event.eventName) {
    case "signup_completed":
      organization.signupAt = Math.min(organization.signupAt, occurredAtMs);
      break;
    case "workspace_created":
      if (withinActivationWindow) {
        organization.workspaceAt = Math.min(organization.workspaceAt, occurredAtMs);
      }
      break;
    case "field_created":
      if (withinActivationWindow) {
        organization.fieldAt = Math.min(organization.fieldAt, occurredAtMs);
      }
      break;
    case "first_action_completed":
      if (withinActivationWindow) {
        organization.firstActionAt = Math.min(organization.firstActionAt, occurredAtMs);
        organization.firstActionAgeHours = Math.min(
          organization.firstActionAgeHours,
          event.organizationAgeHours,
        );
      }
      break;
    case "sync_completed":
      if (event.count > 0) {
        if (withinActivationWindow) {
          organization.activationSyncAt = Math.min(
            organization.activationSyncAt,
            occurredAtMs,
          );
        }
        if (
          event.organizationAgeHours >= WEEK_1_START_HOURS
          && event.organizationAgeHours < WEEK_1_END_HOURS
        ) {
          organization.retainedWeek1 = true;
        }
        if (
          event.organizationAgeHours >= WEEK_4_START_HOURS
          && event.organizationAgeHours < WEEK_4_END_HOURS
        ) {
          organization.retainedWeek4 = true;
        }
      }
      break;
    default:
      break;
  }
}

function buildReferenceResult(organizations, asOfMs) {
  const cohorts = new Map();

  for (const organization of organizations.values()) {
    if (!Number.isFinite(organization.signupAt)) continue;

    let cohort = cohorts.get(organization.cohortWeek);
    if (!cohort) {
      cohort = {
        cohortWeek: organization.cohortWeek,
        eligibleOrganizations: 0,
        workspaceOrganizations: 0,
        fieldOrganizations: 0,
        activatedOrganizations: 0,
        firstActionAges: [],
        week1EligibleOrganizations: 0,
        retainedWeek1: 0,
        week4EligibleOrganizations: 0,
        retainedWeek4: 0,
      };
      cohorts.set(organization.cohortWeek, cohort);
    }

    cohort.eligibleOrganizations += 1;
    const workspaceReached = (
      Number.isFinite(organization.workspaceAt)
      && organization.workspaceAt >= organization.signupAt
    );
    if (workspaceReached) cohort.workspaceOrganizations += 1;

    const fieldReached = (
      workspaceReached
      && Number.isFinite(organization.fieldAt)
      && organization.fieldAt >= organization.workspaceAt
    );
    if (fieldReached) cohort.fieldOrganizations += 1;

    const activated = (
      fieldReached
      && Number.isFinite(organization.firstActionAt)
      && Number.isFinite(organization.activationSyncAt)
      && organization.firstActionAt >= organization.fieldAt
      && organization.activationSyncAt >= organization.firstActionAt
    );
    if (!activated) continue;

    cohort.activatedOrganizations += 1;
    cohort.firstActionAges.push(organization.firstActionAgeHours);

    if (organization.signupAt <= asOfMs - WEEK_1_END_HOURS * HOUR_MS) {
      cohort.week1EligibleOrganizations += 1;
      if (organization.retainedWeek1) cohort.retainedWeek1 += 1;
    }
    if (organization.signupAt <= asOfMs - WEEK_4_END_HOURS * HOUR_MS) {
      cohort.week4EligibleOrganizations += 1;
      if (organization.retainedWeek4) cohort.retainedWeek4 += 1;
    }
  }

  const ordered = Array.from(cohorts.values()).sort((left, right) => {
    if (left.cohortWeek < right.cohortWeek) return -1;
    if (left.cohortWeek > right.cohortWeek) return 1;
    return 0;
  });
  const activationFunnel = freezeRows(
    ordered.slice(0, PRODUCT_ANALYTICS_MAX_COHORTS).map((cohort) => ({
      cohortWeek: cohort.cohortWeek,
      eligibleOrganizations: cohort.eligibleOrganizations,
      workspaceOrganizations: cohort.workspaceOrganizations,
      fieldOrganizations: cohort.fieldOrganizations,
      activatedOrganizations: cohort.activatedOrganizations,
      publishable:
        cohort.eligibleOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
    })),
  );
  const activatedCohorts = ordered.filter((cohort) => cohort.activatedOrganizations > 0);
  const medianTimeToFirstValue = freezeRows(
    activatedCohorts.slice(0, PRODUCT_ANALYTICS_MAX_COHORTS).map((cohort) => ({
      cohortWeek: cohort.cohortWeek,
      activatedOrganizations: cohort.activatedOrganizations,
      medianHoursToFirstValue: exactWeightedMedian(cohort.firstActionAges),
      publishable:
        cohort.activatedOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
    })),
  );
  const weeklyRetention = freezeRows(
    activatedCohorts.slice(0, PRODUCT_ANALYTICS_MAX_COHORTS).map((cohort) => ({
      cohortWeek: cohort.cohortWeek,
      activatedOrganizations: cohort.activatedOrganizations,
      week1EligibleOrganizations: cohort.week1EligibleOrganizations,
      retainedWeek1: cohort.retainedWeek1,
      week4EligibleOrganizations: cohort.week4EligibleOrganizations,
      retainedWeek4: cohort.retainedWeek4,
      week1Publishable:
        cohort.week1EligibleOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
      week4Publishable:
        cohort.week4EligibleOrganizations >= PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT,
    })),
  );

  return Object.freeze({
    activationFunnel,
    medianTimeToFirstValue,
    weeklyRetention,
  });
}

function exactWeightedMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function readDenseArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail("events_shape");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      fail("events_shape");
    }
    if (lengthDescriptor.value > PRODUCT_ANALYTICS_REFERENCE_MAX_EVENTS) {
      fail("event_count");
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length !== lengthDescriptor.value + 1 || !keys.includes("length")) {
      fail("events_shape");
    }

    const copy = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) {
        fail("events_shape");
      }
      copy.push(descriptor.value);
    }
    return copy;
  } catch (error) {
    if (error instanceof ProductAnalyticsReferenceError) throw error;
    fail("events_shape");
  }
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
  } catch (error) {
    if (error instanceof ProductAnalyticsReferenceError) throw error;
    fail(code);
  }
}

function parseAsOf(value) {
  if (typeof value !== "string") fail("as_of");
  const match = value.match(UTC_AS_OF);
  if (!match) fail("as_of");

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("as_of");
  const date = new Date(milliseconds);
  const [, year, month, day, hour, minute, second, fraction = "000"] = match;
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)
    || date.getUTCMilliseconds() !== Number(fraction)
  ) {
    fail("as_of");
  }
  return milliseconds;
}

function fail(code) {
  throw new ProductAnalyticsReferenceError(code);
}
