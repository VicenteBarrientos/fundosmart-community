export type Coordinate = [number, number];

export type PolygonRings = {
  outer: Coordinate[];
  holes: Coordinate[][];
};

export type StoredPolygon = Coordinate[] | PolygonRings;

export type ExclusionKind = "laguna" | "bosque" | "construccion" | "roquerio" | "humedal";

export type PaddockLandUse =
  | "pradera_permanente"
  | "pradera_rotacion"
  | "cultivo_forrajero"
  | "cultivo"
  | "bosque"
  | "infraestructura"
  | "otro";

export type SoilAnalysis = {
  ph: number | null;
  nitrogen: number | null;
  phosphorus: number | null;
  potassium: number | null;
};

export type Potrero = {
  id: string;
  fieldId: string;
  name: string;
  sector: string;
  areaHectares: number;
  coordinates: Coordinate[];
  geometry?: PolygonRings;
  netAreaHectares?: number;
  grazeableAreaHectares?: number | null;
  effectiveGrazeableAreaHectares?: number;
  landUse?: PaddockLandUse;
  holeKinds?: ExclusionKind[];
  soil: SoilAnalysis;
  lastActivity: string;
  status: "Disponible" | "En pastoreo" | "En descanso";
  updatedAt?: string;
  archivedAt?: string | null;
  archiveReason?: PaddockArchiveReason | null;
  createdByOperationId?: string | null;
  archivedByOperationId?: string | null;
};

export type PotreroInput = Omit<Potrero, "id" | "fieldId" | "lastActivity" | "status">;

export type SoilReportReference = {
  filename: string;
  folio: string;
  sampleId: string;
  reportDate: string;
};

export type Fundo = {
  id: string;
  name: string;
  location: string;
  areaHectares: number;
  coordinates: Coordinate[];
  soilReport: SoilReportReference | null;
  snapshotToken?: string;
};

export type FundoInput = Omit<Fundo, "id">;

export const ACTIVITY_TYPE_LABELS = {
  fertilization: "Fertilización",
  grazing: "Pastoreo",
  soil: "Análisis de suelo",
  harvest: "Cosecha",
  maintenance: "Mantención",
  other: "Otro manejo",
} as const;

export type ActivityType = keyof typeof ACTIVITY_TYPE_LABELS;

export type Activity = {
  id: string;
  potreroId: string;
  type: ActivityType;
  occurredAt: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  costClp: number | null;
  createdAt: string;
  updatedAt?: string;
};

export type ActivityInput = Omit<Activity, "id" | "createdAt">;

export type ActivityWithLineage = Activity & {
  inherited: boolean;
  sourcePaddockId: string;
  sourcePaddockName: string;
  lineageDepth: number;
};

export type SubdivisionDraft = {
  fieldId: string;
  history: Coordinate[][][];
  line: Coordinate[];
  updatedAt: string;
};

export type SubdivisionScopeKind = "field" | "paddock";

export type ScopedSubdivisionDraft = SubdivisionDraft & {
  id: string;
  scopeKind: SubdivisionScopeKind;
  scopeId: string;
  baseSnapshotToken: string;
};

export type PaddockArchiveReason = "split" | "merge" | "redesign" | "manual" | "undo";
export type PaddockOperationKind = "split" | "merge" | "redesign" | "undo";

export type PaddockOperationPlanRequest = {
  fieldId: string;
  kind: PaddockOperationKind;
  parentPaddockIds: string[];
  proposedPaddocks: Potrero[];
  sourceOperationId?: string | null;
};

export type PaddockOperationCommitRequest = PaddockOperationPlanRequest & {
  operationId: string;
  requestHash: string;
  expectedSnapshotToken: string;
};

export type PaddockOperationLineage = {
  parentPaddockId: string;
  childPaddockId: string;
  overlapSquareMeters: number;
  parentOverlapRatio: number;
  childOverlapRatio: number;
  isPrimary: boolean;
};

export type PaddockOperationLotMove = {
  lotId: string;
  fromPaddockId: string | null;
  toPaddockId: string | null;
  overlapSquareMeters: number;
  overlapRatio: number;
  reason: string;
  warning: string | null;
};

export type PaddockOperationPreview = {
  fieldId: string;
  kind: PaddockOperationKind;
  requestHash: string;
  snapshotToken: string;
  sourceOperationId: string | null;
  parents: Potrero[];
  proposedPaddocks: Potrero[];
  lineageEdges: PaddockOperationLineage[];
  lotMoves: PaddockOperationLotMove[];
  activityCount: number;
  areaBeforeSquareMeters: number;
  areaAfterSquareMeters: number;
  areaDeltaSquareMeters: number;
  areaDeltaRatio: number;
  warnings: string[];
  blockers: string[];
  valid: boolean;
};

export type PaddockOperationResult = {
  operationId: string;
  fieldId: string;
  kind: PaddockOperationKind;
  requestHash: string;
  sourceOperationId: string | null;
  activePaddocks: Potrero[];
  archivedPaddocks: Potrero[];
  lineageEdges: PaddockOperationLineage[];
  lotMoves: PaddockOperationLotMove[];
  committedAt: string;
  idempotentReplay: boolean;
};

