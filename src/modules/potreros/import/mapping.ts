import type { Coordinate, ExclusionKind, PolygonRings, StoredPolygon } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateAreaSquareMeters, containsPolygon } from "../utils/geometry.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { decodeStoredPolygon, EXCLUSION_KINDS, polygonRingsValidationErrors } from "../utils/polygon-rings.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { validatePotreroGeometry } from "../utils/validate.ts";
import type {
  GisImportPreview,
  GisPreviewCategory,
  GisPreviewFeature,
  ImportedLineString,
  ImportedPoint,
  JsonScalar,
} from "./types";

export type GisPolygonImportRole = "field_boundary" | "paddock" | "ignore";
export type GisLandmarkImportRole = "landmark_candidate" | "ignore";
export type GisImportMappingRole = GisPolygonImportRole | GisLandmarkImportRole;

export type GisImportMappingContext = {
  currentFieldBoundary?: StoredPolygon | null;
  existingPaddockBoundaries?: readonly StoredPolygon[];
};

export type GisImportMappingContextSnapshot = {
  currentFieldBoundary: PolygonRings | null;
  existingPaddockBoundaries: readonly PolygonRings[];
};

type GisImportMappedFeatureBase = {
  planFeatureId: string;
  targetId: string;
  previewFeatureId: string;
  sourceIndex: number;
  partIndex: number | null;
  sourceId: string | null;
  sourceCategory: GisPreviewCategory;
  name: string;
  sector: string;
  properties: Readonly<Record<string, JsonScalar>>;
  sourceErrors: readonly string[];
  sourceWarnings: readonly string[];
  sourceCommitBlockers: readonly string[];
  errors: readonly string[];
  warnings: readonly string[];
  blockers: readonly string[];
  confirmable: boolean;
};

export type GisImportPolygonMapping = GisImportMappedFeatureBase & {
  kind: "polygon";
  role: GisPolygonImportRole;
  geometry: PolygonRings;
  holeKinds: readonly (ExclusionKind | null)[];
  sourceAreaSquareMeters: number | null;
  areaSquareMeters: number;
};

export type GisImportLandmarkMapping = GisImportMappedFeatureBase & {
  kind: "landmark";
  role: GisLandmarkImportRole;
  geometry: ImportedPoint | ImportedLineString;
};

export type GisImportUnsupportedMapping = GisImportMappedFeatureBase & {
  kind: "unsupported";
  role: "ignore";
  geometry: null;
};

export type GisImportMappedFeature =
  | GisImportPolygonMapping
  | GisImportLandmarkMapping
  | GisImportUnsupportedMapping;

export type GisBoundaryHeuristicStatus = "unique_container" | "ambiguous" | "not_found" | "insufficient";

export type GisBoundaryHeuristic = {
  status: GisBoundaryHeuristicStatus;
  boundaryPlanFeatureId: string | null;
  candidatePlanFeatureIds: readonly string[];
};

export type GisImportMappingSummary = {
  totalFeatures: number;
  polygonFeatures: number;
  fieldBoundaries: number;
  paddocks: number;
  landmarkCandidates: number;
  ignored: number;
  polygonsWithHoles: number;
  unclassifiedHoles: number;
  blockingFeatures: number;
  warningFeatures: number;
};

export type GisImportMappingPlan = {
  planId: string;
  importPreviewId: string;
  fieldId: string;
  fileName: string;
  fileSha256: string;
  parserVersion: string;
  revision: number;
  context: GisImportMappingContextSnapshot;
  heuristic: GisBoundaryHeuristic;
  previewWarnings: readonly string[];
  features: readonly GisImportMappedFeature[];
  effectiveBoundarySource: "imported" | "current" | null;
  effectiveBoundaryPlanFeatureId: string | null;
  globalBlockers: readonly string[];
  globalWarnings: readonly string[];
  summary: GisImportMappingSummary;
  canCommit: boolean;
};

