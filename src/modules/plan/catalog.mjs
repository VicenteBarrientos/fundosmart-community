export const PLAN_CATALOG_VERSION = "fundosmart.plan-catalog.v1";

export const PLAN_KEYS = Object.freeze(["free", "pro", "legacy"]);
export const PLAN_RESOURCE_KEYS = Object.freeze([
  "fieldsMax",
  "paddocksMax",
  "membersMax",
  "monthlyExportsMax",
  "ndviEnabled",
]);

function plan(definition) {
  return Object.freeze({
    ...definition,
    quotas: Object.freeze({ ...definition.quotas }),
  });
}

export const PLAN_CATALOG = Object.freeze({
  free: plan({
    key: "free",
    name: "Plan Gratis",
    description: "Cuenta personal de autoservicio para pequeños productores y evaluación.",
    priceClpMonthly: 0,
    quotas: {
      fieldsMax: 2,
      paddocksMax: 200,
      membersMax: 5,
      monthlyExportsMax: 10,
      ndviEnabled: false,
    },
  }),
  pro: plan({
    key: "pro",
    name: "Plan Pro",
    description: "Para fundos comerciales con colaboración de equipo, alertas y exportaciones sin límites.",
    priceClpMonthly: 49_000,
    quotas: {
      fieldsMax: null,
      paddocksMax: 2000,
      membersMax: null,
      monthlyExportsMax: null,
      ndviEnabled: true,
    },
  }),
  legacy: plan({
    key: "legacy",
    name: "Plan Histórico",
    description: "Espacio de transición conservado para organizaciones previas.",
    priceClpMonthly: null,
    quotas: {
      fieldsMax: null,
      paddocksMax: null,
      membersMax: null,
      monthlyExportsMax: null,
      ndviEnabled: true,
    },
  }),
});

const PLAN_KEY_SET = new Set(PLAN_KEYS);

/**
 * Strict resolver for authorization and transition consumers. It intentionally
 * does not normalize or fall back to another plan.
 */
export function resolvePlanDefinition(planKey) {
  return (
    typeof planKey === "string"
    && PLAN_KEY_SET.has(planKey)
  )
    ? PLAN_CATALOG[planKey]
    : null;
}

/**
 * Compatibility resolver used by the existing public pricing presentation.
 * Authorization consumers must use resolvePlanDefinition instead.
 */
export function getPlanDefinition(planKey) {
  const key = typeof planKey === "string" ? planKey.toLowerCase().trim() : "free";
  return PLAN_KEY_SET.has(key) ? PLAN_CATALOG[key] : PLAN_CATALOG.free;
}
