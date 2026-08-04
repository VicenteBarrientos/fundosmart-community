import type { Coordinate, Potrero } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculateHectares } from "./geometry.ts";

export type NeighborAreaDelta = Readonly<{
  paddockId: string;
  paddockName: string;
  previousHectares: number;
  newHectares: number;
  deltaHectares: number;
}>;

export type SharedFencePreview = Readonly<{
  targetPaddockId: string;
  affectedNeighbors: readonly NeighborAreaDelta[];
  totalAreaPreserved: boolean;
}>;

/**
 * Calculates area changes for neighbor paddocks affected by a boundary edit.
 */
export function calculateNeighborAreaPreview(
  targetPaddock: Potrero,
  newOuterRing: Coordinate[],
  allPaddocks: readonly Potrero[],
): SharedFencePreview {
  const newTargetArea = calculateHectares(newOuterRing);
  const targetDelta = newTargetArea - targetPaddock.areaHectares;

  const neighbors = allPaddocks.filter(
    (p) => p.id !== targetPaddock.id && p.fieldId === targetPaddock.fieldId,
  );

  const affectedNeighbors: NeighborAreaDelta[] = [];
  let totalNeighborDelta = 0;

  // Simple, deterministic shared boundary delta model
  if (neighbors.length > 0 && Math.abs(targetDelta) > 0.001) {
    const totalNeighborArea = neighbors.reduce((acc, n) => acc + (n.areaHectares || 0), 0);

    for (const neighbor of neighbors) {
      const neighborArea = neighbor.areaHectares || 0;
      const weight = totalNeighborArea > 0 ? neighborArea / totalNeighborArea : 1 / neighbors.length;
      const shareDelta = targetDelta * weight;
      const neighborNewArea = Math.max(0, neighborArea - shareDelta);
      const neighborActualDelta = neighborNewArea - neighborArea;
      totalNeighborDelta += neighborActualDelta;

      affectedNeighbors.push(
        Object.freeze({
          paddockId: neighbor.id,
          paddockName: neighbor.name,
          previousHectares: neighborArea,
          newHectares: neighborNewArea,
          deltaHectares: neighborActualDelta,
        }),
      );
    }
  }

  const areaDiff = Math.abs(targetDelta + totalNeighborDelta);

  return Object.freeze({
    targetPaddockId: targetPaddock.id,
    affectedNeighbors: Object.freeze(affectedNeighbors),
    totalAreaPreserved: areaDiff < 0.01,
  });
}
