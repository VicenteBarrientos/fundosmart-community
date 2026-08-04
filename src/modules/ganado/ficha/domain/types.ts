import type { LivestockAnimal, LivestockSex, LivestockWeighing } from "@/src/core/domain/types";

export const LIVESTOCK_LACTATION_STATUSES = ["active", "dry", "closed"] as const;
export type LivestockLactationStatus = (typeof LIVESTOCK_LACTATION_STATUSES)[number];

export const LIVESTOCK_REPRODUCTIVE_EVENT_TYPES = [
  "heat",
  "service",
  "insemination",
  "pregnancy_diagnosis",
  "calving",
  "dry_off",
  "abortion",
] as const;
export type LivestockReproductiveEventType = (typeof LIVESTOCK_REPRODUCTIVE_EVENT_TYPES)[number];

export const LIVESTOCK_CALVING_TYPES = ["single", "twin", "multiple", "unknown"] as const;
export type LivestockCalvingType = (typeof LIVESTOCK_CALVING_TYPES)[number];

export const LIVESTOCK_CALVING_DIFFICULTIES = ["unassisted", "assisted", "dystocia", "unknown"] as const;
export type LivestockCalvingDifficulty = (typeof LIVESTOCK_CALVING_DIFFICULTIES)[number];

export const LIVESTOCK_BIRTH_OUTCOMES = ["live", "mixed", "stillbirth", "unknown"] as const;
export type LivestockBirthOutcome = (typeof LIVESTOCK_BIRTH_OUTCOMES)[number];

export const LIVESTOCK_OFFSPRING_OUTCOMES = ["alive", "stillborn", "deceased", "unknown"] as const;
export type LivestockOffspringOutcome = (typeof LIVESTOCK_OFFSPRING_OUTCOMES)[number];

export const LIVESTOCK_HEALTH_EVENT_TYPES = ["observation", "diagnosis", "treatment", "vaccination", "withdrawal_clearance"] as const;
export type LivestockHealthEventType = (typeof LIVESTOCK_HEALTH_EVENT_TYPES)[number];

export const LIVESTOCK_HEALTH_EVENT_STATUSES = ["open", "completed", "cancelled"] as const;
export type LivestockHealthEventStatus = (typeof LIVESTOCK_HEALTH_EVENT_STATUSES)[number];

export const LIVESTOCK_CALVING_TYPE_LABELS: Record<LivestockCalvingType, string> = {
  single: "Único",
  twin: "Mellizos",
  multiple: "Múltiple",
  unknown: "Sin clasificar",
};

export const LIVESTOCK_CALVING_DIFFICULTY_LABELS: Record<LivestockCalvingDifficulty, string> = {
  unassisted: "Sin asistencia",
  assisted: "Asistido",
  dystocia: "Distocia",
  unknown: "Sin clasificar",
};

export const LIVESTOCK_HEALTH_EVENT_LABELS: Record<LivestockHealthEventType, string> = {
  observation: "Observación",
  diagnosis: "Diagnóstico",
  treatment: "Tratamiento",
  vaccination: "Vacunación",
  withdrawal_clearance: "Liberación de retiro",
};

export const LIVESTOCK_REPRODUCTIVE_EVENT_LABELS: Record<LivestockReproductiveEventType, string> = {
  heat: "Celo",
  service: "Cubierta",
  insemination: "Inseminación",
  pregnancy_diagnosis: "Diagnóstico de gestación",
  calving: "Parto",
  dry_off: "Secado",
  abortion: "Aborto",
};

