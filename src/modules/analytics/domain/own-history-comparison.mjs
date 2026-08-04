export const OWN_HISTORY_COMPARISON_VERSION = "fundosmart.analytics.own-history.v1";

/**
 * Periods needed before a historical band means anything. Two points are a line, not
 * a range: the band stays unavailable until there are at least this many prior
 * periods to describe.
 */
export const DEFAULT_MINIMUM_BAND_PERIODS = 3;

/** Relative change below which a metric is reported as flat rather than moved. */
export const DEFAULT_UNCHANGED_TOLERANCE_PCT = 1;

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * Compares a field against its own history.
 *
 * This is deliberately not benchmarking. Nothing leaves the tenant, so it needs no
 * consent, no cohort and no `k` threshold — the comparison a farm asks for first is
 * against itself, and that one is free of every gate that
 * [Fase 5](../../../../docs/roadmap/fase-5-benchmarking.md) has to carry.
 *
 * The default comparator is **year over year**. Comparing consecutive months in a
 * southern-hemisphere dairy compares autumn with winter, so a sequential fall would
 * read as mismanagement when it is the calendar. When the previous year's matching
 * period is absent the comparison falls back to the preceding period and says so
 * rather than passing the substitution off as equivalent.
 */
export function compareAgainstOwnHistory(snapshots, options = {}) {
  const series = normalizeSnapshots(snapshots);
  if (series.length === 0) {
    throw new RangeError("Se requiere al menos un período con métricas para comparar.");
  }

  const targetPeriod = options.targetPeriod
    ? requirePeriod(options.targetPeriod, "targetPeriod")
    : series.at(-1).period;
  const targetIndex = series.findIndex((entry) => entry.period === targetPeriod);
  if (targetIndex < 0) {
    throw new RangeError(`El período ${targetPeriod} no está en la serie recibida.`);
  }

  const minimumBandPeriods = positiveInteger(options.minimumBandPeriods, DEFAULT_MINIMUM_BAND_PERIODS);
  const unchangedTolerancePct = nonNegativeNumber(options.unchangedTolerancePct, DEFAULT_UNCHANGED_TOLERANCE_PCT);

  const target = series[targetIndex];
  const priorPeriods = series.slice(0, targetIndex);
  const yearAgoPeriod = shiftYear(targetPeriod, -1);
  const yearAgo = series.find((entry) => entry.period === yearAgoPeriod) ?? null;
  const previous = targetIndex > 0 ? series[targetIndex - 1] : null;

  const keys = [...new Set([
    ...target.metrics.keys(),
    ...(yearAgo ? yearAgo.metrics.keys() : []),
    ...(previous ? previous.metrics.keys() : []),
  ])].sort();

  const comparisons = keys.map((key) => buildComparison({
    key,
    target,
    yearAgo,
    yearAgoPeriod,
    previous,
    priorPeriods,
    minimumBandPeriods,
    unchangedTolerancePct,
  }));

  return {
    schemaVersion: OWN_HISTORY_COMPARISON_VERSION,
    targetPeriod,
    yearOverYearBasisPeriod: yearAgo ? yearAgoPeriod : null,
    periodOverPeriodBasisPeriod: previous?.period ?? null,
    periodsAvailable: series.map((entry) => entry.period),
    minimumBandPeriods,
    comparisons,
    summary: summarize(comparisons),
  };
}

