import { createHash } from "node:crypto";
import {
  PLAN_CATALOG_VERSION,
  PLAN_KEYS,
  PLAN_RESOURCE_KEYS,
  resolvePlanDefinition,
} from "./catalog.mjs";

export const MANUAL_PLAN_TRANSITION_CONTRACT_VERSION =
  "fundosmart.manual-plan-transition.v1";
export const MANUAL_PLAN_TRANSITION_APPROVAL_ATTESTATION =
  "caller_supplied_manual_unverified";

const REQUEST_FIELDS = Object.freeze([
  "operationId",
  "scopePseudonym",
  "expectedCatalogVersion",
  "currentPlanKey",
  "targetPlanKey",
  "usage",
  "approvalAttestation",
]);
const USAGE_FIELDS = Object.freeze([
  "fields",
  "paddocks",
  "members",
  "monthlyExports",
]);
const RECEIPT_FIELDS = Object.freeze([
  "contractVersion",
  "catalogVersion",
  "receiptId",
  "request",
  "transitionKind",
  "hasCapabilityContractions",
  "resourceProjections",
  "approval",
  "preservation",
  "execution",
  "prerequisites",
  "attestation",
]);
const PROJECTION_FIELDS = Object.freeze([
  "resourceKey",
  "kind",
  "currentLimit",
  "targetLimit",
  "currentEnabled",
  "targetEnabled",
  "currentUsage",
  "change",
  "targetAllowsAdditionalUsageUnderCatalog",
]);
const APPROVAL_FIELDS = Object.freeze([
  "required",
  "evaluated",
  "approved",
  "attestation",
]);
const PRESERVATION_FIELDS = Object.freeze([
  "existingDataPreserved",
  "readAccessPreserved",
  "historyPreserved",
  "deletionAuthorized",
  "truncationAuthorized",
  "hidingAuthorized",
]);
const EXECUTION_FIELDS = Object.freeze([
  "submitted",
  "persisted",
  "planApplied",
  "limitsApplied",
  "writesRestricted",
  "billingCreated",
  "paymentCollected",
  "invoiceIssued",
  "saleAuthorized",
]);
const PREREQUISITE_FIELDS = Object.freeze([
  "reauthorizationRequired",
  "currentPlanComparisonRequired",
  "usageRefreshRequired",
  "atomicPersistenceRequired",
  "costlyWritePolicyRequiredBeforeCommit",
]);
const ATTESTATION_FIELDS = Object.freeze([
  "scope",
  "currentPlan",
  "usage",
  "approval",
  "existingReceipt",
]);
const ATTESTATION_VALUES = Object.freeze({
  scope: "caller_supplied_pseudonym_unverified",
  currentPlan: "caller_supplied_unverified",
  usage: "caller_supplied_unverified",
  approval: "caller_supplied_unverified",
  existingReceipt: "caller_supplied_unverified",
});

const PLAN_KEY_SET = new Set(PLAN_KEYS);
const RESOURCE_KEY_SET = new Set(PLAN_RESOURCE_KEYS);
const TRANSITION_KINDS = new Set([
  "no_op",
  "upgrade",
  "downgrade",
  "legacy_migration",
]);
const RESOURCE_KINDS = new Set(["count", "feature"]);
const RESOURCE_CHANGES = new Set(["unchanged", "expanded", "contracted"]);
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCOPE_PSEUDONYM_PATTERN = /^scope:v1:[A-Za-z0-9_-]{43}$/u;
const RECEIPT_ID_PATTERN = /^mpr:v1:[0-9a-f]{64}$/u;
const INTERNAL_ERROR_TOKEN = Symbol("manual_plan_transition_error");
const INTERNAL_ERROR_CODES = new WeakMap();

const USAGE_KEY_BY_RESOURCE = Object.freeze({
  fieldsMax: "fields",
  paddocksMax: "paddocks",
  membersMax: "members",
  monthlyExportsMax: "monthlyExports",
});

export class ManualPlanTransitionError extends TypeError {
  constructor(code, token) {
    const safeCode = token === INTERNAL_ERROR_TOKEN
      ? code
      : "UNTRUSTED_ERROR";
    super(`Invalid manual plan transition (${safeCode}).`);
    this.name = "ManualPlanTransitionError";
    this.code = safeCode;
    if (token === INTERNAL_ERROR_TOKEN) {
      INTERNAL_ERROR_CODES.set(this, safeCode);
      Object.freeze(this);
    }
  }
}

/**
 * Prepares a deterministic, non-executing receipt. Passing a previously
 * prepared receipt enables local replay/conflict verification, but this pure
 * function does not persist or prove the idempotency record.
 */
