export function normalizeTableText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-CL");
}

export function tableRowMatches({ rowText, query, rowFilter, selectedFilter }) {
  const normalizedQuery = normalizeTableText(query);
  const normalizedFilter = normalizeTableText(selectedFilter);
  const matchesQuery = normalizedQuery.length === 0 || normalizeTableText(rowText).includes(normalizedQuery);
  const matchesFilter = normalizedFilter.length === 0 || normalizeTableText(rowFilter) === normalizedFilter;
  return matchesQuery && matchesFilter;
}

const TABLE_TEXT_COLLATOR = new Intl.Collator("es-CL", {
  numeric: true,
  sensitivity: "base",
});

const MISSING_SORT_VALUES = new Set([
  "",
  "-",
  "—",
  "–",
  "n/a",
  "no aplica",
  "no disponible",
  "datos insuficientes",
]);

const SPANISH_MONTHS = new Map([
  ["ene", 1],
  ["enero", 1],
  ["feb", 2],
  ["febrero", 2],
  ["mar", 3],
  ["marzo", 3],
  ["abr", 4],
  ["abril", 4],
  ["may", 5],
  ["mayo", 5],
  ["jun", 6],
  ["junio", 6],
  ["jul", 7],
  ["julio", 7],
  ["ago", 8],
  ["agosto", 8],
  ["sep", 9],
  ["sept", 9],
  ["septiembre", 9],
  ["oct", 10],
  ["octubre", 10],
  ["nov", 11],
  ["noviembre", 11],
  ["dic", 12],
  ["diciembre", 12],
]);

const SPANISH_MONTH_PATTERN = [...SPANISH_MONTHS.keys()]
  .sort((left, right) => right.length - left.length)
  .join("|");

const DATE_HEADING_PATTERN = /^(?:fecha(?: de muestra| objetivo)?|periodo|diagnostico|secado|parto|pesaje|observacion|leche hasta|carne hasta)$/u;
const NUMBER_HEADING_PATTERN = /^(?:#|valor|numerador|denominador|muestra|produccion|neto|total|litros|grasa|proteina|rcs|ufc|\$\/l|\$ real\/l|a pago|aportes|participacion|resultado que le toca|animales|ultimo peso|gdv|precio compra|peso|oferta(?: utilizable)?|demanda(?: rebano)?|cobertura|superficie|kg ms\/ha|dias disponibles|crecimiento|costo(?: diario)?|manejos 30 d)$/u;

const DATE_ONLY_PATTERNS = [
  /^\d{4}-\d{2}(?:-\d{2})?$/u,
  /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u,
  new RegExp(`^\\d{1,2}\\s+(?:${SPANISH_MONTH_PATTERN})\\.?\\s+\\d{4}$`, "u"),
  new RegExp(`^(?:${SPANISH_MONTH_PATTERN})\\.?\\s+\\d{4}$`, "u"),
];

const NUMERIC_TOKEN_PATTERN = /[+-]?(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)/u;
const NUMERIC_TOKEN_GLOBAL_PATTERN = /[+-]?(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)/gu;
const NUMERIC_UNIT_PATTERN = /\b(?:clp|kg|g|mg|t|ha|l|ml|ufc|rcs|ms|dia|dias|animal|animales|vaca|vacas|registro|registros|ofrecido|ofrecidos|real|reales)\b/gu;

export function tableSortValueIsMissing(value) {
  const normalized = normalizeTableText(value);
  return MISSING_SORT_VALUES.has(normalized)
    || normalized.startsWith("sin ")
    || normalized.startsWith("no hay ");
}

function validUtcDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? timestamp
    : null;
}

