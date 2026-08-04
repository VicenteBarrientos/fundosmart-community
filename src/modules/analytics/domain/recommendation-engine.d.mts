import type { AnalyticsAlert } from "./analytics-projection.mjs";

export const ANALYTICS_RECOMMENDATION_ENGINE_VERSION: "fundosmart.analytics.recommendation-engine.v1";
export const RULE_BASED_RECOMMENDATION_ADAPTER_ID: "fundosmart.analytics.rules.v1";

export type AnalyticsRecommendationEngine<TContext = unknown> = Readonly<{
  version: typeof ANALYTICS_RECOMMENDATION_ENGINE_VERSION;
  adapterId: string;
  strategy: "rules";
  evaluate(context: TContext): AnalyticsAlert[];
}>;

export function createRuleBasedRecommendationEngine<TContext>(input: {
  adapterId?: string;
  evaluate(context: TContext): AnalyticsAlert[];
}): AnalyticsRecommendationEngine<TContext>;

export function runRecommendationEngine<TContext>(
  engine: AnalyticsRecommendationEngine<TContext>,
  context: TContext,
): {
  engineVersion: typeof ANALYTICS_RECOMMENDATION_ENGINE_VERSION;
  adapterId: string;
  strategy: "rules";
  evaluations: AnalyticsAlert[];
};
