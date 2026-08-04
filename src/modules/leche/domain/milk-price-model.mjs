import { classifyMilkLineItem, parseChileanNumber } from "./milk-settlement-analysis.mjs";

export const MILK_PRICE_MODEL_SCHEMA_VERSION = "fundosmart.milk.price-model.v1";

/** Two rates are the same when they differ by less than half a centavo per liter. */
const RATE_EPSILON_CLP = 0.005;

/** A quality sensitivity needs at least two distinct measurements to have a slope at all. */
const MIN_QUALITY_FIT_POINTS = 2;

/** Below this coefficient of determination a fitted slope is not trusted beyond "low". */
const QUALITY_FIT_R2_FLOOR = 0.98;

/**
 * Canonical payment concepts. Order matters: the first matching pattern wins, so
 * narrower concepts must precede broader ones ("gremial productores" before
 * "productor"). Descriptions are not stable across periods — the same concept
 * appears as "Pago base primera quincena" and as "Precio base primera quincena" —
 * so matching happens on a normalized, fortnight-stripped description.
 */
const CANONICAL_COMPONENTS = Object.freeze([
  Object.freeze({ key: "gremial", label: "Bono asociación gremial", pattern: /\bgremial\b|\basociacion\b/ }),
  Object.freeze({ key: "productor", label: "Bonificación productor", pattern: /\bproductor(?:es)?\b/ }),
  Object.freeze({ key: "proyeccion", label: "Bono proyección", pattern: /\bproyeccion\b/ }),
  Object.freeze({ key: "invierno", label: "Bono de invierno", pattern: /\binvierno\b/ }),
  Object.freeze({ key: "pago_diferido", label: "Bonificación pago diferido", pattern: /\bdiferido\b/ }),
  Object.freeze({ key: "especial", label: "Bonificación especial", pattern: /\bespecial\b/ }),
  Object.freeze({ key: "abonos_castigos", label: "Otros abonos y castigos", pattern: /\babonos?\b|\bcastigos?\b/ }),
  Object.freeze({ key: "base", label: "Precio base", pattern: /\bbase\b/ }),
  Object.freeze({ key: "grasa", label: "Grasa", pattern: /\bgrasa\b/, qualityMetric: "fatPct" }),
  Object.freeze({ key: "proteina", label: "Proteína", pattern: /\bproteina\b/, qualityMetric: "proteinPct" }),
  Object.freeze({ key: "solidos", label: "Suma de sólidos", pattern: /\bsolidos?\b/, qualityMetric: "totalSolidsPct" }),
  Object.freeze({
    key: "celulas_somaticas",
    label: "Células somáticas",
    pattern: /\bcelulas?\s+somaticas?\b|\brcs\b/,
    qualityMetric: "somaticCellCount",
  }),
  Object.freeze({ key: "ufc", label: "UFC", pattern: /\bufc\b|\bbacteri/, qualityMetric: "bacterialCountUfc" }),
  Object.freeze({ key: "sanitario_tbc_brucelosis", label: "Sanitario TBC y brucelosis", pattern: /\btbc\b|\bbrucelosis\b/ }),
  Object.freeze({ key: "sanitario_leucosis", label: "Sanitario leucosis", pattern: /\bleucosis\b/ }),
  Object.freeze({ key: "pabco", label: "PABCO", pattern: /\bpabco\b/ }),
  Object.freeze({ key: "estanque", label: "Bonificación por estanque", pattern: /\bestanque\b/ }),
  Object.freeze({ key: "fomento_desarrollo", label: "Fomento y desarrollo", pattern: /\bfomento\b/ }),
]);

const COMPONENTS_BY_KEY = new Map(CANONICAL_COMPONENTS.map((entry) => [entry.key, entry]));

/**
 * Resolves the canonical concept of a settlement line. Unknown descriptions keep
 * their normalized text behind an `otros:` prefix so an unrecognized concept stays
 * visible and is never merged into a known one.
 */