export type PaddockStockingLoad = {
  paddockId: string;
  paddockName: string;
  grossAreaHectares: number;
  netAreaHectares: number;
  grazeableAreaHectares: number | null;
  effectiveGrazeableAreaHectares: number;
  animalCount: number;
  animalsPerHectare: number | null;
};

export type FieldStockingLoad = {
  fieldId: string;
  grossAreaHectares: number;
  netAreaHectares: number;
  effectiveGrazeableAreaHectares: number;
  animalCount: number;
  animalsPerHectare: number | null;
  paddocks: PaddockStockingLoad[];
};

export const LIVESTOCK_CATEGORY_LABELS = {
  dairy_cow: "Vacas en leche",
  dry_cow: "Vacas secas",
  heifer: "Vaquillas",
  calf: "Terneros/as",
  steer: "Novillos",
  bull: "Toros",
  sheep: "Ovinos",
  other: "Otros animales",
} as const;

export type LivestockCategory = keyof typeof LIVESTOCK_CATEGORY_LABELS;

export const LIVESTOCK_STATUS_LABELS = {
  active: "Activo",
  sold: "Vendido",
  departed: "Retirado",
} as const;

export type LivestockStatus = keyof typeof LIVESTOCK_STATUS_LABELS;

export const LIVESTOCK_SEX_LABELS = {
  female: "Hembra",
  male: "Macho",
  unknown: "Sin registrar",
} as const;

export type LivestockSex = keyof typeof LIVESTOCK_SEX_LABELS;

export const LIVESTOCK_ANIMAL_STATUS_LABELS = {
  active: "Activo",
  dead: "Fallecido",
  sold: "Vendido",
  departed: "Retirado",
} as const;

export type LivestockAnimalStatus = keyof typeof LIVESTOCK_ANIMAL_STATUS_LABELS;
export type LivestockTrackingMode = "summary" | "individual";

export type LivestockLot = {
  id: string;
  fieldId: string;
  paddockId: string | null;
  name: string;
  category: LivestockCategory;
  animalCount: number;
  averageWeightKg: number | null;
  entryDate: string;
  status: LivestockStatus;
  ownerName: string | null;
  trackingMode: LivestockTrackingMode;
  notes: string;
  createdAt: string;
  updatedAt?: string;
};

export type LivestockLotInput = Omit<LivestockLot, "id" | "createdAt">;

export type LivestockAnimal = {
  id: string;
  lotId: string;
  tag: string;
  sex: LivestockSex;
  status: LivestockAnimalStatus;
  statusDate: string | null;
  statusReason: string | null;
  birthDate: string | null;
  purchasePriceClp: number | null;
  purchaseDate: string | null;
  salePriceClp: number | null;
  saleBuyer: string | null;
  saleWeightKg: number | null;
  origin: string | null;
  notes: string;
  source: string;
  /** Derivado: el peso del pesaje más reciente. Se lee, no se decide. */
  latestWeightKg: number | null;
  latestWeightDate: string | null;
  createdAt: string;
  snapshotToken?: string;
  /**
   * Pesajes que una escritura afirma para este animal, uno por día.
   *
   * Es una **lista de cambios, no la historia completa**: solo llegan los días que quien
   * escribe realmente tocó. La planilla muestra una ventana de fechas, así que tratarla
   * como reemplazo borraría todo lo que quedó fuera de la pantalla.
   *
   * Solo viaja de ida. El repositorio no la devuelve: al leer, la historia se pide por
   * separado y el animal trae `latestWeightKg` ya resuelto.
   */
  weighings?: LivestockAnimalWeighingWrite[];
};

/** Un pesaje que se escribe desde el animal. `weightKg: null` borra el de ese día. */
export type LivestockAnimalWeighingWrite = {
  recordedAt: string;
  weightKg: number | null;
};

export type LivestockAnimalInput = Omit<LivestockAnimal, "id" | "createdAt">;

export type LivestockWeighing = {
  id: string;
  lotId: string | null;
  animalId: string;
  recordedAt: string;
  weightKg: number;
  notes: string;
  source: string;
  createdAt: string;
  snapshotToken?: string;
};

export const LIVESTOCK_EXPENSE_CATEGORY_LABELS = {
  alimento: "Alimento",
  compra_animales: "Compra de animales",
  combustible: "Combustible",
  flete: "Flete",
  sanidad: "Sanidad",
  otro: "Otro",
} as const;

export type LivestockExpenseCategory = keyof typeof LIVESTOCK_EXPENSE_CATEGORY_LABELS;

export const LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS = {
  society: "Organización",
  partner: "Socio",
  unassigned: "Origen pendiente",
} as const;

export type LivestockExpensePaymentSource = keyof typeof LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS;

export type MilkSettlementLineItem = {
  description: string;
  measurement: string | null;
  unitPriceClp: number | null;
  amountClp: number;
};

