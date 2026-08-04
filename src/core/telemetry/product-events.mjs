export const PRODUCT_EVENT_SCHEMA_VERSION = "1";

const MAX_COUNT = 1_000_000_000;
const REQUIRED_FIELDS = Object.freeze([
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
const REQUIRED_FIELD_SET = new Set(REQUIRED_FIELDS);
const EVENT_ID_PATTERN = /^pe_[a-f0-9]{32}$/u;
const ORGANIZATION_PSEUDONYM_PATTERN = /^org:v1:[A-Za-z0-9_-]{43}$/u;
const JOURNEY_PSEUDONYM_PATTERN = /^journey:v1:[A-Za-z0-9_-]{22}$/u;
const RELEASE_PATTERN = /^(?:[a-f0-9]{12}|unknown)$/u;
const RFC_3339_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;
const ENVIRONMENTS = new Set(["production", "staging", "local"]);
const AUDIENCES = new Set(["customer", "demo", "staff", "synthetic"]);
const FIXED_COUNT_EVENTS = new Set([
  "signup_started",
  "signup_completed",
  "workspace_created",
  "field_created",
  "first_action_completed",
  "upgrade_intent",
  "account_closed",
]);

function rule(source, partition, variants, details, cardinality) {
  return Object.freeze({
    source,
    partition,
    variants: Object.freeze(variants),
    details: Object.freeze(details),
    cardinality,
  });
}

export const PRODUCT_EVENT_CATALOG = Object.freeze({
  signup_started: rule(
    "account",
    "journey",
    ["landing", "demo", "direct_product"],
    ["google_oidc"],
    "per_attempt",
  ),
  signup_completed: rule(
    "account",
    "organization",
    ["google_oidc"],
    ["verified"],
    "once_per_journey",
  ),
  workspace_created: rule(
    "access",
    "organization",
    ["self_service", "staff"],
    ["free", "pro", "legacy"],
    "once_per_workspace",
  ),
  field_created: rule(
    "fields",
    "organization",
    ["manual", "import"],
    ["first", "additional"],
    "per_created_field",
  ),
  first_import_completed: rule(
    "imports",
    "organization",
    [
      "cooprinsem",
      "survet",
      "soil_analysis",
      "agronomic_visit",
      "paddock_boundaries",
      "generic_spreadsheet",
      "traceability",
    ],
    ["clean", "with_warnings"],
    "once_per_organization",
  ),
  first_action_completed: rule(
    "domain",
    "organization",
    [
      "import",
      "animal_event",
      "milk_record",
      "cost_update",
      "paddock_edit",
      "task_completed",
      "alert_reviewed",
    ],
    ["direct", "offline"],
    "once_per_organization",
  ),
  sync_completed: rule(
    "sync",
    "organization",
    ["direct", "offline"],
    ["applied", "conflict_visible"],
    "per_terminal_batch",
  ),
  upgrade_intent: rule(
    "commercial",
    "organization",
    ["field_limit", "paddock_limit", "feature_gate", "settings", "support"],
    ["pro"],
    "per_surface_per_day",
  ),
  account_closed: rule(
    "lifecycle",
    "organization",
    ["self_service", "support", "staff"],
    ["closed"],
    "once_per_closure",
  ),
});

export const PRODUCT_EVENT_NAMES = Object.freeze(Object.keys(PRODUCT_EVENT_CATALOG));

export class ProductEventValidationError extends TypeError {
  constructor(code) {
    super(`Invalid product event (${code}).`);
    this.name = "ProductEventValidationError";
    this.code = code;
  }
}

export async function pseudonymizeOrganization(secret, organizationId) {
  const digest = await hmacSha256(
    requireSecret(secret),
    JSON.stringify(["fundosmart-product-organization", "1", requireIdentifier(organizationId)]),
  );
  return `org:v1:${base64UrlEncode(digest)}`;
}

export async function deriveProductEventId(secret, {
  eventName,
  sourceType,
  sourceId,
}) {
  if (!Object.hasOwn(PRODUCT_EVENT_CATALOG, eventName)) fail("transition_event_name");
  const digest = await hmacSha256(
    requireSecret(secret),
    JSON.stringify([
      "fundosmart-product-event",
      PRODUCT_EVENT_SCHEMA_VERSION,
      eventName,
      requireIdentifier(sourceType),
      requireIdentifier(sourceId),
    ]),
  );
  return `pe_${bytesToHex(digest.slice(0, 16))}`;
}

export function createJourneyPseudonym(cryptoImpl = globalThis.crypto) {
  return `journey:v1:${base64UrlEncode(randomBytes(16, cryptoImpl))}`;
}

export function createRandomProductEventId(cryptoImpl = globalThis.crypto) {
  return `pe_${bytesToHex(randomBytes(16, cryptoImpl))}`;
}

export function assertProductEventV1(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) fail("envelope_type");

  const keys = Reflect.ownKeys(event);
  if (
    keys.length !== REQUIRED_FIELDS.length
    || keys.some((key) => typeof key !== "string" || !REQUIRED_FIELD_SET.has(key))
  ) {
    fail("envelope_fields");
  }

  if (!EVENT_ID_PATTERN.test(event.eventId)) fail("event_id");
  if (event.schemaVersion !== PRODUCT_EVENT_SCHEMA_VERSION) fail("schema_version");
  if (!isRfc3339Timestamp(event.occurredAt)) fail("occurred_at");
  if (!ENVIRONMENTS.has(event.environment)) fail("environment");
  if (typeof event.release !== "string" || !RELEASE_PATTERN.test(event.release)) fail("release");
  if (!AUDIENCES.has(event.audience)) fail("audience");

  const eventRule = typeof event.eventName === "string"
    && Object.hasOwn(PRODUCT_EVENT_CATALOG, event.eventName)
    ? PRODUCT_EVENT_CATALOG[event.eventName]
    : undefined;
  if (!eventRule) fail("event_name");
  if (event.source !== eventRule.source) fail("source");
  if (!eventRule.variants.includes(event.variant)) fail("variant");
  if (!eventRule.details.includes(event.detail)) fail("detail");

  assertCount(event.count, "count");
  assertCount(event.secondaryCount, "secondary_count");
  assertEventCounts(event);

  if (eventRule.partition === "journey") {
    if (
      typeof event.journeyPseudonym !== "string"
      || !JOURNEY_PSEUDONYM_PATTERN.test(event.journeyPseudonym)
      || event.partitionKey !== event.journeyPseudonym
      || event.organizationPseudonym !== null
      || event.cohortWeek !== null
      || event.organizationAgeHours !== null
    ) {
      fail("journey_partition");
    }
    return;
  }

  if (
    typeof event.organizationPseudonym !== "string"
    || !ORGANIZATION_PSEUDONYM_PATTERN.test(event.organizationPseudonym)
    || event.partitionKey !== event.organizationPseudonym
  ) {
    fail("organization_partition");
  }
  if (
    event.journeyPseudonym !== null
    && (
      typeof event.journeyPseudonym !== "string"
      || !JOURNEY_PSEUDONYM_PATTERN.test(event.journeyPseudonym)
    )
  ) {
    fail("journey_pseudonym");
  }
  if (!isMondayCohort(event.cohortWeek)) fail("cohort_week");
  if (
    typeof event.organizationAgeHours !== "number"
    || !Number.isFinite(event.organizationAgeHours)
    || event.organizationAgeHours < 0
  ) {
    fail("organization_age");
  }
}

export function toProductEventDataPoint(event) {
  assertProductEventV1(event);
  return {
    indexes: [event.partitionKey],
    blobs: [
      event.eventName,
      event.schemaVersion,
      event.environment,
      event.release,
      event.audience,
      event.source,
      event.eventId,
      event.journeyPseudonym ?? "none",
      event.cohortWeek ?? "none",
      event.variant,
      event.detail,
    ],
    doubles: [
      Date.parse(event.occurredAt) / 1_000,
      event.organizationAgeHours ?? -1,
      event.count,
      event.secondaryCount,
    ],
  };
}

export function emitProductEvent(dataset, event, { logger = console } = {}) {
  if (!dataset) return false;

  let point;
  try {
    point = toProductEventDataPoint(event);
  } catch {
    warnSafely(logger, "invalid_event");
    return false;
  }

  try {
    if (typeof dataset.writeDataPoint !== "function") return false;
    dataset.writeDataPoint(point);
    return true;
  } catch {
    warnSafely(logger, "write_failed");
    return false;
  }
}

function assertEventCounts(event) {
  if (event.eventName === "first_import_completed" && event.count < 1) {
    fail("first_import_count");
  }
  if (event.eventName === "sync_completed" && event.count < 1 && event.secondaryCount < 1) {
    fail("sync_count");
  }
  if (
    FIXED_COUNT_EVENTS.has(event.eventName)
    && (event.count !== 1 || event.secondaryCount !== 0)
  ) {
    fail("fixed_count");
  }
}

function assertCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) fail(code);
}