export function resolveMilkComponentKey(description) {
  const stripped = stripPeriodPart(normalizeText(description));
  if (!stripped) return { key: "otros:", label: "Sin descripción", qualityMetric: null, recognized: false };

  for (const entry of CANONICAL_COMPONENTS) {
    if (entry.pattern.test(stripped)) {
      return { key: entry.key, label: entry.label, qualityMetric: entry.qualityMetric ?? null, recognized: true };
    }
  }
  return { key: `otros:${stripped}`, label: String(description ?? "").trim(), qualityMetric: null, recognized: false };
}

/**
 * Reads one settlement into per-component rate observations.
 *
 * Every line in a validated settlement corpus satisfies
 * `amountClp = rate * litersOfScope`, where the scope is the fortnight named in the
 * description or the whole period when none is named. The rate is *contractual*
 * when the document carries `unitPriceClp` and *derived* when it has to be
 * recovered as `amountClp / liters`.
 */
export function extractMilkRateObservations(settlement) {
  const period = String(settlement?.period ?? "");
  const litersFirstHalf = finitePositive(settlement?.litersFirstHalf);
  const litersSecondHalf = finitePositive(settlement?.litersSecondHalf);
  const totalLiters = finitePositive(settlement?.totalLiters);

  const observations = [];
  const lineItems = Array.isArray(settlement?.lineItems) ? settlement.lineItems : [];

  for (const [lineItemIndex, lineItem] of lineItems.entries()) {
    const scope = periodPartFromDescription(normalizeText(lineItem?.description));
    const liters = scope === "firstHalf" ? litersFirstHalf : scope === "secondHalf" ? litersSecondHalf : totalLiters;
    const amountClp = finiteNumber(lineItem?.amountClp);
    const contractualRate = finiteNumber(lineItem?.unitPriceClp);
    const { key, label, qualityMetric, recognized } = resolveMilkComponentKey(lineItem?.description);

    if (amountClp === null || liters === null) {
      observations.push({
        componentKey: key,
        label,
        category: classifyMilkLineItem(lineItem),
        period,
        scope,
        lineItemIndex,
        liters,
        amountClp,
        contractualRateClpPerLiter: contractualRate,
        derivedRateClpPerLiter: null,
        rateClpPerLiter: contractualRate,
        provenance: contractualRate === null ? "unavailable" : "contractual",
        measurement: lineItem?.measurement ?? null,
        measurementValue: null,
        measurementIssue: "missingLiters",
        recognized,
        qualityMetric,
      });
      continue;
    }

    const derivedRate = amountClp / liters;
    const measurementValue = parseChileanNumber(lineItem?.measurement);
    // April 2026 records the solids *rate* in the measurement column instead of the
    // percentage. The tell is that the parsed measurement equals the derived rate,
    // which no genuine percentage in this corpus does. Such a point is reported and
    // excluded from the sensitivity fit rather than silently used as a percentage.
    const measurementIssue = lineItem?.measurement == null
      ? "absent"
      : measurementValue === null
        ? "notNumeric"
        : Math.abs(measurementValue - derivedRate) < RATE_EPSILON_CLP
          ? "looksLikeRate"
          : null;

    observations.push({
      componentKey: key,
      label,
      category: classifyMilkLineItem(lineItem),
      period,
      scope,
      lineItemIndex,
      liters,
      amountClp,
      contractualRateClpPerLiter: contractualRate,
      derivedRateClpPerLiter: round(derivedRate, 6),
      rateClpPerLiter: contractualRate ?? round(derivedRate, 6),
      provenance: contractualRate === null ? "derived" : "contractual",
      measurement: lineItem?.measurement ?? null,
      measurementValue,
      measurementIssue,
      recognized,
      qualityMetric,
    });
  }

  return observations;
}

/**
 * Fits a price model over a settlement history.
 *
 * The model has two layers with very different confidence, and they are kept
 * apart on purpose:
 *
 * 1. the per-liter rate of each component, which reproduces a settlement exactly;
 * 2. the sensitivity of a composition rate to its measured percentage, which is a
 *    least-squares fit and is only as good as the number of distinct measurements.
 *
 * Settlements from more than one buyer are rejected: a rate fitted on one buyer's
 * schedule says nothing about another's.
 */
