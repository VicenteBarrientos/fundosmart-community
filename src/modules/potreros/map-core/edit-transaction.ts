import type { Coordinate } from "../types";
import type {
  MapAdapterSnapshot,
  MapConflict,
  MapDraftSource,
  MapEditCommand,
  MapEditObjective,
  MapEditPhase,
  MapEditPreview,
  MapEditValidation,
  MapGestureCommand,
  MapPolygonDraft,
  MapRingTarget,
  MapSaveFailure,
} from "./interaction-contract";

const DEFAULT_HISTORY_LIMIT = 50;
const EMPTY_VALIDATION: MapEditValidation = Object.freeze({
  errors: Object.freeze([]),
  warnings: Object.freeze([]),
});
const EMPTY_DRAFT: MapPolygonDraft = Object.freeze({
  outer: Object.freeze([]),
  holes: Object.freeze([]),
});

export type MapEditHistoryEntry = Readonly<{
  draft: MapPolygonDraft;
  source: MapDraftSource;
}>;

export type MapEditTransaction = Readonly<{
  id: string;
  fieldId: string;
  objective: MapEditObjective;
  entityIds: readonly string[];
  adapterId: string;
  phase: MapEditPhase;
  baseline: MapPolygonDraft;
  draft: MapPolygonDraft;
  source: MapDraftSource;
  validation: MapEditValidation;
  validationFailure: string | null;
  validatedRevision: number | null;
  preview: MapEditPreview | null;
  saveFailure: MapSaveFailure | null;
  conflict: MapConflict | null;
  canonicalVersion: string | null;
  revision: number;
  dirty: boolean;
  history: Readonly<{
    past: readonly MapEditHistoryEntry[];
    future: readonly MapEditHistoryEntry[];
    limit: number;
  }>;
}>;

export type CreateMapEditTransactionInput = Readonly<{
  id: string;
  fieldId: string;
  objective: MapEditObjective;
  entityIds?: readonly string[];
  adapterId: string;
  initialDraft: MapPolygonDraft;
  baselineDraft?: MapPolygonDraft;
  source?: MapDraftSource;
  canonicalVersion?: string | null;
  historyLimit?: number;
  readOnly?: boolean;
}>;

export type MapEditTransitionError = Readonly<{
  code:
    | "invalid-command"
    | "invalid-draft"
    | "invalid-phase"
    | "validation-failed"
    | "history-empty";
  message: string;
}>;

export type MapEditTransition =
  | Readonly<{ ok: true; transaction: MapEditTransaction }>
  | Readonly<{ ok: false; transaction: MapEditTransaction; error: MapEditTransitionError }>;

export function createMapEditTransaction(input: CreateMapEditTransactionInput): MapEditTransaction {
  if (!input.id.trim()) throw new TypeError("La transacción necesita un identificador.");
  if (!input.fieldId.trim()) throw new TypeError("La transacción necesita un fundo.");
  if (!input.adapterId.trim()) throw new TypeError("La transacción necesita un adapter fijado.");
  const initialDraft = cloneDraft(input.initialDraft);
  const historyLimit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(historyLimit) || historyLimit < 1) {
    throw new RangeError("El límite de historial debe ser un entero positivo.");
  }

  const baseline = cloneDraft(input.baselineDraft ?? EMPTY_DRAFT);
  return freezeTransaction({
    id: input.id,
    fieldId: input.fieldId,
    objective: input.objective,
    entityIds: [...new Set(input.entityIds ?? [])],
    adapterId: input.adapterId,
    phase: input.readOnly ? "read-only" : "draft",
    baseline,
    draft: initialDraft,
    source: input.source ?? "manual",
    validation: EMPTY_VALIDATION,
    validationFailure: null,
    validatedRevision: null,
    preview: null,
    saveFailure: null,
    conflict: null,
    canonicalVersion: input.canonicalVersion ?? null,
    revision: 0,
    dirty: !mapPolygonDraftsEqual(baseline, initialDraft),
    history: { past: [], future: [], limit: historyLimit },
  });
}

