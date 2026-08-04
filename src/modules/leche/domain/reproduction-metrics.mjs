import { addChileDays, chileDateKey, chileDaysBetween } from "./chile-date.mjs";

const BREEDING_TYPES = new Set(["service", "insemination"]);
const POSITIVE_RESULTS = new Set([
  "positive",
  "positivo",
  "pregnant",
  "pregnant confirmed",
  "prenada",
  "gestante",
  "confirmed",
  "confirmado",
]);
const NEGATIVE_RESULTS = new Set([
  "negative",
  "negativo",
  "not pregnant",
  "nonpregnant",
  "open",
  "abierta",
  "vacia",
  "no gestante",
  "no prenada",
]);

/**
 * Days open run from the latest calving through the breeding event that led to
 * an explicit positive pregnancy diagnosis. If no conception can be inferred,
 * the result remains open through asOf. A diagnosis without a positive result
 * is intentionally not assumed positive.
 */
export function calculateDaysOpen(events, asOf) {
  const asOfDate = chileDateKey(asOf);
  const normalized = normalizeEvents(events, asOfDate);
  const calving = [...normalized].reverse().find((event) => event.eventType === "calving");
  if (!calving) return null;

  const conception = findConception(normalized, calving.date, asOfDate);
  if (conception) {
    return {
      days: chileDaysBetween(calving.date, conception.breeding.date),
      status: "conceived",
      calvingDate: calving.date,
      conceptionDate: conception.breeding.date,
    };
  }

  const hasBreedingEvents = normalized.some((e) => BREEDING_TYPES.has(e.eventType));
  if (!hasBreedingEvents) {
    return {
      days: chileDaysBetween(calving.date, asOfDate),
      status: "insufficient_data",
      reason: "no_service_or_insemination_events",
      calvingDate: calving.date,
      conceptionDate: null,
    };
  }

  return {
    days: chileDaysBetween(calving.date, asOfDate),
    status: "open",
    calvingDate: calving.date,
    conceptionDate: null,
  };
}

/** Returns the interval between the two latest distinct calving days. */
export function calculateCalvingInterval(events, asOf) {
  const normalizedCalvings = normalizeEvents(events, chileDateKey(asOf))
    .filter((event) => event.eventType === "calving");

  const calvingByDate = new Map();
  for (const event of normalizedCalvings) {
    calvingByDate.set(event.date, event);
  }

  const dates = [...calvingByDate.keys()].sort();
  if (dates.length < 2) return null;

  const latestCalvingDate = dates.at(-1);
  const previousCalvingDate = dates.at(-2);
  const latestEvent = calvingByDate.get(latestCalvingDate);
  const previousEvent = calvingByDate.get(previousCalvingDate);

  const previousEventId = previousEvent?.id ?? previousEvent?.raw?.id ?? null;
  const latestEventId = latestEvent?.id ?? latestEvent?.raw?.id ?? null;

  const sourceRecordIds = [
    previousEvent?.sourceRecordId ?? previousEvent?.raw?.sourceRecordId ?? previousEventId,
    latestEvent?.sourceRecordId ?? latestEvent?.raw?.sourceRecordId ?? latestEventId,
  ].filter(Boolean);

  return {
    days: chileDaysBetween(previousCalvingDate, latestCalvingDate),
    previousCalvingDate,
    latestCalvingDate,
    previousEventId,
    latestEventId,
    sourceRecordIds,
  };
}

/**
 * Computes event-based reproductive rates.
 *
 * Eligibility starts after the voluntary waiting period following calving.
 * Heat-detection and pregnancy denominators use completed, non-overlapping
 * cycleDays opportunities; the successful (conception) cycle is counted even
 * when conception closes it early. This avoids penalizing the current partial
 * cycle. Conception is attributed to the last service/insemination preceding a
 * positive diagnosis in the same calving interval.
 */
