import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import type { Feature, Polygon } from "geojson";
import type { Coordinate, ExclusionKind, Potrero } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateNetHectares, calculateNetAreaSquareMeters, fromGeoJsonPolygonRings, toGeoJsonPolygon } from "./geometry.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { addPolygonExclusion, assertAlignedHoleKinds, decodeStoredPolygon, removePolygonExclusion } from "./polygon-rings.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { paddockAreaMetrics, paddockGeometry } from "./paddock-metrics.ts";

export const EXCLUSION_KIND_LABELS = {
  laguna: "Laguna",
  bosque: "Bosque",
  construccion: "Construcción",
  roquerio: "Roquerío",
  humedal: "Humedal",
} as const satisfies Record<ExclusionKind, string>;

export const EXCLUSION_KIND_COLORS = {
  laguna: "#38bdf8",
  bosque: "#166534",
  construccion: "#78716c",
  roquerio: "#a16207",
  humedal: "#0f766e",
} as const satisfies Record<ExclusionKind, string>;

export type ExclusionScope =
  | { kind: "field"; fieldId: string; fieldName: string }
  | { kind: "paddock"; fieldId: string; paddockId: string; paddockName: string };

export type ExclusionAffectedPaddock = {
  paddockId: string;
  paddockName: string;
  grossAreaHectares: number;
  previousNetAreaHectares: number;
  nextNetAreaHectares: number;
  excludedAreaHectares: number;
  overrideClamped: boolean;
  updatedPaddock: Potrero;
};

export type ExclusionPreview = {
  operation: "create" | "edit";
  scope: ExclusionScope;
  kind: ExclusionKind;
  exclusion: Coordinate[];
  affected: ExclusionAffectedPaddock[];
  blockers: string[];
  warnings: string[];
  totalExcludedAreaHectares: number;
};

const AREA_EPSILON_SQUARE_METERS = 0.01;

