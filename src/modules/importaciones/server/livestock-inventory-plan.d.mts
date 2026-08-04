import type { LivestockAnimalStatus } from "@/src/core/domain/types";
import type { ImportConfirmationRowOutcome } from "../domain/types";
import type {
  LivestockInventoryExitKind,
  ParsedLivestockInventoryRow,
} from "./livestock-inventory-parser.d.mts";

export const LIVESTOCK_INVENTORY_PLAN_VERSION: "fundosmart.import.livestock_inventory.plan.v1";

/** Canonical reproductive event types this profile can produce. */
export type PlannedReproductiveEventType = "calving" | "dry_off" | "heat" | "pregnancy_diagnosis";

export type PlannedRowAnchor = {
  rowNumber: number;
  recordNumber: number;
  tag: string;
};

export type PlannedAnimalCreate = PlannedRowAnchor & {
  dedupeKey: string;
  tag: string;
  birthDate: string | null;
  status: LivestockAnimalStatus;
};

export type PlannedAnimalUpdate = PlannedRowAnchor & {
  animalId: string;
  dedupeKey: string;
  birthDate: string;
};

export type PlannedLotCreate = {
  dedupeKey: string;
  name: string;
};

export type PlannedLotMembership = PlannedRowAnchor & {
  dedupeKey: string;
  lotName: string;
  /** Null when the lot itself is still to be created. */
  lotId: string | null;
};

export type PlannedReproductiveEvent = PlannedRowAnchor & {
  dedupeKey: string;
  eventType: PlannedReproductiveEventType;
  occurredAt: string;
  result: string | null;
};

export type PlannedBirth = PlannedRowAnchor & {
  dedupeKey: string;
  occurredAt: string;
  calfSex: "female" | "male";
  calfExternalId: string | null;
};

export type PlannedStatusChange = PlannedRowAnchor & {
  dedupeKey: string;
  status: LivestockAnimalStatus;
  /** Always null: the source states a year at most. */
  statusDate: null;
  statusReason: string;
  exitYear: number | null;
  sourceText: string;
};

export type PlanPendingCode =
  | "EXIT_DATE_REQUIRED"
  | "EXIT_KIND_HAS_NO_CANONICAL_STATUS"
  | "PALPATION_DATE_REQUIRED"
  | "OFFSPRING_CALVING_PAIRING";

export type PlanPendingDecision = PlannedRowAnchor & {
  code: PlanPendingCode;
  message: string;
  value?: string | null;
};

export type PlanConflict = {
  rowNumber: number;
  recordNumber: number;
  tag?: string;
  code: "ROW_REJECTED_BY_READER" | "BIRTH_DATE_MISMATCH";
  message: string;
  issues?: string[];
  storedValue?: string | null;
  incomingValue?: string | null;
};

export type LivestockInventoryPlanSummary = {
  animalsToCreate: number;
  animalsToUpdate: number;
  lotsToCreate: number;
  lotMemberships: number;
  reproductiveEvents: number;
  eventsByType: Partial<Record<PlannedReproductiveEventType, number>>;
  births: number;
  statusChanges: number;
  pending: number;
  conflicts: number;
};

export type LivestockInventoryPlan = {
  planVersion: typeof LIVESTOCK_INVENTORY_PLAN_VERSION;
  fieldId: string;
  /** Rows the reader produced, including those rejected. */
  rowsSeen: number;
  rowOutcomes: ImportConfirmationRowOutcome[];
  animalsToCreate: PlannedAnimalCreate[];
  animalsToUpdate: PlannedAnimalUpdate[];
  lotsToCreate: PlannedLotCreate[];
  lotMemberships: PlannedLotMembership[];
  reproductiveEvents: PlannedReproductiveEvent[];
  births: PlannedBirth[];
  statusChanges: PlannedStatusChange[];
  pending: PlanPendingDecision[];
  conflicts: PlanConflict[];
  summary: LivestockInventoryPlanSummary;
};

export type LivestockInventoryPlanContext = {
  fieldId: string;
  existingAnimalsByTag?:
    | Map<string, { id: string; birthDate?: string | null; status?: LivestockAnimalStatus }>
    | Record<string, { id: string; birthDate?: string | null; status?: LivestockAnimalStatus }>;
  existingLotsByName?: Map<string, { id: string; name?: string }> | Record<string, { id: string; name?: string }>;
  /** ISO date of the palpation session, which the source states only in a header. */
  palpationDate?: string | null;
};

export function planLivestockInventoryImport(
  parsed: { rows: ParsedLivestockInventoryRow[] },
  context: LivestockInventoryPlanContext,
): LivestockInventoryPlan;

export type LivestockInventoryReceiptCounts = {
  rowCount: number;
  insertedRowCount: number;
  updatedRowCount: number;
  unchangedRowCount: number;
  conflictRowCount: number;
  rejectedRowCount: number;
  importedRowCount: number;
  skippedRowCount: number;
  rowOutcomes: ImportConfirmationRowOutcome[];
  status: "completed" | "completed_with_errors";
};

/** Throws when the outcomes do not account for every row the reader produced. */
export function buildLivestockInventoryReceiptOutcomes(
  plan: LivestockInventoryPlan,
): LivestockInventoryReceiptCounts;

export type LivestockInventoryPlanReadiness = {
  confirmable: boolean;
  conflictCount: number;
  blocking: Array<{ code: PlanPendingCode; count: number; waivable: boolean; dataDropped: string | null }>;
  waived: Array<{ code: PlanPendingCode; count: number; waivable: boolean; dataDropped: string | null }>;
  unknownAcceptances: string[];
  reason: string | null;
};

export function evaluateLivestockInventoryPlanReadiness(
  plan: LivestockInventoryPlan,
  options?: { acceptedPendingCodes?: string[] },
): LivestockInventoryPlanReadiness;

export type LivestockInventoryOperationKind =
  | "lot.insert"
  | "animal.insert"
  | "animal.update_birth_date"
  | "animal.update_status"
  | "lot_membership.insert"
  | "reproductive_event.insert"
  | "birth.insert";

/** Write order dictated by the foreign keys between the canonical tables. */
export const LIVESTOCK_INVENTORY_OPERATION_ORDER: readonly LivestockInventoryOperationKind[];

export type LivestockInventoryOperation = {
  kind: LivestockInventoryOperationKind;
  dedupeKey: string;
  /** Primary key: newly derived for an insert, the target row's key for an update. */
  id: string;
  rowNumber?: number;
  values: Record<string, unknown>;
};

export type LivestockInventoryUnresolvedOperation = {
  kind: LivestockInventoryOperationKind;
  tag: string;
  rowNumber: number;
  reason: "UNKNOWN_ANIMAL" | "UNKNOWN_LOT";
};

export type LivestockInventoryOperationBatch = {
  fieldId: string;
  operations: LivestockInventoryOperation[];
  unresolved: LivestockInventoryUnresolvedOperation[];
  countsByKind: Partial<Record<LivestockInventoryOperationKind, number>>;
};

export function buildLivestockInventoryOperations(
  plan: LivestockInventoryPlan,
  context?: {
    /** Must be deterministic per dedupeKey so a replay derives the same keys. */
    newId?: (kind: string, dedupeKey: string) => string;
    existingAnimalsByTag?: LivestockInventoryPlanContext["existingAnimalsByTag"];
    existingLotsByName?: LivestockInventoryPlanContext["existingLotsByName"];
  },
): LivestockInventoryOperationBatch;

export type { LivestockInventoryExitKind };