export function calculateReproductiveRates(events, options) {
  const periodStart = chileDateKey(options?.periodStart);
  const periodEnd = chileDateKey(options?.periodEnd);
  if (periodEnd < periodStart) throw new RangeError("El fin del período reproductivo no puede preceder su inicio.");
  const voluntaryWaitingPeriodDays = nonNegativeInteger(options?.voluntaryWaitingPeriodDays, 50);
  const cycleDays = positiveInteger(options?.cycleDays, 21);
  const normalized = normalizeEvents(events, periodEnd);
  const eventAnimalIds = normalized.map((event) => event.animalId);
  const animalIds = [...new Set([...(options?.animalIds ?? []).map(String), ...eventAnimalIds])].sort();

  let eligibleCycleCount = 0;
  let detectedHeatCycleCount = 0;
  let breedingAttemptCount = 0;
  let conceptionCount = 0;
  const eligibleAnimals = new Set();

  for (const animalId of animalIds) {
    const animalEvents = normalized.filter((event) => event.animalId === animalId);
    const calvings = animalEvents.filter((event) => event.eventType === "calving");
    for (let index = 0; index < calvings.length; index += 1) {
      const calving = calvings[index];
      const nextCalvingDate = calvings[index + 1]?.date ?? null;
      const segmentEnd = nextCalvingDate ? addChileDays(nextCalvingDate, -1) : periodEnd;
      const conception = findConception(animalEvents, calving.date, segmentEnd);
      const conceptionDate = conception?.breeding.date ?? null;
      const eligibilityDate = addChileDays(calving.date, voluntaryWaitingPeriodDays);
      let cycleStart = maximumDate(eligibilityDate, periodStart);
      const riskEnd = minimumDate(conceptionDate, segmentEnd, periodEnd);

      while (cycleStart <= riskEnd) {
        const cycleEnd = addChileDays(cycleStart, cycleDays - 1);
        const conceptionInCycle = conceptionDate !== null && conceptionDate >= cycleStart && conceptionDate <= cycleEnd;
        if (cycleEnd > periodEnd && !conceptionInCycle) break;

        eligibleCycleCount += 1;
        eligibleAnimals.add(animalId);
        const heatDetected = animalEvents.some((event) =>
          event.eventType === "heat" && event.date >= cycleStart && event.date <= minimumDate(cycleEnd, riskEnd));
        if (heatDetected) detectedHeatCycleCount += 1;
        if (conceptionInCycle) break;
        cycleStart = addChileDays(cycleStart, cycleDays);
      }

      const attemptStart = maximumDate(eligibilityDate, periodStart);
      const attemptEnd = minimumDate(segmentEnd, periodEnd, conceptionDate);
      breedingAttemptCount += animalEvents.filter((event) =>
        BREEDING_TYPES.has(event.eventType) && event.date >= attemptStart && event.date <= attemptEnd).length;
      if (conceptionDate && conceptionDate >= periodStart && conceptionDate <= periodEnd) conceptionCount += 1;
    }
  }

  return {
    periodStart,
    periodEnd,
    eligibleAnimalCount: eligibleAnimals.size,
    eligibleCycleCount,
    detectedHeatCycleCount,
    breedingAttemptCount,
    conceptionCount,
    heatDetectionRatePct: percentage(detectedHeatCycleCount, eligibleCycleCount),
    conceptionRatePct: percentage(conceptionCount, breedingAttemptCount),
    pregnancyRatePct: percentage(conceptionCount, eligibleCycleCount),
  };
}

