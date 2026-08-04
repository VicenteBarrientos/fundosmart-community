import type {
  GisCanonicalLandmarkCandidate,
  GisCanonicalImportPolygon,
  GisImportCommitPlan,
} from "../../import/mapping";
import type { GisImportPreview } from "../../import/types";
import type { Coordinate } from "../../types";
import type { FieldLandmarkKind, FieldLandmarkUpsertRequest } from "../../domain/field-landmarks";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { FIELD_LANDMARK_KINDS } from "../../domain/field-landmarks.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { fieldLandmarkInputFromImportedGeometry, importedFieldLandmarkIdentity } from "../../utils/field-landmarks.ts";

export const GIS_IMPORT_ACCEPT = ".geojson,.json,.kml,.kmz,.zip,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip";
export const GIS_IMPORT_MAX_FILE_MEBIBYTES = 25;
export const MAX_IMPORT_PREVIEW_RENDER_VERTICES = 25_000;

export type GisBoundaryFile = Pick<File, "arrayBuffer" | "name" | "type">;
export type ImportPersistenceDisposition = "applied" | "queued";

export type ImportLandmarkDraft = Readonly<{
  candidateId: string;
  kind: FieldLandmarkKind;
  name: string;
  notes: string;
}>;

export type ImportPersistenceCallbacks = {
  persistFieldBoundary: (polygon: GisCanonicalImportPolygon) => Promise<ImportPersistenceDisposition>;
  persistPaddock: (polygon: GisCanonicalImportPolygon) => Promise<ImportPersistenceDisposition>;
  persistLandmark: (request: FieldLandmarkUpsertRequest) => Promise<"applied">;
};

export type ImportPersistenceEntry = {
  key: string;
  kind: "field_boundary" | "paddock" | "landmark";
  targetId: string;
  label: string;
  disposition: ImportPersistenceDisposition;
};

export type ImportPersistenceFailure = {
  key: string;
  kind: "field_boundary" | "paddock" | "landmark";
  targetId: string;
  label: string;
  message: string;
};

export type ImportPersistenceState = {
  total: number;
  completed: readonly ImportPersistenceEntry[];
  failure: ImportPersistenceFailure | null;
  complete: boolean;
};

type ImportPersistenceOperation = Pick<ImportPersistenceEntry, "key" | "targetId" | "label"> & (
  | { kind: "field_boundary"; polygon: GisCanonicalImportPolygon }
  | { kind: "paddock"; polygon: GisCanonicalImportPolygon }
  | { kind: "landmark"; request: FieldLandmarkUpsertRequest }
);

export async function parseGisBoundaryFile(file: GisBoundaryFile, fieldId: string): Promise<GisImportPreview> {
  const bytes = await file.arrayBuffer();
  // Keep the parser and its format-specific libraries out of the initial potreros bundle.
  // @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
  const { previewGisImport } = await import("../../import/parser.ts");
  return previewGisImport({ bytes, fileName: file.name, contentType: file.type, fieldId });
}

export function createDefaultImportLandmarkDrafts(plan: GisImportCommitPlan): ImportLandmarkDraft[] {
  return plan.landmarkCandidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    kind: "otro",
    name: candidate.name.trim() || "Hito importado",
    notes: "",
  }));
}

export function importPersistenceOperations(
  plan: GisImportCommitPlan,
  landmarkDrafts: readonly ImportLandmarkDraft[] = [],
): ImportPersistenceOperation[] {
  const draftsByCandidate = new Map(landmarkDrafts.map((draft) => [draft.candidateId, draft]));
  return [
    ...(plan.fieldBoundary ? [{
      key: `field_boundary:${plan.fieldBoundary.id}`,
      kind: "field_boundary" as const,
      targetId: plan.fieldBoundary.id,
      label: `Límite · ${plan.fieldBoundary.name}`,
      polygon: plan.fieldBoundary,
    }] : []),
    ...plan.paddocks.map((polygon) => ({
      key: `paddock:${polygon.id}`,
      kind: "paddock" as const,
      targetId: polygon.id,
      label: `Potrero · ${polygon.name}`,
      polygon,
    })),
    ...plan.landmarkCandidates.map((candidate) => landmarkPersistenceOperation(
      plan.fieldId,
      candidate,
      draftsByCandidate.get(candidate.candidateId),
    )),
  ];
}

