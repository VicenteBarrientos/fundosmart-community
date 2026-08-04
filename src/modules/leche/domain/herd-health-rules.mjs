import { addChileDays, chileDateKey, chileDaysBetween } from "./chile-date.mjs";

export const DEFAULT_SOMATIC_CELL_THRESHOLDS = Object.freeze({
  elevated: 200_000,
  high: 400_000,
  critical: 700_000,
});

/**
 * A withdrawal remains active through the complete `until` civil day. A later
 * withdrawal_clearance event can clear a specific source event through
 * metadata.clearsEventId, or all withdrawals from strictly earlier civil days
 * for the animal when that key is absent. A same-day clearance needs an
 * explicit target because date-only events have no reliable ordering.
 * metadata.withdrawalType may be milk, meat or both (default).
 */
export function buildActiveWithdrawals(events, asOf) {
  const asOfDate = chileDateKey(asOf);
  const normalized = normalizeHealthEvents(events, asOfDate);
  const candidates = normalized.filter((event) => event.eventType !== "withdrawal_clearance");
  const entries = [];

  for (const event of candidates) {
    const milkUntil = optionalDate(event.withdrawalMilkUntil);
    const meatUntil = optionalDate(event.withdrawalMeatUntil);
    const milkActive = Boolean(milkUntil && milkUntil >= asOfDate && !isCleared(event, "milk", normalized));
    const meatActive = Boolean(meatUntil && meatUntil >= asOfDate && !isCleared(event, "meat", normalized));
    if (!milkActive && !meatActive) continue;
    entries.push({
      eventId: event.id,
      animalId: event.animalId,
      occurredAt: event.date,
      condition: event.condition ?? null,
      productName: event.productName ?? null,
      milkUntil,
      meatUntil,
      milkActive,
      meatActive,
      doNotDeliverMilk: milkActive,
    });
  }

  entries.sort((left, right) => left.animalId.localeCompare(right.animalId) || left.occurredAt.localeCompare(right.occurredAt));
  const milk = entries.filter((entry) => entry.milkActive);
  const meat = entries.filter((entry) => entry.meatActive);
  return {
    asOf: asOfDate,
    entries,
    milk,
    meat,
    animalIdsWithMilkWithdrawal: [...new Set(milk.map((entry) => entry.animalId))],
    animalIdsWithMeatWithdrawal: [...new Set(meat.map((entry) => entry.animalId))],
  };
}

export function classifySomaticCellCount(value, thresholds = DEFAULT_SOMATIC_CELL_THRESHOLDS) {
  if (value === null || value === undefined || value === "") return "unknown";
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return "unknown";
  const normalized = normalizeThresholds(thresholds);
  if (count >= normalized.critical) return "critical";
  if (count >= normalized.high) return "high";
  if (count >= normalized.elevated) return "elevated";
  return "normal";
}

/**
 * Builds a current mammary-health view from the latest individual RCS control.
 * Herd RCS is volume-weighted by test-day liters; if every valid test has zero
 * liters it falls back to an arithmetic mean. Controls older than max age stay
 * visible as stale but do not enter current herd RCS or risk classification.
 */
