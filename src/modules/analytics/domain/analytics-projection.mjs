import { addChileDays, chileDateKey, chileDaysBetween } from "../../leche/domain/chile-date.mjs";
import {
  calculateCalvingInterval,
  calculateDaysOpen,
  calculateReproductiveRates,
} from "../../leche/domain/reproduction-metrics.mjs";
import { calculateDaysInMilk } from "../../leche/domain/lactation-metrics.mjs";
import {
  createRuleBasedRecommendationEngine,
  runRecommendationEngine,
} from "./recommendation-engine.mjs";

export const ANALYTICS_SCHEMA_VERSION = "fundosmart.analytics.projection.v1";
export const ANALYTICS_TIME_ZONE = "America/Santiago";

export const DEFAULT_ANALYTICS_THRESHOLDS = Object.freeze({
  milkDropPct: -15,
  somaticCellHigh: 400_000,
  somaticCellCritical: 700_000,
  mastitisRatePct: 5,
  pregnancyRatePctMinimum: 20,
  daysOpenMaximum: 150,
  calvingIntervalDaysMaximum: 420,
  averageDailyGainKgMinimum: 0,
  mortalityRatePctMaximum: 3,
  discardRatePctMaximum: 10,
  iofcMinimumClp: 0,
  expectedHeatCycleDays: 21,
});
export const DEFAULT_ANALYTICS_THRESHOLD_REVISION = "5bd5eadb9ae99326057b24198669677b0748f1e1b3a412d46d3ca96263a81685";

const PERIOD_KEY = /^(\d{4})-(\d{2})$/;
const LACTATION_CURVE_BUCKETS = Object.freeze([
  [1, 30], [31, 60], [61, 90], [91, 120], [121, 150],
  [151, 180], [181, 210], [211, 240], [241, 270], [271, 305],
]);
const PROBLEM_COW_CONTROL_COUNT = 3;
const PROBLEM_COW_DROP_LOOKBACK_DAYS = 120;
const PROBLEM_COW_MINIMUM_SPAN_DAYS = 14;
const PROBLEM_COW_SCC_LOOKBACK_DAYS = 60;

const DEFAULT_RECOMMENDATION_ENGINE = createRuleBasedRecommendationEngine({
  evaluate(context) {
    return [
      ...evaluateAnalyticsAlerts({ metrics: context.metrics, window: context.window }, context.thresholds),
      ...evaluateExpectedHeatAlerts(context.reproductiveEvents, context.window, context.thresholds),
    ];
  },
});

/**
 * Produces an inclusive civil-date window. Instants are converted to their
 * calendar day in Santiago so results do not depend on the process timezone.
 */
export function normalizeAnalyticsWindow(value) {
  const input = typeof value === "string" ? { period: value } : (value ?? {});
  if (input.timeZone && input.timeZone !== ANALYTICS_TIME_ZONE) {
    throw new RangeError(`La zona analítica debe ser ${ANALYTICS_TIME_ZONE}.`);
  }

  let period = null;
  let requestedStart;
  let requestedEnd;
  if (input.period) {
    period = String(input.period).trim();
    const match = PERIOD_KEY.exec(period);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
      throw new TypeError("El período analítico debe usar YYYY-MM.");
    }
    requestedStart = `${period}-01`;
    requestedEnd = monthEnd(requestedStart);
  } else {
    requestedStart = chileDateKey(input.start);
    requestedEnd = chileDateKey(input.end);
  }
  if (requestedEnd < requestedStart) {
    throw new RangeError("El fin de la ventana analítica no puede preceder su inicio.");
  }

  const asOf = input.asOf === undefined || input.asOf === null
    ? requestedEnd
    : chileDateKey(input.asOf);
  if (asOf < requestedStart) {
    throw new RangeError("La fecha de corte no puede preceder el inicio de la ventana.");
  }
  const end = minimumDate(requestedEnd, asOf);
  const dayCount = chileDaysBetween(requestedStart, end) + 1;
  const complete = end === requestedEnd;

  let comparisonStart;
  let comparisonEnd;
  if (period && complete) {
    comparisonEnd = addChileDays(requestedStart, -1);
    comparisonStart = `${comparisonEnd.slice(0, 7)}-01`;
  } else {
    comparisonEnd = addChileDays(requestedStart, -1);
    comparisonStart = addChileDays(comparisonEnd, -(dayCount - 1));
  }

  return {
    period,
    start: requestedStart,
    end,
    requestedEnd,
    asOf,
    complete,
    dayCount,
    timeZone: ANALYTICS_TIME_ZONE,
    boundaries: "inclusive",
    comparison: {
      start: comparisonStart,
      end: comparisonEnd,
      dayCount: chileDaysBetween(comparisonStart, comparisonEnd) + 1,
    },
  };
}

/**
 * Projects immutable source facts into rebuildable KPI and alert read models.
 * No clock, random identifier or input mutation participates in the result.
 */
export function buildAnalyticsProjection(input, options = {}) {
  const window = normalizeAnalyticsWindow(input?.window ?? {
    period: input?.period,
    start: input?.start,
    end: input?.end,
    asOf: input?.asOf,
  });
  const issues = new Map();
  const milk = normalizeMilkProduction(input?.milkProduction, window.end, issues);
  const quality = normalizeMilkQuality(input?.milkQuality, window.end, issues);
  const reproductiveEvents = normalizeReproductiveEvents(input?.reproductiveEvents, window.end, issues);
  const lactations = normalizeLactations(input?.lactations, window.end, issues);
  const milkControls = normalizeMilkControls(input?.milkControls, window.end, issues);
  const weights = normalizeWeights(input?.weights, window.end, issues);
  const outcomes = normalizeOutcomes(input?.outcomes, window.end, issues);
  const exposure = normalizeExposure(input?.herdExposure, window.end, issues);
  const finances = normalizeFinances(input?.finances, window.end, issues);

  reportOutliers(milk.filter((row) => inWindow(row.date, window)).map((row) => row.liters), "suspected_outlier_milk_liters", issues);
  reportOutliers(quality.filter((row) => inWindow(row.date, window) && row.somaticCellCount !== null).map((row) => row.somaticCellCount), "suspected_outlier_somatic_cell_count", issues);
  reportOutliers(weights.filter((row) => inWindow(row.date, window)).map((row) => row.weightKg), "suspected_outlier_weight", issues);

  const thresholds = normalizeAnalyticsThresholds(options.thresholds);
  const lactation = projectLactationAnalytics(lactations, milkControls, window, thresholds, issues);
  const metrics = [
    ...projectMilkMetrics(milk, quality, window),
    ...projectReproductionMetrics(reproductiveEvents, input?.reproductiveAnimalIds, window),
    ...lactation.metrics,
    ...projectWeightMetrics(weights, window),
    ...projectOutcomeMetrics(outcomes, exposure, window, input?.outcomesComplete === true),
    ...projectFinanceMetrics(finances, milk, window),
  ];
  const recommendations = runRecommendationEngine(
    options.recommendationEngine ?? DEFAULT_RECOMMENDATION_ENGINE,
    { metrics, reproductiveEvents, thresholds, window },
  );
  const alertEvaluations = [
    ...recommendations.evaluations,
    ...lactation.alertEvaluations,
  ].sort((left, right) => left.code.localeCompare(right.code));
  const issueList = [...issues]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
  const sourceCounts = {
    milkProduction: milk.length,
    milkQuality: quality.length,
    reproductiveEvents: reproductiveEvents.length,
    lactations: lactations.length,
    milkControls: milkControls.length,
    weights: weights.length,
    outcomes: outcomes.length,
    herdExposure: exposure.length,
    finances: finances.length,
  };
  const domains = {
    milk: domainState(milk.length + quality.length, issueList, ["milk", "somatic"]),
    reproduction: domainState(reproductiveEvents.length, issueList, ["reproductive"]),
    lactation: domainState(lactations.length + milkControls.length, issueList, ["lactation", "milk_control"]),
    weight: domainState(weights.length, issueList, ["weight"]),
    outcomes: domainState(outcomes.length + exposure.length, issueList, ["outcome", "exposure"]),
    finance: domainState(finances.length, issueList, ["finance"]),
  };
  const representedDomains = Object.values(domains).filter((state) => state !== "unavailable").length;
  const completeDomains = Object.values(domains).filter((state) => state === "available").length;

  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    window,
    reference: {
      organizationId: nullableText(input?.organizationId),
      fieldId: nullableText(input?.fieldId),
      datasetRevision: nullableText(input?.datasetRevision),
      sourceCounts,
      sourceCoverage: {
        outcomesComplete: input?.outcomesComplete === true,
      },
    },
    quality: {
      state: representedDomains === 0
        ? "unavailable"
        : issueList.length > 0 || completeDomains !== Object.keys(domains).length
          ? "partial"
          : "available",
      issues: issueList,
      domains,
    },
    metrics,
    recommendationEngine: {
      version: recommendations.engineVersion,
      adapterId: recommendations.adapterId,
      strategy: recommendations.strategy,
    },
    alertEvaluations,
    alerts: alertEvaluations.filter((evaluation) => evaluation.status === "triggered"),
  };
}

