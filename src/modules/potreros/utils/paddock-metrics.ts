import type { PaddockLandUse, PolygonRings, Potrero } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateGrossHectares, calculateNetHectares } from "./geometry.ts";

export const LAND_USE_LABELS = {
  pradera_permanente: "Pradera permanente",
  pradera_rotacion: "Pradera en rotación",
  cultivo_forrajero: "Cultivo forrajero",
  cultivo: "Cultivo",
  bosque: "Bosque",
  infraestructura: "Infraestructura",
  otro: "Otro",
} as const satisfies Record<PaddockLandUse, string>;

export type PaddockAreaMetrics = {
  geometry: PolygonRings;
  grossAreaHectares: number;
  netAreaHectares: number;
  grazeableAreaHectares: number | null;
  effectiveGrazeableAreaHectares: number;
  grazeablePercentage: number;
};

export function paddockGeometry(paddock: Pick<Potrero, "coordinates" | "geometry">): PolygonRings {
  return paddock.geometry ?? { outer: paddock.coordinates, holes: [] };
}

export function paddockAreaMetrics(
  paddock: Pick<Potrero, "coordinates" | "geometry" | "grazeableAreaHectares">,
): PaddockAreaMetrics {
  const geometry = paddockGeometry(paddock);
  const grossAreaHectares = calculateGrossHectares(geometry);
  const netAreaHectares = calculateNetHectares(geometry);
  const grazeableAreaHectares = paddock.grazeableAreaHectares ?? null;
  const effectiveGrazeableAreaHectares = grazeableAreaHectares ?? netAreaHectares;
  return {
    geometry,
    grossAreaHectares,
    netAreaHectares,
    grazeableAreaHectares,
    effectiveGrazeableAreaHectares,
    grazeablePercentage: grossAreaHectares > 0
      ? Number((effectiveGrazeableAreaHectares * 100 / grossAreaHectares).toFixed(1))
      : 0,
  };
}

export function formatHectares(value: number): string {
  return `${value.toLocaleString("es-CL", { maximumFractionDigits: 2 })} ha`;
}