export function fitMilkPriceModel(settlements, options = {}) {
  const list = Array.isArray(settlements) ? settlements.filter(Boolean) : [];
  if (list.length === 0) throw new RangeError("Se requiere al menos una liquidación para ajustar el modelo de precio.");

  const buyers = new Set(list.map((settlement) => String(settlement?.buyerName ?? "").trim()).filter(Boolean));
  if (buyers.size > 1) {
    throw new RangeError(
      `El modelo de precio se ajusta por comprador; se recibieron ${buyers.size}: ${[...buyers].join(", ")}.`,
    );
  }
  const plants = new Set(list.map((settlement) => String(settlement?.plant ?? "").trim()).filter(Boolean));

  const ordered = [...list].sort((left, right) => String(left.period).localeCompare(String(right.period)));
  const periods = ordered.map((settlement) => String(settlement.period));
  const excludeSuspectMeasurements = options.excludeSuspectMeasurements !== false;

  const grouped = new Map();
  for (const settlement of ordered) {
    for (const observation of extractMilkRateObservations(settlement)) {
      if (!grouped.has(observation.componentKey)) grouped.set(observation.componentKey, []);
      grouped.get(observation.componentKey).push(observation);
    }
  }

  const components = [...grouped.entries()].map(([componentKey, observations]) =>
    buildComponent(componentKey, observations, { periods, excludeSuspectMeasurements }),
  );
  components.sort((left, right) => left.componentKey.localeCompare(right.componentKey));

  return {
    schemaVersion: MILK_PRICE_MODEL_SCHEMA_VERSION,
    buyerName: [...buyers][0] ?? null,
    plants: [...plants],
    periods,
    periodCount: periods.length,
    components,
    coverage: {
      componentCount: components.length,
      contractual: components.filter((entry) => entry.provenance === "contractual").length,
      derived: components.filter((entry) => entry.provenance === "derived").length,
      unavailable: components.filter((entry) => entry.provenance === "unavailable").length,
      unstable: components.filter((entry) => !entry.rateStability.stable).length,
      withQualitySensitivity: components.filter((entry) => entry.qualitySensitivity !== null).length,
      unrecognized: components.filter((entry) => !entry.recognized).length,
    },
  };
}

function buildComponent(componentKey, observations, { periods, excludeSuspectMeasurements }) {
  const canonical = COMPONENTS_BY_KEY.get(componentKey) ?? null;
  const usable = observations.filter((entry) => entry.rateClpPerLiter !== null);
  const rates = usable.map((entry) => entry.rateClpPerLiter);
  const distinctRates = dedupeNumbers(rates);
  const observedPeriods = dedupeStrings(observations.map((entry) => entry.period));

  const anyContractual = usable.some((entry) => entry.provenance === "contractual");
  const provenance = usable.length === 0 ? "unavailable" : anyContractual ? "contractual" : "derived";

  // The latest period's rate is the projection default. A component whose rate moved
  // between periods — the winter bonus went from 46 to 50 CLP/L — must not be
  // projected as if it were fixed.
  const latestPeriod = observedPeriods[observedPeriods.length - 1] ?? null;
  const latestRates = usable.filter((entry) => entry.period === latestPeriod).map((entry) => entry.rateClpPerLiter);
  const latestRate = latestRates.length > 0 ? mean(latestRates) : null;

  const scopes = dedupeStrings(observations.map((entry) => entry.scope));
  const qualityMetric = canonical?.qualityMetric ?? null;
  const sensitivity = qualityMetric
    ? fitQualitySensitivity(usable, { excludeSuspectMeasurements })
    : null;

  return {
    componentKey,
    label: canonical?.label ?? observations[0]?.label ?? componentKey,
    category: observations[0]?.category ?? "otros",
    recognized: observations[0]?.recognized ?? false,
    qualityMetric,
    provenance,
    rateClpPerLiter: latestRate === null ? null : round(latestRate, 6),
    rateStability: {
      stable: distinctRates.length <= 1,
      distinctRateCount: distinctRates.length,
      spreadClpPerLiter: distinctRates.length === 0 ? null : round(Math.max(...rates) - Math.min(...rates), 6),
      ratesByPeriod: observedPeriods.map((period) => ({
        period,
        rateClpPerLiter: (() => {
          const forPeriod = usable.filter((entry) => entry.period === period).map((entry) => entry.rateClpPerLiter);
          return forPeriod.length === 0 ? null : round(mean(forPeriod), 6);
        })(),
      })),
    },
    scopes,
    periodsObserved: observedPeriods,
    periodsMissing: periods.filter((period) => !observedPeriods.includes(period)),
    qualitySensitivity: sensitivity,
    observations,
  };
}

