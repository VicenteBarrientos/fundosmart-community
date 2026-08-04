import type { Coordinate } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateAreaSquareMeters, intersectionAreaSquareMeters, selfIntersects } from "./geometry.ts";

export type PotreroGeometryValidation = {
  errors: string[];
  warnings: string[];
};

const MINIMUM_OVERLAP_WARNING_SQUARE_METERS = 1_000;
const MINIMUM_POTRERO_WARNING_SQUARE_METERS = 500;
const MAXIMUM_OUTSIDE_RATIO = 0.01;

export function validatePotreroGeometry(
  candidate: Coordinate[],
  siblings: Coordinate[][],
  fundo: Coordinate[],
): PotreroGeometryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const candidateArea = calculateAreaSquareMeters(candidate);
  const hasSelfIntersection = selfIntersects(candidate);

  if (candidate.length < 3) errors.push("El potrero debe tener al menos 3 vértices.");
  if (candidateArea <= 0) errors.push("El potrero debe tener un área mayor que 0.");
  if (hasSelfIntersection) errors.push("El límite del potrero se cruza consigo mismo.");

  if (candidateArea > 0 && candidateArea < MINIMUM_POTRERO_WARNING_SQUARE_METERS) {
    warnings.push("El potrero tiene menos de 0,05 ha; revisa si fue un clic accidental.");
  }

  if (candidate.length >= 3 && candidateArea > 0 && !hasSelfIntersection) {
    const overlapsSibling = siblings.some((sibling) => (
      sibling.length >= 3
      && intersectionAreaSquareMeters(candidate, sibling) > MINIMUM_OVERLAP_WARNING_SQUARE_METERS
    ));
    if (overlapsSibling) {
      warnings.push("El potrero se superpone más de 0,1 ha con otro potrero.");
    }

    if (fundo.length >= 3) {
      const areaInsideFundo = intersectionAreaSquareMeters(candidate, fundo);
      const outsideRatio = Math.max(0, candidateArea - areaInsideFundo) / candidateArea;
      if (outsideRatio > MAXIMUM_OUTSIDE_RATIO) {
        warnings.push("Más del 1 % del potrero queda fuera del límite del fundo.");
      }
    }
  }

  return { errors, warnings };
}

export function validatePotreroGeometryCollection(
  polygons: Coordinate[][],
  fundo: Coordinate[],
  labels?: string[],
): PotreroGeometryValidation {
  const validations = polygons.map((polygon) => validatePotreroGeometry(polygon, [], fundo));
  const bounds = polygons.map(polygonBounds);
  const overlaps = new Set<number>();

  for (let first = 0; first < polygons.length; first += 1) {
    for (let second = first + 1; second < polygons.length; second += 1) {
      if (!boundsOverlapWithArea(bounds[first], bounds[second])) continue;
      if (intersectionAreaSquareMeters(polygons[first], polygons[second]) <= MINIMUM_OVERLAP_WARNING_SQUARE_METERS) continue;
      overlaps.add(first);
      overlaps.add(second);
    }
  }

  overlaps.forEach((index) => {
    validations[index].warnings.push("El potrero se superpone más de 0,1 ha con otro potrero.");
  });

  return {
    errors: uniqueMessages(validations.flatMap((validation, index) => validation.errors.map((message) => `${labels?.[index] ?? `Área ${index + 1}`}: ${message}`))),
    warnings: uniqueMessages(validations.flatMap((validation, index) => validation.warnings.map((message) => `${labels?.[index] ?? `Área ${index + 1}`}: ${message}`))),
  };
}

type PolygonBounds = { minimumLatitude: number; maximumLatitude: number; minimumLongitude: number; maximumLongitude: number };

function polygonBounds(polygon: Coordinate[]): PolygonBounds {
  return polygon.reduce<PolygonBounds>((bounds, [latitude, longitude]) => ({
    minimumLatitude: Math.min(bounds.minimumLatitude, latitude),
    maximumLatitude: Math.max(bounds.maximumLatitude, latitude),
    minimumLongitude: Math.min(bounds.minimumLongitude, longitude),
    maximumLongitude: Math.max(bounds.maximumLongitude, longitude),
  }), {
    minimumLatitude: Number.POSITIVE_INFINITY,
    maximumLatitude: Number.NEGATIVE_INFINITY,
    minimumLongitude: Number.POSITIVE_INFINITY,
    maximumLongitude: Number.NEGATIVE_INFINITY,
  });
}

function boundsOverlapWithArea(first: PolygonBounds, second: PolygonBounds) {
  return first.minimumLatitude < second.maximumLatitude
    && first.maximumLatitude > second.minimumLatitude
    && first.minimumLongitude < second.maximumLongitude
    && first.maximumLongitude > second.minimumLongitude;
}

function uniqueMessages(messages: string[]) {
  return [...new Set(messages)];
}