/** Returns every rule outcome, including explicit unavailable and clear states. */
export function evaluateAnalyticsAlerts(input, configuredThresholds = {}) {
  const thresholds = normalizeAnalyticsThresholds(configuredThresholds);
  const metrics = Array.isArray(input) ? input : (input?.metrics ?? []);
  const metricByKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const fallbackWindow = Array.isArray(input) ? null : (input?.window ?? null);
  const rules = [
    rule("MILK_PRODUCTION_DROP", "warning", "milk.volume_trend_pct", "lte", thresholds.milkDropPct,
      "Se activa cuando la producción diaria cae al menos el umbral configurado frente a la ventana comparable."),
    rule("SOMATIC_CELL_COUNT_HIGH", "warning", "milk.somatic_cell_count", "gte", thresholds.somaticCellHigh,
      "Se activa cuando el recuento de células somáticas alcanza el nivel alto configurado.", {
        criticalAt: thresholds.somaticCellCritical,
      }),
    rule("MASTITIS_RATE_HIGH", "warning", "health.mastitis_rate_pct", "gte", thresholds.mastitisRatePct,
      "Se activa cuando la proporción de animales con mastitis alcanza el umbral configurado."),
    rule("PREGNANCY_RATE_LOW", "warning", "reproduction.pregnancy_rate_pct", "lt", thresholds.pregnancyRatePctMinimum,
      "Se activa cuando la tasa de preñez queda bajo el mínimo configurado."),
    rule("DAYS_OPEN_HIGH", "warning", "reproduction.days_open_average", "gte", thresholds.daysOpenMaximum,
      "Se activa cuando el promedio de días abiertos alcanza el máximo configurado."),
    rule("CALVING_INTERVAL_HIGH", "warning", "reproduction.calving_interval_days_average", "gte", thresholds.calvingIntervalDaysMaximum,
      "Se activa cuando el intervalo entre partos promedio alcanza el máximo configurado."),
    rule("WEIGHT_GAIN_LOW", "warning", "weight.average_daily_gain_kg", "lte", thresholds.averageDailyGainKgMinimum,
      "Se activa cuando la ganancia diaria promedio queda en o bajo el mínimo configurado."),
    rule("MORTALITY_RATE_HIGH", "critical", "outcomes.mortality_rate_pct", "gte", thresholds.mortalityRatePctMaximum,
      "Se activa cuando la mortalidad alcanza el máximo configurado."),
    rule("DISCARD_RATE_HIGH", "warning", "outcomes.discard_rate_pct", "gte", thresholds.discardRatePctMaximum,
      "Se activa cuando el descarte alcanza el máximo configurado."),
    rule("IOFC_LOW", "critical", "finance.iofc_clp", "lte", thresholds.iofcMinimumClp,
      "Se activa cuando el ingreso sobre costo de alimento queda en o bajo el mínimo configurado."),
  ];

  return rules.map((definition) => {
    const metric = metricByKey.get(definition.metricKey);
    const observed = metric?.value ?? null;
    const available = metric?.status === "available" || metric?.status === "partial";
    const triggered = available && compare(observed, definition.operator, definition.threshold);
    const severity = definition.code === "SOMATIC_CELL_COUNT_HIGH"
      && available
      && observed >= definition.criticalAt
      ? "critical"
      : definition.severity;
    return {
      code: definition.code,
      status: available ? (triggered ? "triggered" : "clear") : "unavailable",
      severity,
      explanation: available
        ? definition.explanation
        : `No hay datos suficientes para evaluar ${definition.metricKey}.`,
      evidence: {
        metricKey: definition.metricKey,
        observed,
        operator: definition.operator,
        threshold: definition.threshold,
        unit: metric?.unit ?? null,
        numerator: metric?.numerator ?? null,
        denominator: metric?.denominator ?? null,
        sampleCount: metric?.sampleCount ?? 0,
      },
      window: metric?.window ?? fallbackWindow,
    };
  });
}

/**
 * Projects an expected return-to-heat date from the latest observed cycle
 * anchor. A later positive pregnancy, calving, abortion or dry-off explicitly
 * clears the expectation; no animal state is inferred from missing records.
 */
