import { addChileDays, chileDateKey, chileDaysBetween } from "./chile-date.mjs";

const STANDARD_LACTATION_DAYS = 305;
const RHA_WINDOW_DAYS = 365;
const DEFAULT_DRY_OFF_MAX_DAYS_IN_MILK = 305;
const DEFAULT_DRY_OFF_LOW_PRODUCTION_LITERS = 8;
const DEFAULT_DRY_OFF_MINIMUM_DAYS_FOR_LOW_PRODUCTION = 220;

/**
 * Days in milk are inclusive: the lactation start is DEL 1. For a completed
 * lactation, the value is capped at endedAt even when asOf is later.
 */
export function calculateDaysInMilk(lactation, asOf) {
  const start = lactationStart(lactation);
  const requestedEnd = chileDateKey(asOf);
  if (requestedEnd < start) return null;
  const end = minimumDate(requestedEnd, optionalDate(lactation?.endedAt));
  if (end < start) return null;
  return chileDaysBetween(start, end) + 1;
}

/** Returns the latest valid control in the lactation at or before asOf. */
export function getCurrentProduction(lactation, controls, asOf) {
  const asOfDate = chileDateKey(asOf);
  const latest = controlsForLactation(lactation, controls, asOfDate).sort(
    (left, right) => right.date.localeCompare(left.date),
  )[0];
  if (!latest) return null;
  return {
    controlDate: latest.date,
    liters: latest.liters,
    ageDays: chileDaysBetween(latest.date, asOfDate),
  };
}

/**
 * Flags active lactations that reached 305 DEL or that remain at/below
 * 8 L/day from DEL 220 onward. Thresholds are configurable so the rule can be
 * adapted without changing its deterministic result or hiding its assumptions.
 */
export function evaluateDryOffRecommendation(input, options = {}) {
  const daysInMilk = nullableNonNegativeNumber(input?.daysInMilk);
  const latestLiters = nullableNonNegativeNumber(input?.latestLiters);
  const maxDaysInMilk = positiveNumber(
    options.maxDaysInMilk,
    DEFAULT_DRY_OFF_MAX_DAYS_IN_MILK,
  );
  const lowProductionLiters = positiveNumber(
    options.lowProductionLiters,
    DEFAULT_DRY_OFF_LOW_PRODUCTION_LITERS,
  );
  const minimumDaysForLowProduction = positiveNumber(
    options.minimumDaysForLowProduction,
    DEFAULT_DRY_OFF_MINIMUM_DAYS_FOR_LOW_PRODUCTION,
  );

  if (input?.lactationStatus !== "active" || daysInMilk === null) {
    return { shouldDryOff: false, reason: null };
  }
  if (daysInMilk >= maxDaysInMilk) {
    return { shouldDryOff: true, reason: "days_in_milk" };
  }
  if (
    daysInMilk >= minimumDaysForLowProduction &&
    latestLiters !== null &&
    latestLiters <= lowProductionLiters
  ) {
    return { shouldDryOff: true, reason: "low_production" };
  }
  return { shouldDryOff: false, reason: null };
}

/**
 * Estimates a standard 305-day yield from test-day controls.
 *
 * Each control represents the calendar days closest to it (midpoint/test-day
 * method). The first observation is carried back to lactation start and, while
 * a lactation remains open, the latest observation is carried through day 305.
 * A lactation already closed at asOf contributes zero after endedAt. This is a
 * transparent operational estimate, not a breed-specific Wood curve.
 */
export function calculate305DayProjection(lactation, controls, asOf) {
  const start = lactationStart(lactation);
  const asOfDate = chileDateKey(asOf);
  if (asOfDate < start) return null;

  const testDays = controlsForLactation(lactation, controls, asOfDate).filter(
    (control) =>
      chileDaysBetween(start, control.date) < STANDARD_LACTATION_DAYS,
  );
  if (testDays.length === 0) return null;

  const standardEnd = addChileDays(start, STANDARD_LACTATION_DAYS - 1);
  const endedAt = optionalDate(lactation?.endedAt);
  const observedEnd = minimumDate(asOfDate, endedAt, standardEnd);
  const projectionEnd =
    endedAt && endedAt <= asOfDate
      ? minimumDate(endedAt, standardEnd)
      : standardEnd;

  const estimatedToDateLiters = estimateRange(testDays, start, observedEnd);
  const projected305Liters = estimateRange(testDays, start, projectionEnd);

  return {
    startDate: start,
    throughDate: observedEnd,
    controlCount: testDays.length,
    observedDays: chileDaysBetween(start, observedEnd) + 1,
    estimatedToDateLiters: round2(estimatedToDateLiters),
    projected305Liters: round2(projected305Liters),
    method: "nearest-test-day-carry-forward",
  };
}

