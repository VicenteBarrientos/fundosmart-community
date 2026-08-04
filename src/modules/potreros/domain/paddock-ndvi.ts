import type { ExclusionKind, PaddockArchiveReason, PaddockLandUse, StoredPolygon } from "../types";

export const PADDOCK_NDVI_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const PADDOCK_NDVI_REFRESH_MAX_PADDOCKS = 8;
export const PADDOCK_NDVI_FETCH_CONCURRENCY = 2;

export type PaddockNdviStatus = "ok" | "no_data";
export type PaddockNdviNoDataReason = "no_intervals" | "no_valid_samples";

export type PaddockNdviPaddockSnapshot = Readonly<{
  id: string;
  fieldId: string;
  name: string;
  sector: string;
  areaHectares: number;
  coordinates: StoredPolygon;
  grazeableAreaHectares: number | null;
  landUse: PaddockLandUse;
  holeKinds: ExclusionKind[];
  soilPh: number | null;
  soilNitrogen: number | null;
  soilPhosphorus: number | null;
  soilPotassium: number | null;
  lastActivity: string;
  status: "Disponible" | "En pastoreo" | "En descanso";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  archiveReason: PaddockArchiveReason | null;
  createdByOperationId: string | null;
  archivedByOperationId: string | null;
}>;

export type PaddockNdviValue = Readonly<{
  id: string;
  organizationId: string;
  fieldId: string;
  paddockId: string;
  month: string;
  status: PaddockNdviStatus;
  meanNdvi: number | null;
  noDataReason: PaddockNdviNoDataReason | null;
  cloudPct: number | null;
  cloudPctIsApproximate: boolean;
  interval: Readonly<{ from: string; to: string }>;
  observedAt: string | null;
  sampleCount: number;
  noDataCount: number;
  validSampleCount: number;
  computedAt: string;
  geometrySnapshotToken: string;
}>;

export type PaddockNdviCacheState = "current" | "stale" | "geometry_changed" | "missing";

export type PaddockNdviListingItem = Readonly<{
  paddockId: string;
  paddockName: string;
  cacheState: PaddockNdviCacheState;
  value: PaddockNdviValue | null;
  history: readonly PaddockNdviValue[];
}>;

export type PaddockNdviListing = Readonly<{
  fieldId: string;
  values: PaddockNdviListingItem[];
}>;

export type PaddockNdviRefreshState = "cached" | "refreshed" | "no_data" | "stale" | "unavailable" | "error" | "skipped";

export type PaddockNdviRefreshItem = Readonly<{
  paddockId: string;
  paddockName: string;
  state: PaddockNdviRefreshState;
  stale: boolean;
  value: PaddockNdviValue | null;
  error: Readonly<{ code: string; message: string }> | null;
  retryAfterMs: number | null;
}>;

export type PaddockNdviRefreshSummary = Readonly<{
  total: number;
  cached: number;
  refreshed: number;
  noData: number;
  stale: number;
  unavailable: number;
  errors: number;
  skipped: number;
}>;

export type PaddockNdviRefresh = Readonly<{
  fieldId: string;
  interval: Readonly<{ from: string; to: string }>;
  values: PaddockNdviRefreshItem[];
  summary: PaddockNdviRefreshSummary;
  hasMore: boolean;
  retryAfterMs: number | null;
}>;

export type PaddockNdviRefreshRequest = Readonly<{ fieldId: string }>;