export function createManualPlanTransitionReceipt(
  request,
  existingReceipt = null,
) {
  let normalizedRequest;
  try {
    normalizedRequest = normalizeRequest(request);
  } catch (error) {
    rethrowOrFail(error, "REQUEST_INVALID");
  }

  const expectedReceipt = buildReceipt(normalizedRequest);
  if (existingReceipt === null) return expectedReceipt;

  let normalizedExisting;
  try {
    normalizedExisting = normalizeReceipt(existingReceipt);
  } catch (error) {
    rethrowOrFail(error, "EXISTING_RECEIPT_INVALID");
  }

  const recomputedExisting = buildReceipt(normalizedExisting.request);
  if (!sameCanonicalReceipt(normalizedExisting, recomputedExisting)) {
    fail("EXISTING_RECEIPT_INVALID");
  }
  if (
    normalizedExisting.request.scopePseudonym
    !== normalizedRequest.scopePseudonym
  ) {
    fail("EXISTING_RECEIPT_SCOPE_MISMATCH");
  }
  if (
    normalizedExisting.request.operationId
    !== normalizedRequest.operationId
  ) {
    fail("EXISTING_RECEIPT_KEY_MISMATCH");
  }
  if (normalizedExisting.receiptId !== expectedReceipt.receiptId) {
    fail("MANUAL_PLAN_TRANSITION_IDEMPOTENCY_CONFLICT");
  }

  return expectedReceipt;
}

function normalizeRequest(value) {
  const request = readClosedRecord(value, REQUEST_FIELDS, "REQUEST_SHAPE_INVALID");
  const usage = readClosedRecord(request.usage, USAGE_FIELDS, "USAGE_SHAPE_INVALID");

  if (
    typeof request.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(request.operationId)
  ) {
    fail("OPERATION_ID_INVALID");
  }
  if (
    typeof request.scopePseudonym !== "string"
    || !SCOPE_PSEUDONYM_PATTERN.test(request.scopePseudonym)
  ) {
    fail("SCOPE_PSEUDONYM_INVALID");
  }
  if (request.expectedCatalogVersion !== PLAN_CATALOG_VERSION) {
    fail("CATALOG_VERSION_MISMATCH");
  }
  if (
    typeof request.currentPlanKey !== "string"
    || !PLAN_KEY_SET.has(request.currentPlanKey)
  ) {
    fail("CURRENT_PLAN_INVALID");
  }
  if (
    typeof request.targetPlanKey !== "string"
    || !PLAN_KEY_SET.has(request.targetPlanKey)
  ) {
    fail("TARGET_PLAN_INVALID");
  }
  if (
    request.targetPlanKey === "legacy"
    && request.currentPlanKey !== "legacy"
  ) {
    fail("LEGACY_PLAN_NOT_ASSIGNABLE");
  }
  if (
    request.approvalAttestation
    !== MANUAL_PLAN_TRANSITION_APPROVAL_ATTESTATION
  ) {
    fail("APPROVAL_ATTESTATION_INVALID");
  }

  for (const field of USAGE_FIELDS) {
    if (
      !Number.isSafeInteger(usage[field])
      || usage[field] < 0
      || Object.is(usage[field], -0)
    ) {
      fail("USAGE_INVALID");
    }
  }

  return Object.freeze({
    operationId: request.operationId,
    scopePseudonym: request.scopePseudonym,
    expectedCatalogVersion: request.expectedCatalogVersion,
    currentPlanKey: request.currentPlanKey,
    targetPlanKey: request.targetPlanKey,
    usage: Object.freeze({
      fields: usage.fields,
      paddocks: usage.paddocks,
      members: usage.members,
      monthlyExports: usage.monthlyExports,
    }),
    approvalAttestation: request.approvalAttestation,
  });
}

function buildReceipt(request) {
  const currentPlan = resolvePlanDefinition(request.currentPlanKey);
  const targetPlan = resolvePlanDefinition(request.targetPlanKey);
  if (!currentPlan || !targetPlan) fail("PLAN_RESOLUTION_FAILED");

  const projections = Object.freeze(PLAN_RESOURCE_KEYS.map((resourceKey) => (
    buildResourceProjection(
      resourceKey,
      currentPlan.quotas[resourceKey],
      targetPlan.quotas[resourceKey],
      request.usage,
    )
  )));
  const hasCapabilityContractions = projections.some(
    (projection) => projection.change === "contracted",
  );
  const transitionKind = classifyTransition(request, hasCapabilityContractions);
  const manualApprovalRequired = transitionKind !== "no_op";

  return Object.freeze({
    contractVersion: MANUAL_PLAN_TRANSITION_CONTRACT_VERSION,
    catalogVersion: PLAN_CATALOG_VERSION,
    receiptId: requestReceiptId(request),
    request,
    transitionKind,
    hasCapabilityContractions,
    resourceProjections: projections,
    approval: Object.freeze({
      required: manualApprovalRequired,
      evaluated: false,
      approved: false,
      attestation: MANUAL_PLAN_TRANSITION_APPROVAL_ATTESTATION,
    }),
    preservation: Object.freeze({
      existingDataPreserved: true,
      readAccessPreserved: true,
      historyPreserved: true,
      deletionAuthorized: false,
      truncationAuthorized: false,
      hidingAuthorized: false,
    }),
    execution: Object.freeze({
      submitted: false,
      persisted: false,
      planApplied: false,
      limitsApplied: false,
      writesRestricted: false,
      billingCreated: false,
      paymentCollected: false,
      invoiceIssued: false,
      saleAuthorized: false,
    }),
    prerequisites: Object.freeze({
      reauthorizationRequired: true,
      currentPlanComparisonRequired: true,
      usageRefreshRequired: true,
      atomicPersistenceRequired: true,
      costlyWritePolicyRequiredBeforeCommit: true,
    }),
    attestation: ATTESTATION_VALUES,
  });
}

