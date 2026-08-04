import union from "@turf/union";
import { featureCollection } from "@turf/helpers";
import type { Feature, Polygon } from "geojson";
import type { Coordinate } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateAreaSquareMeters, containsPolygon, fromGeoJsonPolygon, intersectionAreaSquareMeters, selfIntersects, toGeoJsonPolygon } from "./geometry.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { normalizePolygon } from "./subdivide.ts";

export type GeometryOperationKind = "split" | "merge" | "redesign";

export type PaddockGeometry = {
  id: string;
  coordinates: Coordinate[];
};

export type OverlapCell = {
  parentPaddockId: string;
  childPaddockId: string;
  overlapSquareMeters: number;
  parentOverlapRatio: number;
  childOverlapRatio: number;
};

export type LineageEdge = OverlapCell & {
  isPrimary: boolean;
};

export type GeometryOperationPlan = {
  operation: GeometryOperationKind;
  parents: PaddockGeometry[];
  children: PaddockGeometry[];
  overlapMatrix: OverlapCell[];
  lineageEdges: LineageEdge[];
  primaryParentByChildId: Record<string, string | null>;
  areaBeforeSquareMeters: number;
  areaAfterSquareMeters: number;
  areaDeltaSquareMeters: number;
  absoluteAreaDeltaSquareMeters: number;
  areaDeltaRatio: number;
  warnings: string[];
  blockers: string[];
  valid: boolean;
};

export type GeometryPlanOptions = {
  areaToleranceRatio?: number;
  areaToleranceSquareMeters?: number;
};

export type LotDestinationCandidate = {
  paddockId: string;
  overlapSquareMeters: number;
  overlapRatio: number;
};

export type LotMoveDecision = {
  lotId: string | null;
  parentPaddockId: string;
  destinationPaddockId: string | null;
  overlapSquareMeters: number;
  overlapRatio: number;
  minimumOverlapRatio: number;
  reason: "winner" | "below-threshold" | "tie" | "no-overlap" | "invalid-parent";
  warning: string | null;
  candidates: LotDestinationCandidate[];
};

export type LotDestinationOptions = {
  lotId?: string | null;
  minimumOverlapRatio?: number;
  tieToleranceRatio?: number;
};

export type UndoChildState = {
  paddockId: string;
  exists?: boolean;
  ownActivityCount: number;
  descendantOperationCount: number;
};

export type UndoLotMove = {
  lotId: string;
  fromPaddockId: string | null;
  toPaddockId: string | null;
};

export type UndoLotState = {
  lotId: string;
  paddockId: string | null;
};

export type UndoPlan = {
  operationId: string;
  canUndo: boolean;
  blockers: string[];
  reverseLotMoves: UndoLotMove[];
};

export type UndoPlanInput = {
  operationId: string;
  children: UndoChildState[];
  originalLotMoves: UndoLotMove[];
  currentLots: UndoLotState[];
};

// Turf operations can accumulate sub-meter differences when one parent becomes
// many children. Keep the relative allowance tiny and cap it in absolute terms
// so large paddocks cannot hide a material gap.
export const DEFAULT_AREA_TOLERANCE_RATIO = 5e-6;
export const DEFAULT_AREA_TOLERANCE_SQUARE_METERS = 5;
export const DEFAULT_LOT_DESTINATION_MINIMUM_RATIO = 0.3;
export const DEFAULT_LOT_DESTINATION_TIE_TOLERANCE_RATIO = 1e-9;

const OVERLAP_EPSILON_SQUARE_METERS = 0.01;
const THRESHOLD_FLOAT_TOLERANCE_RATIO = 1e-9;
const SHARED_BOUNDARY_EPSILON_METERS = 0.01;
const COLLINEAR_TOLERANCE_METERS = 0.01;
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Validates a proposed split without mutating either the parent or the proposed
 * children. Child geometries normally come from the map subdivision tool.
 */