/** Builds one de-duplicated set of operational lists as of a Chilean day. */
export function buildReproductiveWorklists(events, asOf, options = {}) {
  const asOfDate = chileDateKey(asOf);
  const lookAheadDays = nonNegativeInteger(options.lookAheadDays, 7);
  const voluntaryWaitingPeriodDays = nonNegativeInteger(options.voluntaryWaitingPeriodDays, 50);
  const cycleDays = positiveInteger(options.cycleDays, 21);
  const pregnancyCheckDays = positiveInteger(options.pregnancyCheckDays, 35);
  const gestationDays = positiveInteger(options.gestationDays, 280);
  const dryPeriodDays = nonNegativeInteger(options.dryPeriodDays, 60);
  const inseminationWindowDays = nonNegativeInteger(options.inseminationWindowDays, 1);
  const horizon = addChileDays(asOfDate, lookAheadDays);
  const normalized = normalizeEvents(events, asOfDate);
  const animalIds = [...new Set(normalized.map((event) => event.animalId))].sort();
  const result = { expectedHeat: [], toInseminate: [], pregnancyChecks: [], dryOff: [] };

  for (const animalId of animalIds) {
    const animalEvents = normalized.filter((event) => event.animalId === animalId);
    const latestCalving = findLatest(animalEvents, (event) => event.eventType === "calving");
    const latestAbortion = findLatest(animalEvents, (event) => event.eventType === "abortion");
    const reproductiveStart = maximumEvent(latestCalving, latestAbortion);
    const cycleEvents = reproductiveStart
      ? animalEvents.filter((event) => event.date >= reproductiveStart.date)
      : animalEvents;
    const conception = findConception(cycleEvents, reproductiveStart?.date ?? "0000-01-01", asOfDate);
    const pregnancyInvalidated = conception && cycleEvents.some((event) =>
      (event.eventType === "abortion" || event.eventType === "calving") && event.date > conception.diagnosis.date);
    const activeConception = conception && !pregnancyInvalidated ? conception : null;
    const lastBreeding = findLatest(cycleEvents, (event) => BREEDING_TYPES.has(event.eventType));
    const lastHeat = findLatest(cycleEvents, (event) => event.eventType === "heat");
    let pendingPregnancyCheck = false;

    if (!activeConception && lastHeat) {
      const bredAfterHeat = cycleEvents.some((event) => BREEDING_TYPES.has(event.eventType) && event.date >= lastHeat.date);
      const heatAge = chileDaysBetween(lastHeat.date, asOfDate);
      if (!bredAfterHeat && heatAge >= 0 && heatAge <= inseminationWindowDays) {
        result.toInseminate.push(workItem(animalId, lastHeat.date, asOfDate, lastHeat, "observed_heat"));
      }
    }

    if (!activeConception && lastBreeding) {
      const hasLaterDiagnosisOrOutcome = cycleEvents.some((event) =>
        event.date > lastBreeding.date
        && (event.eventType === "pregnancy_diagnosis" || event.eventType === "calving" || event.eventType === "abortion"));
      const dueDate = addChileDays(lastBreeding.date, pregnancyCheckDays);
      if (!hasLaterDiagnosisOrOutcome && dueDate <= horizon) {
        pendingPregnancyCheck = true;
        result.pregnancyChecks.push(workItem(animalId, dueDate, asOfDate, lastBreeding, "breeding"));
      }
    }

    if (activeConception) {
      const dueDate = addChileDays(activeConception.breeding.date, gestationDays - dryPeriodDays);
      const alreadyDried = cycleEvents.some((event) => event.eventType === "dry_off" && event.date >= activeConception.breeding.date);
      if (!alreadyDried && dueDate <= horizon) {
        result.dryOff.push(workItem(animalId, dueDate, asOfDate, activeConception.breeding, "confirmed_conception"));
      }
    } else if (!pendingPregnancyCheck) {
      const heatBasis = maximumEvent(lastHeat, lastBreeding);
      let dueDate = null;
      let basis = null;
      let reason = null;
      if (heatBasis) {
        dueDate = addChileDays(heatBasis.date, cycleDays);
        basis = heatBasis;
        reason = "last_heat_or_breeding";
      } else if (reproductiveStart?.eventType === "calving") {
        dueDate = addChileDays(reproductiveStart.date, voluntaryWaitingPeriodDays);
        basis = reproductiveStart;
        reason = "voluntary_wait_complete";
      }
      if (dueDate && dueDate <= horizon) {
        result.expectedHeat.push(workItem(animalId, dueDate, asOfDate, basis, reason));
      }
    }
  }

  for (const list of Object.values(result)) {
    list.sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.animalId.localeCompare(right.animalId));
  }
  return result;
}

