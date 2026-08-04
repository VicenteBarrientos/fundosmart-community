import intersect from "@turf/intersect";
import { featureCollection, polygon } from "@turf/helpers";
import type { Position } from "geojson";
import type { Coordinate } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateAreaSquareMeters, selfIntersects } from "./geometry.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { normalizePolygon } from "./subdivide.ts";

export type StripCoordinates = Coordinate[] | Coordinate[][] | Coordinate[][][];

export type StripPaddock = {
  id: string;
  name?: string;
  coordinates: StripCoordinates;
};

export type StripCell = {
  id: string;
  name: string;
  index: number;
  coordinates: Coordinate[];
  areaSquareMeters: number;
  startDistanceMeters: number;
  endDistanceMeters: number;
};

export type StripGeneration = {
  paddockId: string;
  count: number;
  bearingDegrees: number;
  stripWidthMeters: number;
  sourceAreaSquareMeters: number;
  cellsAreaSquareMeters: number;
  areaDeltaSquareMeters: number;
  areaToleranceSquareMeters: number;
  cells: StripCell[];
};

export const MAX_STRIP_COUNT = 200;
export const DEFAULT_STRIP_AREA_TOLERANCE_RATIO = 1e-6;
export const DEFAULT_STRIP_AREA_TOLERANCE_SQUARE_METERS = 0.1;

const EARTH_RADIUS_METERS = 6_371_008.8;
const MINIMUM_GEOMETRY_AREA_SQUARE_METERS = 0.01;
const MINIMUM_AXIS_LENGTH_METERS = 0.01;

type LocalPoint = [number, number];

type LocalProjection = {
  originLatitude: number;
  originLongitude: number;
  longitudeScale: number;
};

/**
 * Generates non-persistent grazing cells by slicing a locally projected
 * paddock into equal-width bands. `bearingDegrees` follows map bearings:
 * 0° points north and 90° points east. Cells are ordered from the tail to
 * the head of that arrow.
 *
 * The sum of the generated areas must differ from the source by no more than
 * max(0.1 m², source area * 1e-6). V1 rejects holes and any slice that would
 * need a MultiPolygon, because its cell model can store only one outer ring.
 */
export function generateStripCells(
  paddock: StripPaddock,
  count: number,
  bearingDegrees: number,
): StripGeneration {
  validateCount(count);
  if (!Number.isFinite(bearingDegrees)) {
    throw new RangeError("La orientación de las franjas debe ser un número finito.");
  }

  const sourceCoordinates = normalizeAndValidateSource(paddock.coordinates);
  const sourceAreaSquareMeters = calculateAreaSquareMeters(sourceCoordinates);
  const projection = createProjection(sourceCoordinates);
  const bearing = normalizeBearing(bearingDegrees);
  const bearingRadians = degreesToRadians(bearing);
  const rotated = sourceCoordinates.map((coordinate) => rotateToBearing(
    projectCoordinate(coordinate, projection),
    bearingRadians,
  ));
  const bounds = localBounds(rotated);
  const forwardLength = bounds.maxForward - bounds.minForward;
  const crossLength = bounds.maxCross - bounds.minCross;

  if (
    sourceAreaSquareMeters <= MINIMUM_GEOMETRY_AREA_SQUARE_METERS
    || forwardLength <= MINIMUM_AXIS_LENGTH_METERS
    || crossLength <= MINIMUM_AXIS_LENGTH_METERS
  ) {
    throw new Error("El potrero es degenerado y no se puede dividir en franjas.");
  }

  const stripWidthMeters = forwardLength / count;
  const bearingKey = stableNumberKey(bearing);
  const cells = Array.from({ length: count }, (_, zeroBasedIndex) => {
    const bandStart = bounds.minForward + stripWidthMeters * zeroBasedIndex;
    const bandEnd = zeroBasedIndex === count - 1
      ? bounds.maxForward
      : bounds.minForward + stripWidthMeters * (zeroBasedIndex + 1);
    const clippedCoordinates = intersectBand(rotated, {
      minForward: bandStart,
      maxForward: bandEnd,
      minCross: bounds.minCross,
      maxCross: bounds.maxCross,
    });
    const coordinates = normalizePolygon(clippedCoordinates.map((point) => unprojectCoordinate(
      rotateFromBearing(point, bearingRadians),
      projection,
    )));
    const areaSquareMeters = calculateAreaSquareMeters(coordinates);

    if (coordinates.length < 3 || areaSquareMeters <= MINIMUM_GEOMETRY_AREA_SQUARE_METERS) {
      throw new Error(`La franja ${zeroBasedIndex + 1} no produce un polígono con área utilizable.`);
    }

    const index = zeroBasedIndex + 1;
    return {
      id: `${paddock.id}:strip:${count}:${bearingKey}:${index}`,
      name: `${paddock.name?.trim() || paddock.id} · Franja ${index}/${count}`,
      index,
      coordinates,
      areaSquareMeters,
      startDistanceMeters: stripWidthMeters * zeroBasedIndex,
      endDistanceMeters: stripWidthMeters * index,
    } satisfies StripCell;
  });

  const cellsAreaSquareMeters = cells.reduce((sum, cell) => sum + cell.areaSquareMeters, 0);
  const areaDeltaSquareMeters = cellsAreaSquareMeters - sourceAreaSquareMeters;
  const areaToleranceSquareMeters = Math.max(
    DEFAULT_STRIP_AREA_TOLERANCE_SQUARE_METERS,
    sourceAreaSquareMeters * DEFAULT_STRIP_AREA_TOLERANCE_RATIO,
  );

  if (Math.abs(areaDeltaSquareMeters) > areaToleranceSquareMeters) {
    throw new Error(
      `Las franjas no conservan el área: diferencia ${Math.abs(areaDeltaSquareMeters).toFixed(3)} m², `
      + `tolerancia ${areaToleranceSquareMeters.toFixed(3)} m².`,
    );
  }

  return {
    paddockId: paddock.id,
    count,
    bearingDegrees: bearing,
    stripWidthMeters,
    sourceAreaSquareMeters,
    cellsAreaSquareMeters,
    areaDeltaSquareMeters,
    areaToleranceSquareMeters,
    cells,
  };
}

function validateCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > MAX_STRIP_COUNT) {
    throw new RangeError(`La cantidad de franjas debe ser un entero entre 2 y ${MAX_STRIP_COUNT}.`);
  }
}

function normalizeAndValidateSource(input: StripCoordinates): Coordinate[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("El potrero no tiene una geometría utilizable.");
  }

  let outerRing: Coordinate[];
  if (isCoordinate(input[0])) {
    outerRing = input as Coordinate[];
  } else if (isCoordinate((input[0] as unknown[] | undefined)?.[0])) {
    const rings = input as Coordinate[][];
    if (rings.length !== 1) {
      throw new Error("El generador V1 no admite potreros con huecos.");
    }
    outerRing = rings[0];
  } else {
    throw new Error("El generador V1 no admite geometrías MultiPolygon.");
  }

  const normalized = normalizePolygon(outerRing.map((coordinate) => [...coordinate] as Coordinate));
  if (
    normalized.length < 3
    || normalized.some(([latitude, longitude]) => !Number.isFinite(latitude) || !Number.isFinite(longitude))
    || calculateAreaSquareMeters(normalized) <= MINIMUM_GEOMETRY_AREA_SQUARE_METERS
  ) {
    throw new Error("El potrero es degenerado y no se puede dividir en franjas.");
  }
  if (selfIntersects(normalized)) {
    throw new Error("El límite del potrero se cruza consigo mismo.");
  }
  return normalized;
}

function createProjection(coordinates: Coordinate[]): LocalProjection {
  const [latitudeSum, longitudeSum] = coordinates.reduce(
    ([latitude, longitude], coordinate) => [latitude + coordinate[0], longitude + coordinate[1]],
    [0, 0],
  );
  const seedLatitude = latitudeSum / coordinates.length;
  const seedLongitudeScale = Math.cos(degreesToRadians(seedLatitude));
  if (Math.abs(seedLongitudeScale) <= Number.EPSILON) {
    throw new Error("No se puede proyectar un potrero ubicado en un polo geográfico.");
  }
  const seedProjection = {
    originLatitude: seedLatitude,
    originLongitude: longitudeSum / coordinates.length,
    longitudeScale: seedLongitudeScale,
  };
  const [centroidEast, centroidNorth] = localPolygonCentroid(
    coordinates.map((coordinate) => projectCoordinate(coordinate, seedProjection)),
  );
  const [originLatitude, originLongitude] = unprojectCoordinate(
    [centroidEast, centroidNorth],
    seedProjection,
  );
  const longitudeScale = Math.cos(degreesToRadians(originLatitude));
  if (Math.abs(longitudeScale) <= Number.EPSILON) {
    throw new Error("No se puede proyectar un potrero ubicado en un polo geográfico.");
  }
  return {
    originLatitude,
    originLongitude,
    longitudeScale,
  };
}

