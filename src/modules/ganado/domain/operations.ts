export type HerdWorkItemKind = "pregnancy_check" | "dry_off" | "calving" | "withdrawal" | "weighing" | "health_follow_up";

export type HerdWorkItem = {
  id: string;
  kind: HerdWorkItemKind;
  animalId: string;
  animalTag: string;
  lotId: string;
  lotName: string;
  fieldId: string;
  dueDate: string;
  priority: "overdue" | "today" | "soon" | "watch";
  title: string;
  detail: string;
};
export type CalvingProjection = {
  animalId: string;
  animalTag: string;
  lotName: string;
  fieldId: string;
  serviceDate: string;
  diagnosisDueDate: string;
  dryOffDueDate: string;
  calvingDueDate: string;
  confirmedPregnant: boolean;
  sireIdentifier: string | null;
};

export type ReproductiveKpis = {
  eligibleFemales: number;
  servedFemales: number;
  confirmedPregnancies: number;
  pregnancyRatePct: number | null;
  servicesPerConception: number | null;
  averageCalvingIntervalDays: number | null;
  difficultBirthRatePct: number | null;
};

export type AnimalMargin = {
  animalId: string;
  animalTag: string;
  lotId: string;
  lotName: string;
  salePriceClp: number;
  purchasePriceClp: number;
  allocatedExpenseClp: number;
  marginClp: number;
  saleWeightKg: number | null;
  marginPerKgClp: number | null;
  buyer: string | null;
};

export type LotMargin = {
  lotId: string;
  lotName: string;
  soldAnimals: number;
  revenueClp: number;
  purchaseCostClp: number;
  allocatedExpenseClp: number;
  marginClp: number;
};

export type PedigreeNode = {
  animalId: string;
  animalTag: string;
  damAnimalId: string | null;
  damTag: string | null;
  sireAnimalId: string | null;
  sireTag: string | null;
  maternalGranddamTag: string | null;
  maternalGrandsireTag: string | null;
  paternalGranddamTag: string | null;
  paternalGrandsireTag: string | null;
};

export type HerdOperations = {
  generatedAt: string;
  workItems: HerdWorkItem[];
  projections: CalvingProjection[];
  kpis: ReproductiveKpis;
  animalMargins: AnimalMargin[];
  lotMargins: LotMargin[];
  pedigree: PedigreeNode[];
};
