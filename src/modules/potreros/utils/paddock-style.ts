import type { PaddockLandUse, Potrero, SoilAnalysis } from "../types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { DEFAULT_LONG_REST_DAYS, DEFAULT_RECENT_DAYS, evaluatePaddockRotation } from "./rotation.ts";
import type { RotationClass, RotationDate, RotationPaddockInput, RotationThresholds } from "./rotation";

export const PADDOCK_THEMATIC_MODE_LABELS = {
  status: "Estado",
  sector: "Sector",
  land_use: "Uso de suelo",
  ph: "pH",
  rotation: "Rotación",
  ndvi: "NDVI",
} as const;

export type PaddockThematicMode = keyof typeof PADDOCK_THEMATIC_MODE_LABELS;

export type PaddockStyleInput = Pick<Potrero, "id" | "name"> & {
  status?: Potrero["status"] | null;
  sector?: string | null;
  landUse?: PaddockLandUse | null;
  soil?: Partial<SoilAnalysis> | null;
};

export type PaddockRotationSnapshot = Pick<RotationPaddockInput, "grazingDates" | "assignedLotCount">;

export type PaddockNdviSnapshot = {
  meanNdvi: number | null;
  observedAt: string | Date | null;
  cloudPct?: number | null;
};

export type PaddockStyleContext = {
  selected?: boolean;
  focused?: boolean;
  sectors?: readonly (string | null | undefined)[];
  rotationSnapshot?: PaddockRotationSnapshot | null;
  rotationReferenceDate?: RotationDate | null;
  rotationThresholds?: RotationThresholds;
  ndviSnapshot?: PaddockNdviSnapshot | null;
};

/** A Leaflet-compatible shape without importing Leaflet or touching the DOM. */
export type PaddockPathStyle = {
  color: string;
  fillColor: string;
  fillOpacity: number;
  opacity: number;
  weight: number;
  dashArray?: string;
};

export type PaddockStyle = {
  mode: PaddockThematicMode;
  categoryKey: string;
  label: string;
  detail: string;
  hasData: boolean;
  selected: boolean;
  focused: boolean;
  textColor: "#000000" | "#FFFFFF";
  pathOptions: PaddockPathStyle;
};

export type PaddockLegendEntry = {
  key: string;
  label: string;
  color: string;
  textColor: "#000000" | "#FFFFFF";
  hasData: boolean;
};

export type PaddockLegend = {
  mode: PaddockThematicMode;
  title: string;
  entries: PaddockLegendEntry[];
};

type SemanticDefinition<Value extends string = string> = {
  value: Value;
  key: string;
  label: string;
  color: string;
};

type ClassifiedPaddock = Omit<SemanticDefinition, "value"> & {
  detail: string;
  hasData: boolean;
};

const STATUS_DEFINITIONS: readonly SemanticDefinition<NonNullable<PaddockStyleInput["status"]>>[] = [
  { value: "Disponible", key: "status:available", label: "Disponible", color: "#007A3D" },
  { value: "En pastoreo", key: "status:grazing", label: "En pastoreo", color: "#C2410C" },
  { value: "En descanso", key: "status:resting", label: "En descanso", color: "#2563EB" },
];

const LAND_USE_DEFINITIONS: readonly SemanticDefinition<PaddockLandUse>[] = [
  { value: "pradera_permanente", key: "land_use:permanent_pasture", label: "Pradera permanente", color: "#009E73" },
  { value: "pradera_rotacion", key: "land_use:rotation_pasture", label: "Pradera de rotación", color: "#0072B2" },
  { value: "cultivo_forrajero", key: "land_use:forage_crop", label: "Cultivo forrajero", color: "#E69F00" },
  { value: "cultivo", key: "land_use:crop", label: "Cultivo", color: "#CC79A7" },
  { value: "bosque", key: "land_use:forest", label: "Bosque", color: "#166534" },
  { value: "infraestructura", key: "land_use:infrastructure", label: "Infraestructura", color: "#475569" },
  { value: "otro", key: "land_use:other", label: "Otro", color: "#6D28D9" },
];