export function buildExclusionPreview({
  scope,
  kind,
  exclusion,
  paddocks,
}: {
  scope: ExclusionScope;
  kind: ExclusionKind;
  exclusion: Coordinate[];
  paddocks: Potrero[];
}): ExclusionPreview {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const affected: ExclusionAffectedPaddock[] = [];
  let exclusionPolygon;

  try {
    exclusionPolygon = toGeoJsonPolygon({ outer: exclusion, holes: [] });
  } catch (cause) {
    blockers.push(messageFrom(cause, "La exclusión dibujada no forma un polígono válido."));
    return finishPreview("create", scope, kind, exclusion, affected, blockers, warnings);
  }

  const candidates = paddocks.filter((paddock) => (
    paddock.fieldId === scope.fieldId
    && !paddock.archivedAt
    && (scope.kind === "field" || paddock.id === scope.paddockId)
  ));
  if (scope.kind === "paddock" && candidates.length === 0) {
    blockers.push("El potrero seleccionado ya no está disponible. Recarga el fundo e inténtalo nuevamente.");
  }

  for (const paddock of candidates) {
    try {
      const geometry = paddockGeometry(paddock);
      const holeKinds = paddock.holeKinds ?? [];
      assertAlignedHoleKinds(geometry.holes, holeKinds);
      const previousSquareMeters = calculateNetAreaSquareMeters(geometry);
      const result = difference(featureCollection([toGeoJsonPolygon(geometry), exclusionPolygon]));
      if (!result) {
        blockers.push(`${paddock.name}: la exclusión eliminaría toda la superficie del potrero.`);
        continue;
      }
      if (result.geometry.type === "MultiPolygon") {
        blockers.push(`${paddock.name}: la exclusión partiría el potrero en varias piezas. MultiPolygon no está soportado en esta versión.`);
        continue;
      }
      const polygonResult = result as Feature<Polygon>;
      const differenceRings = fromGeoJsonPolygonRings(polygonResult);
      const nextSquareMeters = calculateNetAreaSquareMeters(differenceRings);
      if (previousSquareMeters - nextSquareMeters <= AREA_EPSILON_SQUARE_METERS) continue;

      if (!ringsEquivalent(geometry.outer, differenceRings.outer)) {
        blockers.push(`${paddock.name}: la exclusión toca o cruza el borde exterior. Dibújala completamente dentro del potrero.`);
        continue;
      }
      const unmatchedHoles = differenceRings.holes.filter((candidate) => (
        !geometry.holes.some((existing) => ringsEquivalent(existing, candidate))
      ));
      if (differenceRings.holes.length !== geometry.holes.length + 1 || unmatchedHoles.length !== 1) {
        blockers.push(`${paddock.name}: la exclusión toca o se superpone con otra exclusión existente.`);
        continue;
      }

      const added = addPolygonExclusion(geometry, holeKinds, unmatchedHoles[0], kind);
      const previousMetrics = paddockAreaMetrics(paddock);
      const nextNetAreaHectares = calculateNetHectares(added.geometry);
      const currentOverride = paddock.grazeableAreaHectares ?? null;
      const overrideClamped = currentOverride !== null && currentOverride > nextNetAreaHectares;
      const nextOverride = overrideClamped ? nextNetAreaHectares : currentOverride;
      if (overrideClamped) {
        warnings.push(`${paddock.name}: la superficie pastoreable manual bajará a ${formatNumber(nextNetAreaHectares)} ha para no superar la superficie útil.`);
      }
      affected.push({
        paddockId: paddock.id,
        paddockName: paddock.name,
        grossAreaHectares: previousMetrics.grossAreaHectares,
        previousNetAreaHectares: previousMetrics.netAreaHectares,
        nextNetAreaHectares,
        excludedAreaHectares: Number((previousMetrics.netAreaHectares - nextNetAreaHectares).toFixed(2)),
        overrideClamped,
        updatedPaddock: {
          ...paddock,
          coordinates: added.geometry.outer,
          geometry: added.geometry,
          areaHectares: previousMetrics.grossAreaHectares,
          netAreaHectares: nextNetAreaHectares,
          grazeableAreaHectares: nextOverride,
          effectiveGrazeableAreaHectares: nextOverride ?? nextNetAreaHectares,
          holeKinds: added.holeKinds,
        },
      });
    } catch (cause) {
      blockers.push(`${paddock.name}: ${messageFrom(cause, "no fue posible calcular la diferencia de forma segura.")}`);
    }
  }

  if (affected.length === 0 && blockers.length === 0) {
    blockers.push(scope.kind === "field"
      ? "La exclusión no intersecta ningún potrero vigente del fundo."
      : "La exclusión no intersecta la superficie útil del potrero seleccionado.");
  }
  return finishPreview("create", scope, kind, exclusion, affected, blockers, warnings);
}