export function evaluateExpectedHeatAlerts(reproductiveEvents, window, configuredThresholds = {}) {
  const thresholds = normalizeAnalyticsThresholds(configuredThresholds);
  const eventsByAnimal = groupBy(reproductiveEvents, (event) => event.animalId);
  const evaluations = [];
  for (const [animalId, events] of eventsByAnimal) {
    const ordered = [...events].sort(byDateAndId);
    const anchor = [...ordered].reverse().find((event) => (
      event.eventType === "heat" || event.eventType === "service" || event.eventType === "insemination"
    ));
    if (!anchor) continue;
    const expectedDate = addChileDays(anchor.date, thresholds.expectedHeatCycleDays);
    const laterOutcome = ordered.find((event) => event !== anchor && event.date >= anchor.date && (
      (event.eventType === "pregnancy_diagnosis" && positiveReproductiveResult(event.result))
      || event.eventType === "calving"
      || event.eventType === "abortion"
      || event.eventType === "dry_off"
    ));
    const inExpectedWindow = expectedDate >= window.start && expectedDate <= window.end;
    const triggered = !laterOutcome && inExpectedWindow;
    const label = anchor.animalLabel || animalId;
    evaluations.push({
      code: `EXPECTED_HEAT:${encodeMetricSubjectId(animalId)}:${expectedDate}`,
      status: triggered ? "triggered" : "clear",
      severity: "warning",
      explanation: laterOutcome
        ? `${label} no mantiene una alerta de celo: ${laterOutcome.eventType} del ${laterOutcome.date} cerró la expectativa iniciada el ${anchor.date}.`
        : inExpectedWindow
          ? `${label} tiene celo esperado el ${expectedDate}, ${thresholds.expectedHeatCycleDays} días después de ${reproductiveAnchorLabel(anchor.eventType)} del ${anchor.date}.`
          : `${label} tiene una próxima fecha esperada de celo el ${expectedDate}; queda fuera de esta ventana.`,
      evidence: {
        metricKey: "reproduction.expected_heat_cycle_days",
        observed: thresholds.expectedHeatCycleDays,
        operator: "gte",
        threshold: thresholds.expectedHeatCycleDays,
        unit: "days",
        numerator: thresholds.expectedHeatCycleDays,
        denominator: 1,
        sampleCount: 1,
        subject: { type: "animal", id: animalId, label },
        observations: [{ date: anchor.date, value: thresholds.expectedHeatCycleDays }],
        anchorDate: anchor.date,
        anchorType: anchor.eventType,
        expectedDate,
        suppressedBy: laterOutcome ? { date: laterOutcome.date, eventType: laterOutcome.eventType } : null,
      },
      window,
    });
  }
  return evaluations.sort((left, right) => left.code.localeCompare(right.code));
}

function projectMilkMetrics(production, quality, window) {
  const current = production.filter((row) => inWindow(row.date, window));
  const previous = production.filter((row) => inComparison(row.date, window));
  const currentLiters = sum(current.map((row) => row.liters));
  const previousLiters = sum(previous.map((row) => row.liters));
  const currentPerDay = currentLiters / window.dayCount;
  const previousPerDay = previousLiters / window.comparison.dayCount;
  const productionReferences = [sourceReference("milk_production", current)];
  const trendReferences = [sourceReference("milk_production", current), sourceReference("milk_production_comparison", previous)];

  const byDay = groupBy(current, (row) => row.date);
  let cowDays = 0;
  let cowDenominatorComplete = current.length > 0;
  for (const rows of byDay.values()) {
    const declared = [...new Set(rows.map((row) => row.milkingCowCount).filter((value) => value !== null))];
    if (declared.length !== 1 || declared[0] <= 0 || rows.some((row) => row.milkingCowCount === null)) {
      cowDenominatorComplete = false;
      continue;
    }
    cowDays += declared[0];
  }

  const currentQuality = quality.filter((row) => inWindow(row.date, window));
  const previousQuality = quality.filter((row) => inComparison(row.date, window));
  const qualityMetric = (property, key, unit, precision) => {
    const currentRows = currentQuality.filter((row) => row[property] !== null);
    const previousRows = previousQuality.filter((row) => row[property] !== null);
    const currentValue = mean(currentRows.map((row) => row[property]));
    const previousValue = mean(previousRows.map((row) => row[property]));
    return [
      makeMetric({
        key,
        value: currentValue,
        unit,
        precision,
        status: currentRows.length > 0 ? "available" : "unavailable",
        statusReason: currentRows.length > 0 ? null : "no_current_samples",
        numerator: currentValue === null ? null : sum(currentRows.map((row) => row[property])),
        denominator: currentRows.length || null,
        sampleCount: currentRows.length,
        window,
        method: "arithmetic_mean",
        references: [sourceReference("milk_quality", currentRows)],
      }),
      makeMetric({
        key: `${key}_change_pp`,
        value: currentValue !== null && previousValue !== null ? currentValue - previousValue : null,
        unit: "percentage_points",
        precision: 2,
        status: currentValue !== null && previousValue !== null ? "available" : "unavailable",
        statusReason: currentValue === null ? "no_current_samples" : previousValue === null ? "no_comparison_samples" : null,
        numerator: currentValue,
        denominator: previousValue,
        sampleCount: currentRows.length + previousRows.length,
        window,
        method: "difference_of_arithmetic_means",
        references: [sourceReference("milk_quality", currentRows), sourceReference("milk_quality_comparison", previousRows)],
      }),
    ];
  };

  const currentScc = currentQuality.filter((row) => row.somaticCellCount !== null);
  const previousScc = previousQuality.filter((row) => row.somaticCellCount !== null);
  const currentSccAverage = somaticCellAverage(currentScc);
  const previousSccAverage = somaticCellAverage(previousScc);

  return [
    makeMetric({
      key: "milk.volume_liters",
      value: current.length > 0 ? currentLiters : null,
      unit: "liters",
      precision: 2,
      status: current.length > 0 ? "available" : "unavailable",
      statusReason: current.length > 0 ? null : "no_current_production",
      numerator: current.length > 0 ? currentLiters : null,
      denominator: null,
      sampleCount: current.length,
      window,
      method: "sum",
      references: productionReferences,
    }),
    makeMetric({
      key: "milk.volume_trend_pct",
      value: current.length > 0 && previous.length > 0 && previousPerDay > 0
        ? ((currentPerDay - previousPerDay) / previousPerDay) * 100
        : null,
      unit: "percent",
      precision: 2,
      status: current.length === 0 || previous.length === 0
        ? "unavailable"
        : previousPerDay <= 0
          ? "insufficient_data"
          : "available",
      statusReason: current.length === 0
        ? "no_current_production"
        : previous.length === 0
          ? "no_comparison_production"
          : previousPerDay <= 0
            ? "zero_comparison_denominator"
            : null,
      numerator: current.length > 0 ? currentPerDay : null,
      denominator: previous.length > 0 ? previousPerDay : null,
      sampleCount: current.length + previous.length,
      window,
      method: "daily_average_relative_change",
      references: trendReferences,
    }),
    makeMetric({
      key: "milk.production_per_cow_day_liters",
      value: cowDenominatorComplete && cowDays > 0 ? currentLiters / cowDays : null,
      unit: "liters_per_cow_day",
      precision: 3,
      status: current.length === 0
        ? "unavailable"
        : cowDenominatorComplete && cowDays > 0
          ? "available"
          : "insufficient_data",
      statusReason: current.length === 0 ? "no_current_production" : cowDays <= 0 ? "zero_or_missing_cow_days" : "conflicting_cow_count",
      numerator: current.length > 0 ? currentLiters : null,
      denominator: cowDays || null,
      sampleCount: current.length,
      window,
      method: "liters_divided_by_observed_cow_days",
      references: productionReferences,
    }),
    ...qualityMetric("fatPct", "milk.fat_pct", "percent", 3),
    ...qualityMetric("proteinPct", "milk.protein_pct", "percent", 3),
    makeMetric({
      key: "milk.somatic_cell_count",
      value: currentSccAverage.value,
      unit: "cells_per_ml",
      precision: 0,
      status: currentScc.length > 0 ? "available" : "unavailable",
      statusReason: currentScc.length > 0 ? null : "no_current_somatic_cell_samples",
      numerator: currentSccAverage.numerator,
      denominator: currentSccAverage.denominator,
      sampleCount: currentScc.length,
      window,
      method: currentSccAverage.method,
      references: [sourceReference("milk_quality", currentScc)],
    }),
    makeMetric({
      key: "milk.somatic_cell_trend_pct",
      value: currentSccAverage.value !== null && previousSccAverage.value !== null && previousSccAverage.value > 0
        ? ((currentSccAverage.value - previousSccAverage.value) / previousSccAverage.value) * 100
        : null,
      unit: "percent",
      precision: 2,
      status: currentSccAverage.value === null || previousSccAverage.value === null
        ? "unavailable"
        : previousSccAverage.value <= 0
          ? "insufficient_data"
          : "available",
      statusReason: currentSccAverage.value === null ? "no_current_somatic_cell_samples" : previousSccAverage.value === null ? "no_comparison_somatic_cell_samples" : previousSccAverage.value <= 0 ? "zero_comparison_denominator" : null,
      numerator: currentSccAverage.value,
      denominator: previousSccAverage.value,
      sampleCount: currentScc.length + previousScc.length,
      window,
      method: "relative_change_of_period_averages",
      references: [sourceReference("milk_quality", currentScc), sourceReference("milk_quality_comparison", previousScc)],
    }),
  ];
}