export async function executeImportPersistencePlan(
  plan: GisImportCommitPlan,
  callbacks: ImportPersistenceCallbacks,
  previouslyCompleted: readonly ImportPersistenceEntry[] = [],
  onProgress?: (state: ImportPersistenceState) => void,
  landmarkDrafts: readonly ImportLandmarkDraft[] = [],
): Promise<ImportPersistenceState> {
  const operations = importPersistenceOperations(plan, landmarkDrafts);
  const completedByKey = new Map(previouslyCompleted.map((entry) => [entry.key, entry]));
  let completed = operations.flatMap((operation) => {
    const prior = completedByKey.get(operation.key);
    return prior ? [prior] : [];
  });

  for (const operation of operations) {
    if (completedByKey.has(operation.key)) continue;
    try {
      const disposition = operation.kind === "field_boundary"
        ? await callbacks.persistFieldBoundary(operation.polygon)
        : operation.kind === "paddock"
          ? await callbacks.persistPaddock(operation.polygon)
          : await callbacks.persistLandmark(operation.request);
      const entry: ImportPersistenceEntry = {
        key: operation.key,
        kind: operation.kind,
        targetId: operation.targetId,
        label: operation.label,
        disposition,
      };
      completed = [...completed, entry];
      completedByKey.set(entry.key, entry);
      onProgress?.({ total: operations.length, completed, failure: null, complete: false });
    } catch (cause) {
      const state: ImportPersistenceState = {
        total: operations.length,
        completed,
        failure: {
          key: operation.key,
          kind: operation.kind,
          targetId: operation.targetId,
          label: operation.label,
          message: cause instanceof Error ? cause.message : "No fue posible completar esta persistencia.",
        },
        complete: false,
      };
      onProgress?.(state);
      return state;
    }
  }

  const state: ImportPersistenceState = {
    total: operations.length,
    completed,
    failure: null,
    complete: completed.length === operations.length,
  };
  onProgress?.(state);
  return state;
}

export function importCommitUiBlockers(
  plan: GisImportCommitPlan,
  canMutate: boolean,
  networkOnline: boolean,
  landmarkDrafts: readonly ImportLandmarkDraft[] = [],
): string[] {
  const blockers: string[] = [];
  if (!canMutate) blockers.push("Este acceso es de solo lectura: puedes revisar la importación, pero no aplicarla.");
  if (plan.fieldBoundary && !networkOnline) {
    blockers.push("El plan reemplaza el límite del fundo y esa persistencia normal requiere conexión. Los planes que sólo crean potreros sí pueden quedar en cola offline.");
  }
  if (plan.landmarkCandidates.length > 0 && !networkOnline) {
    blockers.push("Los hitos importados requieren conexión para confirmar su versión e idempotencia.");
  }
  const draftErrors = importLandmarkDraftErrors(plan, landmarkDrafts);
  blockers.push(...draftErrors);
  if (plan.fieldBoundary && plan.fieldBoundary.geometry.holes.length > 0) {
    blockers.push("El límite del fundo contiene huecos, pero el contrato actual del fundo sólo conserva el anillo exterior. Cambia ese polígono a potrero o elimina sus huecos en el archivo para evitar pérdida de geometría.");
  }
  return unique(blockers);
}

export function importLandmarkDraftErrors(
  plan: GisImportCommitPlan,
  drafts: readonly ImportLandmarkDraft[],
): string[] {
  const byCandidate = new Map(drafts.map((draft) => [draft.candidateId, draft]));
  const errors: string[] = [];
  for (const candidate of plan.landmarkCandidates) {
    const draft = byCandidate.get(candidate.candidateId);
    if (!draft) {
      errors.push(`Completa el tipo, nombre y notas del hito ${candidate.name || candidate.candidateId}.`);
      continue;
    }
    if (!FIELD_LANDMARK_KINDS.includes(draft.kind) || !draft.name.trim()) {
      errors.push(`Completa un tipo y nombre válidos para el hito ${candidate.name || candidate.candidateId}.`);
    }
  }
  return unique(errors);
}

function landmarkPersistenceOperation(
  fieldId: string,
  candidate: GisCanonicalLandmarkCandidate,
  draft: ImportLandmarkDraft | undefined,
): ImportPersistenceOperation {
  if (!draft || draft.candidateId !== candidate.candidateId) {
    throw new Error(`Falta la edición explícita del hito ${candidate.name || candidate.candidateId}.`);
  }
  const identity = importedFieldLandmarkIdentity(candidate.candidateId);
  const input = fieldLandmarkInputFromImportedGeometry({
    id: identity.id,
    fieldId,
    kind: draft.kind,
    name: draft.name,
    notes: draft.notes,
    geometry: candidate.geometry,
  });
  return {
    key: `landmark:${candidate.candidateId}`,
    kind: "landmark",
    targetId: input.id,
    label: `Hito · ${input.name}`,
    request: { ...input, expectedVersion: null, operationId: identity.operationId },
  };
}

export function uniqueImportMessages(messages: readonly string[]): string[] {
  return unique(messages.filter(Boolean));
}

export function decimateImportPreviewPath(
  coordinates: readonly Coordinate[],
  maxPoints: number,
): Coordinate[] {
  const limit = Math.max(0, Math.floor(maxPoints));
  if (limit === 0 || coordinates.length === 0) return [];
  if (coordinates.length <= limit) return coordinates.map(cloneCoordinate);
  if (limit === 1) return [cloneCoordinate(coordinates[0])];
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round(index * (coordinates.length - 1) / (limit - 1));
    return cloneCoordinate(coordinates[sourceIndex]);
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}
