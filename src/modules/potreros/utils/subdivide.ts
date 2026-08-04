import type { Coordinate } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateAreaSquareMeters, coordinateDistanceMeters, metersToDegrees, selfIntersects } from "./geometry.ts";

type Intersection = {
  point: Coordinate;
  polygonEdge: number;
  lineSegment: number;
  linePosition: number;
};

export type SubdivisionResult = {
  polygons: Coordinate[][];
  createdPolygons: Coordinate[][];
  splitCount: number;
  error: string | null;
};

export type SubdivisionSnap = {
  point: Coordinate;
  distance: number;
  distanceMeters: number;
  polygonIndex: number;
  edgeIndex: number;
};

export type SubdivisionOptions = {
  snapDistanceMeters?: number;
};

export type SubdivisionStartingState = {
  history: Coordinate[][][];
  line: Coordinate[];
  source: "draft" | "saved-paddocks" | "field-boundary";
};

const EPSILON = 1e-9;
const ORIENTATION_EPSILON = 1e-14;
const AREA_TOLERANCE_RATIO = 5e-6;
const AREA_TOLERANCE_SQUARE_METERS = 5;
const DEFAULT_PERSISTED_COORDINATE_LIMIT = 30_000;
export const DEFAULT_SUBDIVISION_SNAP_DISTANCE_METERS = 15;

export function compactSubdivisionHistory(
  history: Coordinate[][][],
  coordinateLimit = DEFAULT_PERSISTED_COORDINATE_LIMIT,
): Coordinate[][][] {
  if (history.length <= 1) return history;
  const limit = Number.isFinite(coordinateLimit) ? Math.max(1, Math.floor(coordinateLimit)) : DEFAULT_PERSISTED_COORDINATE_LIMIT;
  const retained: Coordinate[][][] = [];
  let retainedCoordinates = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const snapshot = history[index];
    const snapshotCoordinates = snapshot.reduce((sum, polygon) => sum + polygon.length, 0);
    if (retained.length > 0 && retainedCoordinates + snapshotCoordinates > limit) break;
    retained.unshift(snapshot);
    retainedCoordinates += snapshotCoordinates;
  }
  return retained;
}

export function selectSubdivisionStartingState({
  boundary,
  savedPolygons,
  draftHistory,
  draftLine,
}: {
  boundary: Coordinate[];
  savedPolygons: Coordinate[][];
  draftHistory?: Coordinate[][][];
  draftLine?: Coordinate[];
}): SubdivisionStartingState {
  const validSavedPolygons = savedPolygons.filter((polygon) => normalizePolygon(polygon).length >= 3);
  const validDraftHistory = (draftHistory ?? [])
    .map((polygons) => polygons.filter((polygon) => normalizePolygon(polygon).length >= 3))
    .filter((polygons) => polygons.length > 0);
  const currentDraft = validDraftHistory[validDraftHistory.length - 1] ?? [];

  // A draft with fewer areas than the already-saved map predates that map. Starting
  // from it would silently force the user to redraw completed paddocks.
  if (currentDraft.length > 0 && currentDraft.length >= validSavedPolygons.length) {
    return {
      history: validDraftHistory,
      line: draftLine ?? [],
      source: "draft",
    };
  }

  if (validSavedPolygons.length > 0) {
    return {
      history: [validSavedPolygons],
      line: [],
      source: "saved-paddocks",
    };
  }

  return {
    history: boundary.length >= 3 ? [[normalizePolygon(boundary)]] : [],
    line: [],
    source: "field-boundary",
  };
}