export function planSplit(
  parent: PaddockGeometry,
  proposedChildren: PaddockGeometry[],
  options: GeometryPlanOptions = {},
): GeometryOperationPlan {
  const parents = [normalizePaddock(parent)];
  const children = proposedChildren.map(normalizePaddock);
  const extraBlockers: string[] = [];

  if (children.length < 2) {
    extraBlockers.push("Una división debe producir al menos dos potreros hijos.");
  }

  children.forEach((child) => {
    if (!safeContains(parents[0].coordinates, child.coordinates)) {
      extraBlockers.push(`El potrero hijo ${child.id} queda fuera de su padre ${parents[0].id}.`);
    }
  });

  for (let first = 0; first < children.length; first += 1) {
    for (let second = first + 1; second < children.length; second += 1) {
      if (safeIntersectionArea(children[first].coordinates, children[second].coordinates) > OVERLAP_EPSILON_SQUARE_METERS) {
        extraBlockers.push(`Los potreros hijos ${children[first].id} y ${children[second].id} se solapan.`);
      }
    }
  }

  return buildOperationPlan("split", parents, children, extraBlockers, options);
}

/**
 * Builds the single Polygon produced by merging adjacent paddocks. Point-only
 * contact, disconnected inputs, MultiPolygons and polygons with holes are
 * rejected explicitly.
 */
export function planMerge(
  sourcePaddocks: PaddockGeometry[],
  childPaddockId: string,
  options: GeometryPlanOptions = {},
): GeometryOperationPlan {
  const parents = sourcePaddocks.map(normalizePaddock);
  const children: PaddockGeometry[] = [];
  const extraBlockers: string[] = [];

  if (parents.length < 2) {
    extraBlockers.push("Una fusión necesita al menos dos potreros de origen.");
  }

  if (parents.length >= 2 && !formsConnectedMerge(parents)) {
    extraBlockers.push("Los potreros deben compartir una arista real; el contacto por un punto o las áreas disjuntas no se pueden fusionar.");
  }

  if (parents.length > 0 && parents.every((paddock) => isUsablePolygon(paddock.coordinates))) {
    try {
      const merged = union(featureCollection(parents.map((paddock) => toGeoJsonPolygon(paddock.coordinates))));
      if (!merged) {
        extraBlockers.push("La unión geométrica no produjo un polígono.");
      } else if (merged.geometry.type !== "Polygon") {
        extraBlockers.push("La fusión produciría un MultiPolygon; sólo se permite un Polygon único.");
      } else if (merged.geometry.coordinates.length !== 1) {
        extraBlockers.push("La fusión produciría un Polygon con huecos, lo que no está permitido.");
      } else {
        const rings = fromGeoJsonPolygon(merged as Feature<Polygon>);
        children.push({ id: childPaddockId, coordinates: normalizeCoordinates(rings[0]) });
      }
    } catch {
      extraBlockers.push("No fue posible construir una unión geométrica válida.");
    }
  }

  return buildOperationPlan("merge", parents, children, extraBlockers, options);
}

/** Plans a many-to-many redesign and records every overlap plus one stable primary parent per child. */
export function planRedesign(
  sourcePaddocks: PaddockGeometry[],
  proposedPaddocks: PaddockGeometry[],
  options: GeometryPlanOptions = {},
): GeometryOperationPlan {
  const parents = sourcePaddocks.map(normalizePaddock);
  const children = proposedPaddocks.map(normalizePaddock);
  const extraBlockers: string[] = [];

  // Un fundo recién creado no tiene potreros: subdividir su límite es una
  // subdivisión inicial (0 padres -> N potreros nuevos), un caso de creación
  // válido. El servidor sigue exigiendo que un rediseño con padres incluya
  // exactamente todos los potreros activos, así que 0 padres solo se acepta
  // cuando el fundo realmente está vacío.
  if (children.length === 0) extraBlockers.push("Un rediseño necesita al menos un potrero resultante.");

  return buildOperationPlan("redesign", parents, children, extraBlockers, options);
}

/**
 * Chooses a lot destination from raw square-metre intersections. A destination
 * exists only when the best child is unique and covers at least the threshold
 * of the parent area.
 */