const PH_DEFINITIONS = [
  { value: "very_acidic", key: "ph:very_acidic", label: "Muy ácido (< 5,5)", color: "#440154" },
  { value: "acidic", key: "ph:acidic", label: "Ácido (5,5–5,9)", color: "#31688E" },
  { value: "suitable", key: "ph:suitable", label: "Adecuado (6,0–6,5)", color: "#35B779" },
  { value: "high", key: "ph:high", label: "Alto (> 6,5)", color: "#FDE725" },
] as const satisfies readonly SemanticDefinition[];

const NDVI_DEFINITIONS = [
  { value: "very_low", key: "ndvi:very_low", label: "Muy bajo (< 0,2)", color: "#00204C" },
  { value: "low", key: "ndvi:low", label: "Bajo (0,2–0,39)", color: "#586E8C" },
  { value: "medium", key: "ndvi:medium", label: "Medio (0,4–0,59)", color: "#A5A66A" },
  { value: "high", key: "ndvi:high", label: "Alto (≥ 0,6)", color: "#FFE945" },
] as const satisfies readonly SemanticDefinition[];

const ROTATION_COLORS: Record<RotationClass, string> = {
  occupied: "#B91C1C",
  recent: "#B45309",
  ready: "#4D7C0F",
  long_rest: "#166534",
};

const SECTOR_COLORS = [
  "#0072B2",
  "#D55E00",
  "#009E73",
  "#CC79A7",
  "#E69F00",
  "#6D28D9",
  "#00838F",
  "#A63D40",
] as const;

const MISSING_DEFINITION = {
  key: "missing",
  label: "Sin dato",
  color: "#6B7280",
} as const;

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"] as const;

export function getPaddockStyle(
  paddock: PaddockStyleInput,
  mode: PaddockThematicMode,
  context: PaddockStyleContext = {},
): PaddockStyle {
  const classified = classifyPaddock(paddock, mode, context);
  const selected = context.selected === true;
  const focused = context.focused === true;
  const interaction = interactionStyle(selected, focused);
  const dashArray = interaction.dashArray ?? (classified.hasData ? undefined : "4 4");
  const pathOptions: PaddockPathStyle = {
    color: interaction.color,
    fillColor: classified.color,
    fillOpacity: classified.hasData ? selected ? 0.76 : focused ? 0.68 : 0.58 : 0.36,
    opacity: 1,
    weight: interaction.weight,
    ...(dashArray ? { dashArray } : {}),
  };

  return {
    mode,
    categoryKey: classified.key,
    label: classified.label,
    detail: classified.detail,
    hasData: classified.hasData,
    selected,
    focused,
    textColor: readableTextColor(classified.color),
    pathOptions,
  };
}

export function getPaddockLegend(
  mode: PaddockThematicMode,
  context: PaddockStyleContext = {},
): PaddockLegend {
  const definitions = legendDefinitions(mode, context);
  return {
    mode,
    title: PADDOCK_THEMATIC_MODE_LABELS[mode],
    entries: [...definitions, MISSING_DEFINITION].map((definition) => ({
      key: definition.key,
      label: definition.label,
      color: definition.color,
      textColor: readableTextColor(definition.color),
      hasData: definition.key !== MISSING_DEFINITION.key,
    })),
  };
}

function classifyPaddock(
  paddock: PaddockStyleInput,
  mode: PaddockThematicMode,
  context: PaddockStyleContext,
): ClassifiedPaddock {
  switch (mode) {
    case "status":
      return classifyFixed(paddock.status, STATUS_DEFINITIONS, "Sin dato de estado");
    case "sector":
      return classifySector(paddock.sector);
    case "land_use":
      return classifyFixed(paddock.landUse, LAND_USE_DEFINITIONS, "Sin dato de uso de suelo");
    case "ph":
      return classifyPh(paddock.soil?.ph);
    case "rotation":
      return classifyRotation(paddock, context);
    case "ndvi":
      return classifyNdvi(context.ndviSnapshot);
    default:
      return exhaustiveMode(mode);
  }
}

function classifyFixed<Value extends string>(
  value: Value | null | undefined,
  definitions: readonly SemanticDefinition<Value>[],
  missingDetail: string,
): ClassifiedPaddock {
  const definition = definitions.find((candidate) => candidate.value === value);
  return definition ? withDetail(definition, definition.label) : missing(missingDetail);
}