/**
 * Least-squares fit of rate against measured percentage.
 *
 * Confidence is capped by the number of *distinct* measurements, never by the
 * number of observations: four readings of the same percentage still determine no
 * slope. A perfectly flat fit over a narrow range is reported as banded rather than
 * as "insensitive", because a payment scale with bands looks flat inside one band.
 */
function fitQualitySensitivity(observations, { excludeSuspectMeasurements }) {
  const excluded = [];
  const points = [];

  for (const entry of observations) {
    if (entry.measurementValue === null) {
      excluded.push({ period: entry.period, scope: entry.scope, reason: entry.measurementIssue ?? "notNumeric" });
      continue;
    }
    if (excludeSuspectMeasurements && entry.measurementIssue === "looksLikeRate") {
      excluded.push({ period: entry.period, scope: entry.scope, reason: "looksLikeRate" });
      continue;
    }
    points.push({
      measurement: entry.measurementValue,
      rateClpPerLiter: entry.rateClpPerLiter,
      period: entry.period,
      scope: entry.scope,
    });
  }

  const distinctMeasurements = dedupeNumbers(points.map((point) => point.measurement));
  if (distinctMeasurements.length < MIN_QUALITY_FIT_POINTS) {
    return {
      confidence: "insufficient",
      slopeClpPerLiterPerPoint: null,
      interceptClpPerLiter: null,
      rSquared: null,
      pointCount: points.length,
      distinctMeasurementCount: distinctMeasurements.length,
      measurementRange: rangeOf(points.map((point) => point.measurement)),
      banded: false,
      points,
      excluded,
    };
  }

  const xs = points.map((point) => point.measurement);
  const ys = points.map((point) => point.rateClpPerLiter);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < xs.length; index += 1) {
    covariance += (xs[index] - meanX) * (ys[index] - meanY);
    varianceX += (xs[index] - meanX) ** 2;
  }
  const slope = varianceX === 0 ? 0 : covariance / varianceX;
  const intercept = meanY - slope * meanX;

  let residualSum = 0;
  let totalSum = 0;
  for (let index = 0; index < xs.length; index += 1) {
    residualSum += (ys[index] - (slope * xs[index] + intercept)) ** 2;
    totalSum += (ys[index] - meanY) ** 2;
  }
  const rSquared = totalSum === 0 ? (residualSum === 0 ? 1 : 0) : round(1 - residualSum / totalSum, 6);
  const banded = Math.abs(slope) < RATE_EPSILON_CLP;

  let confidence = distinctMeasurements.length >= 5 ? "high" : distinctMeasurements.length >= 3 ? "moderate" : "low";
  if (rSquared !== null && rSquared < QUALITY_FIT_R2_FLOOR && confidence !== "low") confidence = "low";

  return {
    confidence,
    slopeClpPerLiterPerPoint: round(slope, 6),
    interceptClpPerLiter: round(intercept, 6),
    rSquared,
    pointCount: points.length,
    distinctMeasurementCount: distinctMeasurements.length,
    measurementRange: rangeOf(xs),
    banded,
    points,
    excluded,
  };
}

/**
 * Projects a settlement from hypothetical inputs.
 *
 * Halves are projected independently and summed, which is what makes a per-fortnight
 * quality difference visible. A component that cannot be resolved to a rate is not
 * dropped: it is returned with `projected: false` and a reason, and the result is
 * marked incomplete.
 */
