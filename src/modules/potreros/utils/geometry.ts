import area from "@turf/area";
import booleanWithin from "@turf/boolean-within";
import buffer from "@turf/buffer";
import intersect from "@turf/intersect";
import kinks from "@turf/kinks";
import length from "@turf/length";
import { featureCollection, lineString, polygon } from "@turf/helpers";
import type { Feature, Polygon } from "geojson";
import type { Coordinate, PolygonRings, StoredPolygon } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { decodeStoredPolygon } from "./polygon-rings.ts";

export type CoordinateRings = Coordinate[] | Coordinate[][];
export type PolygonGeometryInput = StoredPolygon | Coordinate[][];
export type GeoJsonPolygon = Feature<Polygon> | Polygon;
export type DegreeAxis = "latitude" | "longitude";

const EARTH_RADIUS_METERS = 6_371_008.8;
const OVERLAP_AREA_EPSILON_SQUARE_METERS = 0.01;

/** Net polygon area: the outer ring minus every interior exclusion. */
export function calculateAreaSquareMeters(input: PolygonGeometryInput): number {
  const rings = calculationRings(input);
  if (!isUsableRing(rings.outer) || rings.holes.some((hole) => !isUsableRing(hole))) return 0;
  return area(rawGeoJsonPolygon(rings));
}

export function calculateNetAreaSquareMeters(input: PolygonGeometryInput): number {
  return calculateAreaSquareMeters(input);
}

/** Gross cadastral area: the complete outer ring, without subtracting holes. */
export function calculateGrossAreaSquareMeters(input: PolygonGeometryInput): number {
  const { outer } = calculationRings(input);
  if (!isUsableRing(outer)) return 0;
  return area(rawGeoJsonPolygon({ outer, holes: [] }));
}

export function calculateHectares(input: PolygonGeometryInput): number {
  return roundHectares(calculateAreaSquareMeters(input));
}

export function calculateNetHectares(input: PolygonGeometryInput): number {
  return calculateHectares(input);
}

export function calculateGrossHectares(input: PolygonGeometryInput): number {
  return roundHectares(calculateGrossAreaSquareMeters(input));
}

/** Polygon perimeter includes the outer boundary and all inner boundaries. */
export function calculatePerimeterMeters(input: PolygonGeometryInput): number {
  const rings = calculationRings(input);
  if (!isUsableRing(rings.outer) || rings.holes.some((hole) => !isUsableRing(hole))) return 0;
  return [rings.outer, ...rings.holes].reduce((sum, ring) => sum + calculatePathLengthMeters(closeRing(ring)), 0);
}

export function calculatePathLengthMeters(points: Coordinate[]): number {
  if (points.length < 2) return 0;
  return length(lineString(points.map(([latitude, longitude]) => [longitude, latitude])), { units: "meters" });
}

/** Converts application [latitude, longitude] rings to a closed GeoJSON Polygon. */
export function toGeoJsonPolygon(input: PolygonGeometryInput): Feature<Polygon> {
  const rings = strictRings(input);
  return rawGeoJsonPolygon(rings);
}

/** Preserves the historical array-of-rings return contract. */
export function fromGeoJsonPolygon(input: GeoJsonPolygon): Coordinate[][] {
  const rings = fromGeoJsonPolygonRings(input);
  return [rings.outer, ...rings.holes];
}

export function fromGeoJsonPolygonRings(input: GeoJsonPolygon): PolygonRings {
  const geometry = input.type === "Feature" ? input.geometry : input;
  if (geometry.type !== "Polygon") throw new Error("MultiPolygon no está soportado en esta versión.");
  const rings = geometry.coordinates.map((ring) => removeClosingCoordinate(
    ring.map(([longitude, latitude]) => [latitude, longitude] as Coordinate),
  ));
  return decodeStoredPolygon({ outer: rings[0] ?? [], holes: rings.slice(1) });
}

export function metersToDegrees(meters: number, latitude: number, axis: DegreeAxis = "longitude"): number {
  const latitudeDelta = radiansToDegrees(meters / EARTH_RADIUS_METERS);
  if (axis === "latitude") return latitudeDelta;
  const latitudeCosine = Math.abs(Math.cos(degreesToRadians(latitude)));
  return latitudeCosine < Number.EPSILON ? Number.POSITIVE_INFINITY : latitudeDelta / latitudeCosine;
}