export function chooseLotDestination(
  parent: PaddockGeometry,
  possibleChildren: PaddockGeometry[],
  options: LotDestinationOptions = {},
): LotMoveDecision {
  const normalizedParent = normalizePaddock(parent);
  const children = possibleChildren.map(normalizePaddock);
  const minimumOverlapRatio = normalizeRatio(
    options.minimumOverlapRatio,
    DEFAULT_LOT_DESTINATION_MINIMUM_RATIO,
  );
  const tieToleranceRatio = normalizeRatio(
    options.tieToleranceRatio,
    DEFAULT_LOT_DESTINATION_TIE_TOLERANCE_RATIO,
  );
  const parentArea = safeArea(normalizedParent.coordinates);

  if (parentArea <= 0) {
    return lotDecision({
      lotId: options.lotId ?? null,
      parentPaddockId: normalizedParent.id,
      minimumOverlapRatio,
      reason: "invalid-parent",
      warning: `El potrero padre ${normalizedParent.id} no tiene un área válida para reasignar el lote.`,
      candidates: [],
    });
  }

  const candidates = children
    .map((child): LotDestinationCandidate => {
      const overlapSquareMeters = safeIntersectionArea(normalizedParent.coordinates, child.coordinates);
      return {
        paddockId: child.id,
        overlapSquareMeters,
        overlapRatio: overlapSquareMeters / parentArea,
      };
    })
    .sort(compareLotCandidates);
  const winner = candidates[0];

  if (!winner || winner.overlapSquareMeters <= OVERLAP_EPSILON_SQUARE_METERS) {
    return lotDecision({
      lotId: options.lotId ?? null,
      parentPaddockId: normalizedParent.id,
      minimumOverlapRatio,
      reason: "no-overlap",
      warning: `Ningún potrero hijo solapa al padre ${normalizedParent.id}.`,
      candidates,
    });
  }

  if (winner.overlapRatio + THRESHOLD_FLOAT_TOLERANCE_RATIO < minimumOverlapRatio) {
    return lotDecision({
      lotId: options.lotId ?? null,
      parentPaddockId: normalizedParent.id,
      minimumOverlapRatio,
      reason: "below-threshold",
      warning: `El mejor destino cubre menos del ${(minimumOverlapRatio * 100).toFixed(1)}% del potrero padre.`,
      candidates,
    });
  }

  const runnerUp = candidates[1];
  if (runnerUp && Math.abs(winner.overlapRatio - runnerUp.overlapRatio) <= tieToleranceRatio) {
    return lotDecision({
      lotId: options.lotId ?? null,
      parentPaddockId: normalizedParent.id,
      minimumOverlapRatio,
      reason: "tie",
      warning: "Hay un empate entre destinos; el lote requiere asignación manual.",
      candidates,
    });
  }

  return lotDecision({
    lotId: options.lotId ?? null,
    parentPaddockId: normalizedParent.id,
    destinationPaddockId: winner.paddockId,
    overlapSquareMeters: winner.overlapSquareMeters,
    overlapRatio: winner.overlapRatio,
    minimumOverlapRatio,
    reason: "winner",
    warning: null,
    candidates,
  });
}

/**
 * Produces inverse lot moves only when an operation is still untouched. Any
 * child activity, descendant geometry operation, changed/deleted moved lot or
 * newly assigned lot blocks the entire undo.
 */