export function calculateMammaryHealth(controls, healthEvents, asOf, options = {}) {
  const asOfDate = chileDateKey(asOf);
  const maxControlAgeDays = nonNegativeInteger(options.maxControlAgeDays, 45);
  const mastitisLookbackDays = nonNegativeInteger(options.mastitisLookbackDays, 90);
  const thresholds = normalizeThresholds(options.thresholds ?? DEFAULT_SOMATIC_CELL_THRESHOLDS);
  const normalizedControls = normalizeControls(controls, asOfDate);
  const animals = [];

  for (const animalId of [...new Set(normalizedControls.map((control) => control.animalId))].sort()) {
    const history = normalizedControls
      .filter((control) => control.animalId === animalId)
      .sort((left, right) => right.date.localeCompare(left.date));
    const latest = history[0];
    const previous = history[1] ?? null;
    const ageDays = chileDaysBetween(latest.date, asOfDate);
    const stale = ageDays > maxControlAgeDays;
    const trendPct = previous && previous.somaticCellCount > 0
      ? round2(((latest.somaticCellCount - previous.somaticCellCount) / previous.somaticCellCount) * 100)
      : null;
    animals.push({
      animalId,
      controlDate: latest.date,
      ageDays,
      stale,
      totalLiters: latest.totalLiters,
      somaticCellCount: latest.somaticCellCount,
      status: stale ? "unknown" : classifySomaticCellCount(latest.somaticCellCount, thresholds),
      trendPct,
      trend: trendPct === null ? "unavailable" : trendPct >= 20 ? "increasing" : trendPct <= -20 ? "decreasing" : "stable",
    });
  }

  const currentAnimals = animals.filter((animal) => !animal.stale);
  const weightedLiters = currentAnimals.reduce((total, animal) => total + Math.max(0, animal.totalLiters), 0);
  const herdSomaticCellCount = currentAnimals.length === 0
    ? null
    : Math.round(weightedLiters > 0
      ? currentAnimals.reduce((total, animal) => total + (animal.somaticCellCount * Math.max(0, animal.totalLiters)), 0) / weightedLiters
      : currentAnimals.reduce((total, animal) => total + animal.somaticCellCount, 0) / currentAnimals.length);

  const lookbackStart = addChileDays(asOfDate, -mastitisLookbackDays);
  const mastitisCases = normalizeHealthEvents(healthEvents, asOfDate)
    .filter((event) => event.date >= lookbackStart && isMastitisEvent(event))
    .map((event) => ({
      eventId: event.id,
      animalId: event.animalId,
      occurredAt: event.date,
      status: event.status,
      condition: event.condition ?? null,
      active: event.status === "open",
    }))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));

  const highRiskAnimalIds = [...new Set([
    ...currentAnimals.filter((animal) => animal.status === "high" || animal.status === "critical").map((animal) => animal.animalId),
    ...mastitisCases.filter((event) => event.active).map((event) => event.animalId),
  ])].sort();
  const categoryCounts = { normal: 0, elevated: 0, high: 0, critical: 0, unknown: 0 };
  for (const animal of animals) categoryCounts[animal.status] += 1;

  return {
    asOf: asOfDate,
    evaluatedAnimalCount: animals.length,
    currentAnimalCount: currentAnimals.length,
    staleAnimalCount: animals.length - currentAnimals.length,
    herdSomaticCellCount,
    herdStatus: classifySomaticCellCount(herdSomaticCellCount, thresholds),
    categoryCounts,
    animals,
    mastitisCases,
    highRiskAnimalIds,
  };
}

/**
 * Turns measured signals into a review queue. It deliberately stops at
 * "review/recheck": it never infers a diagnosis, treatment or prescription.
 */
export function buildMammaryWorklist(mammaryHealth) {
  const byAnimal = new Map();
  for (const animal of mammaryHealth?.animals ?? []) {
    const reasonCodes = [];
    let priority = null;
    let action = null;
    if (animal.stale) {
      priority = "review";
      action = "update_control";
      reasonCodes.push("stale_control");
    } else if (animal.status === "critical") {
      priority = "urgent";
      action = "review_now";
      reasonCodes.push("critical_rcs");
    } else if (animal.status === "high") {
      priority = "high";
      action = "review_soon";
      reasonCodes.push("high_rcs");
    } else if (animal.status === "elevated") {
      priority = animal.trend === "increasing" ? "high" : "medium";
      action = "schedule_recheck";
      reasonCodes.push("elevated_rcs");
    }
    if (!priority || !action) continue;
    if (animal.trend === "increasing") reasonCodes.push("increasing_trend");
    byAnimal.set(animal.animalId, {
      animalId: animal.animalId,
      priority,
      action,
      controlDate: animal.controlDate,
      ageDays: animal.ageDays,
      totalLiters: animal.totalLiters,
      somaticCellCount: animal.somaticCellCount,
      status: animal.status,
      trend: animal.trend,
      hasOpenMastitis: false,
      mastitisEventIds: [],
      reasonCodes,
    });
  }

  for (const event of (mammaryHealth?.mastitisCases ?? []).filter((entry) => entry.active)) {
    const current = byAnimal.get(event.animalId) ?? {
      animalId: event.animalId,
      priority: "urgent",
      action: "review_now",
      controlDate: null,
      ageDays: null,
      totalLiters: null,
      somaticCellCount: null,
      status: "unknown",
      trend: "unavailable",
      hasOpenMastitis: false,
      mastitisEventIds: [],
      reasonCodes: [],
    };
    current.priority = "urgent";
    current.action = "review_now";
    current.hasOpenMastitis = true;
    current.mastitisEventIds = [...new Set([...current.mastitisEventIds, event.eventId])].sort();
    current.reasonCodes = [...new Set(["open_mastitis_case", ...current.reasonCodes])];
    byAnimal.set(event.animalId, current);
  }

  const priorityRank = { urgent: 0, high: 1, medium: 2, review: 3 };
  return [...byAnimal.values()].sort((left, right) =>
    priorityRank[left.priority] - priorityRank[right.priority]
    || Number(right.hasOpenMastitis) - Number(left.hasOpenMastitis)
    || (right.somaticCellCount ?? -1) - (left.somaticCellCount ?? -1)
    || left.animalId.localeCompare(right.animalId));
}