export type GisImportFeaturePatch = {
  name?: string;
  sector?: string;
  role?: GisImportMappingRole;
  holeKinds?: readonly (ExclusionKind | null)[];
};

export type GisCanonicalImportPolygon = {
  id: string;
  planFeatureId: string;
  previewFeatureId: string;
  name: string;
  sector: string;
  geometry: PolygonRings;
  holeKinds: readonly ExclusionKind[];
  sourceAreaSquareMeters: number | null;
  areaSquareMeters: number;
};

export type GisCanonicalLandmarkCandidate = {
  candidateId: string;
  planFeatureId: string;
  previewFeatureId: string;
  name: string;
  sector: string;
  geometry: ImportedPoint | ImportedLineString;
  properties: Readonly<Record<string, JsonScalar>>;
};

export type GisImportCommitPlan = {
  planId: string;
  importPreviewId: string;
  fieldId: string;
  fileSha256: string;
  fieldBoundary: GisCanonicalImportPolygon | null;
  paddocks: readonly GisCanonicalImportPolygon[];
  landmarkCandidates: readonly GisCanonicalLandmarkCandidate[];
  validationBoundary: {
    source: "imported" | "current";
    geometry: PolygonRings;
  };
  warnings: readonly string[];
  summary: GisImportMappingSummary;
};

export type GisImportCommitBuild =
  | {
      ok: true;
      plan: GisImportCommitPlan;
    }
  | {
      ok: false;
      planId: string;
      blockers: readonly string[];
      warnings: readonly string[];
      summary: GisImportMappingSummary;
    };

type GisImportMappingPlanSource = Omit<
  GisImportMappingPlan,
  "features" | "effectiveBoundarySource" | "effectiveBoundaryPlanFeatureId" | "globalBlockers" | "globalWarnings" | "summary" | "canCommit"
> & {
  features: readonly GisImportMappedFeature[];
};

const MAX_EDITABLE_TEXT_CODE_POINTS = 120;
const MAXIMUM_ROUND_TRIP_AREA_DELTA_RATIO = 0.001;

export function createGisImportMappingPlan(
  preview: GisImportPreview,
  context: GisImportMappingContext = {},
): GisImportMappingPlan {
  const mappedFeatures = preview.features.map((feature, index) => mapPreviewFeature(preview, feature, index));
  const heuristic = inferFieldBoundary(mappedFeatures);
  const features = mappedFeatures.map((feature) => (
    feature.kind === "polygon" && feature.planFeatureId === heuristic.boundaryPlanFeatureId
      ? { ...feature, role: "field_boundary" as const }
      : feature
  ));
  return evaluatePlan({
    planId: `gis-plan:${encodeIdentityPart(preview.importPreviewId)}`,
    importPreviewId: preview.importPreviewId,
    fieldId: preview.fieldId,
    fileName: preview.fileName,
    fileSha256: preview.fileSha256,
    parserVersion: preview.parserVersion,
    revision: 0,
    context: normalizeContext(context),
    heuristic,
    previewWarnings: unique(preview.warnings),
    features,
  });
}

export function updateGisImportMappingFeature(
  plan: GisImportMappingPlan,
  planFeatureId: string,
  patch: GisImportFeaturePatch,
): GisImportMappingPlan {
  let found = false;
  const features = plan.features.map((feature) => {
    if (feature.planFeatureId !== planFeatureId) return feature;
    found = true;
    return patchMappedFeature(feature, patch);
  });
  if (!found) throw new RangeError("La feature seleccionada no pertenece al plan de importación.");
  return evaluatePlan(sourceFromPlan(plan, features, plan.revision + 1));
}