export function planUndo(input: UndoPlanInput): UndoPlan {
  const blockers: string[] = [];
  const children = [...input.children].sort((first, second) => compareIds(first.paddockId, second.paddockId));
  const originalMoves = [...input.originalLotMoves].sort((first, second) => compareIds(first.lotId, second.lotId));
  const currentLots = [...input.currentLots].sort((first, second) => compareIds(first.lotId, second.lotId));
  const childIds = new Set(children.map((child) => child.paddockId));
  const originalMoveByLotId = new Map(originalMoves.map((move) => [move.lotId, move]));
  const currentLotById = new Map(currentLots.map((lot) => [lot.lotId, lot]));

  children.forEach((child) => {
    if (child.exists === false) blockers.push(`El potrero hijo ${child.paddockId} ya no existe.`);
    if (child.ownActivityCount > 0) blockers.push(`El potrero hijo ${child.paddockId} tiene actividad propia.`);
    if (child.descendantOperationCount > 0) {
      blockers.push(`El potrero hijo ${child.paddockId} participa en una operación geométrica descendiente.`);
    }
  });

  originalMoves.forEach((move) => {
    const current = currentLotById.get(move.lotId);
    if (!current) {
      blockers.push(`El lote ${move.lotId} movido por la operación ya no existe.`);
    } else if (current.paddockId !== move.toPaddockId) {
      blockers.push(`El lote ${move.lotId} cambió de potrero después de la operación.`);
    }
  });

  currentLots.forEach((lot) => {
    if (!lot.paddockId || !childIds.has(lot.paddockId)) return;
    const recordedMove = originalMoveByLotId.get(lot.lotId);
    if (!recordedMove || recordedMove.toPaddockId !== lot.paddockId) {
      blockers.push(`El lote ${lot.lotId} fue asignado a un potrero hijo después de la operación.`);
    }
  });

  const uniqueBlockers = unique(blockers);
  return {
    operationId: input.operationId,
    canUndo: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    reverseLotMoves: uniqueBlockers.length === 0
      ? originalMoves.map((move) => ({
        lotId: move.lotId,
        fromPaddockId: move.toPaddockId,
        toPaddockId: move.fromPaddockId,
      }))
      : [],
  };
}

function buildOperationPlan(
  operation: GeometryOperationKind,
  parents: PaddockGeometry[],
  children: PaddockGeometry[],
  extraBlockers: string[],
  options: GeometryPlanOptions,
): GeometryOperationPlan {
  const blockers = [
    ...extraBlockers,
    ...validatePaddocks("padre", parents),
    ...validatePaddocks("hijo", children),
  ];
  const warnings: string[] = [];
  const overlapMatrix: OverlapCell[] = [];

  parents.forEach((parent) => {
    const parentArea = safeArea(parent.coordinates);
    children.forEach((child) => {
      const childArea = safeArea(child.coordinates);
      const overlapSquareMeters = safeIntersectionArea(parent.coordinates, child.coordinates);
      overlapMatrix.push({
        parentPaddockId: parent.id,
        childPaddockId: child.id,
        overlapSquareMeters,
        parentOverlapRatio: parentArea > 0 ? overlapSquareMeters / parentArea : 0,
        childOverlapRatio: childArea > 0 ? overlapSquareMeters / childArea : 0,
      });
    });
  });

  const primaryParentByChildId: Record<string, string | null> = {};
  children.forEach((child) => {
    const candidates = overlapMatrix
      .filter((cell) => cell.childPaddockId === child.id && cell.overlapSquareMeters > OVERLAP_EPSILON_SQUARE_METERS)
      .sort(compareOverlapCells);
    primaryParentByChildId[child.id] = candidates[0]?.parentPaddockId ?? null;
    // En una subdivisión inicial (sin padres) no hay nada que solapar; la
    // advertencia solo aplica cuando existen potreros de origen.
    if (parents.length > 0 && candidates.length === 0) warnings.push(`El potrero hijo ${child.id} no solapa ningún potrero padre.`);
  });

  const lineageEdges = overlapMatrix
    .filter((cell) => cell.overlapSquareMeters > OVERLAP_EPSILON_SQUARE_METERS)
    .map((cell): LineageEdge => ({
      ...cell,
      isPrimary: primaryParentByChildId[cell.childPaddockId] === cell.parentPaddockId,
    }));
  const areaBeforeSquareMeters = parents.reduce((sum, parent) => sum + safeArea(parent.coordinates), 0);
  const areaAfterSquareMeters = children.reduce((sum, child) => sum + safeArea(child.coordinates), 0);
  const areaDeltaSquareMeters = areaAfterSquareMeters - areaBeforeSquareMeters;
  const absoluteAreaDeltaSquareMeters = Math.abs(areaDeltaSquareMeters);
  const areaDeltaRatio = areaBeforeSquareMeters > 0 ? absoluteAreaDeltaSquareMeters / areaBeforeSquareMeters : 0;
  const areaToleranceRatio = normalizeRatio(options.areaToleranceRatio, DEFAULT_AREA_TOLERANCE_RATIO);
  const areaToleranceSquareMeters = normalizeNonNegative(
    options.areaToleranceSquareMeters,
    DEFAULT_AREA_TOLERANCE_SQUARE_METERS,
  );

  if (
    parents.length > 0
    && children.length > 0
    && (areaDeltaRatio > areaToleranceRatio || absoluteAreaDeltaSquareMeters > areaToleranceSquareMeters)
  ) {
    warnings.push(
      `La operación no conserva el área cruda: diferencia de ${absoluteAreaDeltaSquareMeters.toFixed(6)} m² (${(areaDeltaRatio * 100).toFixed(6)}%).`,
    );
  }

  const uniqueBlockers = unique(blockers);
  return {
    operation,
    parents,
    children,
    overlapMatrix,
    lineageEdges,
    primaryParentByChildId,
    areaBeforeSquareMeters,
    areaAfterSquareMeters,
    areaDeltaSquareMeters,
    absoluteAreaDeltaSquareMeters,
    areaDeltaRatio,
    warnings: unique(warnings),
    blockers: uniqueBlockers,
    valid: uniqueBlockers.length === 0,
  };
}