export function projectMilkSettlement(model, input = {}) {
  assertModel(model);
  const halves = normalizeProjectionHalves(input);
  if (halves.length === 0) throw new RangeError("Se requieren litros para proyectar una liquidación.");

  const overrides = input.rateOverridesClpPerLiter ?? {};
  const allowUnstable = input.allowUnstableRates !== false;
  const allowQualityFit = input.allowQualityFit !== false;

  const componentResults = [];
  const warnings = [];
  let netAmountClp = 0;
  let projectedTotalLiters = 0;
  for (const half of halves) projectedTotalLiters += half.liters;

  for (const component of model.components) {
    const parts = [];
    let componentAmount = 0;
    let resolvable = true;
    let rateSource = null;
    let note = null;

    for (const half of halves) {
      const resolved = resolveRateForHalf(component, half, { overrides, allowUnstable, allowQualityFit });
      if (resolved.rateClpPerLiter === null) {
        resolvable = false;
        note = resolved.reason;
        break;
      }
      rateSource = resolved.source;
      if (resolved.note) note = resolved.note;
      const amount = resolved.rateClpPerLiter * half.liters;
      componentAmount += amount;
      parts.push({
        scope: half.key,
        liters: half.liters,
        rateClpPerLiter: round(resolved.rateClpPerLiter, 6),
        amountClp: round(amount, 2),
        rateSource: resolved.source,
      });
    }

    if (!resolvable) {
      componentResults.push({
        componentKey: component.componentKey,
        label: component.label,
        category: component.category,
        projected: false,
        rateSource: null,
        amountClp: null,
        amountPerLiterClp: null,
        parts: [],
        reason: note ?? "unavailable",
      });
      warnings.push({
        code: "COMPONENT_NOT_PROJECTABLE",
        componentKey: component.componentKey,
        message: `«${component.label}» no se puede proyectar: ${reasonMessage(note)}.`,
      });
      continue;
    }

    netAmountClp += componentAmount;
    componentResults.push({
      componentKey: component.componentKey,
      label: component.label,
      category: component.category,
      projected: true,
      rateSource,
      amountClp: round(componentAmount, 2),
      amountPerLiterClp: projectedTotalLiters > 0 ? round(componentAmount / projectedTotalLiters, 6) : null,
      parts,
      reason: null,
    });

    if (rateSource === "latestOfUnstable") {
      warnings.push({
        code: "UNSTABLE_RATE_USED",
        componentKey: component.componentKey,
        message:
          `«${component.label}» cambió de tasa entre períodos (${formatRates(component.rateStability.ratesByPeriod)}); ` +
          "se usó la del último período y la estimación puede no sostenerse.",
      });
    }
    if (rateSource === "qualityFit" && component.qualitySensitivity?.confidence === "low") {
      warnings.push({
        code: "LOW_CONFIDENCE_QUALITY_FIT",
        componentKey: component.componentKey,
        message:
          `La sensibilidad de «${component.label}» se ajustó con ` +
          `${component.qualitySensitivity.distinctMeasurementCount} mediciones distintas: es indicativa, no contractual.`,
      });
    }
  }

  const notProjected = componentResults.filter((entry) => !entry.projected);
  return {
    schemaVersion: MILK_PRICE_MODEL_SCHEMA_VERSION,
    buyerName: model.buyerName,
    basisPeriods: model.periods,
    halves: halves.map((half) => ({ scope: half.key, liters: half.liters, quality: half.quality })),
    totalLiters: projectedTotalLiters,
    components: componentResults,
    netAmountClp: round(netAmountClp, 2),
    netPricePerLiterClp: projectedTotalLiters > 0 ? round(netAmountClp / projectedTotalLiters, 4) : null,
    complete: notProjected.length === 0,
    notProjectedComponentKeys: notProjected.map((entry) => entry.componentKey),
    warnings,
  };
}