export function coordinateDistanceMeters(first: Coordinate, second: Coordinate): number {
  const firstLatitude = degreesToRadians(first[0]);
  const secondLatitude = degreesToRadians(second[0]);
  const latitudeDelta = secondLatitude - firstLatitude;
  const longitudeDelta = degreesToRadians(second[1] - first[1]);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const haversine = sinLatitude * sinLatitude
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * sinLongitude * sinLongitude;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function selfIntersects(input: PolygonGeometryInput): boolean {
  const rings = calculationRings(input);
  return [rings.outer, ...rings.holes].some((ring) => (
    ring.length >= 4 && ring.every(isCoordinate) && kinks(rawGeoJsonPolygon({ outer: ring, holes: [] })).features.length > 0
  ));
}

export function intersectionAreaSquareMeters(first: PolygonGeometryInput, second: PolygonGeometryInput): number {
  if (!hasUsablePolygon(first) || !hasUsablePolygon(second)) return 0;
  const intersection = intersect(featureCollection([toGeoJsonPolygon(first), toGeoJsonPolygon(second)]));
  return intersection ? area(intersection) : 0;
}

export function polygonsOverlap(first: PolygonGeometryInput, second: PolygonGeometryInput): boolean {
  return intersectionAreaSquareMeters(first, second) > OVERLAP_AREA_EPSILON_SQUARE_METERS;
}

export function containsPolygon(outer: PolygonGeometryInput, inner: PolygonGeometryInput, toleranceMeters = 0): boolean {
  if (!hasUsablePolygon(outer) || !hasUsablePolygon(inner)) return false;
  const outerPolygon = toGeoJsonPolygon(outer);
  const innerPolygon = toGeoJsonPolygon(inner);
  if (booleanWithin(innerPolygon, outerPolygon)) return true;
  if (toleranceMeters <= 0) return false;
  const tolerantOuter = buffer(outerPolygon, toleranceMeters, { units: "meters" });
  return tolerantOuter ? booleanWithin(innerPolygon, tolerantOuter) : false;
}

function strictRings(input: PolygonGeometryInput): PolygonRings {
  if (isPolygonRings(input)) return decodeStoredPolygon(input);
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Un polígono GeoJSON necesita al menos tres vértices por anillo.");
  }
  const candidate = isCoordinate(input[0])
    ? { outer: input as Coordinate[], holes: [] }
    : { outer: (input as Coordinate[][])[0] ?? [], holes: (input as Coordinate[][]).slice(1) };
  return decodeStoredPolygon(candidate);
}

function rawGeoJsonPolygon(rings: PolygonRings): Feature<Polygon> {
  return polygon([rings.outer, ...rings.holes]
    .map((ring) => closeRing(ring).map(([latitude, longitude]) => [longitude, latitude])));
}

function calculationRings(input: PolygonGeometryInput): PolygonRings {
  if (isPolygonRings(input)) return decodeStoredPolygon(input);
  if (!Array.isArray(input) || input.length === 0) return { outer: [], holes: [] };
  return isCoordinate(input[0])
    ? { outer: cloneRing(input as Coordinate[]), holes: [] }
    : {
        outer: cloneRing((input as Coordinate[][])[0] ?? []),
        holes: (input as Coordinate[][]).slice(1).map(cloneRing),
      };
}

function isPolygonRings(value: PolygonGeometryInput): value is PolygonRings {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object" && "outer" in value && "holes" in value;
}

function hasUsablePolygon(input: PolygonGeometryInput): boolean {
  const rings = calculationRings(input);
  return isUsableRing(rings.outer) && rings.holes.every(isUsableRing);
}

function isUsableRing(ring: Coordinate[]): boolean {
  return ring.length >= 3 && ring.every(isCoordinate) && !hasZeroPlanarArea(ring);
}

function isCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && Number.isFinite(value[0])
    && typeof value[1] === "number"
    && Number.isFinite(value[1]);
}

function cloneRing(ring: Coordinate[]): Coordinate[] {
  return ring.map(([latitude, longitude]) => [latitude, longitude]);
}

function closeRing(ring: Coordinate[]): Coordinate[] {
  if (coordinatesEqual(ring[0], ring[ring.length - 1])) return [...ring];
  return [...ring, ring[0]];
}

function removeClosingCoordinate(ring: Coordinate[]): Coordinate[] {
  if (ring.length > 1 && coordinatesEqual(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring;
}

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function hasZeroPlanarArea(points: Coordinate[]): boolean {
  const [originLatitude, originLongitude] = points[0];
  const twiceArea = points.reduce((sum, [latitude, longitude], index) => {
    const [nextLatitude, nextLongitude] = points[(index + 1) % points.length];
    return sum
      + (longitude - originLongitude) * (nextLatitude - originLatitude)
      - (nextLongitude - originLongitude) * (latitude - originLatitude);
  }, 0);
  return Math.abs(twiceArea) <= Number.EPSILON;
}

function roundHectares(squareMeters: number): number {
  return Number((squareMeters / 10_000).toFixed(2));
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}