export function setGisImportHoleKind(
  plan: GisImportMappingPlan,
  planFeatureId: string,
  holeIndex: number,
  kind: ExclusionKind | null,
): GisImportMappingPlan {
  const feature = plan.features.find((candidate) => candidate.planFeatureId === planFeatureId);
  if (!feature || feature.kind !== "polygon") {
    throw new RangeError("La feature seleccionada no es un polígono del plan.");
  }
  if (!Number.isInteger(holeIndex) || holeIndex < 0 || holeIndex >= feature.geometry.holes.length) {
    throw new RangeError("El hueco seleccionado no existe.");
  }
  if (kind !== null && !EXCLUSION_KINDS.includes(kind)) {
    throw new RangeError("El tipo de exclusión no es válido.");
  }
  const holeKinds = feature.holeKinds.map((current, index) => index === holeIndex ? kind : current);
  return updateGisImportMappingFeature(plan, planFeatureId, { holeKinds });
}

export function withGisImportMappingContext(
  plan: GisImportMappingPlan,
  context: GisImportMappingContext,
): GisImportMappingPlan {
  return evaluatePlan({
    ...sourceFromPlan(plan, plan.features, plan.revision + 1),
    context: normalizeContext(context),
  });
}

export function buildGisImportCommitPlan(plan: GisImportMappingPlan): GisImportCommitBuild {
  const warnings = unique([
    ...plan.globalWarnings,
    ...plan.features.flatMap((feature) => feature.warnings),
  ]);
  if (!plan.canCommit) {
    return {
      ok: false,
      planId: plan.planId,
      blockers: [...plan.globalBlockers],
      warnings,
      summary: { ...plan.summary },
    };
  }

  const fieldBoundaryFeature = plan.features.find(isActiveFieldBoundary) ?? null;
  const fieldBoundary = fieldBoundaryFeature ? canonicalPolygon(fieldBoundaryFeature) : null;
  const paddocks = plan.features.filter(isActivePaddock).map(canonicalPolygon);
  const landmarkCandidates = plan.features.filter(isLandmarkCandidate).map((feature) => ({
    candidateId: feature.targetId,
    planFeatureId: feature.planFeatureId,
    previewFeatureId: feature.previewFeatureId,
    name: feature.name,
    sector: feature.sector,
    geometry: cloneLandmarkGeometry(feature.geometry),
    properties: cloneProperties(feature.properties),
  }));
  const validationBoundary = fieldBoundary
    ? { source: "imported" as const, geometry: cloneRings(fieldBoundary.geometry) }
    : plan.context.currentFieldBoundary
      ? { source: "current" as const, geometry: cloneRings(plan.context.currentFieldBoundary) }
      : null;
  if (!validationBoundary) throw new Error("El plan confirmable perdió su límite de validación.");

  return {
    ok: true,
    plan: {
      planId: plan.planId,
      importPreviewId: plan.importPreviewId,
      fieldId: plan.fieldId,
      fileSha256: plan.fileSha256,
      fieldBoundary,
      paddocks,
      landmarkCandidates,
      validationBoundary,
      warnings,
      summary: { ...plan.summary },
    },
  };
}

function mapPreviewFeature(
  preview: GisImportPreview,
  feature: GisPreviewFeature,
  index: number,
): GisImportMappedFeature {
  const identity = featureIdentity(preview, feature, index);
  const shared = {
    planFeatureId: `gis-map:${identity}`,
    targetId: `gis-import:${identity}`,
    previewFeatureId: feature.previewFeatureId,
    sourceIndex: feature.sourceIndex,
    partIndex: feature.partIndex,
    sourceId: feature.sourceId,
    sourceCategory: feature.category,
    name: normalizeEditableText(feature.name),
    sector: initialSector(feature.properties),
    properties: cloneProperties(feature.properties),
    sourceErrors: unique(feature.errors),
    sourceWarnings: unique(feature.warnings),
    sourceCommitBlockers: unique(feature.commitBlockers),
    errors: [] as string[],
    warnings: [] as string[],
    blockers: [] as string[],
    confirmable: false,
  };

  if (feature.geometry?.type === "Polygon") {
    const geometry = {
      outer: cloneRing(feature.geometry.outer),
      holes: feature.geometry.holes.map(cloneRing),
    };
    return {
      ...shared,
      kind: "polygon",
      role: "paddock",
      geometry,
      holeKinds: geometry.holes.map(() => null),
      sourceAreaSquareMeters: feature.areaSquareMeters,
      areaSquareMeters: safeArea(geometry),
    };
  }
  if (feature.geometry?.type === "Point" || feature.geometry?.type === "LineString") {
    return {
      ...shared,
      kind: "landmark",
      role: "landmark_candidate",
      geometry: cloneLandmarkGeometry(feature.geometry),
    };
  }
  return { ...shared, kind: "unsupported", role: "ignore", geometry: null };
}