export function transitionMapEdit(
  transaction: MapEditTransaction,
  command: MapEditCommand,
): MapEditTransition {
  if (isGestureCommand(command)) return transitionGesture(transaction, command);

  switch (command.type) {
    case "validation-started":
      if (!canEdit(transaction)) {
        return rejected(transaction, "invalid-phase", "No se puede validar en el estado actual.");
      }
      return accepted({
        ...transaction,
        phase: "validating",
        validationFailure: null,
        preview: null,
        saveFailure: null,
        conflict: null,
      });

    case "validation-finished":
      if (transaction.phase !== "validating") {
        return rejected(transaction, "invalid-phase", "La validación no estaba en curso.");
      }
      return accepted({
        ...transaction,
        phase: "draft",
        validation: cloneValidation(command.validation),
        validationFailure: null,
        validatedRevision: transaction.revision,
        preview: null,
        saveFailure: null,
      });

    case "validation-aborted":
      if (transaction.phase !== "validating") {
        return rejected(transaction, "invalid-phase", "La validación no estaba en curso.");
      }
      return accepted({
        ...transaction,
        phase: "draft",
        validation: EMPTY_VALIDATION,
        validationFailure: command.message,
        validatedRevision: null,
        preview: null,
      });

    case "preview-ready":
      if (transaction.phase !== "draft") {
        return rejected(transaction, "invalid-phase", "El resumen previo sólo se crea desde un borrador.");
      }
      if (transaction.validatedRevision !== transaction.revision) {
        return rejected(transaction, "validation-failed", "Valida esta revisión antes de preparar el resumen.");
      }
      if (transaction.validation.errors.length > 0) {
        return rejected(transaction, "validation-failed", "Corrige los errores antes de preparar el resumen.");
      }
      return accepted({
        ...transaction,
        phase: "preview",
        preview: clonePreview(command.preview),
        saveFailure: null,
        conflict: null,
      });

    case "save-started":
      if (transaction.phase !== "preview" || !transaction.preview) {
        return rejected(transaction, "invalid-phase", "Confirma un resumen válido antes de guardar.");
      }
      if (transaction.validation.errors.length > 0) {
        return rejected(transaction, "validation-failed", "No se puede guardar un borrador inválido.");
      }
      return accepted({
        ...transaction,
        phase: "saving",
        saveFailure: null,
        conflict: null,
      });

    case "save-failed":
      if (transaction.phase !== "saving") {
        return rejected(transaction, "invalid-phase", "No existe un guardado que pueda fallar.");
      }
      return accepted({
        ...transaction,
        phase: "save-error",
        saveFailure: Object.freeze({ ...command.failure }),
      });

    case "retry-save":
      if (transaction.phase !== "save-error" || !transaction.saveFailure?.retryable) {
        return rejected(transaction, "invalid-phase", "El guardado no admite un reintento.");
      }
      if (transaction.saveFailure.canonicalStateUnknown) {
        return rejected(transaction, "invalid-phase", "Relee el estado canónico antes de reintentar.");
      }
      return accepted({
        ...transaction,
        phase: "saving",
        saveFailure: null,
      });

    case "sync-deferred":
      if (transaction.phase !== "saving") {
        return rejected(transaction, "invalid-phase", "Sólo un guardado en curso puede quedar pendiente.");
      }
      return accepted({ ...transaction, phase: "pending-sync" });

    case "conflict-detected":
      if (transaction.phase !== "saving" && transaction.phase !== "pending-sync") {
        return rejected(transaction, "invalid-phase", "El conflicto no pertenece a un guardado activo.");
      }
      return accepted({
        ...transaction,
        phase: "conflict",
        saveFailure: null,
        conflict: { ...command.conflict },
      });

    case "conflict-resolved": {
      if (transaction.phase !== "conflict") {
        return rejected(transaction, "invalid-phase", "No existe un conflicto que reanudar.");
      }
      const baseline = cloneDraft(command.canonicalDraft);
      const draft = cloneDraft(command.resolvedDraft);
      return accepted({
        ...transaction,
        phase: "draft",
        baseline,
        draft,
        source: "recovery",
        validation: EMPTY_VALIDATION,
        validationFailure: null,
        validatedRevision: null,
        preview: null,
        saveFailure: null,
        conflict: null,
        canonicalVersion: command.canonicalVersion,
        revision: transaction.revision + 1,
        dirty: !mapPolygonDraftsEqual(baseline, draft),
        history: { ...transaction.history, past: [], future: [] },
      });
    }

    case "canonical-reconciled": {
      if (
        transaction.phase !== "save-error"
        || !transaction.saveFailure?.canonicalStateUnknown
      ) {
        return rejected(transaction, "invalid-phase", "No existe un resultado incierto que reconciliar.");
      }
      if (command.outcome === "not-applied") {
        return accepted({
          ...transaction,
          phase: "save-error",
          saveFailure: Object.freeze({
            ...transaction.saveFailure,
            canonicalStateUnknown: false,
          }),
        });
      }
      return accepted(finalizeCanonical(
        transaction,
        command.draft,
        command.canonicalVersion,
      ));
    }

    case "canonical-reloaded": {
      if (
        transaction.phase !== "saving"
        && transaction.phase !== "pending-sync"
        && transaction.phase !== "conflict"
      ) {
        return rejected(transaction, "invalid-phase", "La relectura canónica no corresponde al estado actual.");
      }
      return accepted(finalizeCanonical(
        transaction,
        command.draft,
        command.canonicalVersion,
      ));
    }

    case "cancel":
      if (
        transaction.phase === "saved"
        || transaction.phase === "cancelled"
        || transaction.phase === "saving"
        || transaction.phase === "pending-sync"
        || (
          transaction.phase === "save-error"
          && transaction.saveFailure?.canonicalStateUnknown
        )
      ) {
        return rejected(
          transaction,
          "invalid-phase",
          "La transacción debe reconciliar el resultado canónico antes de terminar.",
        );
      }
      return accepted({
        ...transaction,
        phase: "cancelled",
        preview: null,
        saveFailure: null,
        conflict: null,
        history: { ...transaction.history, past: [], future: [] },
      });
  }
}

