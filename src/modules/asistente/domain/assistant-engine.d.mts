import type { MilkModuleSnapshot } from "@/src/modules/leche/domain/types";

export type AssistantEngineData = {
  canOperate: boolean;
  fields: Array<{ id: string; name: string }>;
  paddocks: Array<{ id: string; fieldId: string; name: string }>;
  livestock: { total: number; active: number };
  livestockByField: Record<string, { total: number; active: number }>;
  milk: MilkModuleSnapshot;
};

export type AssistantActivityAction = {
  kind: "create_activity";
  id: string;
  fieldId: string;
  fieldName: string;
  paddockId: string;
  paddockName: string;
  activityType: "fertilization" | "grazing" | "soil" | "harvest" | "maintenance" | "other";
  activityLabel: string;
  occurredAt: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  costClp: null;
  createdAt: string;
};

export type AssistantEngineReply = {
  message: string;
  suggestions: string[];
  links: Array<{ label: string; href: string }>;
  action: AssistantActivityAction | null;
};

export function buildAssistantReply(
  message: string,
  data: AssistantEngineData,
  options?: { today?: string; actionId?: string; createdAt?: string },
): AssistantEngineReply;

export function validateConfirmedActivity(action: unknown, confirmationId: unknown): string | null;
