const CATEGORY_DEFINITIONS = Object.freeze([
  Object.freeze({ category: "base", label: "Precio base" }),
  Object.freeze({ category: "composicion", label: "Composición" }),
  Object.freeze({ category: "calidad", label: "Calidad" }),
  Object.freeze({ category: "sanitario", label: "Sanitario" }),
  Object.freeze({ category: "bonos", label: "Bonos" }),
  Object.freeze({ category: "otros", label: "Otros" }),
]);

export const DEFAULT_MILK_QUALITY_THRESHOLDS = Object.freeze({
  rcs: 700_000,
  ufc: 1_000_000,
});

/**
 * Parses common Chilean numeric notation while also accepting ordinary decimal
 * notation. Returns null when the input does not contain a finite number.
 */
export function parseChileanNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  const source = String(value).trim();
  if (!source) return null;
  const match = source
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ")
    .match(/(?<![\p{L}\d])[+-]?\s*\d[\d.,'\s]*/u);
  if (!match) return null;

  const parenthesized = /^\s*\(/.test(source) && /\)\s*(?:\D*)$/.test(source);
  let numeric = match[0].replace(/[\s']/g, "");
  const sign = numeric.startsWith("-") || parenthesized ? -1 : 1;
  numeric = numeric.replace(/^[+-]/, "");

  const commaCount = countCharacter(numeric, ",");
  const dotCount = countCharacter(numeric, ".");
  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = numeric.lastIndexOf(",") > numeric.lastIndexOf(".") ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    numeric = numeric.replaceAll(groupingSeparator, "");
    numeric = replaceLast(numeric, decimalSeparator, ".").replaceAll(decimalSeparator, "");
  } else if (commaCount > 0) {
    numeric = normalizeSingleSeparator(numeric, ",", commaCount);
  } else if (dotCount > 0) {
    numeric = normalizeSingleSeparator(numeric, ".", dotCount);
  }

  const parsed = Number(numeric) * sign;
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyMilkLineItem(lineItemOrDescription) {
  const description = normalizeText(
    typeof lineItemOrDescription === "string"
      ? lineItemOrDescription
      : lineItemOrDescription?.description,
  );

  if (/\b(?:precio|pago)\s+base\b|\bbase\s+(?:primera|segunda|por|de)\b/.test(description)) {
    return "base";
  }
  if (/\bgrasa\b|\bproteina\b|\bsolidos?\b/.test(description)) return "composicion";
  if (/\bsanitari[oa]\b|\btbc\b|\bbrucelosis\b|\bleucosis\b|\bpabco\b/.test(description)) {
    return "sanitario";
  }
  if (/\brcs\b|\bufc\b|\bcelulas?\s+somaticas?\b|\bbacteri/.test(description)) {
    return "calidad";
  }
  if (/\bbono\b|\bbonificacion\b|\bfomento\b|\bestanque\b/.test(description)) return "bonos";
  return "otros";
}

export function parseMilkQualityLineItem(lineItem, lineItemIndex = null) {
  const description = normalizeText(lineItem?.description);
  const metric = qualityMetricFromDescription(description);
  if (!metric) return null;

  const rawValue = parseChileanNumber(lineItem?.measurement);
  if (rawValue === null) return null;

  const countMetric = metric === "somaticCellCount" || metric === "bacterialCountUfc";
  const value = countMetric
    ? normalizeCountPerMl(rawValue, lineItem?.measurement)
    : round(rawValue, 4);

  return {
    metric,
    value,
    rawValue,
    unit: countMetric ? "perMl" : "percent",
    periodPart: periodPartFromDescription(description),
    lineItemIndex,
    description: String(lineItem?.description ?? ""),
    measurement: lineItem?.measurement ?? null,
  };
}

export function extractMilkSettlementQuality(settlement) {
  const observations = (settlement?.lineItems ?? [])
    .map((lineItem, index) => parseMilkQualityLineItem(lineItem, index))
    .filter(Boolean);

  return {
    fatPct: aggregateMetric(observations, "fatPct", settlement, false),
    proteinPct: aggregateMetric(observations, "proteinPct", settlement, false),
    totalSolidsPct: aggregateMetric(observations, "totalSolidsPct", settlement, false),
    somaticCellCount: aggregateMetric(observations, "somaticCellCount", settlement, true),
    bacterialCountUfc: aggregateMetric(observations, "bacterialCountUfc", settlement, true),
    observations,
  };
}

export function calculateMilkPaymentComposition(lineItemsOrSettlement, totalLiters, netAmountClp) {
  const isSettlement = !Array.isArray(lineItemsOrSettlement);
  const lineItems = isSettlement ? (lineItemsOrSettlement?.lineItems ?? []) : (lineItemsOrSettlement ?? []);
  const liters = finiteNumber(isSettlement ? lineItemsOrSettlement?.totalLiters : totalLiters);
  const declaredNet = finiteNumber(isSettlement ? lineItemsOrSettlement?.netAmountClp : netAmountClp);

  const analyzedLineItems = lineItems.map((lineItem, index) => {
    const amountClp = finiteNumber(lineItem?.amountClp) ?? 0;
    return {
      ...lineItem,
      lineItemIndex: index,
      category: classifyMilkLineItem(lineItem),
      amountClp,
      amountPerLiterClp: perLiter(amountClp, liters),
    };
  });
  const totalAmountClp = analyzedLineItems.reduce((sum, lineItem) => sum + lineItem.amountClp, 0);
  const shareBase = declaredNet ?? totalAmountClp;
  const categories = CATEGORY_DEFINITIONS.map(({ category, label }) => {
    const entries = analyzedLineItems.filter((lineItem) => lineItem.category === category);
    const amountClp = entries.reduce((sum, lineItem) => sum + lineItem.amountClp, 0);
    return {
      category,
      label,
      amountClp,
      amountPerLiterClp: perLiter(amountClp, liters),
      sharePct: shareBase === 0 ? null : round((amountClp / shareBase) * 100, 4),
      lineItemCount: entries.length,
    };
  });

  return {
    lineItems: analyzedLineItems,
    categories,
    totalAmountClp,
    totalAmountPerLiterClp: perLiter(totalAmountClp, liters),
    reconciliationDifferenceClp: declaredNet === null ? null : totalAmountClp - declaredNet,
  };
}

export function evaluateMilkQualityAlerts(quality, thresholds = {}) {
  const normalizedThresholds = {
    rcs: qualityThreshold(thresholds.rcs, DEFAULT_MILK_QUALITY_THRESHOLDS.rcs, "rcs"),
    ufc: qualityThreshold(thresholds.ufc, DEFAULT_MILK_QUALITY_THRESHOLDS.ufc, "ufc"),
  };
  const observations = Array.isArray(quality?.observations) ? quality.observations : [];
  const rules = [
    {
      metric: "somaticCellCount",
      shortMetric: "rcs",
      code: "RCS_THRESHOLD_EXCEEDED",
      label: "RCS",
      threshold: normalizedThresholds.rcs,
      unitLabel: "células/ml",
    },
    {
      metric: "bacterialCountUfc",
      shortMetric: "ufc",
      code: "UFC_THRESHOLD_EXCEEDED",
      label: "UFC",
      threshold: normalizedThresholds.ufc,
      unitLabel: "UFC/ml",
    },
  ];

  const alerts = [];
  for (const rule of rules) {
    const candidates = observations.filter((entry) => entry.metric === rule.metric);
    const fallbackValue = finiteNumber(quality?.[rule.metric]);
    if (candidates.length === 0 && fallbackValue !== null) {
      candidates.push({ metric: rule.metric, value: fallbackValue, periodPart: null, lineItemIndex: null });
    }
    const exceeded = candidates
      .filter((entry) => entry.value > rule.threshold)
      .sort((left, right) => right.value - left.value)[0];
    if (!exceeded) continue;

    alerts.push({
      code: rule.code,
      metric: rule.shortMetric,
      severity: "warning",
      value: exceeded.value,
      threshold: rule.threshold,
      unit: "perMl",
      periodPart: exceeded.periodPart ?? null,
      lineItemIndex: exceeded.lineItemIndex ?? null,
      message: `${rule.label} ${formatInteger(exceeded.value)} ${rule.unitLabel} supera el umbral de ${formatInteger(rule.threshold)} ${rule.unitLabel}.`,
    });
  }
  return alerts;
}

export function analyzeMilkSettlement(settlement, options = {}) {
  const quality = extractMilkSettlementQuality(settlement);
  const payment = calculateMilkPaymentComposition(settlement);
  return {
    quality,
    payment,
    alerts: evaluateMilkQualityAlerts(quality, options.thresholds),
  };
}

function qualityMetricFromDescription(description) {
  if (/\brcs\b|\bcelulas?\s+somaticas?\b/.test(description)) return "somaticCellCount";
  if (/\bufc\b|\bbacteri|\bunidades?\s+formadoras?\s+de\s+colonias?\b/.test(description)) {
    return "bacterialCountUfc";
  }
  if (/\bproteina\b/.test(description)) return "proteinPct";
  if (/\bgrasa\b/.test(description)) return "fatPct";
  if (/\bsolidos?\b/.test(description)) return "totalSolidsPct";
  return null;
}

function normalizeCountPerMl(value, measurement) {
  const normalizedMeasurement = normalizeText(measurement);
  const explicitlyMillions = /\bmillon(?:es)?\b|\b10\s*\^?\s*6\b/.test(normalizedMeasurement);
  const explicitlyThousands = /\bmil\b|\b10\s*\^?\s*3\b/.test(normalizedMeasurement);
  const explicitlyPerMl = /\bml\b/.test(normalizedMeasurement);
  const multiplier = explicitlyMillions
    ? 1_000_000
    : explicitlyThousands
      ? 1_000
      : !explicitlyPerMl && Math.abs(value) < 10_000
        ? 1_000
        : 1;
  return Math.round(value * multiplier);
}

function aggregateMetric(observations, metric, settlement, integerResult) {
  const entries = observations.filter((entry) => entry.metric === metric);
  if (entries.length === 0) return null;
  let totalWeight = 0;
  let weightedValue = 0;
  for (const entry of entries) {
    const weight = entry.periodPart === "firstHalf"
      ? finitePositiveNumber(settlement?.litersFirstHalf) ?? 1
      : entry.periodPart === "secondHalf"
        ? finitePositiveNumber(settlement?.litersSecondHalf) ?? 1
        : 1;
    weightedValue += entry.value * weight;
    totalWeight += weight;
  }
  const average = weightedValue / totalWeight;
  return integerResult ? Math.round(average) : round(average, 4);
}

function periodPartFromDescription(description) {
  if (/\bprimer(?:a)?\s+quincena\b|\b1(?:era|ra)?\s+quincena\b/.test(description)) return "firstHalf";
  if (/\bsegund(?:a)?\s+quincena\b|\b2(?:da)?\s+quincena\b/.test(description)) return "secondHalf";
  return null;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

function normalizeSingleSeparator(value, separator, count) {
  const groups = value.split(separator);
  const looksGrouped = groups.length > 1 && groups.slice(1).every((group) => group.length === 3);
  if (count > 1) return looksGrouped ? groups.join("") : replaceLast(value, separator, ".").replaceAll(separator, "");
  if (separator === "." && groups[1]?.length === 3) return groups.join("");
  return value.replace(separator, ".");
}

function replaceLast(value, search, replacement) {
  const index = value.lastIndexOf(search);
  return index < 0 ? value : `${value.slice(0, index)}${replacement}${value.slice(index + search.length)}`;
}

function countCharacter(value, character) {
  return value.split(character).length - 1;
}

function qualityThreshold(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const parsed = parseChileanNumber(value);
  if (parsed === null || parsed < 0) throw new RangeError(`El umbral ${name} debe ser un número no negativo.`);
  return parsed;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finitePositiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function perLiter(amountClp, liters) {
  return liters !== null && liters > 0 ? round(amountClp / liters, 4) : null;
}

function round(value, decimalPlaces) {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatInteger(value) {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(value);
}
