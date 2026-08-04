export type PlanKey = "free" | "pro" | "legacy";

export type PlanResourceQuotas = {
  readonly fieldsMax: number | null;
  readonly paddocksMax: number | null;
  readonly membersMax: number | null;
  readonly monthlyExportsMax: number | null;
  readonly ndviEnabled: boolean;
};

export type PlanDefinition = {
  readonly key: PlanKey;
  readonly name: string;
  readonly description: string;
  readonly priceClpMonthly: number | null;
  readonly quotas: Readonly<PlanResourceQuotas>;
};

export const PLAN_CATALOG_VERSION: "fundosmart.plan-catalog.v1";
export const PLAN_KEYS: readonly ["free", "pro", "legacy"];
export const PLAN_RESOURCE_KEYS: readonly [
  "fieldsMax",
  "paddocksMax",
  "membersMax",
  "monthlyExportsMax",
  "ndviEnabled",
];

export const PLAN_CATALOG: Readonly<Record<PlanKey, Readonly<PlanDefinition>>>;

export function getPlanDefinition(planKey?: string | null): PlanDefinition;
export function resolvePlanDefinition(planKey: unknown): PlanDefinition | null;
