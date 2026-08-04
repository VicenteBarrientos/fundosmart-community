import type { Activity, Coordinate, LivestockAnimal, LivestockExpense, LivestockFeedingPlan, LivestockLot, LivestockWeighing, MilkSettlement, Potrero } from "../../../core/domain/types";

export const DEMO_EMAIL: string;
export const DEMO_MEMBERSHIP_ID: string;
export const DEMO_FIELD_ID: string;
export const DEMO_CREATED_AT: string;
export const DEMO_DATA_PROVENANCE: Readonly<{
  kind: "deterministic-synthetic";
  privateSources: false;
  version: "public-demo-v1";
}>;
export const DEMO_FIELD: { id: string; name: string; location: string; areaHectares: number; coordinates: Coordinate[] };
export const DEMO_PADDOCKS: Potrero[];
export const DEMO_ACTIVITIES: Array<Omit<Activity, "createdAt">>;
export const DEMO_LOTS: Array<Omit<LivestockLot, "createdAt">>;
export const DEMO_ANIMALS: Array<Omit<LivestockAnimal, "latestWeightKg" | "latestWeightDate" | "createdAt"> & { weightKg: number }>;
export const DEMO_WEIGHINGS: Array<Omit<LivestockWeighing, "createdAt">>;
export const DEMO_FEEDING_PLANS: Array<Omit<LivestockFeedingPlan, "createdAt" | "updatedAt">>;
export const DEMO_EXPENSES: Array<Omit<LivestockExpense, "createdAt">>;
export const DEMO_MILK_SETTLEMENTS: Array<Omit<MilkSettlement, "createdAt" | "updatedAt">>;
