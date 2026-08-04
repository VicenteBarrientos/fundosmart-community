"use client";

import { useEffect, useRef } from "react";
import type { Coordinate } from "../../types";
import type { GisImportMappedFeature, GisImportMappingPlan } from "../../import/mapping";
import {
  decimateImportPreviewPath,
  MAX_IMPORT_PREVIEW_RENDER_VERTICES,
} from "./import-boundaries-state";

const WIDTH = 760;
const HEIGHT = 280;
const PADDING = 24;

export function ImportGeometryPreview({ plan }: { plan: GisImportMappingPlan }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = "#f3f6f1";
    context.fillRect(0, 0, WIDTH, HEIGHT);

    const bounds = coordinateBounds(plan.features);
    if (!bounds) return;
    const project = ([latitude, longitude]: Coordinate): [number, number] => {
      const longitudeSpan = Math.max(bounds.maxLongitude - bounds.minLongitude, 1e-9);
      const latitudeSpan = Math.max(bounds.maxLatitude - bounds.minLatitude, 1e-9);
      return [
        PADDING + (longitude - bounds.minLongitude) / longitudeSpan * (WIDTH - PADDING * 2),
        HEIGHT - PADDING - (latitude - bounds.minLatitude) / latitudeSpan * (HEIGHT - PADDING * 2),
      ];
    };

    let remainingVertices = MAX_IMPORT_PREVIEW_RENDER_VERTICES;
    plan.features.forEach((feature, featureIndex) => {
      const remainingFeatures = plan.features.length - featureIndex;
      const minimum = feature.kind === "polygon" ? 3 : feature.kind === "landmark" && feature.geometry.type === "LineString" ? 2 : 1;
      const featureBudget = Math.min(600, Math.max(minimum, Math.floor(remainingVertices / Math.max(remainingFeatures, 1))));
      let usedVertices = 0;
      if (feature.kind === "polygon") {
        const colors = feature.role === "field_boundary"
          ? { fill: "rgba(23,59,45,0.08)", stroke: "#173b2d" }
          : feature.role === "paddock"
            ? { fill: "rgba(120,169,51,0.24)", stroke: "#4f7d23" }
            : { fill: "rgba(138,149,143,0.12)", stroke: "#8a958f" };
        context.beginPath();
        const minimumHoleBudget = Math.min(feature.geometry.holes.length * 3, Math.max(0, featureBudget - 3));
        const outer = decimateImportPreviewPath(feature.geometry.outer, Math.max(3, featureBudget - minimumHoleBudget));
        traceClosedRing(context, outer, project);
        usedVertices += outer.length;
        for (let holeIndex = 0; holeIndex < feature.geometry.holes.length; holeIndex += 1) {
          const available = featureBudget - usedVertices;
          if (available < 3) break;
          const remainingHoles = feature.geometry.holes.length - holeIndex;
          const sampledHole = decimateImportPreviewPath(feature.geometry.holes[holeIndex], Math.max(3, Math.floor(available / remainingHoles)));
          traceClosedRing(context, sampledHole, project);
          usedVertices += sampledHole.length;
        }
        context.fillStyle = colors.fill;
        context.strokeStyle = colors.stroke;
        context.lineWidth = feature.role === "field_boundary" ? 3 : 2;
        context.fill("evenodd");
        context.stroke();
      } else if (feature.kind === "landmark" && feature.geometry.type === "LineString") {
        const sampledLine = decimateImportPreviewPath(feature.geometry.coordinates, featureBudget);
        context.beginPath();
        traceLine(context, sampledLine, project);
        usedVertices += sampledLine.length;
        context.strokeStyle = feature.role === "ignore" ? "#a7afa9" : "#d97706";
        context.lineWidth = 2.5;
        context.setLineDash([7, 5]);
        context.stroke();
        context.setLineDash([]);
      } else if (feature.kind === "landmark" && feature.geometry.type === "Point") {
        const [x, y] = project(feature.geometry.coordinates);
        context.beginPath();
        context.arc(x, y, 5, 0, Math.PI * 2);
        context.fillStyle = feature.role === "ignore" ? "#a7afa9" : "#d97706";
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.stroke();
        usedVertices += 1;
      }
      remainingVertices = Math.max(0, remainingVertices - usedVertices);
    });
  }, [plan]);

  return (
    <canvas
      aria-label={`Vista previa de ${plan.summary.totalFeatures} geometrías importadas`}
      className="h-auto max-h-72 w-full rounded-2xl border border-line-steel"
      height={HEIGHT}
      ref={canvasRef}
      role="img"
      width={WIDTH}
    />
  );
}

function coordinateBounds(features: readonly GisImportMappedFeature[]) {
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let count = 0;
  const visit = ([latitude, longitude]: Coordinate) => {
    minLatitude = Math.min(minLatitude, latitude);
    maxLatitude = Math.max(maxLatitude, latitude);
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    count += 1;
  };
  features.forEach((feature) => {
    if (feature.kind === "polygon") {
      feature.geometry.outer.forEach(visit);
      feature.geometry.holes.forEach((ring) => ring.forEach(visit));
    }
    else if (feature.kind === "landmark" && feature.geometry.type === "Point") visit(feature.geometry.coordinates);
    else if (feature.kind === "landmark" && feature.geometry.type === "LineString") feature.geometry.coordinates.forEach(visit);
  });
  return count === 0 ? null : { minLatitude, maxLatitude, minLongitude, maxLongitude };
}

function traceClosedRing(
  context: CanvasRenderingContext2D,
  ring: readonly Coordinate[],
  project: (coordinate: Coordinate) => [number, number],
) {
  traceLine(context, ring, project);
  context.closePath();
}

function traceLine(
  context: CanvasRenderingContext2D,
  coordinates: readonly Coordinate[],
  project: (coordinate: Coordinate) => [number, number],
) {
  coordinates.forEach((coordinate, index) => {
    const [x, y] = project(coordinate);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
}