export function nearestSubdivisionBoundaryPoint(
  point: Coordinate,
  polygons: Coordinate[][],
  maximumDistanceMeters = Number.POSITIVE_INFINITY,
): SubdivisionSnap | null {
  let closest: Omit<SubdivisionSnap, "distanceMeters"> & { approximateDistanceSquared: number } | null = null;
  const bounded = Number.isFinite(maximumDistanceMeters);
  const latitudeDelta = bounded ? metersToDegrees(Math.max(0, maximumDistanceMeters), point[0], "latitude") : Number.POSITIVE_INFINITY;
  const longitudeDelta = bounded ? metersToDegrees(Math.max(0, maximumDistanceMeters), point[0]) : Number.POSITIVE_INFINITY;
  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    const polygon = polygons[polygonIndex];
    const ring = removeClosingPoint(polygon);
    for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
      const start = ring[edgeIndex];
      const end = ring[(edgeIndex + 1) % ring.length];
      if (bounded && !segmentIntersectsSearchBounds(point, start, end, latitudeDelta, longitudeDelta)) continue;
      const candidate = closestPointOnSegment(point, start, end);
      const candidateDistance = distance(point, candidate);
      const approximateDistanceSquared = approximateMetricDistanceSquared(point, candidate);
      if (!closest || approximateDistanceSquared < closest.approximateDistanceSquared) {
        closest = {
          point: candidate,
          distance: candidateDistance,
          approximateDistanceSquared,
          polygonIndex,
          edgeIndex,
        };
      }
    }
  }
  if (!closest) return null;
  const distanceMeters = coordinateDistanceMeters(point, closest.point);
  if (bounded && distanceMeters > maximumDistanceMeters) return null;
  return {
    point: closest.point,
    distance: closest.distance,
    distanceMeters,
    polygonIndex: closest.polygonIndex,
    edgeIndex: closest.edgeIndex,
  };
}

export function subdividePolygons(
  polygons: Coordinate[][],
  divider: Coordinate[],
  options: SubdivisionOptions = {},
): SubdivisionResult {
  if (divider.length < 2) {
    return { polygons, createdPolygons: [], splitCount: 0, error: "Marca al menos dos puntos para crear una división." };
  }

  const snapDistanceMeters = Number.isFinite(options.snapDistanceMeters)
    ? Math.max(0, options.snapDistanceMeters ?? DEFAULT_SUBDIVISION_SNAP_DISTANCE_METERS)
    : DEFAULT_SUBDIVISION_SNAP_DISTANCE_METERS;
  const snappedDivider = snapDividerEndpoints(divider, polygons, snapDistanceMeters);
  let splitCount = 0;
  const createdPolygons: Coordinate[][] = [];
  const divided = polygons.flatMap((polygon) => {
    const result = splitPolygon(polygon, snappedDivider);
    if (!result) return [polygon];
    splitCount += 1;
    createdPolygons.push(...result);
    return result;
  });

  if (splitCount === 0) {
    return {
      polygons,
      createdPolygons: [],
      splitCount: 0,
      error: "La línea debe comenzar y terminar sobre los bordes de una misma área.",
    };
  }

  return { polygons: divided, createdPolygons, splitCount, error: null };
}

function splitPolygon(polygon: Coordinate[], divider: Coordinate[]): Coordinate[][] | null {
  const ring = removeClosingPoint(polygon);
  if (ring.length < 3) return null;
  if (!dividerIsSimple(divider) || dividerOverlapsBoundary(ring, divider)) return null;
  if (ringContainsPoint(ring, divider[0]) || ringContainsPoint(ring, divider[divider.length - 1])) return null;

  const intersections = collectIntersections(ring, divider);
  if (intersections.length < 2) return null;
  const pieces = intersections.length === 2
    ? splitRingWithChord(ring, pathAlongDivider(divider, intersections[0], intersections[1]))
    : splitRingWithMultipleChords(ring, divider, intersections);
  return pieces && splitResultIsValid(ring, pieces) ? pieces : null;
}