export function isPositivePregnancyDiagnosis(event) {
  if (event?.eventType !== "pregnancy_diagnosis") return false;
  if (event?.metadata?.positive === true || event?.metadata?.pregnant === true) return true;
  const metadataStatus = event?.metadata?.pregnancyStatus ?? event?.metadata?.status;
  const result = normalizeText(metadataStatus ?? event?.result);
  return POSITIVE_RESULTS.has(result)
    || ["positivo ", "pregnant ", "prenada ", "gestante "].some((prefix) => result.startsWith(prefix));
}

export function isNegativePregnancyDiagnosis(event) {
  if (event?.eventType !== "pregnancy_diagnosis") return false;
  if (event?.metadata?.positive === false || event?.metadata?.pregnant === false) {
    return true;
  }
  const metadataStatus = event?.metadata?.pregnancyStatus ?? event?.metadata?.status;
  return NEGATIVE_RESULTS.has(normalizeText(metadataStatus ?? event?.result));
}

function findConception(events, startDate, endDate) {
  const candidates = events.filter((event) => event.date >= startDate && event.date <= endDate);
  const diagnosis = [...candidates].reverse().find((event) =>
    isPositivePregnancyDiagnosis(event) || isNegativePregnancyDiagnosis(event));
  if (!diagnosis || !isPositivePregnancyDiagnosis(diagnosis)) return null;
  const invalidated = candidates.some((event) =>
    (event.eventType === "abortion" || event.eventType === "calving")
    && event.date > diagnosis.date);
  if (invalidated) return null;
  const breeding = [...candidates].reverse().find((event) =>
    BREEDING_TYPES.has(event.eventType) && event.date <= diagnosis.date);
  return breeding ? { breeding, diagnosis } : null;
}

function normalizeEvents(events, throughDate) {
  return (events ?? []).flatMap((event, index) => {
    const animalId = String(event?.animalId ?? "").trim();
    if (!animalId || !event?.occurredAt || !event?.eventType) return [];
    const date = chileDateKey(event.occurredAt);
    if (date > throughDate) return [];
    return [{ ...event, id: String(event.id ?? `event-${index}`), animalId, date }];
  }).sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
}

function workItem(animalId, dueDate, asOfDate, basis, reason) {
  const signedDays = chileDaysBetween(asOfDate, dueDate);
  return {
    animalId,
    dueDate,
    daysUntilDue: signedDays,
    daysOverdue: Math.max(0, -signedDays),
    basisEventId: basis.id,
    reason,
  };
}

function findLatest(events, predicate) {
  return [...events].reverse().find(predicate) ?? null;
}

function maximumEvent(...events) {
  return events.filter(Boolean).sort((left, right) => left.date.localeCompare(right.date)).at(-1) ?? null;
}

function percentage(numerator, denominator) {
  return denominator === 0 ? null : Math.round(((numerator / denominator) * 10_000)) / 100;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("es-CL")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function minimumDate(...values) {
  return values.filter(Boolean).sort()[0] ?? "9999-12-31";
}

function maximumDate(...values) {
  return values.filter(Boolean).sort().at(-1) ?? "0000-01-01";
}

function nonNegativeInteger(value, fallback) {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) throw new TypeError("La configuración de días debe ser un entero no negativo.");
  return normalized;
}

function positiveInteger(value, fallback) {
  const normalized = nonNegativeInteger(value, fallback);
  if (normalized === 0) throw new TypeError("La configuración de días debe ser mayor que cero.");
  return normalized;
}