function finalizeCanonical(
  transaction: MapEditTransaction,
  draft: MapPolygonDraft,
  canonicalVersion: string,
): MapEditTransaction {
  const canonicalDraft = cloneDraft(draft);
  return {
    ...transaction,
    phase: "saved",
    baseline: cloneDraft(canonicalDraft),
    draft: canonicalDraft,
    source: "canonical",
    validation: EMPTY_VALIDATION,
    validationFailure: null,
    validatedRevision: null,
    preview: null,
    saveFailure: null,
    conflict: null,
    canonicalVersion,
    revision: transaction.revision + 1,
    dirty: false,
    history: { ...transaction.history, past: [], future: [] },
  };
}

export function mapAdapterSnapshot(transaction: MapEditTransaction): MapAdapterSnapshot {
  return {
    transactionId: transaction.id,
    objective: transaction.objective,
    phase: transaction.phase,
    revision: transaction.revision,
    draft: cloneDraft(transaction.draft),
  };
}

export function mapPolygonDraftsEqual(first: MapPolygonDraft, second: MapPolygonDraft): boolean {
  return ringsEqual(first.outer, second.outer)
    && first.holes.length === second.holes.length
    && first.holes.every((hole, index) => ringsEqual(hole, second.holes[index]));
}

export function mapEditCanUndo(transaction: MapEditTransaction): boolean {
  return canEdit(transaction) && transaction.history.past.length > 0;
}

export function mapEditCanRedo(transaction: MapEditTransaction): boolean {
  return canEdit(transaction) && transaction.history.future.length > 0;
}