function buildResourceProjection(resourceKey, currentQuota, targetQuota, usage) {
  if (typeof currentQuota === "boolean" && typeof targetQuota === "boolean") {
    return Object.freeze({
      resourceKey,
      kind: "feature",
      currentLimit: null,
      targetLimit: null,
      currentEnabled: currentQuota,
      targetEnabled: targetQuota,
      currentUsage: null,
      change: compareBooleans(currentQuota, targetQuota),
      targetAllowsAdditionalUsageUnderCatalog: targetQuota,
    });
  }

  const usageKey = USAGE_KEY_BY_RESOURCE[resourceKey];
  if (
    !usageKey
    || (currentQuota !== null && !Number.isSafeInteger(currentQuota))
    || (targetQuota !== null && !Number.isSafeInteger(targetQuota))
  ) {
    fail("CATALOG_RESOURCE_INVALID");
  }
  const currentUsage = usage[usageKey];
  return Object.freeze({
    resourceKey,
    kind: "count",
    currentLimit: currentQuota,
    targetLimit: targetQuota,
    currentEnabled: null,
    targetEnabled: null,
    currentUsage,
    change: compareLimits(currentQuota, targetQuota),
    targetAllowsAdditionalUsageUnderCatalog:
      targetQuota === null || currentUsage < targetQuota,
  });
}

function compareBooleans(currentValue, targetValue) {
  if (currentValue === targetValue) return "unchanged";
  return targetValue ? "expanded" : "contracted";
}

function compareLimits(currentLimit, targetLimit) {
  if (currentLimit === targetLimit) return "unchanged";
  if (targetLimit === null) return "expanded";
  if (currentLimit === null) return "contracted";
  return targetLimit > currentLimit ? "expanded" : "contracted";
}

function classifyTransition(request, hasCapabilityContractions) {
  if (request.currentPlanKey === request.targetPlanKey) return "no_op";
  if (request.currentPlanKey === "legacy") return "legacy_migration";
  return hasCapabilityContractions ? "downgrade" : "upgrade";
}

function requestReceiptId(request) {
  const canonicalRequest = JSON.stringify([
    MANUAL_PLAN_TRANSITION_CONTRACT_VERSION,
    PLAN_CATALOG_VERSION,
    request.operationId,
    request.scopePseudonym,
    request.currentPlanKey,
    request.targetPlanKey,
    [
      request.usage.fields,
      request.usage.paddocks,
      request.usage.members,
      request.usage.monthlyExports,
    ],
    request.approvalAttestation,
  ]);
  const digest = createHash("sha256").update(canonicalRequest).digest("hex");
  return `mpr:v1:${digest}`;
}