export type MilkSettlement = {
  id: string;
  fieldId: string;
  period: string;
  generatedAt: string | null;
  plant: string;
  purchaseOrder: string;
  producerCode: string;
  producerName: string;
  buyerName: string;
  litersFirstHalf: number | null;
  litersSecondHalf: number | null;
  totalLiters: number;
  netAmountClp: number;
  taxAmountClp: number;
  grossAmountClp: number;
  netPricePerLiterClp: number;
  grossPricePerLiterClp: number | null;
  sourceDocumentName: string | null;
  notes: string;
  lineItems: MilkSettlementLineItem[];
  createdAt: string;
  updatedAt: string;
};

export type MilkBulkProductionKind = "tank_total" | "delivery" | "milk_meter_rollup";

export type MilkBulkProductionSource = "manual" | "cooprinsem_clo" | "equipment";

export type MilkBulkProduction = {
  id: string;
  organizationId: string;
  fieldId: string;
  recordedAt: string;
  kind: MilkBulkProductionKind;
  volumeLiters: number;
  source: MilkBulkProductionSource;
  sourceRecordId: string | null;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type MilkQualitySampleKind = "bulk_tank" | "settlement" | "laboratory";

export type MilkQualitySampleSource = "manual" | "settlement" | "cooprinsem_laboratory" | "equipment";

export type MilkSomaticCellCountUnit = "cells_per_ml" | "thousand_cells_per_ml";

export type MilkBacterialCountUnit = "cfu_per_ml" | "thousand_cfu_per_ml";

export type MilkQualitySanitaryFlags = Partial<
  Record<
    "tbc" | "brucellosis" | "leucosis" | "pabco",
    "compliant" | "non_compliant" | "pending" | "not_reported"
  >
>;

export type MilkQualitySample = {
  id: string;
  organizationId: string;
  fieldId: string;
  sampledAt: string;
  period: string;
  kind: MilkQualitySampleKind;
  fatPercent: number | null;
  proteinPercent: number | null;
  totalSolidsPercent: number | null;
  somaticCellCount: number | null;
  somaticCellCountUnit: MilkSomaticCellCountUnit | null;
  bacterialCount: number | null;
  bacterialCountUnit: MilkBacterialCountUnit | null;
  sanitaryFlags: MilkQualitySanitaryFlags;
  source: MilkQualitySampleSource;
  sourceRecordId: string | null;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PabcoComplianceRequirement =
  | "veterinary_advisory"
  | "medicine_prescriptions"
  | "withdrawal_management"
  | "annual_water_analysis"
  | "animal_traceability";

export type PabcoComplianceStatus = "pending" | "compliant" | "expiring" | "expired" | "not_applicable";

export type PabcoComplianceSource = "manual" | "sag" | "cooprinsem";

export type PabcoComplianceItem = {
  id: string;
  organizationId: string;
  fieldId: string;
  requirement: PabcoComplianceRequirement;
  status: PabcoComplianceStatus;
  evidenceDocumentId: string | null;
  validFrom: string | null;
  validUntil: string | null;
  reminderAt: string | null;
  source: PabcoComplianceSource;
  sourceRecordId: string | null;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type LivestockPartner = {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  snapshotToken: string | null;
};

export type LivestockContribution = {
  id: string;
  partnerId: string;
  amountClp: number;
  date: string | null;
  description: string;
  createdAt: string;
  snapshotToken: string | null;
};

export type LivestockExpense = {
  id: string;
  fieldId: string | null;
  date: string | null;
  description: string;
  category: LivestockExpenseCategory;
  amountClp: number;
  paymentSource: LivestockExpensePaymentSource;
  paidById: string | null;
  lotId: string | null;
  createdAt: string;
};

export type LivestockFinanceAuditAction =
  | "finance.partner.created"
  | "finance.partner.updated"
  | "finance.partner.deleted"
  | "finance.contribution.created"
  | "finance.contribution.updated"
  | "finance.contribution.deleted"
  | "finance.expense.created"
  | "finance.expense.updated"
  | "finance.expense.deleted";

export type LivestockFinanceAuditEntity =
  | "livestock_partner"
  | "livestock_contribution"
  | "livestock_expense";

export type LivestockFinanceAuditEntry = {
  id: string;
  action: LivestockFinanceAuditAction;
  actor: string;
  entityType: LivestockFinanceAuditEntity;
  entityId: string;
  fieldId: string | null;
  subject: string;
  amountClp: number | null;
  occurredAt: string;
};

export type LivestockFeedingPlan = {
  id: string;
  lotId: string;
  productName: string;
  kgPerAnimalDay: number;
  sackWeightKg: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type LivestockFeedInventory = {
  id: string;
  fieldId: string;
  productName: string;
  quantityKg: number;
  unitCostClp: number;
  reorderLevelKg: number;
  createdAt: string;
  updatedAt: string;
};

export type LivestockFeedConsumption = {
  id: string;
  fieldId: string;
  lotId: string;
  inventoryItemId: string;
  planId: string | null;
  occurredAt: string;
  quantityKg: number;
  costClp: number;
  source: string;
  createdBy: string;
  createdAt: string;
};