function projectReproductionMetrics(events, declaredAnimalIds, window) {
  const animalIds = [...new Set([
    ...(declaredAnimalIds ?? []).map(String).filter(Boolean),
    ...events.map((event) => event.animalId),
  ])].sort();
  const rates = calculateReproductiveRates(events, {
    periodStart: window.start,
    periodEnd: window.end,
    animalIds,
  });
  const hasBreedingEvents = events.some((e) => e.eventType === "service" || e.eventType === "insemination");
  const daysOpenResults = animalIds.flatMap((animalId) => {
    const value = calculateDaysOpen(events.filter((event) => event.animalId === animalId), window.end);
    return value && value.status !== "insufficient_data" ? [value.days] : [];
  });
  const intervals = animalIds.flatMap((animalId) => {
    const value = calculateCalvingInterval(events.filter((event) => event.animalId === animalId), window.end);
    return value ? [value.days] : [];
  });
  const reference = [sourceReference("reproductive_events", events)];
  return [
    makeMetric({
      key: "reproduction.pregnancy_rate_pct",
      value: rates.pregnancyRatePct,
      unit: "percent",
      precision: 2,
      status: rates.eligibleCycleCount > 0 ? "available" : "insufficient_data",
      statusReason: rates.eligibleCycleCount > 0 ? null : "zero_eligible_cycles",
      numerator: rates.conceptionCount,
      denominator: rates.eligibleCycleCount,
      sampleCount: rates.eligibleAnimalCount,
      window,
      method: "conceptions_per_eligible_cycle",
      references: reference,
    }),
    makeMetric({
      key: "reproduction.days_open_average",
      value: hasBreedingEvents ? mean(daysOpenResults) : null,
      unit: "days",
      precision: 1,
      status: !hasBreedingEvents
        ? "insufficient_data"
        : daysOpenResults.length > 0
          ? "available"
          : "unavailable",
      statusReason: !hasBreedingEvents
        ? "no_service_or_insemination_events"
        : daysOpenResults.length > 0
          ? null
          : "no_calving_history",
      numerator: hasBreedingEvents ? sumOrNull(daysOpenResults) : null,
      denominator: hasBreedingEvents ? (daysOpenResults.length || null) : null,
      sampleCount: hasBreedingEvents ? daysOpenResults.length : 0,
      window,
      method: "mean_days_from_latest_calving_to_conception_or_cutoff",
      references: reference,
    }),
    makeMetric({
      key: "reproduction.calving_interval_days_average",
      value: mean(intervals),
      unit: "days",
      precision: 1,
      status: intervals.length > 0 ? "available" : "unavailable",
      statusReason: intervals.length > 0 ? null : "fewer_than_two_calvings_per_animal",
      numerator: sumOrNull(intervals),
      denominator: intervals.length || null,
      sampleCount: intervals.length,
      window,
      method: "mean_latest_calving_interval",
      references: reference,
    }),
  ];
}