export function buildExclusionEditPreview({
  paddock,
  exclusionIndex,
  kind,
  exclusion,
}: {
  paddock: Potrero;
  exclusionIndex: number;
  kind: ExclusionKind;
  exclusion: Coordinate[];
}): ExclusionPreview {
  const scope: ExclusionScope = {
    kind: "paddock",
    fieldId: paddock.fieldId,
    paddockId: paddock.id,
    paddockName: paddock.name,
  };
  const blockers: string[] = [];
  const warnings: string[] = [];
  const affected: ExclusionAffectedPaddock[] = [];

  try {
    const geometry = paddockGeometry(paddock);
    const holeKinds = paddock.holeKinds ?? [];
    assertAlignedHoleKinds(geometry.holes, holeKinds);
    if (!Number.isInteger(exclusionIndex) || exclusionIndex < 0 || exclusionIndex >= geometry.holes.length) {
      blockers.push("La exclusión seleccionada ya no está disponible. Recarga el potrero e inténtalo nuevamente.");
      return finishPreview("edit", scope, kind, exclusion, affected, blockers, warnings);
    }
    if (ringsEquivalent(geometry.holes[exclusionIndex], exclusion) && holeKinds[exclusionIndex] === kind) {
      blockers.push("No hay cambios en el borde ni en el tipo de la exclusión.");
      return finishPreview("edit", scope, kind, exclusion, affected, blockers, warnings);
    }

    const nextGeometry = decodeStoredPolygon({
      outer: geometry.outer,
      holes: geometry.holes.map((hole, index) => index === exclusionIndex ? exclusion : hole),
    });
    const nextHoleKinds = holeKinds.map((current, index) => index === exclusionIndex ? kind : current);
    assertAlignedHoleKinds(nextGeometry.holes, nextHoleKinds);

    const previousMetrics = paddockAreaMetrics(paddock);
    const nextNetAreaHectares = calculateNetHectares(nextGeometry);
    const excludedAreaHectares = calculateNetHectares({ outer: exclusion, holes: [] });
    const currentOverride = paddock.grazeableAreaHectares ?? null;
    const overrideClamped = currentOverride !== null && currentOverride > nextNetAreaHectares;
    const nextOverride = overrideClamped ? nextNetAreaHectares : currentOverride;
    if (overrideClamped) {
      warnings.push(`${paddock.name}: la superficie pastoreable manual bajará a ${formatNumber(nextNetAreaHectares)} ha para no superar la superficie útil.`);
    }
    affected.push({
      paddockId: paddock.id,
      paddockName: paddock.name,
      grossAreaHectares: previousMetrics.grossAreaHectares,
      previousNetAreaHectares: previousMetrics.netAreaHectares,
      nextNetAreaHectares,
      excludedAreaHectares,
      overrideClamped,
      updatedPaddock: {
        ...paddock,
        coordinates: nextGeometry.outer,
        geometry: nextGeometry,
        areaHectares: previousMetrics.grossAreaHectares,
        netAreaHectares: nextNetAreaHectares,
        grazeableAreaHectares: nextOverride,
        effectiveGrazeableAreaHectares: nextOverride ?? nextNetAreaHectares,
        holeKinds: nextHoleKinds,
      },
    });
  } catch (cause) {
    blockers.push(`${paddock.name}: ${messageFrom(cause, "no fue posible validar el nuevo borde de la exclusión.")}`);
  }

  return finishPreview("edit", scope, kind, exclusion, affected, blockers, warnings);
}

export function removePaddockExclusion(paddock: Potrero, index: number): Potrero {
  const geometry = paddockGeometry(paddock);
  const removed = removePolygonExclusion(geometry, paddock.holeKinds ?? [], index);
  const grossAreaHectares = paddockAreaMetrics(paddock).grossAreaHectares;
  const netAreaHectares = calculateNetHectares(removed.geometry);
  const manual = paddock.grazeableAreaHectares ?? null;
  return {
    ...paddock,
    coordinates: removed.geometry.outer,
    geometry: removed.geometry,
    areaHectares: grossAreaHectares,
    netAreaHectares,
    effectiveGrazeableAreaHectares: manual ?? netAreaHectares,
    holeKinds: removed.holeKinds,
  };
}

function finishPreview(
  operation: ExclusionPreview["operation"],
  scope: ExclusionScope,
  kind: ExclusionKind,
  exclusion: Coordinate[],
  affected: ExclusionAffectedPaddock[],
  blockers: string[],
  warnings: string[],
): ExclusionPreview {
  return {
    operation,
    scope,
    kind,
    exclusion,
    affected,
    blockers,
    warnings,
    totalExcludedAreaHectares: Number(affected.reduce((sum, item) => sum + item.excludedAreaHectares, 0).toFixed(2)),
  };
}

function ringsEquivalent(first: Coordinate[], second: Coordinate[]): boolean {
  if (first.length !== second.length || first.length === 0) return false;
  for (let start = 0; start < second.length; start += 1) {
    if (!coordinatesNear(first[0], second[start])) continue;
    if (first.every((coordinate, index) => coordinatesNear(coordinate, second[(start + index) % second.length]))) return true;
    if (first.every((coordinate, index) => coordinatesNear(coordinate, second[(start - index + second.length) % second.length]))) return true;
  }
  return false;
}

function coordinatesNear(first: Coordinate, second: Coordinate): boolean {
  return Math.abs(first[0] - second[0]) <= 1e-10 && Math.abs(first[1] - second[1]) <= 1e-10;
}

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function formatNumber(value: number): string {
  return value.toLocaleString("es-CL", { maximumFractionDigits: 2 });
}
