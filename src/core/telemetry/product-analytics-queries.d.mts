export type ProductAnalyticsEnvironment = "production" | "staging";
export type ProductAnalyticsQueryName =
  | "activation_funnel"
  | "median_time_to_first_value"
  | "weekly_retention";

export const PRODUCT_ANALYTICS_WINDOW_DAYS: 90;
export const PRODUCT_ANALYTICS_MAX_COHORTS: 32;
export const PRODUCT_ANALYTICS_MIN_PUBLISHABLE_COHORT: 5;
export const PRODUCT_ANALYTICS_QUERY_NAMES: readonly ProductAnalyticsQueryName[];
export const PRODUCT_ANALYTICS_DATASETS: Readonly<
  Record<ProductAnalyticsEnvironment, string>
>;

export class ProductAnalyticsQueryError extends TypeError {
  readonly code: string;
  constructor(code: string);
}

export type ProductActivationFunnelRow = Readonly<{
  cohortWeek: string;
  eligibleOrganizations: number;
  workspaceOrganizations: number;
  fieldOrganizations: number;
  activatedOrganizations: number;
  publishable: boolean;
}>;

export type ProductMedianTimeRow = Readonly<{
  cohortWeek: string;
  activatedOrganizations: number;
  medianHoursToFirstValue: number;
  publishable: boolean;
}>;

export type ProductWeeklyRetentionRow = Readonly<{
  cohortWeek: string;
  activatedOrganizations: number;
  week1EligibleOrganizations: number;
  retainedWeek1: number;
  week4EligibleOrganizations: number;
  retainedWeek4: number;
  week1Publishable: boolean;
  week4Publishable: boolean;
}>;

export type ProductAnalyticsRowByQuery = {
  activation_funnel: ProductActivationFunnelRow;
  median_time_to_first_value: ProductMedianTimeRow;
  weekly_retention: ProductWeeklyRetentionRow;
};

export function buildProductAnalyticsQuery(
  queryName: ProductAnalyticsQueryName,
  environment: ProductAnalyticsEnvironment,
): string;

export function parseProductAnalyticsResponse<Name extends ProductAnalyticsQueryName>(
  queryName: Name,
  response: unknown,
): ReadonlyArray<ProductAnalyticsRowByQuery[Name]>;
