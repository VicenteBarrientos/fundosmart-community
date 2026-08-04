import type { PlanKey, PlanResourceQuotas } from "./catalog.d.mts";

export type ResourceKey = keyof PlanResourceQuotas;

export type EntitlementNoticeLevel =
  | "none"
  | "warning_70"
  | "warning_90"
  | "limit_reached"
  | "invalid_request";

export type EntitlementEvaluation =
  | {
      readonly catalogVersion: "fundosmart.plan-catalog.v1";
      readonly valid: true;
      readonly allowed: boolean;
      readonly planKey: PlanKey;
      readonly resourceKey: ResourceKey;
      readonly limit: number | null;
      readonly usage: number;
      readonly percentage: number;
      readonly noticeLevel: Exclude<EntitlementNoticeLevel, "invalid_request">;
      readonly reasonCode: null;
      readonly message: string;
    }
  | {
      readonly catalogVersion: "fundosmart.plan-catalog.v1";
      readonly valid: false;
      readonly allowed: false;
      readonly planKey: null;
      readonly resourceKey: null;
      readonly limit: null;
      readonly usage: null;
      readonly percentage: 0;
      readonly noticeLevel: "invalid_request";
      readonly reasonCode:
        | "INPUT_SHAPE_INVALID"
        | "PLAN_KEY_INVALID"
        | "RESOURCE_KEY_INVALID"
        | "CURRENT_USAGE_INVALID"
        | "FEATURE_USAGE_INVALID";
      readonly message: string;
    };

export function evaluateResourceEntitlement(input: {
  planKey: PlanKey | string | null;
  resourceKey: ResourceKey;
  currentUsage: number;
}): EntitlementEvaluation;