function projectLactationAnalytics(lactations, milkControls, window, configuredThresholds, issues) {
  const thresholds = normalizeAnalyticsThresholds(configuredThresholds);
  const lactationById = new Map(lactations.map((entry) => [entry.sourceId, entry]));
  const activeLactations = lactations.filter((entry) => (
    entry.startedAt <= window.end
    && (entry.endedAt ? entry.endedAt >= window.end : !entry.status || entry.status === "active")
  ));
  const daysInMilk = activeLactations.flatMap((entry) => {
    const value = calculateDaysInMilk(entry, window.end);
    return value === null ? [] : [value];
  });
  const linkedControls = milkControls.flatMap((control) => {
    if (!control.lactationId) return [];
    const lactation = lactationById.get(control.lactationId);
    if (!lactation || lactation.animalId !== control.animalId) return [];
    if (control.date < lactation.startedAt || (lactation.endedAt && control.date > lactation.endedAt)) return [];
    const dim = chileDaysBetween(lactation.startedAt, control.date) + 1;
    return dim >= 1 ? [{ ...control, dim, lactation }] : [];
  });
  const controlsWithHistoricalLot = linkedControls.filter((control) => control.historicalLotId);
  if (linkedControls.length > controlsWithHistoricalLot.length) {
    addIssue(issues, "historical_lot_membership_unavailable", linkedControls.length - controlsWithHistoricalLot.length);
  }
  const metrics = [
    makeMetric({
      key: "lactation.days_in_milk_average",
      value: mean(daysInMilk),
      unit: "days",
      precision: 1,
      status: daysInMilk.length > 0 ? "available" : "unavailable",
      statusReason: daysInMilk.length > 0 ? null : "no_active_lactations_at_cutoff",
      numerator: sumOrNull(daysInMilk),
      denominator: daysInMilk.length || null,
      sampleCount: daysInMilk.length,
      window,
      method: "mean_inclusive_days_from_lactation_start",
      references: [sourceReference("livestock_lactations", activeLactations)],
    }),
    ...LACTATION_CURVE_BUCKETS.map(([start, end]) => {
      const controls = linkedControls.filter((entry) => entry.dim >= start && entry.dim <= end);
      const liters = controls.map((entry) => entry.totalLiters);
      return makeMetric({
        key: `lactation.curve.dim_${String(start).padStart(3, "0")}_${String(end).padStart(3, "0")}_liters`,
        value: mean(liters),
        unit: "liters_per_control_day",
        precision: 2,
        status: controls.length > 0 ? "available" : "unavailable",
        statusReason: controls.length > 0 ? null : "no_linked_milk_controls_in_dim_bucket",
        numerator: sumOrNull(liters),
        denominator: controls.length || null,
        sampleCount: controls.length,
        window,
        method: "arithmetic_mean_of_linked_test_days_by_dim_bucket",
        references: [sourceReference("livestock_milk_controls", controls)],
      });
    }),
  ];

  const animalSubjects = uniqueSubjects(
    lactations.map((entry) => ({ id: entry.animalId, label: entry.animalLabel || entry.animalId })),
  );
  const lotSubjects = uniqueSubjects(controlsWithHistoricalLot.map((entry) => ({
    id: entry.historicalLotId,
    label: entry.historicalLotName || entry.historicalLotId,
  })));
  const currentControls = linkedControls.filter((control) => inWindow(control.date, window));
  const currentLotControls = controlsWithHistoricalLot.filter((control) => inWindow(control.date, window));

  for (const subject of animalSubjects) {
    const subjectControls = linkedControls.filter((control) => control.animalId === subject.id);
    const productionControls = currentControls.filter((control) => control.animalId === subject.id);
    metrics.push(subjectProductionMetric("animal", subject, productionControls, window));
    metrics.push(...subjectCurveMetrics("animal", subject, subjectControls, window));
  }

  for (const subject of lotSubjects) {
    const subjectControls = controlsWithHistoricalLot.filter((control) => control.historicalLotId === subject.id);
    const productionControls = currentLotControls.filter((control) => control.historicalLotId === subject.id);
    metrics.push(subjectProductionMetric("lot", subject, productionControls, window));
    metrics.push(...subjectCurveMetrics("lot", subject, subjectControls, window));
  }

  const lotCoverage = linkedControls.length > 0 ? controlsWithHistoricalLot.length / linkedControls.length * 100 : null;
  metrics.push(makeMetric({
    key: "lactation.historical_lot_membership_coverage_pct",
    value: lotCoverage,
    unit: "percent",
    precision: 2,
    status: linkedControls.length === 0
      ? "unavailable"
      : controlsWithHistoricalLot.length === 0
        ? "unavailable"
        : controlsWithHistoricalLot.length === linkedControls.length
          ? "available"
          : "partial",
    statusReason: linkedControls.length === 0
      ? "no_linked_milk_controls"
      : controlsWithHistoricalLot.length === 0
        ? "historical_lot_membership_unavailable"
        : controlsWithHistoricalLot.length === linkedControls.length
          ? null
          : "historical_lot_membership_partial",
    numerator: controlsWithHistoricalLot.length,
    denominator: linkedControls.length || null,
    sampleCount: linkedControls.length,
    window,
    method: "historically_resolved_controls_divided_by_linked_controls",
    references: [sourceReference("livestock_milk_controls", linkedControls)],
  }));

  const alertEvaluations = [];
  const dropCutoff = addChileDays(window.end, -(PROBLEM_COW_DROP_LOOKBACK_DAYS - 1));
  const sccCutoff = addChileDays(window.end, -(PROBLEM_COW_SCC_LOOKBACK_DAYS - 1));
  for (const lactation of activeLactations) {
    const controls = linkedControls
      .filter((entry) => entry.lactation.sourceId === lactation.sourceId && entry.date <= window.end)
      .sort(byDateAndId);
    const label = lactation.animalLabel || controls.at(-1)?.animalLabel || lactation.animalId;
    const subject = { type: "animal", id: lactation.animalId, label };
    const recentScc = controls
      .filter((entry) => entry.date >= sccCutoff && entry.somaticCellCount !== null)
      .at(-1);
    if (recentScc && recentScc.somaticCellCount >= thresholds.somaticCellHigh) {
      alertEvaluations.push({
        code: `PROBLEM_COW_SOMATIC_CELL_HIGH:${lactation.animalId}`,
        status: "triggered",
        severity: recentScc.somaticCellCount >= thresholds.somaticCellCritical ? "critical" : "warning",
        explanation: `${label} registró ${Math.round(recentScc.somaticCellCount).toLocaleString("es-CL")} cél/mL el ${recentScc.date}; el umbral es ${Math.round(thresholds.somaticCellHigh).toLocaleString("es-CL")} cél/mL.`,
        evidence: {
          metricKey: "animal.somatic_cell_count",
          observed: recentScc.somaticCellCount,
          operator: "gte",
          threshold: thresholds.somaticCellHigh,
          unit: "cells_per_ml",
          numerator: recentScc.somaticCellCount,
          denominator: 1,
          sampleCount: 1,
          subject,
          observations: [{ date: recentScc.date, value: recentScc.somaticCellCount }],
        },
        window,
      });
    }

    const recentProduction = controls
      .filter((entry) => entry.date >= dropCutoff)
      .slice(-PROBLEM_COW_CONTROL_COUNT);
    if (recentProduction.length !== PROBLEM_COW_CONTROL_COUNT) continue;
    const strictlyDeclining = recentProduction.every((entry, index) => (
      index === 0 || entry.totalLiters < recentProduction[index - 1].totalLiters
    ));
    const observationSpanDays = chileDaysBetween(recentProduction[0].date, recentProduction.at(-1).date);
    const first = recentProduction[0].totalLiters;
    const last = recentProduction.at(-1).totalLiters;
    const dropPct = first > 0 ? ((last - first) / first) * 100 : null;
    if (
      !strictlyDeclining
      || observationSpanDays < PROBLEM_COW_MINIMUM_SPAN_DAYS
      || dropPct === null
      || dropPct > thresholds.milkDropPct
    ) continue;
    alertEvaluations.push({
      code: `PROBLEM_COW_PRODUCTION_DROP:${lactation.animalId}`,
      status: "triggered",
      severity: "warning",
      explanation: `${label} bajó en tres controles consecutivos, de ${roundNullable(first, 2)} L a ${roundNullable(last, 2)} L (${roundNullable(dropPct, 2)}%) entre ${recentProduction[0].date} y ${recentProduction.at(-1).date}.`,
      evidence: {
        metricKey: "animal.production_drop_pct",
        observed: roundNullable(dropPct, 2),
        operator: "lte",
        threshold: thresholds.milkDropPct,
        unit: "percent",
        numerator: last - first,
        denominator: first,
        sampleCount: recentProduction.length,
        subject,
        observations: recentProduction.map((entry) => ({ date: entry.date, value: entry.totalLiters })),
      },
      window,
    });
  }

  return {
    metrics,
    alertEvaluations: alertEvaluations.sort((left, right) => left.code.localeCompare(right.code)),
  };
}

function subjectProductionMetric(kind, subject, controls, window) {
  const liters = controls.map((entry) => entry.totalLiters);
  return makeMetric({
    key: `milk.production.${kind}:${encodeMetricSubjectId(subject.id)}:liters_per_control_day`,
    value: mean(liters),
    unit: "liters_per_control_day",
    precision: 2,
    status: controls.length > 0 ? "available" : "unavailable",
    statusReason: controls.length > 0 ? null : "no_individual_milk_controls_in_window",
    numerator: sumOrNull(liters),
    denominator: controls.length || null,
    sampleCount: controls.length,
    window,
    method: "arithmetic_mean_of_individual_test_days_in_window",
    references: [sourceReference("livestock_milk_controls", controls, { type: kind, ...subject })],
  });
}

