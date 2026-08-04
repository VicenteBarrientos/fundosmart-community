import type { Coordinate, PolygonRings } from "../types";
import type { RankedRotationEvaluation, RotationClass } from "../utils/rotation";

export type PaddockCellOperationKind = "create" | "close";

export type PaddockCell = {
  id: string;
  fieldId: string;
  paddockId: string;
  name: string;
  index: number;
  coordinates: Coordinate[];
  geometry: PolygonRings;
  areaSquareMeters: number;
  startDistanceMeters: number;
  endDistanceMeters: number;
  activeFrom: string;
  activeTo: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  createdByOperationId: string;
  closedByOperationId: string | null;
};

export type PaddockCellGenerationPlanRequest = {
  fieldId: string;
  paddockId: string;
  count: number;
  bearingDegrees: number;
};

export type PaddockCellGenerationCommitRequest = PaddockCellGenerationPlanRequest & {
  operationId: string;
  requestHash: string;
  expectedSnapshotToken: string;
};

export type PaddockCellCloseRequest = {
  fieldId: string;
  paddockId: string;
  operationId: string;
  expectedSnapshotToken: string;
};

export type PaddockCellOperationRequest = PaddockCellGenerationCommitRequest | PaddockCellCloseRequest;

export type PaddockCellPreviewCell = {
  id: string;
  name: string;
  index: number;
  coordinates: Coordinate[];
  geometry: PolygonRings;
  areaSquareMeters: number;
  startDistanceMeters: number;
  endDistanceMeters: number;
};

export type PaddockCellGenerationPreview = {
  fieldId: string;
  paddockId: string;
  paddockName: string;
  count: number;
  bearingDegrees: number;
  stripWidthMeters: number;
  sourceAreaSquareMeters: number;
  cellsAreaSquareMeters: number;
  areaDeltaSquareMeters: number;
  areaToleranceSquareMeters: number;
  requestHash: string;
  snapshotToken: string;
  cells: PaddockCellPreviewCell[];
};

export type PaddockCellOperationResult = {
  operationId: string;
  kind: PaddockCellOperationKind;
  fieldId: string;
  paddockId: string;
  requestHash: string;
  snapshotToken: string;
  activeCells: PaddockCell[];
  closedCells: PaddockCell[];
  committedAt: string;
  idempotentReplay: boolean;
};

export type PaddockCellListing = {
  fieldId: string;
  paddockId: string;
  snapshotToken: string;
  active: PaddockCell[];
  history: PaddockCell[];
};

export type FieldActivePaddockCellListing = {
  fieldId: string;
  snapshotToken: string;
  active: PaddockCell[];
};

export type PaddockRotationSettings = {
  fieldId: string;
  recentDays: number;
  longRestDays: number;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PaddockRotationSettingsUpdateRequest = {
  fieldId: string;
  operationId: string;
  recentDays: number;
  longRestDays: number;
  expectedVersion: number | null;
};

export type PaddockRotationSettingsOperationResult = {
  operationId: string;
  requestHash: string;
  settings: PaddockRotationSettings;
  idempotentReplay: boolean;
};

export type PaddockRotationEffectiveStatus = "occupied" | "rest";

export type PaddockRotationEntry = RankedRotationEvaluation & {
  effectiveStatus: PaddockRotationEffectiveStatus;
  statusSource: "assigned_lots" | "grazing_history" | "no_grazing_history";
  manualOverride: null;
};

export type PaddockRotationSnapshot = {
  fieldId: string;
  referenceDate: string;
  snapshotToken: string;
  settings: PaddockRotationSettings;
  paddocks: PaddockRotationEntry[];
  readyPaddocks: PaddockRotationEntry[];
  banner: string;
  counts: Record<RotationClass, number>;
  sources: {
    grazingActivitiesOnly: true;
    activeAssignedLotsOnly: true;
    manualOverrideSupported: false;
  };
};