function transitionGesture(
  transaction: MapEditTransaction,
  command: MapGestureCommand,
): MapEditTransition {
  if (!canEdit(transaction)) {
    return rejected(transaction, "invalid-phase", "El adapter no puede modificar el borrador en el estado actual.");
  }

  if (command.type === "undo") return undo(transaction);
  if (command.type === "redo") return redo(transaction);

  const nextDraftResult = applyDraftCommand(transaction.draft, command);
  if (!nextDraftResult.ok) return rejected(transaction, "invalid-draft", nextDraftResult.message);
  if (mapPolygonDraftsEqual(transaction.draft, nextDraftResult.draft)) return accepted(transaction);

  const past = [...transaction.history.past, historyEntry(transaction)]
    .slice(-transaction.history.limit);
  const nextDraft = cloneDraft(nextDraftResult.draft);
  return accepted({
    ...transaction,
    phase: "draft",
    draft: nextDraft,
    source: command.source,
    validation: EMPTY_VALIDATION,
    validationFailure: null,
    validatedRevision: null,
    preview: null,
    saveFailure: null,
    conflict: null,
    revision: transaction.revision + 1,
    dirty: !mapPolygonDraftsEqual(transaction.baseline, nextDraft),
    history: { ...transaction.history, past, future: [] },
  });
}

function undo(transaction: MapEditTransaction): MapEditTransition {
  const previous = transaction.history.past.at(-1);
  if (!previous) return rejected(transaction, "history-empty", "No hay un cambio anterior.");
  const draft = cloneDraft(previous.draft);
  return accepted({
    ...transaction,
    phase: "draft",
    draft,
    source: previous.source,
    validation: EMPTY_VALIDATION,
    validationFailure: null,
    validatedRevision: null,
    preview: null,
    saveFailure: null,
    conflict: null,
    revision: transaction.revision + 1,
    dirty: !mapPolygonDraftsEqual(transaction.baseline, draft),
    history: {
      ...transaction.history,
      past: transaction.history.past.slice(0, -1),
      future: [...transaction.history.future, historyEntry(transaction)]
        .slice(-transaction.history.limit),
    },
  });
}

function redo(transaction: MapEditTransaction): MapEditTransition {
  const next = transaction.history.future.at(-1);
  if (!next) return rejected(transaction, "history-empty", "No hay un cambio para rehacer.");
  const draft = cloneDraft(next.draft);
  return accepted({
    ...transaction,
    phase: "draft",
    draft,
    source: next.source,
    validation: EMPTY_VALIDATION,
    validationFailure: null,
    validatedRevision: null,
    preview: null,
    saveFailure: null,
    conflict: null,
    revision: transaction.revision + 1,
    dirty: !mapPolygonDraftsEqual(transaction.baseline, draft),
    history: {
      ...transaction.history,
      past: [...transaction.history.past, historyEntry(transaction)]
        .slice(-transaction.history.limit),
      future: transaction.history.future.slice(0, -1),
    },
  });
}

type DraftCommandResult =
  | Readonly<{ ok: true; draft: MapPolygonDraft }>
  | Readonly<{ ok: false; message: string }>;

function applyDraftCommand(
  current: MapPolygonDraft,
  command: Exclude<MapGestureCommand, { type: "undo" | "redo" }>,
): DraftCommandResult {
  if (command.type === "replace-draft") return { ok: true, draft: cloneDraft(command.draft) };
  const ring = readRing(current, command.target);
  if (!ring) return { ok: false, message: "El anillo solicitado no existe." };

  if (command.type === "append-vertex") {
    return { ok: true, draft: writeRing(current, command.target, [...ring, cloneCoordinate(command.coordinate)]) };
  }
  if (command.type === "insert-vertex") {
    if (command.edgeIndex < 0 || command.edgeIndex >= ring.length) {
      return { ok: false, message: "La arista solicitada no existe." };
    }
    return {
      ok: true,
      draft: writeRing(current, command.target, [
        ...ring.slice(0, command.edgeIndex + 1),
        cloneCoordinate(command.coordinate),
        ...ring.slice(command.edgeIndex + 1),
      ]),
    };
  }
  if (command.type === "move-vertex") {
    if (!ring[command.vertexIndex]) return { ok: false, message: "El vértice solicitado no existe." };
    return {
      ok: true,
      draft: writeRing(
        current,
        command.target,
        ring.map((coordinate, index) => (
          index === command.vertexIndex ? cloneCoordinate(command.coordinate) : cloneCoordinate(coordinate)
        )),
      ),
    };
  }
  if (!ring[command.vertexIndex]) return { ok: false, message: "El vértice solicitado no existe." };
  if (ring.length <= 3) return { ok: false, message: "Un anillo necesita al menos tres vértices." };
  return {
    ok: true,
    draft: writeRing(
      current,
      command.target,
      ring.filter((_, index) => index !== command.vertexIndex),
    ),
  };
}

