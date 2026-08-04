import {
  PLAN_CATALOG_VERSION,
  PLAN_RESOURCE_KEYS,
  resolvePlanDefinition,
} from "./catalog.mjs";

const INPUT_FIELDS = Object.freeze(["planKey", "resourceKey", "currentUsage"]);
const RESOURCE_KEY_SET = new Set(PLAN_RESOURCE_KEYS);

export function evaluateResourceEntitlement(input) {
  let candidate;
  try {
    candidate = readClosedRecord(input, INPUT_FIELDS);
  } catch {
    return invalidEvaluation("INPUT_SHAPE_INVALID");
  }

  const plan = resolvePlanDefinition(candidate.planKey);
  if (!plan) return invalidEvaluation("PLAN_KEY_INVALID");
  if (
    typeof candidate.resourceKey !== "string"
    || !RESOURCE_KEY_SET.has(candidate.resourceKey)
  ) {
    return invalidEvaluation("RESOURCE_KEY_INVALID");
  }
  if (
    !Number.isSafeInteger(candidate.currentUsage)
    || candidate.currentUsage < 0
    || Object.is(candidate.currentUsage, -0)
  ) {
    return invalidEvaluation("CURRENT_USAGE_INVALID");
  }

  const planKey = plan.key;
  const resourceKey = candidate.resourceKey;
  const usage = candidate.currentUsage;
  const quota = plan.quotas[resourceKey];

  if (typeof quota === "boolean") {
    if (usage !== 0) return invalidEvaluation("FEATURE_USAGE_INVALID");
    const allowed = quota;
    return Object.freeze({
      catalogVersion: PLAN_CATALOG_VERSION,
      valid: true,
      allowed,
      planKey,
      resourceKey,
      limit: null,
      usage,
      percentage: allowed ? 0 : 100,
      noticeLevel: allowed ? "none" : "limit_reached",
      reasonCode: null,
      message: allowed
        ? "Función habilitada."
        : `La función '${resourceKey}' no está disponible en el ${plan.name}. Solicita el Plan Pro para activarla.`,
    });
  }

  if (quota === null) {
    return Object.freeze({
      catalogVersion: PLAN_CATALOG_VERSION,
      valid: true,
      allowed: true,
      planKey,
      resourceKey,
      limit: null,
      usage,
      percentage: 0,
      noticeLevel: "none",
      reasonCode: null,
      message: "Recurso sin límite para este plan.",
    });
  }

  const limit = quota;
  const ratio = BigInt(usage) * 100n;
  const limitRatio = BigInt(limit);
  const rawPercentage = ratio / limitRatio;
  const percentage = Number(rawPercentage > 100n ? 100n : rawPercentage);
  const allowed = usage < limit;

  let noticeLevel = "none";
  let message = `Uso de ${usage} de ${limit} (${percentage}%).`;

  if (!allowed) {
    noticeLevel = "limit_reached";
    message = `Has alcanzado el límite máximo de ${limit} para '${resourceKey}' en el ${plan.name}. Actualiza a Plan Pro para continuar.`;
  } else if (ratio >= limitRatio * 90n) {
    noticeLevel = "warning_90";
    message = `Has consumido el ${percentage}% de tu cuota de '${resourceKey}' (${usage}/${limit}).`;
  } else if (ratio >= limitRatio * 70n) {
    noticeLevel = "warning_70";
    message = `Has consumido el ${percentage}% de tu cuota de '${resourceKey}' (${usage}/${limit}).`;
  }

  return Object.freeze({
    catalogVersion: PLAN_CATALOG_VERSION,
    valid: true,
    allowed,
    planKey,
    resourceKey,
    limit,
    usage,
    percentage,
    noticeLevel,
    reasonCode: null,
    message,
  });
}

function invalidEvaluation(reasonCode) {
  return Object.freeze({
    catalogVersion: PLAN_CATALOG_VERSION,
    valid: false,
    allowed: false,
    planKey: null,
    resourceKey: null,
    limit: null,
    usage: null,
    percentage: 0,
    noticeLevel: "invalid_request",
    reasonCode,
    message: "No se pudo evaluar el entitlement solicitado.",
  });
}

function readClosedRecord(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid_record");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("invalid_record");
  }

  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError("invalid_record");
  }

  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw new TypeError("invalid_record");
    }
    result[field] = descriptor.value;
  }
  return result;
}