function subjectCurveMetrics(kind, subject, controls, window) {
  return LACTATION_CURVE_BUCKETS.map(([start, end]) => {
    const bucketControls = controls.filter((entry) => entry.dim >= start && entry.dim <= end);
    const liters = bucketControls.map((entry) => entry.totalLiters);
    return makeMetric({
      key: `lactation.curve.${kind}:${encodeMetricSubjectId(subject.id)}:dim_${String(start).padStart(3, "0")}_${String(end).padStart(3, "0")}_liters`,
      value: mean(liters),
      unit: "liters_per_control_day",
      precision: 2,
      status: bucketControls.length > 0 ? "available" : "unavailable",
      statusReason: bucketControls.length > 0 ? null : "no_linked_milk_controls_in_dim_bucket",
      numerator: sumOrNull(liters),
      denominator: bucketControls.length || null,
      sampleCount: bucketControls.length,
      window,
      method: `arithmetic_mean_of_${kind}_test_days_by_dim_bucket`,
      references: [sourceReference("livestock_milk_controls", bucketControls, { type: kind, ...subject })],
    });
  });
}

function uniqueSubjects(subjects) {
  const byId = new Map();
  for (const subject of subjects) {
    if (subject.id && !byId.has(subject.id)) byId.set(subject.id, subject);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function encodeMetricSubjectId(value) {
  return encodeURIComponent(value);
}

function projectWeightMetrics(weights, window) {
  const current = weights.filter((row) => inWindow(row.date, window));
  const byAnimal = groupBy(current, (row) => row.animalId);
  const gains = [];
  for (const [animalId, rows] of byAnimal) {
    const sorted = [...rows].sort(byDateAndId);
    const first = sorted[0];
    const last = sorted.at(-1);
    const days = chileDaysBetween(first.date, last.date);
    if (days <= 0) continue;
    gains.push({ animalId, days, gainKg: last.weightKg - first.weightKg, dailyGainKg: (last.weightKg - first.weightKg) / days });
  }
  const totalDays = sum(gains.map((gain) => gain.days));
  return [
    makeMetric({
      key: "weight.total_gain_kg",
      value: gains.length > 0 ? sum(gains.map((gain) => gain.gainKg)) : null,
      unit: "kg",
      precision: 2,
      status: gains.length > 0 ? "available" : current.length > 0 ? "insufficient_data" : "unavailable",
      statusReason: gains.length > 0 ? null : current.length > 0 ? "fewer_than_two_distinct_weight_dates" : "no_weight_samples",
      numerator: gains.length > 0 ? sum(gains.map((gain) => gain.gainKg)) : null,
      denominator: null,
      sampleCount: gains.length,
      window,
      method: "sum_of_first_to_last_animal_gain",
      references: [sourceReference("weights", current)],
    }),
    makeMetric({
      key: "weight.average_daily_gain_kg",
      value: gains.length > 0 && totalDays > 0 ? sum(gains.map((gain) => gain.gainKg)) / totalDays : null,
      unit: "kg_per_day",
      precision: 3,
      status: gains.length > 0 ? "available" : current.length > 0 ? "insufficient_data" : "unavailable",
      statusReason: gains.length > 0 ? null : current.length > 0 ? "fewer_than_two_distinct_weight_dates" : "no_weight_samples",
      numerator: gains.length > 0 ? sum(gains.map((gain) => gain.gainKg)) : null,
      denominator: totalDays || null,
      sampleCount: gains.length,
      window,
      method: "aggregate_gain_divided_by_observation_days",
      references: [sourceReference("weights", current)],
    }),
  ];
}

function projectOutcomeMetrics(outcomes, exposure, window, outcomesComplete) {
  const current = outcomes.filter((row) => inWindow(row.date, window));
  const currentExposure = exposure.filter((row) => inWindow(row.date, window));
  const averageExposure = mean(currentExposure.map((row) => row.activeAnimals));
  const counts = (type) => new Set(current.filter((row) => row.type === type).map((row) => row.animalId)).size;
  const mortalityCount = counts("death");
  const discardCount = counts("discard");
  const hasOutcomeCoverage = outcomesComplete;
  const reference = [sourceReference("outcomes", current), sourceReference("herd_exposure", currentExposure)];
  const rate = (key, count) => makeMetric({
    key,
    value: averageExposure !== null && averageExposure > 0 ? (count / averageExposure) * 100 : null,
    unit: "percent",
    precision: 2,
    status: !hasOutcomeCoverage || currentExposure.length === 0 ? "unavailable" : averageExposure > 0 ? "available" : "insufficient_data",
    statusReason: !hasOutcomeCoverage ? "outcome_source_not_confirmed_complete" : currentExposure.length === 0 ? "no_herd_exposure" : averageExposure <= 0 ? "zero_herd_exposure" : null,
    numerator: count,
    denominator: averageExposure,
    sampleCount: currentExposure.length,
    window,
    method: "unique_animals_divided_by_mean_observed_herd",
    references: reference,
  });
  return [
    makeMetric({
      key: "health.mastitis_case_count",
      value: hasOutcomeCoverage
        ? new Set(current.filter((row) => row.type === "mastitis").map((row) => row.animalId)).size
        : null,
      unit: "animals",
      precision: 0,
      status: hasOutcomeCoverage ? "available" : "unavailable",
      statusReason: hasOutcomeCoverage ? null : "outcome_source_not_confirmed_complete",
      numerator: hasOutcomeCoverage
        ? new Set(current.filter((row) => row.type === "mastitis").map((row) => row.animalId)).size
        : null,
      denominator: null,
      sampleCount: current.filter((row) => row.type === "mastitis").length,
      window,
      method: "distinct_animals_with_mastitis",
      references: [sourceReference("outcomes", current)],
    }),
    rate("health.mastitis_rate_pct", new Set(current.filter((row) => row.type === "mastitis").map((row) => row.animalId)).size),
    rate("outcomes.mortality_rate_pct", mortalityCount),
    rate("outcomes.discard_rate_pct", discardCount),
  ];
}

function projectFinanceMetrics(finances, production, window) {
  const current = finances.filter((row) => inWindow(row.date, window));
  const currentProduction = production.filter((row) => inWindow(row.date, window));
  const liters = sum(currentProduction.map((row) => row.liters));
  const hasRevenue = current.some((row) => row.milkRevenueClp !== null);
  const hasFeedCost = current.some((row) => row.feedCostClp !== null);
  const hasOtherCost = current.some((row) => row.otherCostClp !== null);
  const revenue = sum(current.map((row) => row.milkRevenueClp ?? 0));
  const feedCost = sum(current.map((row) => row.feedCostClp ?? 0));
  const otherCost = sum(current.map((row) => row.otherCostClp ?? 0));
  const totalCost = feedCost + otherCost;
  const reference = [sourceReference("finances", current)];
  return [
    makeMetric({
      key: "finance.feed_cost_clp",
      value: hasFeedCost ? feedCost : null,
      unit: "clp",
      precision: 0,
      status: hasFeedCost ? "available" : "unavailable",
      statusReason: hasFeedCost ? null : "no_feed_cost",
      numerator: hasFeedCost ? feedCost : null,
      denominator: null,
      sampleCount: current.filter((row) => row.feedCostClp !== null).length,
      window,
      method: "sum",
      references: reference,
    }),
    makeMetric({
      key: "finance.iofc_clp",
      value: hasRevenue && hasFeedCost ? revenue - feedCost : null,
      unit: "clp",
      precision: 0,
      status: hasRevenue && hasFeedCost ? "available" : "unavailable",
      statusReason: !hasRevenue ? "no_milk_revenue" : !hasFeedCost ? "no_feed_cost" : null,
      numerator: hasRevenue ? revenue : null,
      denominator: hasFeedCost ? feedCost : null,
      sampleCount: current.length,
      window,
      method: "milk_revenue_minus_feed_cost",
      references: reference,
    }),
    makeMetric({
      key: "finance.cost_per_liter_clp",
      value: (hasFeedCost || hasOtherCost) && currentProduction.length > 0 && liters > 0 ? totalCost / liters : null,
      unit: "clp_per_liter",
      precision: 2,
      status: !hasFeedCost && !hasOtherCost
        ? "unavailable"
        : currentProduction.length === 0
          ? "unavailable"
          : liters <= 0
            ? "insufficient_data"
            : "available",
      statusReason: !hasFeedCost && !hasOtherCost ? "no_cost_data" : currentProduction.length === 0 ? "no_current_production" : liters <= 0 ? "zero_liter_denominator" : null,
      numerator: hasFeedCost || hasOtherCost ? totalCost : null,
      denominator: currentProduction.length > 0 ? liters : null,
      sampleCount: current.length + currentProduction.length,
      window,
      method: "feed_and_other_cost_divided_by_liters",
      references: [sourceReference("finances", current), sourceReference("milk_production", currentProduction)],
    }),
  ];
}

function normalizeMilkProduction(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_milk_production", issues, (row) => {
    const liters = nonNegativeNumber(row?.liters);
    if (liters === null) return null;
    const declaredCows = optionalNonNegativeNumber(row?.milkingCowCount);
    if (row?.milkingCowCount !== null && row?.milkingCowCount !== undefined && declaredCows === null) {
      addIssue(issues, "invalid_milk_cow_count");
    }
    return { liters, milkingCowCount: declaredCows };
  });
}