function buildComparison({
  key,
  target,
  yearAgo,
  yearAgoPeriod,
  previous,
  priorPeriods,
  minimumBandPeriods,
  unchangedTolerancePct,
}) {
  const targetMetric = target.metrics.get(key) ?? null;

  // Naming the period that is missing is more useful than reporting nothing, so a
  // year-over-year comparison always answers — with the period it would have needed.
  // A period-over-period comparison has no candidate to name when the target is the
  // first period in the series, and returns null there.
  const yearOverYear = yearAgo
    ? buildDelta(targetMetric, yearAgo.metrics.get(key) ?? null, yearAgo.period, unchangedTolerancePct)
    : delta({ basisPeriod: yearAgoPeriod, status: "insufficient_data", statusReason: "basis_period_absent" });
  const periodOverPeriod = previous
    ? buildDelta(targetMetric, previous.metrics.get(key) ?? null, previous.period, unchangedTolerancePct)
    : null;

  // Year over year is the comparator that holds season constant; the sequential one
  // is a declared substitute, never a silent one.
  const usableYoY = yearOverYear?.status === "available";
  const usablePoP = periodOverPeriod?.status === "available";
  const primary = usableYoY ? "yearOverYear" : usablePoP ? "periodOverPeriod" : null;
  const primaryDelta = primary === "yearOverYear" ? yearOverYear : primary === "periodOverPeriod" ? periodOverPeriod : null;

  const notes = [];
  if (!usableYoY && usablePoP) {
    notes.push({
      code: "SEASONAL_COMPARISON",
      message: `No hay ${yearAgoPeriod} para comparar el mismo período del año anterior; se comparó con ${previous?.period}, que puede ser otra estación.`,
    });
  }

  const band = buildBand(key, priorPeriods, targetMetric, minimumBandPeriods);

  return {
    key,
    unit: targetMetric?.unit ?? null,
    target: targetMetric
      ? { period: target.period, value: targetMetric.value, status: targetMetric.status, statusReason: targetMetric.statusReason ?? null }
      : { period: target.period, value: null, status: "unavailable", statusReason: "metric_absent_in_period" },
    yearOverYear,
    periodOverPeriod,
    primary,
    band,
    verdict: primaryDelta
      ? primaryDelta.direction === "flat" ? "unchanged" : "changed"
      : "insufficient_data",
    reason: primaryDelta ? null : (yearOverYear?.statusReason ?? periodOverPeriod?.statusReason ?? "no_basis_period"),
    notes,
  };
}

function buildDelta(targetMetric, basisMetric, basisPeriod, unchangedTolerancePct) {
  if (!basisPeriod) return null;
  if (!targetMetric || !basisMetric) {
    return delta({ basisPeriod, status: "insufficient_data", statusReason: "metric_absent_in_one_period" });
  }
  // A metric the projection itself could not compute must never become a delta.
  if (targetMetric.status !== "available" || basisMetric.status !== "available") {
    return delta({
      basisPeriod,
      basisValue: basisMetric.value,
      status: "insufficient_data",
      statusReason: targetMetric.status !== "available"
        ? `target_${targetMetric.status}`
        : `basis_${basisMetric.status}`,
    });
  }
  if (!Number.isFinite(targetMetric.value) || !Number.isFinite(basisMetric.value)) {
    return delta({ basisPeriod, basisValue: basisMetric.value, status: "insufficient_data", statusReason: "non_numeric_value" });
  }

  const absolute = round(targetMetric.value - basisMetric.value, 6);
  const percent = basisMetric.value === 0 ? null : round((absolute / Math.abs(basisMetric.value)) * 100, 4);
  const flat = percent === null
    ? absolute === 0
    : Math.abs(percent) <= unchangedTolerancePct;

  return delta({
    basisPeriod,
    basisValue: basisMetric.value,
    status: "available",
    deltaAbsolute: absolute,
    deltaPct: percent,
    // Direction is stated as a fact. Whether up is good depends on the metric, and
    // that judgement already lives in the analytics thresholds.
    direction: flat ? "flat" : absolute > 0 ? "up" : "down",
  });
}

function delta(input) {
  return {
    basisPeriod: input.basisPeriod ?? null,
    basisValue: input.basisValue ?? null,
    deltaAbsolute: input.deltaAbsolute ?? null,
    deltaPct: input.deltaPct ?? null,
    direction: input.direction ?? null,
    status: input.status,
    statusReason: input.statusReason ?? null,
  };
}

/**
 * Describes the range the metric has occupied before this period, and where the
 * current value sits in it. This is what lets an alert fire on a field leaving its
 * own normal range instead of only on a fixed threshold.
 */