function resolveRateForHalf(component, half, { overrides, allowUnstable, allowQualityFit }) {
  const override = finiteNumber(overrides?.[component.componentKey]);
  if (override !== null) return { rateClpPerLiter: override, source: "override", reason: null, note: null };

  const sensitivity = component.qualitySensitivity;
  const measurement = component.qualityMetric ? finiteNumber(half.quality?.[component.qualityMetric]) : null;

  // When the requested measurement is one the documents already priced, use that
  // observed rate instead of the fitted line. A fit that reproduces its own points
  // to six decimals is still an approximation of a figure the buyer stated exactly.
  if (measurement !== null) {
    const candidates = component.observations.filter(
      (entry) =>
        entry.rateClpPerLiter !== null &&
        entry.measurementValue !== null &&
        entry.measurementIssue !== "looksLikeRate" &&
        Math.abs(entry.measurementValue - measurement) < RATE_EPSILON_CLP,
    );
    // The same percentage can appear in several periods, one stating the rate and
    // another only implying it. A stated rate is exact; a rate recovered by division
    // carries the buyer's per-line peso rounding, so contractual wins.
    const observed =
      candidates.find((entry) => entry.provenance === "contractual") ?? candidates[0] ?? null;
    if (observed) {
      return {
        rateClpPerLiter: observed.rateClpPerLiter,
        source: observed.provenance === "contractual" ? "contractualAtMeasurement" : "observedAtMeasurement",
        reason: null,
        note: null,
      };
    }
  }

  if (
    allowQualityFit &&
    measurement !== null &&
    sensitivity &&
    sensitivity.confidence !== "insufficient" &&
    !sensitivity.banded
  ) {
    const rate = sensitivity.slopeClpPerLiterPerPoint * measurement + sensitivity.interceptClpPerLiter;
    const outside =
      sensitivity.measurementRange &&
      (measurement < sensitivity.measurementRange.min || measurement > sensitivity.measurementRange.max);
    return {
      rateClpPerLiter: rate,
      source: "qualityFit",
      reason: null,
      note: outside ? "extrapolated" : null,
    };
  }

  if (component.rateStability.stable && component.rateClpPerLiter !== null) {
    return { rateClpPerLiter: component.rateClpPerLiter, source: "stable", reason: null, note: null };
  }
  if (component.rateClpPerLiter !== null) {
    if (!allowUnstable) return { rateClpPerLiter: null, source: null, reason: "unstableRate", note: null };
    return { rateClpPerLiter: component.rateClpPerLiter, source: "latestOfUnstable", reason: null, note: null };
  }
  return { rateClpPerLiter: null, source: null, reason: "noRate", note: null };
}

/**
 * Backtests the model against a settlement history.
 *
 * `mode: "holdout"` refits the model without the period under test, which is the
 * only honest way to test a fitted rate: a two-point line reproduces its own two
 * points perfectly and proves nothing. When a hold-out fit is impossible — a single
 * settlement, or a component seen in only one period — the result says so instead of
 * reporting a flattering in-sample number.
 */
