import type {
  PabcoComplianceRequirement,
  PabcoComplianceStatus,
} from "@/src/core/domain/types";

export type PabcoReminderSource = {
  id: string;
  fieldId: string;
  requirement: PabcoComplianceRequirement;
  status: PabcoComplianceStatus;
  validUntil: string | null;
  reminderAt: string | null;
};

export type PabcoReminderWorkItem = {
  id: string;
  complianceItemId: string;
  fieldId: string;
  title: string;
  detail: string;
  dueDate: string;
  validUntil: string | null;
  status: PabcoComplianceStatus;
};

export function derivePabcoReminderWorkItems(
  items: PabcoReminderSource[],
): PabcoReminderWorkItem[];
export function selectDuePabcoReminderWorkItems(
  items: PabcoReminderSource[],
  today: string,
  reminderDays: number,
): PabcoReminderWorkItem[];
export function derivePabcoComplianceStatus(
  item: Pick<PabcoReminderSource, "status" | "validUntil" | "reminderAt">,
  today: string,
): PabcoComplianceStatus;
export function clampReminderDays(value: unknown): number;
