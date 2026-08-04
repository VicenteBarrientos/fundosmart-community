import type { HerdWorkItem } from "../ganado/domain/operations";
import type { MilkMammaryWorkItem } from "../leche/domain/types";
import type { OperationalAlert } from "./operational-alerts.mjs";

export type TodayAgendaUrgency = "urgent" | "today" | "soon" | "review";
export type TodayAgendaCategory =
  | "reproduction"
  | "health"
  | "weighing"
  | "production"
  | "finance"
  | "paddocks"
  | "records"
  | "imports";
export type TodayAgendaSource =
  | "ganado"
  | "leche"
  | "costos"
  | "potreros"
  | "dashboard"
  | "importaciones";

export type TodayAgendaItem = {
  id: string;
  revision: string;
  category: TodayAgendaCategory;
  source: TodayAgendaSource;
  sourceLabel: string;
  fieldId: string | null;
  animalId: string | null;
  animalTag: string | null;
  lotName: string | null;
  urgency: TodayAgendaUrgency;
  title: string;
  reason: string;
  evidenceDate: string;
  dateLabel: string;
  href: string;
  actionLabel: string;
};

export type AgronomicAgendaSignal = {
  id: string;
  fieldId: string;
  importJobId: string;
  paddockId: string;
  paddockName: string;
  externalPaddockKey: string;
  visitDate: string;
  actionHeading: string;
  recommendationText: string;
};

export type ImportAgendaSignal = {
  id: string;
  fieldId?: string | null;
  importJobId: string;
  sourceType: string;
  filename: string;
  createdAt: string;
  status: "staged" | "conflict";
  summary: string;
};

export function buildTodayAgenda(input?: {
  agronomicWorkItems?: AgronomicAgendaSignal[];
  importWorkItems?: ImportAgendaSignal[];
  contextFieldId?: string | null;
  herdWorkItems?: HerdWorkItem[];
  mammaryWorkItems?: MilkMammaryWorkItem[];
  operationalAlerts?: OperationalAlert[];
  referenceDate?: string;
}): TodayAgendaItem[];

export function agendaItemRevision(item: Record<string, unknown>): string;
