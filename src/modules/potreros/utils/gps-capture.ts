import { polygon } from "@turf/helpers";
import simplify from "@turf/simplify";
import type { Feature, Polygon } from "geojson";
import type { Coordinate } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { coordinateDistanceMeters } from "./geometry.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { validatePotreroGeometry, type PotreroGeometryValidation } from "./validate.ts";

export const GPS_MAX_ACCURACY_METERS = 15;
export const GPS_MIN_VERTEX_DISTANCE_METERS = 8;
export const GPS_SIMPLIFY_TOLERANCE_METERS = 2;

const EARTH_RADIUS_METERS = 6_371_008.8;
const GPS_DISTANCE_COMPARISON_EPSILON_METERS = 0.000_001;

export type GpsPositionSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  timestamp: number;
  altitudeMeters?: number | null;
  headingDegrees?: number | null;
  speedMetersPerSecond?: number | null;
};

export type GpsLocationFix = {
  coordinate: Coordinate;
  accuracyMeters: number;
  timestamp: number;
  altitudeMeters: number | null;
  headingDegrees: number | null;
  speedMetersPerSecond: number | null;
};

export type GpsFixDecisionReason =
  | "accepted_first"
  | "accepted_distance"
  | "invalid_sample"
  | "low_accuracy"
  | "too_close";

export type GpsFixDecision = {
  accepted: boolean;
  reason: GpsFixDecisionReason;
  distanceFromLastAcceptedMeters: number | null;
};

export type GpsSampleResult = {
  fix: GpsLocationFix | null;
  acceptedFixes: GpsLocationFix[];
  decision: GpsFixDecision;
};

export type GpsBoundaryContext = {
  siblings?: Coordinate[][];
  fundo?: Coordinate[];
};

export type GpsBoundaryFinalization = {
  coordinates: Coordinate[];
  rawVertexCount: number;
  simplifiedVertexCount: number;
  validation: PotreroGeometryValidation;
  valid: boolean;
};

export function normalizeGpsPositionSample(sample: GpsPositionSample): GpsLocationFix | null {
  if (
    !isFiniteNumber(sample.latitude)
    || !isFiniteNumber(sample.longitude)
    || !isFiniteNumber(sample.accuracyMeters)
    || !isFiniteNumber(sample.timestamp)
    || sample.latitude < -90
    || sample.latitude > 90
    || sample.longitude < -180
    || sample.longitude > 180
    || sample.accuracyMeters < 0
  ) {
    return null;
  }

  return {
    coordinate: [sample.latitude, sample.longitude],
    accuracyMeters: sample.accuracyMeters,
    timestamp: sample.timestamp,
    altitudeMeters: finiteOptionalNumber(sample.altitudeMeters),
    headingDegrees: finiteOptionalNumber(sample.headingDegrees),
    speedMetersPerSecond: finiteOptionalNumber(sample.speedMetersPerSecond),
  };
}

export function evaluateGpsFix(
  acceptedFixes: GpsLocationFix[],
  fix: GpsLocationFix,
): GpsFixDecision {
  if (fix.accuracyMeters >= GPS_MAX_ACCURACY_METERS) {
    return { accepted: false, reason: "low_accuracy", distanceFromLastAcceptedMeters: null };
  }

  const previous = acceptedFixes.at(-1);
  if (!previous) {
    return { accepted: true, reason: "accepted_first", distanceFromLastAcceptedMeters: null };
  }

  const distance = coordinateDistanceMeters(previous.coordinate, fix.coordinate);
  return distance + GPS_DISTANCE_COMPARISON_EPSILON_METERS >= GPS_MIN_VERTEX_DISTANCE_METERS
    ? { accepted: true, reason: "accepted_distance", distanceFromLastAcceptedMeters: distance }
    : { accepted: false, reason: "too_close", distanceFromLastAcceptedMeters: distance };
}

export function processGpsSample(
  acceptedFixes: GpsLocationFix[],
  sample: GpsPositionSample,
): GpsSampleResult {
  const fix = normalizeGpsPositionSample(sample);
  if (!fix) {
    return {
      fix: null,
      acceptedFixes,
      decision: { accepted: false, reason: "invalid_sample", distanceFromLastAcceptedMeters: null },
    };
  }

  const decision = evaluateGpsFix(acceptedFixes, fix);
  return {
    fix,
    decision,
    acceptedFixes: decision.accepted ? [...acceptedFixes, fix] : acceptedFixes,
  };
}