/**
 * Rolling Herd Average (RHA) over the 365 Chilean civil days ending at asOf.
 * The numerator is estimated test-day milk inside supplied lactation windows.
 * The denominator is the distinct set of animals whose supplied lactations
 * overlap that window; dry days therefore contribute zero. Without historical
 * inventory snapshots this is the only reproducible denominator available.
 */
export function calculateRollingHerdAverage({
  lactations = [],
  controls = [],
  asOf,
}) {
  const windowEnd = chileDateKey(asOf);
  const windowStart = addChileDays(windowEnd, -(RHA_WINDOW_DAYS - 1));
  const representedAnimals = new Set();
  let estimatedMilkLiters = 0;

  for (const lactation of lactations ?? []) {
    const start = lactationStart(lactation);
    const end = minimumDate(optionalDate(lactation?.endedAt), windowEnd);
    if (end < windowStart || start > windowEnd || end < start) continue;

    const animalId = requiredString(
      lactation?.animalId,
      "La lactancia debe identificar al animal.",
    );
    representedAnimals.add(animalId);
    const overlapStart = maximumDate(start, windowStart);
    const overlapEnd = minimumDate(end, windowEnd);
    const testDays = controlsForLactation(lactation, controls, windowEnd);
    if (testDays.length > 0)
      estimatedMilkLiters += estimateRange(testDays, overlapStart, overlapEnd);
  }

  const cowCount = representedAnimals.size;
  const roundedTotal = round2(estimatedMilkLiters);
  return {
    windowStart,
    windowEnd,
    cowCount,
    estimatedMilkLiters: roundedTotal,
    litersPerCow: cowCount === 0 ? null : round2(roundedTotal / cowCount),
    method: "365-day-nearest-test-day",
  };
}

function controlsForLactation(lactation, controls, throughDate) {
  const start = lactationStart(lactation);
  const end = minimumDate(optionalDate(lactation?.endedAt), throughDate);
  const animalId = requiredString(
    lactation?.animalId,
    "La lactancia debe identificar al animal.",
  );
  const lactationId = nullableString(lactation?.id);

  return (controls ?? [])
    .flatMap((control) => {
      if (String(control?.animalId ?? "") !== animalId) return [];
      const controlLactationId = nullableString(control?.lactationId);
      if (
        controlLactationId &&
        lactationId &&
        controlLactationId !== lactationId
      )
        return [];
      const date = chileDateKey(control?.controlDate);
      if (date < start || date > end) return [];
      if (
        control?.totalLiters === null ||
        control?.totalLiters === undefined ||
        control?.totalLiters === ""
      )
        return [];
      const liters = Number(control?.totalLiters);
      if (!Number.isFinite(liters) || liters < 0) return [];
      return [{ date, liters }];
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function estimateRange(testDays, rangeStart, rangeEnd) {
  if (rangeEnd < rangeStart) return 0;
  const sorted = [...testDays].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  let total = 0;
  const days = chileDaysBetween(rangeStart, rangeEnd);
  for (let offset = 0; offset <= days; offset += 1) {
    const day = addChileDays(rangeStart, offset);
    total += nearestTestDay(sorted, day).liters;
  }
  return total;
}

function nearestTestDay(testDays, date) {
  let nearest = testDays[0];
  let nearestDistance = Math.abs(chileDaysBetween(nearest.date, date));
  for (const control of testDays.slice(1)) {
    const distance = Math.abs(chileDaysBetween(control.date, date));
    if (distance < nearestDistance) {
      nearest = control;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function lactationStart(lactation) {
  const value = lactation?.startedAt ?? lactation?.calvingDate;
  if (!value) throw new TypeError("La lactancia debe tener fecha de inicio.");
  return chileDateKey(value);
}

function optionalDate(value) {
  return value ? chileDateKey(value) : null;
}

function minimumDate(...values) {
  return values.filter(Boolean).sort()[0] ?? "9999-12-31";
}

function maximumDate(...values) {
  return values.filter(Boolean).sort().at(-1) ?? "0000-01-01";
}

function nullableString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requiredString(value, message) {
  const normalized = nullableString(value);
  if (!normalized) throw new TypeError(message);
  return normalized;
}

function nullableNonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError("Los umbrales de secado deben ser números positivos.");
  }
  return parsed;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