function normalizeMilkQuality(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_milk_quality", issues, (row) => {
    const fatPct = optionalFactNumber(row?.fatPct, "invalid_milk_quality_value", issues);
    const proteinPct = optionalFactNumber(row?.proteinPct, "invalid_milk_quality_value", issues);
    const somaticCellCount = optionalFactNumber(row?.somaticCellCount, "invalid_milk_quality_value", issues);
    const liters = optionalFactNumber(row?.liters, "invalid_milk_quality_value", issues);
    if ([fatPct, proteinPct, somaticCellCount].every((value) => value === null)) return null;
    return { fatPct, proteinPct, somaticCellCount, liters };
  });
}

function normalizeReproductiveEvents(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_reproductive_event", issues, (row) => {
    const animalId = nullableText(row?.animalId);
    const eventType = nullableText(row?.eventType);
    if (!animalId || !eventType) return null;
    return {
      animalId,
      animalLabel: nullableText(row?.animalLabel) || animalId,
      eventType,
      result: row?.result ?? null,
      metadata: row?.metadata ?? null,
    };
  }, "occurredAt").map((row) => ({ ...row, id: row.sourceId, occurredAt: row.date }));
}

function normalizeLactations(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_lactation", issues, (row) => {
    const animalId = nullableText(row?.animalId);
    if (!animalId) return null;
    let endedAt = null;
    if (row?.endedAt) {
      try {
        endedAt = chileDateKey(row.endedAt);
      } catch {
        addIssue(issues, "invalid_lactation_end");
        return null;
      }
    }
    const startedAt = chileDateKey(row.startedAt);
    if (endedAt && endedAt < startedAt) {
      addIssue(issues, "invalid_lactation_end");
      return null;
    }
    return {
      animalId,
      animalLabel: nullableText(row?.animalLabel) || animalId,
      startedAt,
      endedAt,
      status: nullableText(row?.status),
    };
  }, "startedAt").map((row) => ({ ...row, id: row.sourceId }));
}

function normalizeMilkControls(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_milk_control", issues, (row) => {
    const animalId = nullableText(row?.animalId);
    const totalLiters = nonNegativeNumber(row?.totalLiters);
    const somaticCellCount = optionalFactNumber(row?.somaticCellCount, "invalid_milk_control_somatic_cell_count", issues);
    if (!animalId || totalLiters === null) return null;
    const lactationId = nullableText(row?.lactationId);
    if (!lactationId) addIssue(issues, "unlinked_milk_control");
    return {
      animalId,
      animalLabel: nullableText(row?.animalLabel) || animalId,
      lactationId,
      historicalLotId: nullableText(row?.historicalLotId),
      historicalLotName: nullableText(row?.historicalLotName),
      totalLiters,
      somaticCellCount,
    };
  });
}

function normalizeWeights(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_weight", issues, (row) => {
    const animalId = nullableText(row?.animalId);
    const weightKg = nonNegativeNumber(row?.weightKg);
    if (!animalId || weightKg === null) return null;
    return { animalId, weightKg };
  });
}

function normalizeOutcomes(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_outcome", issues, (row) => {
    const animalId = nullableText(row?.animalId);
    const type = nullableText(row?.type);
    if (!animalId || !["death", "discard", "mastitis"].includes(type)) return null;
    return { animalId, type };
  });
}

function normalizeExposure(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_exposure", issues, (row) => {
    const activeAnimals = optionalNonNegativeNumber(row?.activeAnimals);
    if (activeAnimals === null) return null;
    return { activeAnimals };
  });
}

function normalizeFinances(rows, throughDate, issues) {
  return normalizeDatedRows(rows, throughDate, "invalid_finance", issues, (row) => {
    const milkRevenueClp = optionalFactNumber(row?.milkRevenueClp, "invalid_finance_value", issues);
    const feedCostClp = optionalFactNumber(row?.feedCostClp, "invalid_finance_value", issues);
    const otherCostClp = optionalFactNumber(row?.otherCostClp, "invalid_finance_value", issues);
    if ([milkRevenueClp, feedCostClp, otherCostClp].every((value) => value === null)) return null;
    return { milkRevenueClp, feedCostClp, otherCostClp };
  });
}