function collectIntersections(ring: Coordinate[], divider: Coordinate[]): Intersection[] {
  const lineDistances = cumulativeDistances(divider);
  const intersections: Intersection[] = [];

  for (let lineIndex = 0; lineIndex < divider.length - 1; lineIndex += 1) {
    for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
      const intersection = segmentIntersection(
        divider[lineIndex],
        divider[lineIndex + 1],
        ring[edgeIndex],
        ring[(edgeIndex + 1) % ring.length],
      );
      if (!intersection) continue;

      const normalizedEdge = intersection.edgeT > 1 - EPSILON ? (edgeIndex + 1) % ring.length : edgeIndex;
      const linePosition = lineDistances[lineIndex] + distance(divider[lineIndex], intersection.point);
      const candidate: Intersection = {
        point: intersection.point,
        polygonEdge: normalizedEdge,
        lineSegment: lineIndex,
        linePosition,
      };

      if (!intersections.some((item) => distance(item.point, candidate.point) < EPSILON)) {
        intersections.push(candidate);
      }
    }
  }

  intersections.sort((a, b) => a.linePosition - b.linePosition);
  return intersections;
}

/**
 * Corta un anillo con una cuerda: un tramo del divisor cuyos dos extremos caen sobre
 * el borde. Es la primitiva histórica de dos intersecciones y sigue siendo la única
 * que produce geometría; los cortes múltiples se reducen a una secuencia de cuerdas.
 */
function splitRingWithChord(ring: Coordinate[], chord: Coordinate[]): [Coordinate[], Coordinate[]] | null {
  const intersections = collectIntersections(ring, chord);
  if (intersections.length !== 2) return null;

  const [start, end] = intersections;
  if (distance(start.point, end.point) < EPSILON) return null;

  const dividerPath = pathAlongDivider(chord, start, end);
  const boundaryStartToEnd = pathAlongBoundary(ring, start, end);
  const boundaryEndToStart = pathAlongBoundary(ring, end, start);
  const first = normalizePolygon([...dividerPath, ...boundaryEndToStart.slice(1, -1)]);
  const second = normalizePolygon([...dividerPath].reverse().concat(boundaryStartToEnd.slice(1, -1)));

  if (first.length < 3 || second.length < 3 || planarArea(first) < EPSILON || planarArea(second) < EPSILON) {
    return null;
  }

  const originalArea = planarArea(ring);
  const dividedArea = planarArea(first) + planarArea(second);
  if (!conservesArea(originalArea, dividedArea)) return null;

  return [first, second];
}

/**
 * Un potrero cóncavo —el que rodea una quebrada o un bosquete— puede ser cruzado más
 * de dos veces por un solo corte. Cada par consecutivo de intersecciones delimita un
 * tramo del divisor que va por dentro o por fuera del potrero; solo los de adentro son
 * cuerdas reales. Aplicarlas de a una reutiliza la primitiva ya validada en vez de
 * introducir un motor de polygonize nuevo.
 */
function splitRingWithMultipleChords(
  ring: Coordinate[],
  divider: Coordinate[],
  intersections: Intersection[],
): Coordinate[][] | null {
  const chords: Coordinate[][] = [];
  for (let index = 0; index < intersections.length - 1; index += 1) {
    const chord = pathAlongDivider(divider, intersections[index], intersections[index + 1]);
    if (chord.length < 2 || distance(chord[0], chord[chord.length - 1]) < EPSILON) return null;
    if (ringContainsPoint(ring, midpointAlongPath(chord))) chords.push(chord);
  }
  if (chords.length === 0) return null;

  let pieces: Coordinate[][] = [ring];
  for (const chord of chords) {
    const next: Coordinate[][] = [];
    let appliedCount = 0;
    for (const piece of pieces) {
      const result = splitRingWithChord(piece, chord);
      if (!result) {
        next.push(piece);
        continue;
      }
      next.push(...result);
      appliedCount += 1;
    }
    // La operación es transaccional: cada cuerda interior debe dividir exactamente
    // una pieza. No se acepta conservar solo el subconjunto que sí funcionó.
    if (appliedCount !== 1) return null;
    pieces = next;
  }

  const dividedArea = pieces.reduce((sum, piece) => sum + planarArea(piece), 0);
  if (!conservesArea(planarArea(ring), dividedArea)) return null;

  return pieces;
}

function conservesArea(originalArea: number, dividedArea: number) {
  const areaTolerance = Math.max(originalArea * 1e-7, 1e-12);
  return Math.abs(originalArea - dividedArea) <= areaTolerance;
}

