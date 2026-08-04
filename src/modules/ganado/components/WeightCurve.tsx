import type { LivestockWeighing } from "@/src/core/domain/types";
import { formatDate, formatNumber } from "../lib/format";

export function WeightCurve({ weighings }: { weighings: LivestockWeighing[] }) {
  const points = [...weighings].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  if (points.length === 0) return null;

  const width = 620;
  const height = 220;
  const margin = { top: 26, right: 18, bottom: 38, left: 48 };
  const weights = points.map((point) => point.weightKg);
  const minWeight = Math.min(...weights);
  const maxWeight = Math.max(...weights);
  const weightRange = Math.max(maxWeight - minWeight, 10);
  const weightFloor = minWeight - weightRange * 0.15;
  const weightCeiling = maxWeight + weightRange * 0.15;
  const firstDay = dayNumber(points[0].recordedAt);
  const lastDay = dayNumber(points[points.length - 1].recordedAt);
  const dayRange = Math.max(lastDay - firstDay, 1);
  const x = (point: LivestockWeighing) => points.length === 1
    ? width / 2
    : margin.left + ((dayNumber(point.recordedAt) - firstDay) / dayRange) * (width - margin.left - margin.right);
  const y = (weightKg: number) => height - margin.bottom
    - ((weightKg - weightFloor) / (weightCeiling - weightFloor)) * (height - margin.top - margin.bottom);
  const line = points.map((point) => `${x(point).toFixed(1)},${y(point.weightKg).toFixed(1)}`).join(" ");
  const references = [minWeight, Math.round((minWeight + maxWeight) / 2), maxWeight]
    .filter((value, index, values) => values.indexOf(value) === index);

  return (
    <svg aria-label="Curva de peso" className="w-full" role="img" viewBox={`0 0 ${width} ${height}`}>
      {references.map((weightKg) => (
        <g key={weightKg}>
          <line stroke="#dfe4dc" strokeDasharray="4 4" x1={margin.left} x2={width - margin.right} y1={y(weightKg)} y2={y(weightKg)} />
          <text fill="#8a958f" fontSize="10" textAnchor="end" x={margin.left - 7} y={y(weightKg) + 4}>{formatNumber(weightKg, 1)}</text>
        </g>
      ))}
      {points.length > 1 && <polyline fill="none" points={line} stroke="#19784b" strokeWidth="3" />}
      {points.map((point) => (
        <g key={point.id}>
          <circle cx={x(point)} cy={y(point.weightKg)} fill="#19784b" r="5" />
          <text fill="#263129" fontSize="11" fontWeight="700" textAnchor="middle" x={x(point)} y={y(point.weightKg) - 11}>{formatNumber(point.weightKg, 1)}</text>
          <text fill="#8a958f" fontSize="9" textAnchor="middle" x={x(point)} y={height - margin.bottom + 18}>{formatDate(point.recordedAt)}</text>
        </g>
      ))}
    </svg>
  );
}

function dayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}
