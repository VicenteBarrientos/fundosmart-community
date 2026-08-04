export type RotationClass = "occupied" | "recent" | "ready" | "long_rest";
export type RotationDataQuality = "valid" | "no_history" | "invalid_history" | "future_history";
export type RotationDate = string | Date;

export type RotationPaddockInput = {
  id: string;
  name: string;
  grazingDates?: readonly (RotationDate | null | undefined)[];
  assignedLotCount?: number;
};

export type RotationThresholds = {
  recentDays?: number;
  longRestDays?: number;
};

export type RotationEvaluationOptions = RotationThresholds & {
  referenceDate: RotationDate;
};

export type RotationEvaluation = {
  paddockId: string;
  paddockName: string;
  classification: RotationClass;
  restDays: number | null;
  lastGrazingAt: string | null;
  assignedLotCount: number;
  isReady: boolean;
  dataQuality: RotationDataQuality;
  invalidGrazingDateCount: number;
  futureGrazingDateCount: number;
  recentDaysThreshold: number;
  longRestDaysThreshold: number;
};

export type RankedRotationEvaluation = RotationEvaluation & {
  rank: number;
};

export type RotationOverview = {
  paddocks: RankedRotationEvaluation[];
  readyPaddocks: RankedRotationEvaluation[];
  summary: string;
  counts: Record<RotationClass, number>;
};

export const DEFAULT_RECENT_DAYS = 15;
export const DEFAULT_LONG_REST_DAYS = 30;
export const DEFAULT_READY_SUMMARY_LIMIT = 3;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Evaluates rotation exclusively from the supplied snapshot. Callers must pass
 * the reference day, keeping the engine deterministic and timezone independent.
 * Boundaries follow the roadmap: <15 recent, 15–30 ready and >30 long rest.
 * An assigned lot always wins and forces occupied/restDays=0.
 *
 * Missing or wholly invalid history is exposed as long_rest with restDays=null,
 * but isReady=false so an unknown paddock is never recommended as safe to graze.
 * A future grazing date is exposed as recent/restDays=0 and isReady=false.
 */
export function evaluatePaddockRotation(
  paddock: RotationPaddockInput,
  options: RotationEvaluationOptions,
): RotationEvaluation {
  const thresholds = normalizeThresholds(options);
  const referenceDay = parseRequiredDay(options.referenceDate, "La fecha de referencia");
  const assignedLotCount = normalizeAssignedLotCount(paddock.assignedLotCount);
  const rawDates = paddock.grazingDates ?? [];
  const parsedDates = rawDates.map(parseOptionalDay);
  const validDays = parsedDates.filter((value): value is CalendarDay => value !== null);
  const invalidGrazingDateCount = parsedDates.length - validDays.length;
  const futureGrazingDateCount = validDays.filter((day) => day.utcTimestamp > referenceDay.utcTimestamp).length;
  const latestGrazing = validDays.reduce<CalendarDay | null>(
    (latest, day) => latest === null || day.utcTimestamp > latest.utcTimestamp ? day : latest,
    null,
  );

  const shared = {
    paddockId: paddock.id,
    paddockName: paddock.name,
    lastGrazingAt: latestGrazing?.isoDate ?? null,
    assignedLotCount,
    invalidGrazingDateCount,
    futureGrazingDateCount,
    recentDaysThreshold: thresholds.recentDays,
    longRestDaysThreshold: thresholds.longRestDays,
  };

  if (assignedLotCount > 0) {
    return {
      ...shared,
      classification: "occupied",
      restDays: 0,
      isReady: false,
      dataQuality: latestGrazing && latestGrazing.utcTimestamp > referenceDay.utcTimestamp
        ? "future_history"
        : latestGrazing ? "valid" : invalidGrazingDateCount > 0 ? "invalid_history" : "no_history",
    };
  }

  if (!latestGrazing) {
    return {
      ...shared,
      classification: "long_rest",
      restDays: null,
      isReady: false,
      dataQuality: invalidGrazingDateCount > 0 ? "invalid_history" : "no_history",
    };
  }

  if (latestGrazing.utcTimestamp > referenceDay.utcTimestamp) {
    return {
      ...shared,
      classification: "recent",
      restDays: 0,
      isReady: false,
      dataQuality: "future_history",
    };
  }

  const restDays = Math.floor((referenceDay.utcTimestamp - latestGrazing.utcTimestamp) / MILLISECONDS_PER_DAY);
  const classification = classifyKnownRest(restDays, thresholds);
  return {
    ...shared,
    classification,
    restDays,
    isReady: classification === "ready" || classification === "long_rest",
    dataQuality: "valid",
  };
}