function inferFieldBoundary(features: readonly GisImportMappedFeature[]): GisBoundaryHeuristic {
  const polygons = features.filter((feature): feature is GisImportPolygonMapping => (
    feature.kind === "polygon" && polygonRingsValidationErrors(feature.geometry).length === 0
  ));
  if (polygons.length < 2) {
    return { status: "insufficient", boundaryPlanFeatureId: null, candidatePlanFeatureIds: [] };
  }
  const candidates = polygons.filter((candidate) => polygons.every((other) => (
    candidate.planFeatureId === other.planFeatureId || containsPolygon(candidate.geometry, other.geometry)
  )));
  if (candidates.length === 1) {
    return {
      status: "unique_container",
      boundaryPlanFeatureId: candidates[0].planFeatureId,
      candidatePlanFeatureIds: [candidates[0].planFeatureId],
    };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      boundaryPlanFeatureId: null,
      candidatePlanFeatureIds: candidates.map((candidate) => candidate.planFeatureId),
    };
  }
  return { status: "not_found", boundaryPlanFeatureId: null, candidatePlanFeatureIds: [] };
}

function patchMappedFeature(feature: GisImportMappedFeature, patch: GisImportFeaturePatch): GisImportMappedFeature {
  const name = "name" in patch ? editablePatchText(patch.name, "El nombre") : feature.name;
  const sector = "sector" in patch ? editablePatchText(patch.sector, "El sector") : feature.sector;
  const role = "role" in patch ? validatePatchedRole(feature, patch.role) : feature.role;

  if (feature.kind === "polygon") {
    const holeKinds = "holeKinds" in patch ? validateHoleKindsPatch(feature, patch.holeKinds) : [...feature.holeKinds];
    return { ...feature, name, sector, role: role as GisPolygonImportRole, holeKinds };
  }
  if ("holeKinds" in patch) throw new RangeError("Sólo los polígonos pueden clasificar huecos.");
  if (feature.kind === "landmark") {
    return { ...feature, name, sector, role: role as GisLandmarkImportRole };
  }
  return { ...feature, name, sector, role: "ignore" };
}

function validatePatchedRole(feature: GisImportMappedFeature, role: GisImportMappingRole | undefined): GisImportMappingRole {
  if (feature.kind === "polygon" && (role === "field_boundary" || role === "paddock" || role === "ignore")) return role;
  if (feature.kind === "landmark" && (role === "landmark_candidate" || role === "ignore")) return role;
  if (feature.kind === "unsupported" && role === "ignore") return role;
  throw new RangeError("El rol no corresponde al tipo de geometría seleccionado.");
}

function validateHoleKindsPatch(
  feature: GisImportPolygonMapping,
  values: readonly (ExclusionKind | null)[] | undefined,
): (ExclusionKind | null)[] {
  if (!values || values.length !== feature.geometry.holes.length) {
    throw new RangeError("Debe existir una clasificación por cada hueco del polígono.");
  }
  if (values.some((value) => value !== null && !EXCLUSION_KINDS.includes(value))) {
    throw new RangeError("Uno de los tipos de exclusión no es válido.");
  }
  return [...values];
}