function validatePaddocks(role: "padre" | "hijo", paddocks: PaddockGeometry[]): string[] {
  const blockers: string[] = [];
  const seenIds = new Set<string>();
  paddocks.forEach((paddock) => {
    if (!paddock.id) blockers.push(`Hay un potrero ${role} sin identificador.`);
    if (seenIds.has(paddock.id)) blockers.push(`El identificador ${paddock.id} está duplicado entre los potreros ${role}.`);
    seenIds.add(paddock.id);
    if (paddock.coordinates.length < 3 || !paddock.coordinates.every(isFiniteCoordinate)) {
      blockers.push(`El potrero ${role} ${paddock.id} no tiene coordenadas válidas.`);
      return;
    }
    if (safeArea(paddock.coordinates) <= 0) blockers.push(`El potrero ${role} ${paddock.id} tiene área cero.`);
    if (safeSelfIntersects(paddock.coordinates)) blockers.push(`El potrero ${role} ${paddock.id} se autointersecta.`);
  });
  return blockers;
}

function formsConnectedMerge(paddocks: PaddockGeometry[]): boolean {
  const visited = new Set<number>([0]);
  const pending = [0];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (let candidate = 0; candidate < paddocks.length; candidate += 1) {
      if (visited.has(candidate)) continue;
      if (!hasMergeConnection(paddocks[current].coordinates, paddocks[candidate].coordinates)) continue;
      visited.add(candidate);
      pending.push(candidate);
    }
  }
  return visited.size === paddocks.length;
}

function hasMergeConnection(first: Coordinate[], second: Coordinate[]): boolean {
  if (safeIntersectionArea(first, second) > OVERLAP_EPSILON_SQUARE_METERS) return true;
  return sharedBoundaryLengthMeters(first, second) > SHARED_BOUNDARY_EPSILON_METERS;
}

function sharedBoundaryLengthMeters(first: Coordinate[], second: Coordinate[]): number {
  const referenceLatitude = (
    first.reduce((sum, coordinate) => sum + coordinate[0], 0)
      + second.reduce((sum, coordinate) => sum + coordinate[0], 0)
  ) / (first.length + second.length);
  let sharedLength = 0;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstStart = projectCoordinate(first[firstIndex], referenceLatitude);
    const firstEnd = projectCoordinate(first[(firstIndex + 1) % first.length], referenceLatitude);
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondStart = projectCoordinate(second[secondIndex], referenceLatitude);
      const secondEnd = projectCoordinate(second[(secondIndex + 1) % second.length], referenceLatitude);
      sharedLength += collinearSegmentOverlapMeters(firstStart, firstEnd, secondStart, secondEnd);
    }
  }
  return sharedLength;
}

type ProjectedPoint = { x: number; y: number };

function projectCoordinate(coordinate: Coordinate, referenceLatitude: number): ProjectedPoint {
  return {
    x: EARTH_RADIUS_METERS * toRadians(coordinate[1]) * Math.cos(toRadians(referenceLatitude)),
    y: EARTH_RADIUS_METERS * toRadians(coordinate[0]),
  };
}