export function backtestMilkPriceModel(settlements, options = {}) {
  const list = Array.isArray(settlements) ? settlements.filter(Boolean) : [];
  if (list.length === 0) throw new RangeError("Se requiere al menos una liquidación para hacer backtest.");
  const toleranceClp = finiteNonNegative(options.toleranceClp) ?? 1;
  const mode = options.mode === "inSample" ? "inSample" : "holdout";

  const results = list.map((settlement) => {
    const others = list.filter((candidate) => candidate !== settlement);
    const canHoldOut = mode === "holdout" && others.length > 0;
    if (mode === "holdout" && others.length === 0) {
      return {
        period: String(settlement.period),
        mode: "unavailable",
        reason: "singlePeriodHistory",
        actualNetClp: finiteNumber(settlement.netAmountClp),
        predictedNetClp: null,
        differenceClp: null,
        differencePct: null,
        withinTolerance: null,
        components: [],
      };
    }

    const model = fitMilkPriceModel(canHoldOut ? others : list, options.fitOptions ?? {});
    const projection = projectMilkSettlement(model, projectionInputFromSettlement(settlement));
    const actual = finiteNumber(settlement.netAmountClp);
    const observedByKey = new Map();
    for (const observation of extractMilkRateObservations(settlement)) {
      const current = observedByKey.get(observation.componentKey) ?? 0;
      observedByKey.set(observation.componentKey, current + (finiteNumber(observation.amountClp) ?? 0));
    }

    const components = [...observedByKey.entries()].map(([componentKey, actualAmountClp]) => {
      const projected = projection.components.find((entry) => entry.componentKey === componentKey) ?? null;
      const predicted = projected?.projected ? projected.amountClp : null;
      return {
        componentKey,
        label: projected?.label ?? componentKey,
        actualAmountClp: round(actualAmountClp, 2),
        predictedAmountClp: predicted,
        differenceClp: predicted === null ? null : round(predicted - actualAmountClp, 2),
        rateSource: projected?.rateSource ?? null,
        covered: predicted !== null,
        reason: projected?.projected ? null : (projected?.reason ?? "componentAbsentFromModel"),
      };
    });
    components.sort((left, right) => left.componentKey.localeCompare(right.componentKey));

    const missing = components.filter((entry) => !entry.covered);
    const predictedNetClp = projection.complete && missing.length === 0 ? projection.netAmountClp : null;
    const differenceClp = predictedNetClp === null || actual === null ? null : round(predictedNetClp - actual, 2);

    // A model fitted on several periods knows concepts a given period never paid —
    // April never had "Bonificación especial", June never had "Otros abonos y
    // castigos". Charging that to model error would be misleading, so the extra
    // concepts are named and a matched-component difference is reported alongside.
    const extra = projection.components.filter(
      (entry) => entry.projected && !observedByKey.has(entry.componentKey),
    );
    const extraAmountClp = extra.reduce((sum, entry) => sum + (entry.amountClp ?? 0), 0);
    const matchedDifferenceClp = components.every((entry) => entry.covered)
      ? round(
          components.reduce((sum, entry) => sum + (entry.differenceClp ?? 0), 0),
          2,
        )
      : null;

    return {
      period: String(settlement.period),
      mode: canHoldOut ? "holdout" : "inSample",
      reason: null,
      actualNetClp: actual,
      predictedNetClp,
      differenceClp,
      differencePct: differenceClp === null || !actual ? null : round((differenceClp / actual) * 100, 6),
      withinTolerance: differenceClp === null ? null : Math.abs(differenceClp) <= toleranceClp,
      matchedDifferenceClp,
      matchedWithinTolerance: matchedDifferenceClp === null ? null : Math.abs(matchedDifferenceClp) <= toleranceClp,
      uncoveredComponentKeys: missing.map((entry) => entry.componentKey),
      extraComponentKeys: extra.map((entry) => entry.componentKey),
      extraAmountClp: round(extraAmountClp, 2),
      components,
    };
  });

  const evaluated = results.filter((entry) => entry.differenceClp !== null);
  const matched = results.filter((entry) => entry.matchedDifferenceClp !== null && entry.matchedDifferenceClp !== undefined);
  return {
    schemaVersion: MILK_PRICE_MODEL_SCHEMA_VERSION,
    mode,
    toleranceClp,
    periodCount: list.length,
    evaluatedCount: evaluated.length,
    unevaluatedCount: results.length - evaluated.length,
    matchedEvaluatedCount: matched.length,
    allMatchedWithinTolerance: matched.length > 0 && matched.every((entry) => entry.matchedWithinTolerance),
    allWithinTolerance: evaluated.length > 0 && evaluated.every((entry) => entry.withinTolerance),
    worstDifferenceClp: evaluated.length === 0
      ? null
      : evaluated.reduce((worst, entry) => (Math.abs(entry.differenceClp) > Math.abs(worst) ? entry.differenceClp : worst), 0),
    results,
  };
}

/**
 * Per-component money value of one tenth of a quality point at a given volume.
 * Only components with a usable, non-banded sensitivity produce a figure.
 */
export function calculateQualitySensitivityTable(model, options = {}) {
  assertModel(model);
  const liters = finitePositive(options.totalLiters);
  const step = finitePositive(options.step) ?? 0.1;

  return model.components
    .filter((component) => component.qualityMetric !== null)
    .map((component) => {
      const sensitivity = component.qualitySensitivity;
      const usable = Boolean(sensitivity) && sensitivity.confidence !== "insufficient" && !sensitivity.banded;
      const perLiter = usable ? sensitivity.slopeClpPerLiterPerPoint * step : null;
      return {
        componentKey: component.componentKey,
        label: component.label,
        qualityMetric: component.qualityMetric,
        usable,
        step,
        confidence: sensitivity?.confidence ?? "insufficient",
        banded: sensitivity?.banded ?? false,
        distinctMeasurementCount: sensitivity?.distinctMeasurementCount ?? 0,
        slopeClpPerLiterPerPoint: usable ? round(sensitivity.slopeClpPerLiterPerPoint, 6) : null,
        clpPerLiterPerStep: perLiter === null ? null : round(perLiter, 6),
        clpPerPeriodPerStep: perLiter === null || liters === null ? null : Math.round(perLiter * liters),
        excludedPointCount: sensitivity?.excluded.length ?? 0,
      };
    })
    .sort((left, right) => left.componentKey.localeCompare(right.componentKey));
}