function midpointAlongPath(path: Coordinate[]): Coordinate {
  const distances = cumulativeDistances(path);
  const half = distances[distances.length - 1] / 2;
  for (let index = 1; index < path.length; index += 1) {
    if (distances[index] < half) continue;
    const span = distances[index] - distances[index - 1];
    const ratio = span < EPSILON ? 0 : (half - distances[index - 1]) / span;
    return [
      path[index - 1][0] + (path[index][0] - path[index - 1][0]) * ratio,
      path[index - 1][1] + (path[index][1] - path[index - 1][1]) * ratio,
    ];
  }
  return path[path.length - 1];
}

function ringContainsPoint(ring: Coordinate[], point: Coordinate) {
  for (let index = 0; index < ring.length; index += 1) {
    const next = ring[(index + 1) % ring.length];
    if (
      Math.abs(orientation(ring[index], next, point)) <= ORIENTATION_EPSILON
      && pointOnSegment(point, ring[index], next)
    ) {
      return false;
    }
  }
  const longitude = point[1];
  const latitude = point[0];
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentLongitude = ring[index][1];
    const currentLatitude = ring[index][0];
    const previousLongitude = ring[previous][1];
    const previousLatitude = ring[previous][0];
    const straddles = (currentLatitude > latitude) !== (previousLatitude > latitude);
    if (!straddles) continue;
    const crossingLongitude = currentLongitude
      + ((latitude - currentLatitude) / (previousLatitude - currentLatitude)) * (previousLongitude - currentLongitude);
    if (longitude < crossingLongitude) inside = !inside;
  }
  return inside;
}

function dividerIsSimple(divider: Coordinate[]) {
  if (divider.length < 2 || divider.some(([latitude, longitude]) => (
    !Number.isFinite(latitude) || !Number.isFinite(longitude)
  ))) {
    return false;
  }
  for (let index = 0; index < divider.length - 1; index += 1) {
    if (distance(divider[index], divider[index + 1]) < EPSILON) return false;
    if (
      index > 0
      && collinearOverlapLength(
        divider[index - 1],
        divider[index],
        divider[index],
        divider[index + 1],
      ) > EPSILON
    ) {
      return false;
    }
  }
  for (let first = 0; first < divider.length; first += 1) {
    for (let second = first + 1; second < divider.length; second += 1) {
      if (distance(divider[first], divider[second]) < EPSILON) return false;
    }
  }
  for (let first = 0; first < divider.length - 1; first += 1) {
    for (let second = first + 2; second < divider.length - 1; second += 1) {
      if (segmentsIntersectInclusive(
        divider[first],
        divider[first + 1],
        divider[second],
        divider[second + 1],
      )) {
        return false;
      }
    }
  }
  return true;
}

function dividerOverlapsBoundary(ring: Coordinate[], divider: Coordinate[]) {
  for (let dividerIndex = 0; dividerIndex < divider.length - 1; dividerIndex += 1) {
    for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
      if (collinearOverlapLength(
        divider[dividerIndex],
        divider[dividerIndex + 1],
        ring[edgeIndex],
        ring[(edgeIndex + 1) % ring.length],
      ) > EPSILON) {
        return true;
      }
    }
  }
  return false;
}