function buildBand(key, priorPeriods, targetMetric, minimumBandPeriods) {
  const points = priorPeriods
    .map((entry) => ({ period: entry.period, metric: entry.metrics.get(key) ?? null }))
    .filter((entry) => entry.metric?.status === "available" && Number.isFinite(entry.metric.value));

  if (points.length < minimumBandPeriods) {
    return {
      status: "insufficient_data",
      statusReason: "fewer_periods_than_minimum",
      periodsUsed: points.length,
      minimum: null,
      maximum: null,
      mean: null,
      position: null,
    };
  }

  const values = points.map((entry) => entry.metric.value);
  const minimum = round(Math.min(...values), 6);
  const maximum = round(Math.max(...values), 6);
  const usable = targetMetric?.status === "available" && Number.isFinite(targetMetric.value);

  return {
    status: "available",
    statusReason: null,
    periodsUsed: points.length,
    periods: points.map((entry) => entry.period),
    minimum,
    maximum,
    mean: round(values.reduce((total, value) => total + value, 0) / values.length, 6),
    position: !usable ? null : targetMetric.value > maximum ? "above" : targetMetric.value < minimum ? "below" : "inside",
  };
}

/**
 * Reduces the comparison to the signals worth putting on the daily agenda: a metric
 * that left the range it has occupied all along.
 */
export function selectOwnHistoryAgendaSignals(comparison) {
  const signals = [];
  for (const entry of comparison?.comparisons ?? []) {
    if (entry.band?.status !== "available" || !entry.band.position || entry.band.position === "inside") continue;
    signals.push({
      key: entry.key,
      period: entry.target.period,
      value: entry.target.value,
      unit: entry.unit,
      position: entry.band.position,
      band: { minimum: entry.band.minimum, maximum: entry.band.maximum, periodsUsed: entry.band.periodsUsed },
      // The reason states the band, not a verdict: the agenda explains why the item
      // appeared and links to the evidence.
      reason: entry.band.position === "above"
        ? `Está sobre su propio máximo histórico (${entry.band.maximum}) en ${entry.band.periodsUsed} períodos.`
        : `Está bajo su propio mínimo histórico (${entry.band.minimum}) en ${entry.band.periodsUsed} períodos.`,
    });
  }
  return signals.sort((left, right) => left.key.localeCompare(right.key));
}

function summarize(comparisons) {
  return {
    metricCount: comparisons.length,
    changed: comparisons.filter((entry) => entry.verdict === "changed").length,
    unchanged: comparisons.filter((entry) => entry.verdict === "unchanged").length,
    insufficientData: comparisons.filter((entry) => entry.verdict === "insufficient_data").length,
    yearOverYearCount: comparisons.filter((entry) => entry.primary === "yearOverYear").length,
    seasonalFallbackCount: comparisons.filter((entry) => entry.notes.some((note) => note.code === "SEASONAL_COMPARISON")).length,
    outsideBandCount: comparisons.filter((entry) => entry.band?.position === "above" || entry.band?.position === "below").length,
  };
}

function normalizeSnapshots(snapshots) {
  const byPeriod = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const period = requirePeriod(snapshot?.period, "period");
    if (byPeriod.has(period)) {
      throw new RangeError(`El período ${period} aparece más de una vez en la serie.`);
    }
    const metrics = new Map();
    for (const metric of snapshot?.metrics ?? []) {
      const key = String(metric?.key ?? "").trim();
      if (!key || metrics.has(key)) continue;
      metrics.set(key, metric);
    }
    byPeriod.set(period, { period, metrics });
  }
  return [...byPeriod.values()].sort((left, right) => left.period.localeCompare(right.period));
}

function requirePeriod(value, name) {
  const text = String(value ?? "").trim();
  const match = text.match(PERIOD_PATTERN);
  if (!match) throw new RangeError(`${name} debe tener el formato aaaa-mm.`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError(`${name} tiene un mes fuera de rango: ${text}.`);
  return text;
}

function shiftYear(period, years) {
  const [year, month] = period.split("-");
  return `${String(Number(year) + years).padStart(4, "0")}-${month}`;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new RangeError("El mínimo de períodos debe ser un entero positivo.");
  return value;
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError("La tolerancia debe ser un número no negativo.");
  return value;
}

function round(value, decimalPlaces) {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