function readRing(draft: MapPolygonDraft, target: MapRingTarget): readonly Coordinate[] | null {
  return target.kind === "outer" ? draft.outer : draft.holes[target.index] ?? null;
}

function writeRing(
  draft: MapPolygonDraft,
  target: MapRingTarget,
  ring: Coordinate[],
): MapPolygonDraft {
  if (target.kind === "outer") return { outer: cloneRing(ring), holes: draft.holes.map(cloneRing) };
  return {
    outer: cloneRing(draft.outer),
    holes: draft.holes.map((hole, index) => index === target.index ? cloneRing(ring) : cloneRing(hole)),
  };
}

function isGestureCommand(command: MapEditCommand): command is MapGestureCommand {
  return [
    "replace-draft",
    "append-vertex",
    "insert-vertex",
    "move-vertex",
    "remove-vertex",
    "undo",
    "redo",
  ].includes(command.type);
}

function canEdit(transaction: MapEditTransaction): boolean {
  return transaction.phase === "draft"
    || transaction.phase === "preview"
    || (
      transaction.phase === "save-error"
      && !transaction.saveFailure?.canonicalStateUnknown
    );
}

function accepted(transaction: MapEditTransaction): MapEditTransition {
  return { ok: true, transaction: freezeTransaction(transaction) };
}

function rejected(
  transaction: MapEditTransaction,
  code: MapEditTransitionError["code"],
  message: string,
): MapEditTransition {
  return { ok: false, transaction, error: { code, message } };
}

function cloneDraft(draft: MapPolygonDraft): MapPolygonDraft {
  return Object.freeze({
    outer: freezeRing(draft.outer),
    holes: Object.freeze(draft.holes.map(freezeRing)),
  });
}

function cloneRing(ring: readonly Coordinate[]): Coordinate[] {
  return ring.map(cloneCoordinate);
}

function freezeRing(ring: readonly Coordinate[]): readonly Coordinate[] {
  return Object.freeze(ring.map(([latitude, longitude]) => (
    Object.freeze([latitude, longitude]) as Coordinate
  )));
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}

function ringsEqual(first: readonly Coordinate[], second: readonly Coordinate[]): boolean {
  return first.length === second.length && first.every((coordinate, index) => (
    coordinate[0] === second[index]?.[0] && coordinate[1] === second[index]?.[1]
  ));
}

function cloneValidation(validation: MapEditValidation): MapEditValidation {
  return Object.freeze({
    errors: Object.freeze([...validation.errors]),
    warnings: Object.freeze([...validation.warnings]),
  });
}

function clonePreview(preview: MapEditPreview): MapEditPreview {
  return Object.freeze({
    ...preview,
    affectedEntityIds: Object.freeze([...preview.affectedEntityIds]),
    warnings: Object.freeze([...preview.warnings]),
  });
}

function historyEntry(transaction: MapEditTransaction): MapEditHistoryEntry {
  return Object.freeze({
    draft: cloneDraft(transaction.draft),
    source: transaction.source,
  });
}

function freezeTransaction(transaction: MapEditTransaction): MapEditTransaction {
  if (Object.isFrozen(transaction)) return transaction;
  Object.freeze(transaction.entityIds);
  Object.freeze(transaction.history.past);
  Object.freeze(transaction.history.future);
  Object.freeze(transaction.history);
  if (transaction.conflict && !Object.isFrozen(transaction.conflict)) Object.freeze(transaction.conflict);
  if (transaction.saveFailure && !Object.isFrozen(transaction.saveFailure)) Object.freeze(transaction.saveFailure);
  return Object.freeze(transaction);
}