function isMondayCohort(value) {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    && date.getUTCDay() === 1;
}

function isRfc3339Timestamp(value) {
  if (typeof value !== "string" || !RFC_3339_PATTERN.test(value)) return false;
  const match = value.match(
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/u,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const leapYear = numericYear % 4 === 0
    && (numericYear % 100 !== 0 || numericYear % 400 === 0);
  const lastDayOfMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][numericMonth - 1];
  return numericMonth >= 1
    && numericMonth <= 12
    && numericDay >= 1
    && numericDay <= lastDayOfMonth
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && (offsetHour === undefined || Number(offsetHour) <= 23)
    && (offsetMinute === undefined || Number(offsetMinute) <= 59)
    && Number.isFinite(Date.parse(value));
}

function requireSecret(value) {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength < 32) {
    fail("hmac_secret");
  }
  return value;
}

function requireIdentifier(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 512
    || value.trim() !== value
  ) {
    fail("hmac_identifier");
  }
  return value;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function randomBytes(length, cryptoImpl) {
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== "function") {
    fail("random_source");
  }
  const bytes = new Uint8Array(length);
  cryptoImpl.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function warnSafely(logger, reason) {
  try {
    logger?.warn?.(JSON.stringify({
      event: "product_telemetry.write_failed",
      reason,
    }));
  } catch {
    // Product telemetry is never allowed to alter the business response.
  }
}

function fail(code) {
  throw new ProductEventValidationError(code);
}