function localPolygonCentroid(points: LocalPoint[]): LocalPoint {
  let twiceSignedArea = 0;
  let eastWeightedSum = 0;
  let northWeightedSum = 0;
  points.forEach(([east, north], index) => {
    const [nextEast, nextNorth] = points[(index + 1) % points.length];
    const cross = east * nextNorth - nextEast * north;
    twiceSignedArea += cross;
    eastWeightedSum += (east + nextEast) * cross;
    northWeightedSum += (north + nextNorth) * cross;
  });
  if (Math.abs(twiceSignedArea) <= Number.EPSILON) return [0, 0];
  return [
    eastWeightedSum / (3 * twiceSignedArea),
    northWeightedSum / (3 * twiceSignedArea),
  ];
}

function projectCoordinate([latitude, longitude]: Coordinate, projection: LocalProjection): LocalPoint {
  const north = degreesToRadians(latitude - projection.originLatitude) * EARTH_RADIUS_METERS;
  const east = degreesToRadians(longitude - projection.originLongitude)
    * EARTH_RADIUS_METERS
    * projection.longitudeScale;
  return [east, north];
}

function unprojectCoordinate([east, north]: LocalPoint, projection: LocalProjection): Coordinate {
  return [
    projection.originLatitude + radiansToDegrees(north / EARTH_RADIUS_METERS),
    projection.originLongitude + radiansToDegrees(east / (EARTH_RADIUS_METERS * projection.longitudeScale)),
  ];
}

// Local output is [forward along the arrow, cross-arrow].
function rotateToBearing([east, north]: LocalPoint, bearingRadians: number): LocalPoint {
  const sin = Math.sin(bearingRadians);
  const cos = Math.cos(bearingRadians);
  return [east * sin + north * cos, east * cos - north * sin];
}

function rotateFromBearing([forward, cross]: LocalPoint, bearingRadians: number): LocalPoint {
  const sin = Math.sin(bearingRadians);
  const cos = Math.cos(bearingRadians);
  return [forward * sin + cross * cos, forward * cos - cross * sin];
}

function localBounds(points: LocalPoint[]) {
  return points.reduce((bounds, [forward, cross]) => ({
    minForward: Math.min(bounds.minForward, forward),
    maxForward: Math.max(bounds.maxForward, forward),
    minCross: Math.min(bounds.minCross, cross),
    maxCross: Math.max(bounds.maxCross, cross),
  }), {
    minForward: Number.POSITIVE_INFINITY,
    maxForward: Number.NEGATIVE_INFINITY,
    minCross: Number.POSITIVE_INFINITY,
    maxCross: Number.NEGATIVE_INFINITY,
  });
}

function intersectBand(
  polygonCoordinates: LocalPoint[],
  bounds: { minForward: number; maxForward: number; minCross: number; maxCross: number },
): LocalPoint[] {
  const source = polygon([closeLocalRing(polygonCoordinates)]);
  const band = polygon([[
    [bounds.minForward, bounds.minCross],
    [bounds.maxForward, bounds.minCross],
    [bounds.maxForward, bounds.maxCross],
    [bounds.minForward, bounds.maxCross],
    [bounds.minForward, bounds.minCross],
  ]]);
  const result = intersect(featureCollection([source, band]));

  if (!result) {
    throw new Error("Una banda no intersecta el potrero y no puede representarse como celda.");
  }
  if (result.geometry.type !== "Polygon") {
    throw new Error("Una franja produciría un MultiPolygon; el modelo de celdas V1 no puede representarlo.");
  }
  if (result.geometry.coordinates.length !== 1) {
    throw new Error("Una franja produciría un polígono con huecos; el modelo de celdas V1 no puede representarlo.");
  }

  return removeClosingLocalPoint(result.geometry.coordinates[0].map(toLocalPoint));
}

function closeLocalRing(points: LocalPoint[]): Position[] {
  const ring = points.map(([first, second]) => [first, second]);
  if (!localPointsEqual(points[0], points[points.length - 1])) {
    ring.push([points[0][0], points[0][1]]);
  }
  return ring;
}

function removeClosingLocalPoint(points: LocalPoint[]): LocalPoint[] {
  if (points.length > 1 && localPointsEqual(points[0], points[points.length - 1])) {
    return points.slice(0, -1);
  }
  return points;
}

function toLocalPoint(position: Position): LocalPoint {
  return [position[0], position[1]];
}

function localPointsEqual(first: LocalPoint, second: LocalPoint): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function isCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number";
}

function normalizeBearing(value: number): number {
  const normalized = value % 360;
  return Object.is(normalized, -0) || normalized === 0 ? 0 : normalized < 0 ? normalized + 360 : normalized;
}

function stableNumberKey(value: number): string {
  return String(value).replace("-", "m").replace(".", "_");
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
