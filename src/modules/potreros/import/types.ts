import type { Coordinate } from "../types";

export type GisImportFormat = "geojson" | "kml" | "kmz" | "shapefile";
export type GisPreviewCategory = "paddock" | "infrastructure_candidate" | "unsupported";
export type JsonScalar = string | number | boolean | null;

export type ImportedPolygon = {
  type: "Polygon";
  outer: Coordinate[];
  holes: Coordinate[][];
};

export type ImportedPoint = {
  type: "Point";
  coordinates: Coordinate;
};

export type ImportedLineString = {
  type: "LineString";
  coordinates: Coordinate[];
};

export type ImportedGeometry = ImportedPolygon | ImportedPoint | ImportedLineString;

export type GisPreviewFeature = {
  previewFeatureId: string;
  sourceIndex: number;
  partIndex: number | null;
  sourceId: string | null;
  name: string;
  properties: Record<string, JsonScalar>;
  category: GisPreviewCategory;
  geometry: ImportedGeometry | null;
  areaSquareMeters: number | null;
  perimeterMeters: number | null;
  vertexCount: number;
  canCommitV1: boolean;
  errors: string[];
  warnings: string[];
  commitBlockers: string[];
};

export type GisImportPreview = {
  importPreviewId: string;
  parserVersion: string;
  fieldId: string;
  fileName: string;
  fileSha256: string;
  format: GisImportFormat;
  compressedBytes: number;
  expandedBytes: number;
  sourceFeatureCount: number;
  previewFeatureCount: number;
  totalRawVertices: number;
  totalPreviewVertices: number;
  features: GisPreviewFeature[];
  warnings: string[];
  limits: {
    maxCompressedFileBytes: number;
    maxArchiveEntries: number;
    maxExpandedArchiveBytes: number;
    maxSourceFeatures: number;
    maxPreviewFeatures: number;
    maxRawVerticesPerRing: number;
    maxRawVerticesTotal: number;
    maxPreviewVerticesPerRing: number;
    maxPreviewVerticesTotal: number;
    simplifyToleranceMeters: number;
  };
};

export type GisImportInput = {
  bytes: ArrayBuffer | Uint8Array;
  fileName: string;
  contentType?: string | null;
  fieldId: string;
};

export class GisImportError extends Error {
  readonly code: string;
  readonly status: 400 | 413 | 415 | 422;

  constructor(
    message: string,
    code: string,
    status: 400 | 413 | 415 | 422 = 422,
  ) {
    super(message);
    this.name = "GisImportError";
    this.code = code;
    this.status = status;
  }
}