function evaluatePlan(source: GisImportMappingPlanSource): GisImportMappingPlan {
  const fieldBoundaries = source.features.filter(isActiveFieldBoundary);
  const paddocks = source.features.filter(isActivePaddock);
  const importedBoundary = fieldBoundaries.length === 1 && polygonRingsValidationErrors(fieldBoundaries[0].geometry).length === 0
    ? fieldBoundaries[0]
    : null;
  const effectiveBoundary = importedBoundary?.geometry ?? (fieldBoundaries.length === 0 ? source.context.currentFieldBoundary : null);
  const importedSiblingOuters = paddocks
    .filter((feature) => polygonRingsValidationErrors(feature.geometry).length === 0)
    .map((feature) => ({ id: feature.planFeatureId, outer: feature.geometry.outer }));
  const existingSiblingOuters = source.context.existingPaddockBoundaries.map((geometry) => geometry.outer);

  const features = source.features.map((feature) => validateMappedFeature(
    feature,
    fieldBoundaries.length,
    effectiveBoundary?.outer ?? [],
    importedSiblingOuters,
    existingSiblingOuters,
  ));
  const validatedPaddocks = features.filter(isActivePaddock);
  const validatedFieldBoundaries = features.filter(isActiveFieldBoundary);
  const globalBlockers: string[] = [];
  if (validatedFieldBoundaries.length > 1) {
    globalBlockers.push("El plan puede seleccionar como máximo un límite del fundo.");
  }
  if (validatedPaddocks.length === 0) {
    globalBlockers.push("Selecciona al menos un polígono con rol de potrero.");
  }
  if (validatedPaddocks.length > 0 && !effectiveBoundary) {
    globalBlockers.push("Selecciona un único límite importado o proporciona el límite actual del fundo.");
  }
  features.forEach((feature) => {
    if (feature.blockers.length === 0) return;
    feature.blockers.forEach((blocker) => globalBlockers.push(`${feature.name || feature.previewFeatureId}: ${blocker}`));
  });
  const globalWarnings = unique([
    ...source.previewWarnings,
    ...heuristicWarnings(source.heuristic),
  ]);
  const summary = summarize(features);
  return {
    ...source,
    features,
    effectiveBoundarySource: importedBoundary ? "imported" : effectiveBoundary ? "current" : null,
    effectiveBoundaryPlanFeatureId: importedBoundary?.planFeatureId ?? null,
    globalBlockers: unique(globalBlockers),
    globalWarnings,
    summary,
    canCommit: globalBlockers.length === 0,
  };
}

function validateMappedFeature(
  feature: GisImportMappedFeature,
  fieldBoundaryCount: number,
  effectiveBoundary: Coordinate[],
  importedSiblingOuters: readonly { id: string; outer: Coordinate[] }[],
  existingSiblingOuters: readonly Coordinate[][],
): GisImportMappedFeature {
  if (feature.kind === "unsupported") {
    return {
      ...feature,
      errors: unique(feature.sourceErrors),
      warnings: unique(feature.sourceWarnings),
      blockers: [],
      confirmable: true,
    };
  }
  if (feature.kind === "landmark") {
    return {
      ...feature,
      errors: unique(feature.sourceErrors),
      warnings: unique(feature.sourceWarnings),
      blockers: [],
      confirmable: true,
    };
  }

  const ringErrors = polygonRingsValidationErrors(feature.geometry);
  const siblings = feature.role === "paddock"
    ? [
        ...importedSiblingOuters.filter((sibling) => sibling.id !== feature.planFeatureId).map((sibling) => sibling.outer),
        ...existingSiblingOuters,
      ]
    : [];
  const geometryValidation = ringErrors.length === 0 && feature.role !== "ignore"
    ? validatePotreroGeometry(
        feature.geometry.outer,
        siblings,
        feature.role === "field_boundary" ? feature.geometry.outer : effectiveBoundary,
      )
    : { errors: [], warnings: [] };
  const areaSquareMeters = ringErrors.length === 0 ? safeArea(feature.geometry) : 0;
  const errors = unique([...feature.sourceErrors, ...ringErrors, ...geometryValidation.errors]);
  const warnings = unique([...feature.sourceWarnings, ...geometryValidation.warnings]);
  const blockers: string[] = [];
  if (feature.role !== "ignore") {
    blockers.push(...errors);
    blockers.push(...feature.sourceCommitBlockers.filter((blocker) => !/tipo a cada hueco/iu.test(blocker)));
    if (!feature.name) blockers.push("Ingresa un nombre.");
    if (feature.role === "paddock" && !feature.sector) blockers.push("Ingresa un sector.");
    if (feature.role === "field_boundary" && fieldBoundaryCount > 1) {
      blockers.push("Hay más de un polígono marcado como límite del fundo.");
    }
    const unclassifiedHoles = feature.holeKinds.filter((kind) => kind === null).length;
    if (feature.holeKinds.length !== feature.geometry.holes.length) {
      blockers.push("Debe existir una clasificación por cada hueco del polígono.");
    } else if (unclassifiedHoles > 0) {
      blockers.push(`Clasifica ${unclassifiedHoles} ${unclassifiedHoles === 1 ? "hueco" : "huecos"} antes de confirmar.`);
    }
    if (areaRoundTripExceeded(feature.sourceAreaSquareMeters, areaSquareMeters)) {
      blockers.push("La geometría varió más de 0,1 % respecto de la vista previa.");
    }
  }
  return {
    ...feature,
    areaSquareMeters,
    errors,
    warnings,
    blockers: unique(blockers),
    confirmable: blockers.length === 0,
  };
}