function classifySector(value: string | null | undefined): ClassifiedPaddock {
  const sector = normalizeSector(value);
  if (!sector) return missing("Sin dato de sector");
  return {
    key: `sector:${sector.key}`,
    label: sector.label,
    color: sectorColor(sector.key),
    detail: `Sector ${sector.label}`,
    hasData: true,
  };
}

function classifyPh(value: number | null | undefined): ClassifiedPaddock {
  if (!isFiniteInRange(value, 0, 14)) return missing("Sin dato de pH válido");
  const definition = value < 5.5
    ? PH_DEFINITIONS[0]
    : value < 6
      ? PH_DEFINITIONS[1]
      : value <= 6.5
        ? PH_DEFINITIONS[2]
        : PH_DEFINITIONS[3];
  return withDetail(definition, `pH ${formatNumber(value, 1)} · ${definition.label}`);
}

function classifyRotation(paddock: PaddockStyleInput, context: PaddockStyleContext): ClassifiedPaddock {
  if (!context.rotationSnapshot || context.rotationReferenceDate == null) {
    return missing("Sin datos de rotación");
  }
  const evaluation = evaluatePaddockRotation({
    id: paddock.id,
    name: paddock.name,
    ...context.rotationSnapshot,
  }, {
    referenceDate: context.rotationReferenceDate,
    ...context.rotationThresholds,
  });
  if (evaluation.classification !== "occupied" && evaluation.dataQuality !== "valid") {
    return missing(rotationMissingDetail(evaluation.dataQuality));
  }
  const definitions = rotationDefinitions({
    recentDays: evaluation.recentDaysThreshold,
    longRestDays: evaluation.longRestDaysThreshold,
  });
  const definition = definitions.find((candidate) => candidate.value === evaluation.classification);
  if (!definition) return missing("Sin datos de rotación");
  const detail = evaluation.classification === "occupied"
    ? `${definition.label} · ${evaluation.assignedLotCount} ${evaluation.assignedLotCount === 1 ? "lote" : "lotes"}`
    : `${definition.label} · ${evaluation.restDays} días`;
  return withDetail(definition, detail);
}

function classifyNdvi(snapshot: PaddockNdviSnapshot | null | undefined): ClassifiedPaddock {
  const observedMonth = parseObservedMonth(snapshot?.observedAt);
  const value = snapshot?.meanNdvi;
  if (!observedMonth || !isFiniteInRange(value, -1, 1)) {
    return missing("Sin NDVI con fecha válida");
  }
  const definition = value < 0.2
    ? NDVI_DEFINITIONS[0]
    : value < 0.4
      ? NDVI_DEFINITIONS[1]
      : value < 0.6
        ? NDVI_DEFINITIONS[2]
        : NDVI_DEFINITIONS[3];
  return withDetail(definition, `NDVI ${formatNumber(value, 2)} · ${observedMonth.label}`);
}

function legendDefinitions(
  mode: PaddockThematicMode,
  context: PaddockStyleContext,
): readonly Omit<SemanticDefinition, "value">[] {
  switch (mode) {
    case "status":
      return STATUS_DEFINITIONS;
    case "sector":
      return sectorDefinitions(context.sectors ?? []);
    case "land_use":
      return LAND_USE_DEFINITIONS;
    case "ph":
      return PH_DEFINITIONS;
    case "rotation":
      return rotationDefinitions(context.rotationThresholds);
    case "ndvi":
      return NDVI_DEFINITIONS;
    default:
      return exhaustiveMode(mode);
  }
}