function normalizeControls(controls, throughDate) {
  return (controls ?? []).flatMap((control) => {
    const animalId = String(control?.animalId ?? "").trim();
    if (!animalId || !control?.controlDate) return [];
    const date = chileDateKey(control.controlDate);
    if (control.somaticCellCount === null || control.somaticCellCount === undefined || control.somaticCellCount === "") return [];
    const somaticCellCount = Number(control.somaticCellCount);
    const totalLiters = Number(control.totalLiters);
    if (date > throughDate || !Number.isFinite(somaticCellCount) || somaticCellCount < 0) return [];
    return [{ animalId, date, somaticCellCount, totalLiters: Number.isFinite(totalLiters) && totalLiters >= 0 ? totalLiters : 0 }];
  });
}

function normalizeHealthEvents(events, throughDate) {
  return (events ?? []).flatMap((event, index) => {
    const animalId = String(event?.animalId ?? "").trim();
    if (!animalId || !event?.occurredAt || event?.status === "cancelled") return [];
    const date = chileDateKey(event.occurredAt);
    if (date > throughDate) return [];
    return [{ ...event, id: String(event.id ?? `health-${index}`), animalId, date }];
  }).sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
}

function isCleared(sourceEvent, dimension, events) {
  return events.some((clearance) => {
    if (clearance.eventType !== "withdrawal_clearance" || clearance.animalId !== sourceEvent.animalId) return false;
    const target = String(clearance.metadata?.clearsEventId ?? "").trim();
    if (target) {
      if (target !== sourceEvent.id || clearance.date < sourceEvent.date) return false;
    } else if (clearance.date <= sourceEvent.date) {
      return false;
    }
    const declared = clearance.metadata?.withdrawalTypes ?? clearance.metadata?.withdrawalType ?? "both";
    const dimensions = Array.isArray(declared) ? declared.map(normalizeText) : [normalizeText(declared)];
    return dimensions.includes("both") || dimensions.includes("ambos") || dimensions.includes(dimension)
      || (dimension === "milk" && dimensions.includes("leche"))
      || (dimension === "meat" && dimensions.includes("carne"));
  });
}

function isMastitisEvent(event) {
  if (event.metadata?.mammary === true) return true;
  const text = normalizeText(`${event.condition ?? ""} ${event.notes ?? ""} ${event.metadata?.conditionCode ?? ""}`);
  return text.includes("mastitis") || text.includes("salud mamaria");
}

function normalizeThresholds(thresholds) {
  const normalized = {
    elevated: Number(thresholds?.elevated),
    high: Number(thresholds?.high),
    critical: Number(thresholds?.critical),
  };
  if (!Number.isFinite(normalized.elevated) || !Number.isFinite(normalized.high) || !Number.isFinite(normalized.critical)
    || normalized.elevated < 0 || normalized.elevated > normalized.high || normalized.high > normalized.critical) {
    throw new TypeError("Los umbrales RCS deben ser números ordenados: elevated <= high <= critical.");
  }
  return normalized;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("es-CL").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function optionalDate(value) {
  return value ? chileDateKey(value) : null;
}

function nonNegativeInteger(value, fallback) {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) throw new TypeError("La configuración de días debe ser un entero no negativo.");
  return normalized;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