function segmentsIntersectInclusive(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
) {
  const firstSecondStart = orientation(firstStart, firstEnd, secondStart);
  const firstSecondEnd = orientation(firstStart, firstEnd, secondEnd);
  const secondFirstStart = orientation(secondStart, secondEnd, firstStart);
  const secondFirstEnd = orientation(secondStart, secondEnd, firstEnd);
  const firstStartSign = orientationSign(firstSecondStart);
  const firstEndSign = orientationSign(firstSecondEnd);
  const secondStartSign = orientationSign(secondFirstStart);
  const secondEndSign = orientationSign(secondFirstEnd);

  if (firstStartSign * firstEndSign < 0 && secondStartSign * secondEndSign < 0) {
    return true;
  }
  return (Math.abs(firstSecondStart) <= ORIENTATION_EPSILON && pointOnSegment(secondStart, firstStart, firstEnd))
    || (Math.abs(firstSecondEnd) <= ORIENTATION_EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (Math.abs(secondFirstStart) <= ORIENTATION_EPSILON && pointOnSegment(firstStart, secondStart, secondEnd))
    || (Math.abs(secondFirstEnd) <= ORIENTATION_EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function orientation(start: Coordinate, end: Coordinate, point: Coordinate) {
  return (end[1] - start[1]) * (point[0] - start[0])
    - (end[0] - start[0]) * (point[1] - start[1]);
}

function orientationSign(value: number) {
  if (value > ORIENTATION_EPSILON) return 1;
  if (value < -ORIENTATION_EPSILON) return -1;
  return 0;
}

function pointOnSegment(point: Coordinate, start: Coordinate, end: Coordinate) {
  return point[0] >= Math.min(start[0], end[0]) - EPSILON
    && point[0] <= Math.max(start[0], end[0]) + EPSILON
    && point[1] >= Math.min(start[1], end[1]) - EPSILON
    && point[1] <= Math.max(start[1], end[1]) + EPSILON;
}

function collinearOverlapLength(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
) {
  if (
    Math.abs(orientation(firstStart, firstEnd, secondStart)) > ORIENTATION_EPSILON
    || Math.abs(orientation(firstStart, firstEnd, secondEnd)) > ORIENTATION_EPSILON
  ) {
    return 0;
  }
  const axis = Math.abs(firstEnd[0] - firstStart[0]) >= Math.abs(firstEnd[1] - firstStart[1]) ? 0 : 1;
  const overlapStart = Math.max(
    Math.min(firstStart[axis], firstEnd[axis]),
    Math.min(secondStart[axis], secondEnd[axis]),
  );
  const overlapEnd = Math.min(
    Math.max(firstStart[axis], firstEnd[axis]),
    Math.max(secondStart[axis], secondEnd[axis]),
  );
  return Math.max(0, overlapEnd - overlapStart);
}

function conservesMetricArea(original: Coordinate[], pieces: Coordinate[][]) {
  const originalArea = calculateAreaSquareMeters(original);
  const dividedArea = pieces.reduce((sum, piece) => sum + calculateAreaSquareMeters(piece), 0);
  const tolerance = Math.min(
    originalArea * AREA_TOLERANCE_RATIO,
    AREA_TOLERANCE_SQUARE_METERS,
  );
  return Number.isFinite(originalArea)
    && Number.isFinite(dividedArea)
    && Math.abs(originalArea - dividedArea) <= tolerance;
}

function splitResultIsValid(original: Coordinate[], pieces: Coordinate[][]) {
  const dividedArea = pieces.reduce((sum, piece) => sum + planarArea(piece), 0);
  return pieces.every((piece) => piece.length >= 3 && !selfIntersects(piece))
    && conservesArea(planarArea(original), dividedArea)
    && conservesMetricArea(original, pieces);
}

function snapDividerEndpoints(
  divider: Coordinate[],
  polygons: Coordinate[][],
  snapDistanceMeters: number,
): Coordinate[] {
  const result = [...divider];
  const first = nearestSubdivisionBoundaryPoint(divider[0], polygons);
  const last = nearestSubdivisionBoundaryPoint(divider[divider.length - 1], polygons);
  if (first && first.distanceMeters <= snapDistanceMeters) result[0] = first.point;
  if (last && last.distanceMeters <= snapDistanceMeters) result[result.length - 1] = last.point;
  return result;
}

export function closestPointOnSegment(point: Coordinate, start: Coordinate, end: Coordinate): Coordinate {
  const referenceLatitude = (point[0] + start[0] + end[0]) / 3;
  const longitudeScale = Math.max(Math.abs(Math.cos(referenceLatitude * Math.PI / 180)), Number.EPSILON);
  const px = point[1] * longitudeScale;
  const py = point[0];
  const ax = start[1] * longitudeScale;
  const ay = start[0];
  const bx = end[1] * longitudeScale;
  const by = end[0];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return start;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return [ay + t * dy, (ax + t * dx) / longitudeScale];
}

function segmentIntersection(lineStart: Coordinate, lineEnd: Coordinate, edgeStart: Coordinate, edgeEnd: Coordinate) {
  const ax = lineStart[1];
  const ay = lineStart[0];
  const bx = lineEnd[1];
  const by = lineEnd[0];
  const cx = edgeStart[1];
  const cy = edgeStart[0];
  const dx = edgeEnd[1];
  const dy = edgeEnd[0];
  const lineX = bx - ax;
  const lineY = by - ay;
  const edgeX = dx - cx;
  const edgeY = dy - cy;
  const denominator = lineX * edgeY - lineY * edgeX;
  if (Math.abs(denominator) < EPSILON) return null;

  const startX = cx - ax;
  const startY = cy - ay;
  const lineT = (startX * edgeY - startY * edgeX) / denominator;
  const edgeT = (startX * lineY - startY * lineX) / denominator;
  if (lineT < -EPSILON || lineT > 1 + EPSILON || edgeT < -EPSILON || edgeT > 1 + EPSILON) return null;

  return {
    point: [ay + Math.max(0, Math.min(1, lineT)) * lineY, ax + Math.max(0, Math.min(1, lineT)) * lineX] as Coordinate,
    edgeT,
  };
}

function pathAlongDivider(divider: Coordinate[], start: Intersection, end: Intersection) {
  const result: Coordinate[] = [start.point];
  for (let index = start.lineSegment + 1; index <= end.lineSegment; index += 1) {
    result.push(divider[index]);
  }
  result.push(end.point);
  return removeDuplicateNeighbors(result);
}

function pathAlongBoundary(ring: Coordinate[], start: Intersection, end: Intersection) {
  const result: Coordinate[] = [start.point];
  let edge = start.polygonEdge;
  let guard = 0;
  while (edge !== end.polygonEdge && guard <= ring.length) {
    result.push(ring[(edge + 1) % ring.length]);
    edge = (edge + 1) % ring.length;
    guard += 1;
  }
  result.push(end.point);
  return removeDuplicateNeighbors(result);
}

function cumulativeDistances(points: Coordinate[]) {
  const result = [0];
  for (let index = 1; index < points.length; index += 1) {
    result.push(result[index - 1] + distance(points[index - 1], points[index]));
  }
  return result;
}

function distance(first: Coordinate, second: Coordinate) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

function approximateMetricDistanceSquared(first: Coordinate, second: Coordinate) {
  const latitudeMeters = (second[0] - first[0]) * 111_195;
  const longitudeMeters = (second[1] - first[1]) * 111_195 * Math.cos(first[0] * Math.PI / 180);
  return latitudeMeters * latitudeMeters + longitudeMeters * longitudeMeters;
}

function segmentIntersectsSearchBounds(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
  latitudeDelta: number,
  longitudeDelta: number,
) {
  return Math.max(start[0], end[0]) >= point[0] - latitudeDelta
    && Math.min(start[0], end[0]) <= point[0] + latitudeDelta
    && Math.max(start[1], end[1]) >= point[1] - longitudeDelta
    && Math.min(start[1], end[1]) <= point[1] + longitudeDelta;
}

function planarArea(points: Coordinate[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[1] * next[0] - next[1] * point[0];
  }, 0) / 2);
}

function removeClosingPoint(points: Coordinate[]) {
  if (points.length > 1 && distance(points[0], points[points.length - 1]) < EPSILON) return points.slice(0, -1);
  return points;
}

export function removeDuplicateNeighbors(points: Coordinate[]) {
  return points.filter((point, index) => index === 0 || distance(point, points[index - 1]) >= EPSILON);
}

export function normalizePolygon(points: Coordinate[]) {
  const normalized = removeDuplicateNeighbors(points);
  return removeClosingPoint(normalized);
}