export function finalizeGpsBoundary(
  acceptedFixes: GpsLocationFix[],
  context: GpsBoundaryContext = {},
): GpsBoundaryFinalization {
  const rawCoordinates = acceptedFixes.map(({ coordinate }) => cloneCoordinate(coordinate));
  const openCoordinates = simplifyGpsBoundary(rawCoordinates, GPS_SIMPLIFY_TOLERANCE_METERS);
  const validation = validatePotreroGeometry(
    openCoordinates,
    context.siblings ?? [],
    context.fundo ?? openCoordinates,
  );
  const coordinates = openCoordinates.length === 0 ? [] : closeRing(openCoordinates);

  return {
    coordinates,
    rawVertexCount: rawCoordinates.length,
    simplifiedVertexCount: openCoordinates.length,
    validation,
    valid: validation.errors.length === 0,
  };
}

/**
 * GPS finalization returns a closed ring for interchange/validation, while the
 * interactive Leaflet drafts in this module store only editable vertices.
 */
export function gpsBoundaryCoordinatesToDraft(coordinates: Coordinate[]): Coordinate[] {
  const cloned = coordinates.map(cloneCoordinate);
  return removeClosingPoint(cloned);
}

export function simplifyGpsBoundary(
  coordinates: Coordinate[],
  toleranceMeters = GPS_SIMPLIFY_TOLERANCE_METERS,
): Coordinate[] {
  const open = removeClosingPoint(removeDuplicateNeighbors(coordinates.map(cloneCoordinate)));
  if (open.length < 3 || toleranceMeters <= 0) return open;

  const projection = metricProjection(open);
  if (!projection) return open;
  const projectedRing = closeRing(open).map(([latitude, longitude]) => [
    degreesToRadians(longitude - projection.longitude) * EARTH_RADIUS_METERS * projection.longitudeScale,
    degreesToRadians(latitude - projection.latitude) * EARTH_RADIUS_METERS,
  ]);
  const feature = polygon([projectedRing]) as Feature<Polygon>;
  const simplified = simplify(feature, { tolerance: toleranceMeters, highQuality: true, mutate: false });
  const restored = simplified.geometry.coordinates[0].map(([east, north]) => [
    projection.latitude + radiansToDegrees(north / EARTH_RADIUS_METERS),
    projection.longitude + radiansToDegrees(east / (EARTH_RADIUS_METERS * projection.longitudeScale)),
  ] as Coordinate);
  return removeClosingPoint(removeDuplicateNeighbors(restored));
}

function metricProjection(coordinates: Coordinate[]): {
  latitude: number;
  longitude: number;
  longitudeScale: number;
} | null {
  const sums = coordinates.reduce(
    ([latitude, longitude], coordinate) => [latitude + coordinate[0], longitude + coordinate[1]],
    [0, 0],
  );
  const latitude = sums[0] / coordinates.length;
  const longitudeScale = Math.cos(degreesToRadians(latitude));
  if (Math.abs(longitudeScale) < 1e-8) return null;
  return {
    latitude,
    longitude: sums[1] / coordinates.length,
    longitudeScale,
  };
}

function finiteOptionalNumber(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function removeDuplicateNeighbors(coordinates: Coordinate[]): Coordinate[] {
  return coordinates.filter((coordinate, index) => (
    index === 0 || !coordinatesEqual(coordinate, coordinates[index - 1])
  ));
}

function removeClosingPoint(coordinates: Coordinate[]): Coordinate[] {
  return coordinates.length > 1 && coordinatesEqual(coordinates[0], coordinates.at(-1)!)
    ? coordinates.slice(0, -1)
    : coordinates;
}

function closeRing(coordinates: Coordinate[]): Coordinate[] {
  const cloned = coordinates.map(cloneCoordinate);
  return coordinatesEqual(cloned[0], cloned.at(-1)!) ? cloned : [...cloned, cloneCoordinate(cloned[0])];
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