/** Builds the projection input that reproduces a real settlement. */
export function projectionInputFromSettlement(settlement) {
  const observations = extractMilkRateObservations(settlement);
  const qualityFor = (scope) => {
    const quality = {};
    for (const observation of observations) {
      if (!observation.qualityMetric || observation.scope !== scope) continue;
      if (observation.measurementValue === null || observation.measurementIssue === "looksLikeRate") continue;
      quality[observation.qualityMetric] = observation.measurementValue;
    }
    return quality;
  };

  const litersFirstHalf = finitePositive(settlement?.litersFirstHalf);
  const litersSecondHalf = finitePositive(settlement?.litersSecondHalf);
  if (litersFirstHalf !== null && litersSecondHalf !== null) {
    const totalQuality = qualityFor("total");
    return {
      litersFirstHalf,
      litersSecondHalf,
      qualityFirstHalf: { ...totalQuality, ...qualityFor("firstHalf") },
      qualitySecondHalf: { ...totalQuality, ...qualityFor("secondHalf") },
    };
  }
  return { totalLiters: finitePositive(settlement?.totalLiters), quality: qualityFor("total") };
}

function normalizeProjectionHalves(input) {
  const litersFirstHalf = finitePositive(input.litersFirstHalf);
  const litersSecondHalf = finitePositive(input.litersSecondHalf);
  if (litersFirstHalf !== null || litersSecondHalf !== null) {
    const halves = [];
    if (litersFirstHalf !== null) {
      halves.push({
        key: "firstHalf",
        liters: litersFirstHalf,
        quality: input.qualityFirstHalf ?? input.quality ?? {},
      });
    }
    if (litersSecondHalf !== null) {
      halves.push({
        key: "secondHalf",
        liters: litersSecondHalf,
        quality: input.qualitySecondHalf ?? input.quality ?? {},
      });
    }
    return halves;
  }
  const totalLiters = finitePositive(input.totalLiters);
  if (totalLiters === null) return [];
  return [{ key: "total", liters: totalLiters, quality: input.quality ?? {} }];
}

function assertModel(model) {
  if (!model || model.schemaVersion !== MILK_PRICE_MODEL_SCHEMA_VERSION || !Array.isArray(model.components)) {
    throw new TypeError("Se requiere un modelo de precio válido.");
  }
}

function reasonMessage(reason) {
  if (reason === "unstableRate") return "su tasa cambió entre períodos y no se autorizó usar la más reciente";
  if (reason === "noRate") return "no hay tasa contractual ni derivable";
  if (reason === "missingLiters") return "falta el volumen del período de origen";
  return "falta información";
}

function formatRates(ratesByPeriod) {
  return ratesByPeriod
    .filter((entry) => entry.rateClpPerLiter !== null)
    .map((entry) => `${entry.period}: ${entry.rateClpPerLiter}`)
    .join(" → ");
}

function stripPeriodPart(description) {
  return description
    .replace(/\b(?:primer(?:a)?|segund(?:a)?|1(?:era|ra)?|2(?:da)?)\s+quincena\b/g, " ")
    .replace(/\bpago\s+por\b|\bpago\s+de\b|\bbonificacion\s+por\b|\bbonificacion\s+de\b|\bbono\s+de\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function periodPartFromDescription(description) {
  if (/\bprimer(?:a)?\s+quincena\b|\b1(?:era|ra)?\s+quincena\b/.test(description)) return "firstHalf";
  if (/\bsegund(?:a)?\s+quincena\b|\b2(?:da)?\s+quincena\b/.test(description)) return "secondHalf";
  return "total";
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

function dedupeNumbers(values) {
  const unique = [];
  for (const value of values) {
    if (!unique.some((candidate) => Math.abs(candidate - value) < RATE_EPSILON_CLP)) unique.push(value);
  }
  return unique;
}

function dedupeStrings(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function rangeOf(values) {
  if (values.length === 0) return null;
  return { min: round(Math.min(...values), 6), max: round(Math.max(...values), 6) };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finitePositive(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function round(value, decimalPlaces) {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
