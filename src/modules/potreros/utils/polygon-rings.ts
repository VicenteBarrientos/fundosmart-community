import type { Coordinate, ExclusionKind, PolygonRings, StoredPolygon } from "../types";

export const MAX_POLYGON_RING_VERTICES = 2_000;
export const EXCLUSION_KINDS = ["laguna", "bosque", "construccion", "roquerio", "humedal"] as const satisfies readonly ExclusionKind[];

export class PolygonRingsError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PolygonRingsError";
    this.code = code;
  }
}

export function decodeStoredPolygon(value: unknown): PolygonRings {
  const parsed = typeof value === "string" ? parseStoredJson(value) : value;
  if (isMultiPolygon(parsed)) {
    throw new PolygonRingsError("MultiPolygon no está soportado en esta versión.", "MULTIPOLYGON_UNSUPPORTED");
  }
  const candidate = Array.isArray(parsed)
    ? { outer: parsed, holes: [] }
    : isPlainObject(parsed) && "outer" in parsed && "holes" in parsed
      ? { outer: parsed.outer, holes: parsed.holes }
      : null;
  if (!candidate || !Array.isArray(candidate.outer) || !Array.isArray(candidate.holes)) {
    throw new PolygonRingsError("La geometría del potrero no tiene un formato de anillos válido.", "POLYGON_FORMAT_INVALID");
  }
  const rings: PolygonRings = {
    outer: decodeRing(candidate.outer, "exterior"),
    holes: candidate.holes.map((hole, index) => decodeRing(hole, `interior ${index + 1}`)),
  };
  assertValidPolygonRings(rings);
  return rings;
}

export function encodeStoredPolygon(value: StoredPolygon | PolygonRings): PolygonRings {
  const rings = decodeStoredPolygon(value);
  return clonePolygonRings(rings);
}

export function assertValidPolygonRings(rings: PolygonRings): void {
  const errors = polygonRingsValidationErrors(rings);
  if (errors.length > 0) throw new PolygonRingsError(errors[0], "POLYGON_TOPOLOGY_INVALID");
}

export function polygonRingsValidationErrors(rings: PolygonRings): string[] {
  const errors: string[] = [];
  const allRings = [rings.outer, ...rings.holes];
  allRings.forEach((ring, index) => {
    const label = index === 0 ? "El anillo exterior" : `La exclusión ${index}`;
    if (ring.length < 3) errors.push(`${label} debe tener al menos 3 vértices.`);
    if (ring.length > MAX_POLYGON_RING_VERTICES) errors.push(`${label} supera el límite de ${MAX_POLYGON_RING_VERTICES} vértices.`);
    if (!ring.every(isFiniteCoordinate)) errors.push(`${label} contiene coordenadas no finitas.`);
    if (ring.length >= 3 && Math.abs(planarTwiceArea(ring)) <= Number.EPSILON) errors.push(`${label} debe tener un área mayor que 0.`);
    if (ring.length >= 4 && ringSelfIntersects(ring)) errors.push(`${label} se cruza consigo mismo.`);
  });
  if (errors.length > 0) return unique(errors);

  rings.holes.forEach((hole, index) => {
    const number = index + 1;
    if (ringsTouchOrCross(rings.outer, hole) || hole.some((point) => !pointStrictlyInsideRing(point, rings.outer))) {
      errors.push(`La exclusión ${number} debe estar estrictamente dentro del anillo exterior y no tocar su borde.`);
    }
  });
  for (let first = 0; first < rings.holes.length; first += 1) {
    for (let second = first + 1; second < rings.holes.length; second += 1) {
      const firstHole = rings.holes[first];
      const secondHole = rings.holes[second];
      if (
        ringsTouchOrCross(firstHole, secondHole)
        || pointInsideOrOnRing(firstHole[0], secondHole)
        || pointInsideOrOnRing(secondHole[0], firstHole)
      ) {
        errors.push(`Las exclusiones ${first + 1} y ${second + 1} no pueden tocarse ni solaparse.`);
      }
    }
  }
  return unique(errors);
}

export function assertAlignedHoleKinds(holes: Coordinate[][], holeKinds: readonly ExclusionKind[]): void {
  if (holeKinds.length !== holes.length) {
    throw new PolygonRingsError("Cada exclusión debe tener exactamente un tipo asociado.", "HOLE_KINDS_MISMATCH");
  }
  if (holeKinds.some((kind) => !EXCLUSION_KINDS.includes(kind))) {
    throw new PolygonRingsError("Uno de los tipos de exclusión no es válido.", "EXCLUSION_KIND_INVALID");
  }
}

export function addPolygonExclusion(
  geometry: StoredPolygon | PolygonRings,
  holeKinds: readonly ExclusionKind[],
  exclusion: Coordinate[],
  kind: ExclusionKind,
): { geometry: PolygonRings; holeKinds: ExclusionKind[] } {
  if (!EXCLUSION_KINDS.includes(kind)) {
    throw new PolygonRingsError("El tipo de exclusión no es válido.", "EXCLUSION_KIND_INVALID");
  }
  const current = decodeStoredPolygon(geometry);
  assertAlignedHoleKinds(current.holes, holeKinds);
  const next = decodeStoredPolygon({ outer: current.outer, holes: [...current.holes, exclusion] });
  return { geometry: next, holeKinds: [...holeKinds, kind] };
}