function normalizeReceipt(value) {
  const receipt = readClosedRecord(
    value,
    RECEIPT_FIELDS,
    "EXISTING_RECEIPT_SHAPE_INVALID",
  );
  const request = normalizeRequest(receipt.request);
  const projections = readClosedArray(
    receipt.resourceProjections,
    PLAN_RESOURCE_KEYS.length,
    "EXISTING_RECEIPT_PROJECTIONS_INVALID",
  ).map(normalizeProjection);
  const approval = normalizeBooleanRecord(
    receipt.approval,
    APPROVAL_FIELDS,
    "EXISTING_RECEIPT_APPROVAL_INVALID",
    ["required", "evaluated", "approved"],
    { attestation: MANUAL_PLAN_TRANSITION_APPROVAL_ATTESTATION },
  );
  const preservation = normalizeBooleanRecord(
    receipt.preservation,
    PRESERVATION_FIELDS,
    "EXISTING_RECEIPT_PRESERVATION_INVALID",
    PRESERVATION_FIELDS,
  );
  const execution = normalizeBooleanRecord(
    receipt.execution,
    EXECUTION_FIELDS,
    "EXISTING_RECEIPT_EXECUTION_INVALID",
    EXECUTION_FIELDS,
  );
  const prerequisites = normalizeBooleanRecord(
    receipt.prerequisites,
    PREREQUISITE_FIELDS,
    "EXISTING_RECEIPT_PREREQUISITES_INVALID",
    PREREQUISITE_FIELDS,
  );
  const attestation = normalizeExactStringRecord(
    receipt.attestation,
    ATTESTATION_FIELDS,
    "EXISTING_RECEIPT_ATTESTATION_INVALID",
    ATTESTATION_VALUES,
  );

  if (receipt.contractVersion !== MANUAL_PLAN_TRANSITION_CONTRACT_VERSION) {
    fail("EXISTING_RECEIPT_CONTRACT_VERSION_INVALID");
  }
  if (receipt.catalogVersion !== PLAN_CATALOG_VERSION) {
    fail("EXISTING_RECEIPT_CATALOG_VERSION_INVALID");
  }
  if (
    typeof receipt.receiptId !== "string"
    || !RECEIPT_ID_PATTERN.test(receipt.receiptId)
  ) {
    fail("EXISTING_RECEIPT_ID_INVALID");
  }
  if (
    typeof receipt.transitionKind !== "string"
    || !TRANSITION_KINDS.has(receipt.transitionKind)
  ) {
    fail("EXISTING_RECEIPT_TRANSITION_KIND_INVALID");
  }
  if (typeof receipt.hasCapabilityContractions !== "boolean") {
    fail("EXISTING_RECEIPT_CONTRACTION_FLAG_INVALID");
  }

  return {
    contractVersion: receipt.contractVersion,
    catalogVersion: receipt.catalogVersion,
    receiptId: receipt.receiptId,
    request,
    transitionKind: receipt.transitionKind,
    hasCapabilityContractions: receipt.hasCapabilityContractions,
    resourceProjections: projections,
    approval,
    preservation,
    execution,
    prerequisites,
    attestation,
  };
}

function normalizeProjection(value) {
  const projection = readClosedRecord(
    value,
    PROJECTION_FIELDS,
    "EXISTING_RECEIPT_PROJECTION_INVALID",
  );
  if (
    typeof projection.resourceKey !== "string"
    || !RESOURCE_KEY_SET.has(projection.resourceKey)
    || typeof projection.kind !== "string"
    || !RESOURCE_KINDS.has(projection.kind)
    || typeof projection.change !== "string"
    || !RESOURCE_CHANGES.has(projection.change)
    || typeof projection.targetAllowsAdditionalUsageUnderCatalog !== "boolean"
  ) {
    fail("EXISTING_RECEIPT_PROJECTION_INVALID");
  }
  for (const field of ["currentLimit", "targetLimit", "currentUsage"]) {
    if (
      projection[field] !== null
      && (
        !Number.isSafeInteger(projection[field])
        || projection[field] < 0
        || Object.is(projection[field], -0)
      )
    ) {
      fail("EXISTING_RECEIPT_PROJECTION_INVALID");
    }
  }
  for (const field of ["currentEnabled", "targetEnabled"]) {
    if (
      projection[field] !== null
      && typeof projection[field] !== "boolean"
    ) {
      fail("EXISTING_RECEIPT_PROJECTION_INVALID");
    }
  }
  return { ...projection };
}

function normalizeBooleanRecord(
  value,
  fields,
  code,
  booleanFields,
  stringFields = {},
) {
  const record = readClosedRecord(value, fields, code);
  for (const field of booleanFields) {
    if (typeof record[field] !== "boolean") fail(code);
  }
  for (const [field, expected] of Object.entries(stringFields)) {
    if (record[field] !== expected) fail(code);
  }
  return { ...record };
}

function normalizeExactStringRecord(value, fields, code, expectedValues) {
  const record = readClosedRecord(value, fields, code);
  for (const field of fields) {
    if (record[field] !== expectedValues[field]) fail(code);
  }
  return { ...record };
}

function sameCanonicalReceipt(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readClosedRecord(value, fields, code) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(code);
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    fail(code);
  }
  const result = {};
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

function readClosedArray(value, expectedLength, code) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(code);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor
    || lengthDescriptor.value !== expectedLength
    || Reflect.ownKeys(value).length !== expectedLength + 1
  ) {
    fail(code);
  }
  const result = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function rethrowOrFail(error, fallbackCode) {
  const internalCode = (
    error
    && (typeof error === "object" || typeof error === "function")
  )
    ? INTERNAL_ERROR_CODES.get(error)
    : undefined;
  if (internalCode) fail(internalCode);
  fail(fallbackCode);
}

function fail(code) {
  throw new ManualPlanTransitionError(code, INTERNAL_ERROR_TOKEN);
}
