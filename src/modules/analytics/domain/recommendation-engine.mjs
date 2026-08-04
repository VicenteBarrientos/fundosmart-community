export const ANALYTICS_RECOMMENDATION_ENGINE_VERSION = "fundosmart.analytics.recommendation-engine.v1";
export const RULE_BASED_RECOMMENDATION_ADAPTER_ID = "fundosmart.analytics.rules.v1";

/**
 * Creates a deterministic adapter for the recommendation contract. The
 * contract intentionally describes rules, not a model, so callers can replace
 * the adapter without changing the projection or persistence boundary.
 */
export function createRuleBasedRecommendationEngine(input) {
  if (!input || typeof input.evaluate !== "function") {
    throw new TypeError("El adaptador de recomendaciones necesita una función evaluate.");
  }
  const adapterId = boundedIdentifier(input.adapterId ?? RULE_BASED_RECOMMENDATION_ADAPTER_ID);
  return Object.freeze({
    version: ANALYTICS_RECOMMENDATION_ENGINE_VERSION,
    adapterId,
    strategy: "rules",
    evaluate: input.evaluate,
  });
}

export function runRecommendationEngine(engine, context) {
  if (!engine || engine.version !== ANALYTICS_RECOMMENDATION_ENGINE_VERSION) {
    throw new TypeError("La versión del motor de recomendaciones no es compatible.");
  }
  if (engine.strategy !== "rules" || typeof engine.evaluate !== "function") {
    throw new TypeError("El motor de recomendaciones debe usar un adaptador de reglas explícito.");
  }
  const evaluations = engine.evaluate(context);
  if (!Array.isArray(evaluations)) {
    throw new TypeError("El adaptador de recomendaciones debe devolver evaluaciones.");
  }
  return {
    engineVersion: engine.version,
    adapterId: boundedIdentifier(engine.adapterId),
    strategy: "rules",
    evaluations,
  };
}

function boundedIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 160 || !/^[a-z0-9._:-]+$/u.test(normalized)) {
    throw new TypeError("El identificador del adaptador de recomendaciones no es válido.");
  }
  return normalized;
}