function normalizeDatedRows(rows, throughDate, issueCode, issues, project, dateField = "date") {
  const normalized = [];
  for (const row of rows ?? []) {
    let date;
    try {
      date = chileDateKey(row?.[dateField]);
    } catch {
      addIssue(issues, issueCode);
      continue;
    }
    if (date > throughDate) continue;
    const projected = project(row);
    if (!projected) {
      addIssue(issues, issueCode);
      continue;
    }
    normalized.push({
      ...projected,
      date,
      sourceId: nullableText(row?.id ?? row?.sourceId),
    });
  }
  return normalized.sort(byDateAndId);
}

function makeMetric(input) {
  return {
    key: input.key,
    status: input.status,
    statusReason: input.statusReason ?? null,
    value: roundNullable(input.value, input.precision),
    unit: input.unit,
    numerator: roundNullable(input.numerator, 6),
    denominator: roundNullable(input.denominator, 6),
    sampleCount: input.sampleCount,
    window: input.window,
    method: input.method,
    references: input.references,
  };
}

function somaticCellAverage(rows) {
  if (rows.length === 0) return { value: null, numerator: null, denominator: null, method: "unavailable" };
  const completeWeights = rows.every((row) => row.liters !== null && row.liters > 0);
  if (completeWeights) {
    const denominator = sum(rows.map((row) => row.liters));
    const numerator = sum(rows.map((row) => row.somaticCellCount * row.liters));
    return { value: numerator / denominator, numerator, denominator, method: "volume_weighted_mean" };
  }
  const numerator = sum(rows.map((row) => row.somaticCellCount));
  return { value: numerator / rows.length, numerator, denominator: rows.length, method: "arithmetic_mean_without_complete_volume" };
}

function sourceReference(kind, rows, subject = undefined) {
  const sourceIds = [...new Set(rows.map((row) => row.sourceId).filter(Boolean))].sort();
  const dates = rows.map((row) => row.date).sort();
  return {
    kind,
    count: rows.length,
    sourceIds,
    observedFrom: dates[0] ?? null,
    observedThrough: dates.at(-1) ?? null,
    ...(subject ? { subject } : {}),
  };
}

export function normalizeAnalyticsThresholds(value) {
  const normalized = { ...DEFAULT_ANALYTICS_THRESHOLDS };
  for (const key of Object.keys(normalized)) {
    if (value?.[key] === undefined || value?.[key] === null) continue;
    const number = Number(value[key]);
    if (!Number.isFinite(number)) throw new TypeError(`El umbral ${key} debe ser finito.`);
    normalized[key] = number;
  }
  if (normalized.milkDropPct > 0) throw new RangeError("milkDropPct debe ser cero o negativo.");
  if (normalized.milkDropPct < -100) throw new RangeError("milkDropPct no puede ser menor que -100.");
  if (normalized.somaticCellHigh < 0 || normalized.somaticCellCritical < normalized.somaticCellHigh) {
    throw new RangeError("Los umbrales RCS deben ser no negativos y estar ordenados.");
  }
  if (normalized.somaticCellCritical > 10_000_000) throw new RangeError("Los umbrales RCS exceden el máximo operativo.");
  for (const key of ["mastitisRatePct", "pregnancyRatePctMinimum", "mortalityRatePctMaximum", "discardRatePctMaximum"]) {
    if (normalized[key] < 0 || normalized[key] > 100) throw new RangeError(`El umbral ${key} debe estar entre 0 y 100.`);
  }
  for (const key of ["daysOpenMaximum", "calvingIntervalDaysMaximum"]) {
    if (normalized[key] < 0 || normalized[key] > 3650) throw new RangeError(`El umbral ${key} debe estar entre 0 y 3650.`);
  }
  if (!Number.isInteger(normalized.expectedHeatCycleDays) || normalized.expectedHeatCycleDays < 1 || normalized.expectedHeatCycleDays > 60) {
    throw new RangeError("expectedHeatCycleDays debe ser un entero entre 1 y 60.");
  }
  if (Math.abs(normalized.averageDailyGainKgMinimum) > 100) throw new RangeError("averageDailyGainKgMinimum excede el rango operativo.");
  if (Math.abs(normalized.iofcMinimumClp) > 1_000_000_000_000) throw new RangeError("iofcMinimumClp excede el rango operativo.");
  return normalized;
}

function rule(code, severity, metricKey, operator, threshold, explanation, extra = {}) {
  return { code, severity, metricKey, operator, threshold, explanation, ...extra };
}

function compare(value, operator, threshold) {
  if (operator === "lt") return value < threshold;
  if (operator === "lte") return value <= threshold;
  if (operator === "gte") return value >= threshold;
  throw new TypeError(`Operador de alerta no soportado: ${operator}.`);
}

function domainState(count, issues, fragments) {
  if (count === 0) return "unavailable";
  return issues.some((issue) => fragments.some((fragment) => issue.code.includes(fragment))) ? "partial" : "available";
}

function reportOutliers(values, code, issues) {
  const count = suspectedOutlierCount(values);
  if (count > 0) addIssue(issues, code, count);
}

function suspectedOutlierCount(values) {
  if (values.length < 4) return 0;
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const mad = median(deviations);
  if (mad === 0) {
    const tolerance = Math.max(1, Math.abs(center) * 0.5);
    return values.filter((value) => Math.abs(value - center) > tolerance).length;
  }
  return values.filter((value) => (0.6745 * Math.abs(value - center)) / mad > 5).length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function addIssue(issues, code, amount = 1) {
  issues.set(code, (issues.get(code) ?? 0) + amount);
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalNonNegativeNumber(value) {
  return nonNegativeNumber(value);
}

function optionalFactNumber(value, issueCode, issues) {
  const normalized = optionalNonNegativeNumber(value);
  const supplied = value !== null
    && value !== undefined
    && (typeof value !== "string" || value.trim() !== "");
  if (supplied && normalized === null) {
    addIssue(issues, issueCode);
  }
  return normalized;
}

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function positiveReproductiveResult(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["positive", "positivo", "pregnant", "preñada", "prenada", "true", "1"].includes(normalized);
}

function reproductiveAnchorLabel(value) {
  if (value === "heat") return "un celo observado";
  if (value === "insemination") return "una inseminación";
  return "un servicio";
}

function inWindow(date, window) {
  return date >= window.start && date <= window.end;
}

function inComparison(date, window) {
  return date >= window.comparison.start && date <= window.comparison.end;
}

function byDateAndId(left, right) {
  return left.date.localeCompare(right.date)
    || String(left.sourceId ?? "").localeCompare(String(right.sourceId ?? ""))
    || stableRowKey(left).localeCompare(stableRowKey(right));
}

function stableRowKey(value) {
  return stableSerialize(value);
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value ?? "");
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return String(value);
}

function groupBy(values, key) {
  const result = new Map();
  for (const value of values) {
    const group = key(value);
    result.set(group, [...(result.get(group) ?? []), value]);
  }
  return result;
}

function mean(values) {
  return values.length > 0 ? sum(values) / values.length : null;
}

function sumOrNull(values) {
  return values.length > 0 ? sum(values) : null;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundNullable(value, precision) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function minimumDate(...values) {
  return values.sort()[0];
}

function monthEnd(monthStart) {
  const [year, month] = monthStart.split("-").map(Number);
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return addChileDays(next, -1);
}
