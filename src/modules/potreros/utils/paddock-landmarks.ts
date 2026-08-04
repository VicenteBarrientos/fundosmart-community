import type { Coordinate, Potrero } from "../types";
import type { FieldLandmark } from "../domain/field-landmarks";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { paddockGeometry } from "./paddock-metrics.ts";

/**
 * Landmarks are stored per field, never per paddock: the same watering point can
 * serve two paddocks and a fence line usually crosses several of them. The
 * association is therefore derived from the geometry itself, so it stays correct
 * after a boundary edit, a subdivision or a merge without any extra migration.
 */
export function landmarkBelongsToPaddock(
  landmark: Pick<FieldLandmark, "geometry" | "geometryType">,
  paddock: Pick<Potrero, "coordinates" | "geometry">,
): boolean {
  const rings = paddockGeometry(paddock);
  const outer = rings.outer;
  if (outer.length < 3 || landmark.geometry.length === 0) return false;

  if (landmark.geometryType === "point") {
    const point = landmark.geometry[0];
    return pointInsidePaddock(point, outer, rings.holes);
  }

  if (landmark.geometry.some((vertex) => pointInsidePaddock(vertex, outer, rings.holes))) return true;
  return landmark.geometry.slice(1).some((vertex, index) =>
    segmentCrossesRing(landmark.geometry[index], vertex, outer));
}

export function paddockLandmarks(
  landmarks: readonly FieldLandmark[],
  paddock: Pick<Potrero, "coordinates" | "geometry"> | null,
): FieldLandmark[] {
  if (!paddock) return [];
  return landmarks.filter((landmark) => landmarkBelongsToPaddock(landmark, paddock));
}

/** A landmark inside an exclusion hole is not part of the grazeable paddock. */
function pointInsidePaddock(point: Coordinate, outer: Coordinate[], holes: Coordinate[][]): boolean {
  if (!pointInsideRing(point, outer)) return false;
  return !holes.some((hole) => pointInsideRing(point, hole));
}

function pointInsideRing(point: Coordinate, ring: Coordinate[]): boolean {
  if (ring.length < 3) return false;
  const [latitude, longitude] = point;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [currentLatitude, currentLongitude] = ring[index];
    const [previousLatitude, previousLongitude] = ring[previous];
    const straddles = currentLongitude > longitude !== previousLongitude > longitude;
    if (!straddles) continue;
    const crossingLatitude = currentLatitude
      + (longitude - currentLongitude) * (previousLatitude - currentLatitude) / (previousLongitude - currentLongitude);
    if (latitude < crossingLatitude) inside = !inside;
  }
  return inside;
}

function segmentCrossesRing(start: Coordinate, end: Coordinate, ring: Coordinate[]): boolean {
  return ring.some((vertex, index) =>
    segmentsIntersect(start, end, vertex, ring[(index + 1) % ring.length]));
}

function segmentsIntersect(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
): boolean {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  return firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation;
}

function orientation(origin: Coordinate, first: Coordinate, second: Coordinate): number {
  const value = (first[0] - origin[0]) * (second[1] - origin[1])
    - (first[1] - origin[1]) * (second[0] - origin[0]);
  if (value > 1e-12) return 1;
  if (value < -1e-12) return -1;
  return 0;
}