export function parseTableDate(value) {
  if (tableSortValueIsMissing(value)) return null;
  const normalized = normalizeTableText(value);

  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/u);
  if (isoMatch) {
    return validUtcDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3] ?? 1));
  }

  const numericMatch = normalized.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/u);
  if (numericMatch) {
    const year = Number(numericMatch[3]);
    return validUtcDate(year < 100 ? 2000 + year : year, Number(numericMatch[2]), Number(numericMatch[1]));
  }

  const namedMatch = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+(${SPANISH_MONTH_PATTERN})\\.?\\s+(\\d{4})\\b`, "u"));
  if (namedMatch) {
    return validUtcDate(Number(namedMatch[3]), SPANISH_MONTHS.get(namedMatch[2]), Number(namedMatch[1]));
  }

  const monthMatch = normalized.match(new RegExp(`\\b(${SPANISH_MONTH_PATTERN})\\.?\\s+(\\d{4})\\b`, "u"));
  if (monthMatch) {
    return validUtcDate(Number(monthMatch[2]), SPANISH_MONTHS.get(monthMatch[1]), 1);
  }

  return null;
}

function normalizedNumberToken(token) {
  const negative = token.startsWith("-");
  const unsigned = token.replace(/^[+-]/u, "");
  let canonical;

  if (unsigned.includes(",")) {
    canonical = unsigned.replace(/\./gu, "").replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/u.test(unsigned)) {
    canonical = unsigned.replace(/\./gu, "");
  } else {
    canonical = unsigned;
  }

  const parsed = Number(canonical);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function parseTableNumber(value) {
  if (tableSortValueIsMissing(value)) return null;
  const normalized = normalizeTableText(value).replace(/[−]/gu, "-");
  const token = normalized.match(NUMERIC_TOKEN_PATTERN)?.[0];
  if (!token) return null;
  const parsed = normalizedNumberToken(token);
  if (parsed === null) return null;
  return /^\s*\(/u.test(normalized) ? -Math.abs(parsed) : parsed;
}

function isDateOnlyValue(value) {
  const normalized = normalizeTableText(value);
  return DATE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isPredominantlyNumericValue(value) {
  if (parseTableNumber(value) === null) return false;
  const remainder = normalizeTableText(value)
    .replace(NUMERIC_TOKEN_GLOBAL_PATTERN, " ")
    .replace(NUMERIC_UNIT_PATTERN, " ")
    .replace(/[$%‰°/·.,:+()−–—\s]/gu, "");
  return remainder.length === 0;
}

export function detectTableSortKind(heading, values) {
  const normalizedHeading = normalizeTableText(heading);
  const meaningfulValues = values.filter((value) => !tableSortValueIsMissing(value));
  if (meaningfulValues.length === 0) return "text";

  if (DATE_HEADING_PATTERN.test(normalizedHeading)
    && meaningfulValues.some((value) => parseTableDate(value) !== null)) {
    return "date";
  }

  if (NUMBER_HEADING_PATTERN.test(normalizedHeading)
    && meaningfulValues.some((value) => parseTableNumber(value) !== null)) {
    return "number";
  }

  const dateValues = meaningfulValues.filter(isDateOnlyValue).length;
  if (dateValues / meaningfulValues.length >= 0.6) return "date";

  const numericValues = meaningfulValues.filter(isPredominantlyNumericValue).length;
  if (numericValues / meaningfulValues.length >= 0.6) return "number";

  return "text";
}

export function compareTableSortValues(left, right, kind, direction = "ascending") {
  let leftValue = left;
  let rightValue = right;

  if (kind === "date") {
    leftValue = parseTableDate(left);
    rightValue = parseTableDate(right);
  } else if (kind === "number") {
    leftValue = parseTableNumber(left);
    rightValue = parseTableNumber(right);
  } else {
    leftValue = tableSortValueIsMissing(left) ? null : String(left ?? "");
    rightValue = tableSortValueIsMissing(right) ? null : String(right ?? "");
  }

  const leftMissing = leftValue === null;
  const rightMissing = rightValue === null;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }

  const comparison = kind === "text"
    ? TABLE_TEXT_COLLATOR.compare(leftValue, rightValue)
    : leftValue - rightValue;
  return direction === "descending" ? -comparison : comparison;
}