function summarize(features: readonly GisImportMappedFeature[]): GisImportMappingSummary {
  const polygons = features.filter((feature): feature is GisImportPolygonMapping => feature.kind === "polygon");
  return {
    totalFeatures: features.length,
    polygonFeatures: polygons.length,
    fieldBoundaries: polygons.filter((feature) => feature.role === "field_boundary").length,
    paddocks: polygons.filter((feature) => feature.role === "paddock").length,
    landmarkCandidates: features.filter(isLandmarkCandidate).length,
    ignored: features.filter((feature) => feature.role === "ignore").length,
    polygonsWithHoles: polygons.filter((feature) => feature.geometry.holes.length > 0).length,
    unclassifiedHoles: polygons
      .filter((feature) => feature.role !== "ignore")
      .reduce((sum, feature) => sum + feature.holeKinds.filter((kind) => kind === null).length, 0),
    blockingFeatures: features.filter((feature) => feature.blockers.length > 0).length,
    warningFeatures: features.filter((feature) => feature.warnings.length > 0).length,
  };
}

function canonicalPolygon(feature: GisImportPolygonMapping): GisCanonicalImportPolygon {
  if (!completeHoleKinds(feature.holeKinds)) throw new Error("El plan confirmable conserva huecos sin clasificar.");
  const geometry = decodeStoredPolygon(feature.geometry);
  return {
    id: feature.targetId,
    planFeatureId: feature.planFeatureId,
    previewFeatureId: feature.previewFeatureId,
    name: feature.name,
    sector: feature.sector,
    geometry,
    holeKinds: [...feature.holeKinds],
    sourceAreaSquareMeters: feature.sourceAreaSquareMeters,
    areaSquareMeters: calculateAreaSquareMeters(geometry),
  };
}

function sourceFromPlan(
  plan: GisImportMappingPlan,
  features: readonly GisImportMappedFeature[],
  revision: number,
): GisImportMappingPlanSource {
  return {
    planId: plan.planId,
    importPreviewId: plan.importPreviewId,
    fieldId: plan.fieldId,
    fileName: plan.fileName,
    fileSha256: plan.fileSha256,
    parserVersion: plan.parserVersion,
    revision,
    context: plan.context,
    heuristic: plan.heuristic,
    previewWarnings: plan.previewWarnings,
    features,
  };
}

function normalizeContext(context: GisImportMappingContext): GisImportMappingContextSnapshot {
  return {
    currentFieldBoundary: context.currentFieldBoundary ? decodeStoredPolygon(context.currentFieldBoundary) : null,
    existingPaddockBoundaries: (context.existingPaddockBoundaries ?? []).map((geometry) => decodeStoredPolygon(geometry)),
  };
}