function collinearSegmentOverlapMeters(
  firstStart: ProjectedPoint,
  firstEnd: ProjectedPoint,
  secondStart: ProjectedPoint,
  secondEnd: ProjectedPoint,
): number {
  const dx = firstEnd.x - firstStart.x;
  const dy = firstEnd.y - firstStart.y;
  const segmentLength = Math.hypot(dx, dy);
  if (segmentLength <= SHARED_BOUNDARY_EPSILON_METERS) return 0;

  const secondStartDistance = Math.abs(dx * (secondStart.y - firstStart.y) - dy * (secondStart.x - firstStart.x)) / segmentLength;
  const secondEndDistance = Math.abs(dx * (secondEnd.y - firstStart.y) - dy * (secondEnd.x - firstStart.x)) / segmentLength;
  if (secondStartDistance > COLLINEAR_TOLERANCE_METERS || secondEndDistance > COLLINEAR_TOLERANCE_METERS) return 0;

  const unitX = dx / segmentLength;
  const unitY = dy / segmentLength;
  const secondStartPosition = (secondStart.x - firstStart.x) * unitX + (secondStart.y - firstStart.y) * unitY;
  const secondEndPosition = (secondEnd.x - firstStart.x) * unitX + (secondEnd.y - firstStart.y) * unitY;
  const overlapStart = Math.max(0, Math.min(secondStartPosition, secondEndPosition));
  const overlapEnd = Math.min(segmentLength, Math.max(secondStartPosition, secondEndPosition));
  return Math.max(0, overlapEnd - overlapStart);
}

function normalizePaddock(paddock: PaddockGeometry): PaddockGeometry {
  return {
    id: paddock.id,
    coordinates: normalizeCoordinates(paddock.coordinates),
  };
}

function normalizeCoordinates(coordinates: Coordinate[]): Coordinate[] {
  return normalizePolygon(coordinates.map(([latitude, longitude]) => [latitude, longitude] as Coordinate));
}

function isUsablePolygon(coordinates: Coordinate[]): boolean {
  return coordinates.length >= 3 && coordinates.every(isFiniteCoordinate) && safeArea(coordinates) > 0;
}

function isFiniteCoordinate(coordinate: Coordinate): boolean {
  return Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]);
}

function safeArea(coordinates: Coordinate[]): number {
  try {
    return calculateAreaSquareMeters(coordinates);
  } catch {
    return 0;
  }
}

function safeIntersectionArea(first: Coordinate[], second: Coordinate[]): number {
  try {
    return intersectionAreaSquareMeters(first, second);
  } catch {
    return 0;
  }
}

function safeContains(outer: Coordinate[], inner: Coordinate[]): boolean {
  try {
    return containsPolygon(outer, inner, 0.01);
  } catch {
    return false;
  }
}

function safeSelfIntersects(coordinates: Coordinate[]): boolean {
  try {
    return selfIntersects(coordinates);
  } catch {
    return true;
  }
}

function lotDecision(input: {
  lotId: string | null;
  parentPaddockId: string;
  destinationPaddockId?: string | null;
  overlapSquareMeters?: number;
  overlapRatio?: number;
  minimumOverlapRatio: number;
  reason: LotMoveDecision["reason"];
  warning: string | null;
  candidates: LotDestinationCandidate[];
}): LotMoveDecision {
  return {
    lotId: input.lotId,
    parentPaddockId: input.parentPaddockId,
    destinationPaddockId: input.destinationPaddockId ?? null,
    overlapSquareMeters: input.overlapSquareMeters ?? 0,
    overlapRatio: input.overlapRatio ?? 0,
    minimumOverlapRatio: input.minimumOverlapRatio,
    reason: input.reason,
    warning: input.warning,
    candidates: input.candidates,
  };
}

function compareLotCandidates(first: LotDestinationCandidate, second: LotDestinationCandidate): number {
  return second.overlapSquareMeters - first.overlapSquareMeters || compareIds(first.paddockId, second.paddockId);
}

function compareOverlapCells(first: OverlapCell, second: OverlapCell): number {
  return second.overlapSquareMeters - first.overlapSquareMeters
    || compareIds(first.parentPaddockId, second.parentPaddockId);
}

function compareIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value ?? fallback)) : fallback;
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value ?? fallback) : fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}