export type LivestockLactation = {
  id: string;
  fieldId: string;
  animalId: string;
  sequenceNumber: number;
  calvingDate: string | null;
  startedAt: string;
  endedAt: string | null;
  status: LivestockLactationStatus;
  dryOffReason: string | null;
  source: string;
  sourceRecordId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type LivestockMilkControl = {
  id: string;
  fieldId: string;
  animalId: string;
  lactationId: string | null;
  controlDate: string;
  morningLiters: number | null;
  afternoonLiters: number | null;
  thirdMilkingLiters: number | null;
  totalLiters: number;
  fatPct: number | null;
  proteinPct: number | null;
  somaticCellCount: number | null;
  notes: string;
  source: string;
  sourceRecordId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type LivestockReproductiveEvent = {
  id: string;
  fieldId: string;
  animalId: string;
  eventType: LivestockReproductiveEventType;
  occurredAt: string;
  method: string | null;
  result: string | null;
  sireIdentifier: string | null;
  sireAnimalId: string | null;
  notes: string;
  metadata: Record<string, unknown>;
  source: string;
  sourceRecordId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type LivestockBirthOffspring = {
  id: string;
  birthId: string;
  animalId: string | null;
  temporaryIdentifier: string;
  sex: LivestockSex;
  outcome: LivestockOffspringOutcome;
  birthWeightKg: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type LivestockBirth = {
  id: string;
  fieldId: string;
  damAnimalId: string;
  reproductiveEventId: string | null;
  occurredAt: string;
  calvingType: LivestockCalvingType;
  difficulty: LivestockCalvingDifficulty;
  outcome: LivestockBirthOutcome;
  sireIdentifier: string | null;
  sireAnimalId: string | null;
  notes: string;
  source: string;
  sourceRecordId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  offspring: LivestockBirthOffspring[];
};

export type LivestockHealthEvent = {
  id: string;
  fieldId: string;
  animalId: string;
  eventType: LivestockHealthEventType;
  occurredAt: string;
  status: LivestockHealthEventStatus;
  condition: string | null;
  productName: string | null;
  activeIngredient: string | null;
  doseAmount: number | null;
  doseUnit: string | null;
  route: string | null;
  withdrawalMilkUntil: string | null;
  withdrawalMeatUntil: string | null;
  professional: string | null;
  notes: string;
  metadata: Record<string, unknown>;
  source: string;
  sourceRecordId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type AnimalDirectoryItem = {
  id: string;
  tag: string;
  sex: LivestockAnimal["sex"];
  status: LivestockAnimal["status"];
  fieldId: string;
  fieldName: string;
  lotId: string;
  lotName: string;
  latestWeightKg: number | null;
  latestWeightDate: string | null;
};

export type AnimalTimelineItem = {
  id: string;
  occurredAt: string;
  kind: "milk_control" | "reproductive_event" | "birth" | "health_event" | "weighing" | "lactation";
  title: string;
  summary: string;
  tone: "green" | "amber" | "blue" | "neutral" | "red";
};

export type AnimalInsight = {
  code: string;
  level: "info" | "attention" | "positive";
  title: string;
  detail: string;
};

export type AnimalParentageLink = {
  birthId: string;
  occurredAt: string;
  damAnimalId: string;
  damTag: string;
  sireIdentifier: string | null;
  sireAnimalId: string | null;
  sireTag: string | null;
};

export type AnimalRecord = {
  animal: LivestockAnimal;
  fieldId: string;
  fieldName: string;
  lotName: string;
  identifiers: Array<{
    id: string;
    kind: string;
    value: string;
    sourceSystem: string;
    validFrom: string | null;
    validTo: string | null;
  }>;
  lactations: LivestockLactation[];
  milkControls: LivestockMilkControl[];
  reproductiveEvents: LivestockReproductiveEvent[];
  births: LivestockBirth[];
  healthEvents: LivestockHealthEvent[];
  parentage: AnimalParentageLink[];
  weighings: LivestockWeighing[];
  timeline: AnimalTimelineItem[];
  insights: AnimalInsight[];
};

export type MilkControlInput = {
  animalId: string;
  controlDate: string;
  morningLiters: number | null;
  afternoonLiters: number | null;
  thirdMilkingLiters: number | null;
  totalLiters: number | null;
  fatPct: number | null;
  proteinPct: number | null;
  somaticCellCount: number | null;
  notes: string;
};

export type ReproductiveEventInput = {
  animalId: string;
  eventType: LivestockReproductiveEventType;
  occurredAt: string;
  method: string | null;
  result: string | null;
  sireIdentifier: string | null;
  notes: string;
};

export type BirthInput = {
  animalId: string;
  occurredAt: string;
  calvingType: LivestockCalvingType;
  difficulty: LivestockCalvingDifficulty;
  outcome: LivestockBirthOutcome;
  sireIdentifier: string | null;
  notes: string;
  offspring: Array<{
    temporaryIdentifier: string;
    sex: LivestockSex;
    outcome: LivestockOffspringOutcome;
    birthWeightKg: number | null;
    notes: string;
  }>;
};

export type RenumberInput = {
  animalId: string;
  newTag: string;
  effectiveOn: string;
  reason: string | null;
};

export type HealthEventInput = {
  animalId: string;
  eventType: LivestockHealthEventType;
  occurredAt: string;
  status: LivestockHealthEventStatus;
  condition: string | null;
  productName: string | null;
  activeIngredient: string | null;
  doseAmount: number | null;
  doseUnit: string | null;
  route: string | null;
  withdrawalMilkUntil: string | null;
  withdrawalMeatUntil: string | null;
  professional: string | null;
  notes: string;
};