function initialSector(properties: Record<string, JsonScalar>): string {
  for (const key of ["sector", "Sector", "SECTOR"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return normalizeEditableText(value);
    if (typeof value === "number" && Number.isFinite(value)) return normalizeEditableText(String(value));
  }
  return "";
}

function editablePatchText(value: string | undefined, label: string): string {
  if (typeof value !== "string") throw new RangeError(`${label} debe ser texto.`);
  return normalizeEditableText(value);
}

function normalizeEditableText(value: string): string {
  return [...value.normalize("NFC").trim()].slice(0, MAX_EDITABLE_TEXT_CODE_POINTS).join("");
}

function featureIdentity(preview: GisImportPreview, feature: GisPreviewFeature, index: number): string {
  return [
    preview.importPreviewId,
    feature.previewFeatureId,
    String(feature.sourceIndex),
    feature.partIndex === null ? "root" : String(feature.partIndex),
    String(index),
  ].map(encodeIdentityPart).join(":");
}

function encodeIdentityPart(value: string): string {
  return [...value].map((character) => (
    /^[A-Za-z0-9_-]$/u.test(character)
      ? character
      : `~${(character.codePointAt(0) ?? 0).toString(16)}~`
  )).join("");
}

function cloneProperties(properties: Readonly<Record<string, JsonScalar>>): Record<string, JsonScalar> {
  return Object.fromEntries(Object.entries(properties));
}

function cloneRings(geometry: PolygonRings): PolygonRings {
  return { outer: cloneRing(geometry.outer), holes: geometry.holes.map(cloneRing) };
}

function cloneRing(ring: readonly Coordinate[]): Coordinate[] {
  return ring.map(([latitude, longitude]) => [latitude, longitude]);
}

function cloneLandmarkGeometry(geometry: ImportedPoint | ImportedLineString): ImportedPoint | ImportedLineString {
  return geometry.type === "Point"
    ? { type: "Point", coordinates: [...geometry.coordinates] as Coordinate }
    : { type: "LineString", coordinates: cloneRing(geometry.coordinates) };
}

function safeArea(geometry: PolygonRings): number {
  return polygonRingsValidationErrors(geometry).length === 0 ? calculateAreaSquareMeters(geometry) : 0;
}

function areaRoundTripExceeded(sourceArea: number | null, mappedArea: number): boolean {
  if (sourceArea === null || !Number.isFinite(sourceArea) || sourceArea <= 0 || mappedArea <= 0) return false;
  return Math.abs(mappedArea - sourceArea) / sourceArea > MAXIMUM_ROUND_TRIP_AREA_DELTA_RATIO;
}

function heuristicWarnings(heuristic: GisBoundaryHeuristic): string[] {
  if (heuristic.status === "unique_container") return [];
  if (heuristic.status === "ambiguous") {
    return ["No se infirió el límite del fundo porque más de un polígono contiene a todos los demás."];
  }
  if (heuristic.status === "not_found") {
    return ["No se infirió un límite del fundo: ningún polígono contiene a todos los demás."];
  }
  return ["No hay al menos dos polígonos para inferir un límite del fundo."];
}

function completeHoleKinds(values: readonly (ExclusionKind | null)[]): values is readonly ExclusionKind[] {
  return values.every((value): value is ExclusionKind => value !== null && EXCLUSION_KINDS.includes(value));
}

function isActiveFieldBoundary(feature: GisImportMappedFeature): feature is GisImportPolygonMapping {
  return feature.kind === "polygon" && feature.role === "field_boundary";
}

function isActivePaddock(feature: GisImportMappedFeature): feature is GisImportPolygonMapping {
  return feature.kind === "polygon" && feature.role === "paddock";
}

function isLandmarkCandidate(feature: GisImportMappedFeature): feature is GisImportLandmarkMapping {
  return feature.kind === "landmark" && feature.role === "landmark_candidate";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