export function removePolygonExclusion(
  geometry: StoredPolygon | PolygonRings,
  holeKinds: readonly ExclusionKind[],
  index: number,
): { geometry: PolygonRings; holeKinds: ExclusionKind[]; removedKind: ExclusionKind } {
  const current = decodeStoredPolygon(geometry);
  assertAlignedHoleKinds(current.holes, holeKinds);
  if (!Number.isInteger(index) || index < 0 || index >= current.holes.length) {
    throw new PolygonRingsError("La exclusión seleccionada no existe.", "EXCLUSION_INDEX_INVALID");
  }
  const nextHoles = current.holes.filter((_, candidateIndex) => candidateIndex !== index);
  const nextKinds = holeKinds.filter((_, candidateIndex) => candidateIndex !== index);
  return {
    geometry: decodeStoredPolygon({ outer: current.outer, holes: nextHoles }),
    holeKinds: [...nextKinds],
    removedKind: holeKinds[index],
  };
}

export function clonePolygonRings(rings: PolygonRings): PolygonRings {
  return {
    outer: rings.outer.map(cloneCoordinate),
    holes: rings.holes.map((hole) => hole.map(cloneCoordinate)),
  };
}

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PolygonRingsError("La geometría almacenada no contiene JSON válido.", "POLYGON_JSON_INVALID");
  }
}

function decodeRing(value: unknown, label: string): Coordinate[] {
  if (!Array.isArray(value)) throw new PolygonRingsError(`El anillo ${label} no es una lista de coordenadas.`, "POLYGON_RING_INVALID");
  const coordinates = value.map((point) => {
    if (!isFiniteCoordinate(point)) {
      throw new PolygonRingsError(`El anillo ${label} contiene una coordenada inválida.`, "POLYGON_COORDINATE_INVALID");
    }
    return cloneCoordinate(point);
  });
  if (coordinates.length > 1 && coordinatesEqual(coordinates[0], coordinates[coordinates.length - 1])) coordinates.pop();
  return coordinates;
}

function isFiniteCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && Number.isFinite(value[0])
    && typeof value[1] === "number"
    && Number.isFinite(value[1]);
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMultiPolygon(value: unknown): boolean {
  return isPlainObject(value) && value.type === "MultiPolygon";
}

function ringSelfIntersects(ring: Coordinate[]): boolean {
  for (let first = 0; first < ring.length; first += 1) {
    const firstNext = (first + 1) % ring.length;
    for (let second = first + 1; second < ring.length; second += 1) {
      const secondNext = (second + 1) % ring.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (first === 0 && secondNext === 0) continue;
      if (segmentsIntersect(ring[first], ring[firstNext], ring[second], ring[secondNext])) return true;
    }
  }
  return false;
}

function ringsTouchOrCross(first: Coordinate[], second: Coordinate[]): boolean {
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % first.length;
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondNext = (secondIndex + 1) % second.length;
      if (segmentsIntersect(first[firstIndex], first[firstNext], second[secondIndex], second[secondNext])) return true;
    }
  }
  return false;
}

function segmentsIntersect(firstStart: Coordinate, firstEnd: Coordinate, secondStart: Coordinate, secondEnd: Coordinate): boolean {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  if (firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation) return true;
  return (firstOrientation === 0 && pointOnSegment(secondStart, firstStart, firstEnd))
    || (secondOrientation === 0 && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (thirdOrientation === 0 && pointOnSegment(firstStart, secondStart, secondEnd))
    || (fourthOrientation === 0 && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function orientation(first: Coordinate, second: Coordinate, third: Coordinate): -1 | 0 | 1 {
  const cross = (second[1] - first[1]) * (third[0] - first[0])
    - (second[0] - first[0]) * (third[1] - first[1]);
  if (Math.abs(cross) <= 1e-12) return 0;
  return cross > 0 ? 1 : -1;
}

function pointOnSegment(point: Coordinate, start: Coordinate, end: Coordinate): boolean {
  return orientation(start, end, point) === 0
    && point[0] >= Math.min(start[0], end[0]) - 1e-12
    && point[0] <= Math.max(start[0], end[0]) + 1e-12
    && point[1] >= Math.min(start[1], end[1]) - 1e-12
    && point[1] <= Math.max(start[1], end[1]) + 1e-12;
}

function pointStrictlyInsideRing(point: Coordinate, ring: Coordinate[]): boolean {
  if (ring.some((start, index) => pointOnSegment(point, start, ring[(index + 1) % ring.length]))) return false;
  return pointInsideOrOnRing(point, ring);
}

function pointInsideOrOnRing(point: Coordinate, ring: Coordinate[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses = (currentPoint[0] > point[0]) !== (previousPoint[0] > point[0]);
    if (crosses) {
      const longitudeAtLatitude = (previousPoint[1] - currentPoint[1]) * (point[0] - currentPoint[0])
        / (previousPoint[0] - currentPoint[0]) + currentPoint[1];
      if (point[1] < longitudeAtLatitude) inside = !inside;
    }
  }
  return inside;
}

function planarTwiceArea(ring: Coordinate[]): number {
  return ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point[1] * next[0] - next[1] * point[0];
  }, 0);
}

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