export function rankPaddockRotations(evaluations: readonly RotationEvaluation[]): RankedRotationEvaluation[] {
  return [...evaluations]
    .sort(compareRotationEvaluations)
    .map((evaluation, index) => ({ ...evaluation, rank: index + 1 }));
}

export function summarizeReadyPaddocks(
  evaluations: readonly RotationEvaluation[],
  limit = DEFAULT_READY_SUMMARY_LIMIT,
): string {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("El límite del resumen debe ser un entero mayor que 0.");
  }
  const ready = rankPaddockRotations(evaluations).filter((evaluation) => evaluation.isReady).slice(0, limit);
  if (ready.length === 0) return "No hay potreros listos para pastorear.";
  const details = ready
    .map((evaluation) => `${evaluation.paddockName} (${evaluation.restDays} días)`)
    .join(", ");
  return `Potreros listos para pastorear: ${details}.`;
}

export function buildRotationOverview(
  paddocks: readonly RotationPaddockInput[],
  options: RotationEvaluationOptions & { summaryLimit?: number },
): RotationOverview {
  const evaluations = paddocks.map((paddock) => evaluatePaddockRotation(paddock, options));
  const ranked = rankPaddockRotations(evaluations);
  const readyPaddocks = ranked.filter((evaluation) => evaluation.isReady);
  const counts: Record<RotationClass, number> = {
    occupied: 0,
    recent: 0,
    ready: 0,
    long_rest: 0,
  };
  ranked.forEach((evaluation) => {
    counts[evaluation.classification] += 1;
  });
  return {
    paddocks: ranked,
    readyPaddocks,
    summary: summarizeReadyPaddocks(ranked, options.summaryLimit ?? DEFAULT_READY_SUMMARY_LIMIT),
    counts,
  };
}

type CalendarDay = {
  isoDate: string;
  utcTimestamp: number;
};

function normalizeThresholds(options: RotationThresholds) {
  const recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;
  const longRestDays = options.longRestDays ?? DEFAULT_LONG_REST_DAYS;
  if (
    !Number.isInteger(recentDays)
    || !Number.isInteger(longRestDays)
    || recentDays < 0
    || longRestDays < recentDays
  ) {
    throw new RangeError("Los umbrales deben ser días enteros, con 0 ≤ reciente ≤ descanso largo.");
  }
  return { recentDays, longRestDays };
}

function normalizeAssignedLotCount(value: number | undefined): number {
  const count = value ?? 0;
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("La cantidad de lotes asignados debe ser un entero mayor o igual que 0.");
  }
  return count;
}

function classifyKnownRest(
  restDays: number,
  thresholds: { recentDays: number; longRestDays: number },
): RotationClass {
  if (restDays < thresholds.recentDays) return "recent";
  if (restDays <= thresholds.longRestDays) return "ready";
  return "long_rest";
}

function compareRotationEvaluations(first: RotationEvaluation, second: RotationEvaluation): number {
  const readinessDifference = readinessOrder(first) - readinessOrder(second);
  if (readinessDifference !== 0) return readinessDifference;

  const firstRest = first.restDays ?? Number.NEGATIVE_INFINITY;
  const secondRest = second.restDays ?? Number.NEGATIVE_INFINITY;
  if (firstRest !== secondRest) return secondRest - firstRest;

  const nameDifference = compareStableText(first.paddockName, second.paddockName);
  return nameDifference || compareStableText(first.paddockId, second.paddockId);
}

function readinessOrder(evaluation: RotationEvaluation): number {
  if (evaluation.isReady) return 0;
  if (evaluation.classification === "recent") return 1;
  if (evaluation.classification === "occupied") return 2;
  return 3;
}

function compareStableText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function parseRequiredDay(value: RotationDate, label: string): CalendarDay {
  const parsed = parseOptionalDay(value);
  if (!parsed) throw new RangeError(`${label} no es válida.`);
  return parsed;
}

function parseOptionalDay(value: RotationDate | null | undefined): CalendarDay | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return createCalendarDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value !== "string") return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = createCalendarDay(year, month, day);
  if (!parsed) return null;
  if (value.trim().length > 10 && !Number.isFinite(Date.parse(value.trim()))) return null;
  return parsed;
}

function createCalendarDay(year: number, month: number, day: number): CalendarDay | null {
  const utcTimestamp = Date.UTC(year, month - 1, day);
  const date = new Date(utcTimestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    isoDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    utcTimestamp,
  };
}
