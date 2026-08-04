import type { Coordinate } from "../types";

export const FIELD_LANDMARK_KINDS = [
  "bebedero",
  "porton",
  "sala_ordena",
  "bodega",
  "manga",
  "cerco_electrico",
  "callejon",
  "linea_agua",
  "otro",
] as const;

export type FieldLandmarkKind = typeof FIELD_LANDMARK_KINDS[number];
export type FieldLandmarkGeometryType = "point" | "line";
export type FieldLandmarkOperationKind = "create" | "update" | "delete";

export type FieldLandmark = {
  id: string;
  fieldId: string;
  kind: FieldLandmarkKind;
  geometryType: FieldLandmarkGeometryType;
  geometry: Coordinate[];
  name: string;
  notes: string;
  lengthMeters: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  lastOperationId: string;
};

export type FieldLandmarkInput = Pick<
  FieldLandmark,
  "id" | "fieldId" | "kind" | "geometryType" | "geometry" | "name" | "notes"
>;

/**
 * Structural match for the normalized Point/LineString shapes produced by the
 * GIS preview. Coordinates already use FundoSmart's [latitude, longitude] order.
 */
export type FieldLandmarkImportedGeometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] };

export type FieldLandmarkImportedInput = Omit<FieldLandmarkInput, "geometryType" | "geometry" | "notes"> & {
  geometry: FieldLandmarkImportedGeometry;
  notes?: string;
};

export type FieldLandmarkUpsertRequest = FieldLandmarkInput & {
  operationId: string;
  expectedVersion: number | null;
};

export type FieldLandmarkDeleteRequest = {
  id: string;
  fieldId: string;
  operationId: string;
  expectedVersion: number;
};

export type FieldLandmarkOperationRequest = FieldLandmarkUpsertRequest | FieldLandmarkDeleteRequest;

export type FieldLandmarkOperationResult = {
  operationId: string;
  kind: FieldLandmarkOperationKind;
  requestHash: string;
  landmark: FieldLandmark;
  committedAt: string;
  idempotentReplay: boolean;
};

export type FieldLandmarkListing = {
  fieldId: string;
  active: FieldLandmark[];
  archived: FieldLandmark[];
};