function rotationDefinitions(thresholds: RotationThresholds = {}): readonly SemanticDefinition<RotationClass>[] {
  const recentDays = thresholds.recentDays ?? DEFAULT_RECENT_DAYS;
  const longRestDays = thresholds.longRestDays ?? DEFAULT_LONG_REST_DAYS;
  if (!Number.isInteger(recentDays) || !Number.isInteger(longRestDays) || recentDays < 0 || longRestDays < recentDays) {
    throw new RangeError("Los umbrales deben ser días enteros, con 0 ≤ reciente ≤ descanso largo.");
  }
  return [
    { value: "occupied", key: "rotation:occupied", label: "Ocupado", color: ROTATION_COLORS.occupied },
    { value: "recent", key: "rotation:recent", label: `Descanso reciente (< ${recentDays} días)`, color: ROTATION_COLORS.recent },
    { value: "ready", key: "rotation:ready", label: `Listo (${recentDays}–${longRestDays} días)`, color: ROTATION_COLORS.ready },
    { value: "long_rest", key: "rotation:long_rest", label: `Descanso largo (> ${longRestDays} días)`, color: ROTATION_COLORS.long_rest },
  ];
}

function sectorDefinitions(values: readonly (string | null | undefined)[]): SemanticDefinition[] {
  const sectors = new Map<string, string>();
  values.forEach((value) => {
    const normalized = normalizeSector(value);
    if (!normalized) return;
    const currentLabel = sectors.get(normalized.key);
    if (!currentLabel || compareStableText(normalized.label, currentLabel) < 0) {
      sectors.set(normalized.key, normalized.label);
    }
  });
  return [...sectors.entries()]
    .sort(([first], [second]) => compareStableText(first, second))
    .map(([key, label]) => ({
      value: key,
      key: `sector:${key}`,
      label,
      color: sectorColor(key),
    }));
}

function normalizeSector(value: string | null | undefined): { key: string; label: string } | null {
  if (typeof value !== "string") return null;
  const label = value.normalize("NFKC").trim();
  if (!label) return null;
  return { key: label.toLowerCase(), label };
}

function sectorColor(key: string): string {
  let hash = 2_166_136_261;
  for (const character of key) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0;
  }
  return SECTOR_COLORS[hash % SECTOR_COLORS.length];
}

function withDetail(definition: Omit<SemanticDefinition, "value">, detail: string): ClassifiedPaddock {
  return {
    key: definition.key,
    label: definition.label,
    color: definition.color,
    detail,
    hasData: true,
  };
}

function missing(detail: string): ClassifiedPaddock {
  return { ...MISSING_DEFINITION, detail, hasData: false };
}

function rotationMissingDetail(dataQuality: "no_history" | "invalid_history" | "future_history"): string {
  if (dataQuality === "invalid_history") return "Sin historial de pastoreo válido";
  if (dataQuality === "future_history") return "Historial de pastoreo con fecha futura";
  return "Sin historial de pastoreo";
}

function interactionStyle(selected: boolean, focused: boolean) {
  if (selected && focused) return { color: "#0F172A", weight: 5, dashArray: "8 3" } as const;
  if (selected) return { color: "#0F172A", weight: 5 } as const;
  if (focused) return { color: "#FFFFFF", weight: 4, dashArray: "8 3" } as const;
  return { color: "#FFFFFF", weight: 2 } as const;
}

function readableTextColor(background: string): "#000000" | "#FFFFFF" {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#FFFFFF") ? "#000000" : "#FFFFFF";
}

function contrastRatio(first: string, second: string): number {
  const brighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const components = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  if (!components) throw new RangeError(`Color hexadecimal no válido: ${color}`);
  const linear = components.slice(1).map((component) => {
    const channel = Number.parseInt(component, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function parseObservedMonth(value: string | Date | null | undefined): { label: string } | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return monthLabel(value.getUTCFullYear(), value.getUTCMonth() + 1);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})(?:-(\d{2})(?:T.*)?)?$/u.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!match[3]) return monthLabel(year, month);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || (trimmed.length > 10 && !Number.isFinite(Date.parse(trimmed)))
  ) {
    return null;
  }
  return monthLabel(year, month);
}

function monthLabel(year: number, month: number): { label: string } | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 0 || month < 1 || month > 12) return null;
  return { label: `${MONTH_LABELS[month - 1]} ${String(year).padStart(4, "0")}` };
}

function isFiniteInRange(value: number | null | undefined, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",");
}

function compareStableText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function exhaustiveMode(value: never): never {
  throw new RangeError(`Modo temático no soportado: ${String(value)}`);
}
