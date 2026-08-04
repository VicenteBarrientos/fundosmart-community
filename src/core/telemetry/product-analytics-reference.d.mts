import type {
  ProductActivationFunnelRow,
  ProductAnalyticsEnvironment,
  ProductMedianTimeRow,
  ProductWeeklyRetentionRow,
} from "./product-analytics-queries.mjs";
import type { ProductEventV1 } from "./product-events.mjs";

export const PRODUCT_ANALYTICS_REFERENCE_MAX_EVENTS: 100000;

export class ProductAnalyticsReferenceError extends TypeError {
  readonly code: string;
  constructor(code: string);
}

export type ProductAnalyticsReferenceResult = Readonly<{
  activationFunnel: ReadonlyArray<ProductActivationFunnelRow>;
  medianTimeToFirstValue: ReadonlyArray<ProductMedianTimeRow>;
  weeklyRetention: ReadonlyArray<ProductWeeklyRetentionRow>;
}>;

export function evaluateProductAnalyticsReference(
  events: readonly ProductEventV1[],
  options: Readonly<{
    environment: ProductAnalyticsEnvironment;
    asOf: string;
  }>,
): ProductAnalyticsReferenceResult;
