const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const SANTIAGO_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Normalizes a date to its civil calendar day in America/Santiago.
 *
 * Domain dates (`YYYY-MM-DD`) and ISO local date-times without an offset are
 * deliberately treated as Chilean wall-clock values. ISO instants carrying Z
 * or an explicit offset are converted to the day that instant had in Santiago.
 * This keeps rules independent from the host process timezone and DST length.
 */
export function chileDateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("La fecha no es válida.");
    return formatInstant(value);
  }

  const text = String(value ?? "").trim();
  const dateOnlyMatch = DATE_ONLY.exec(text);
  if (dateOnlyMatch) {
    assertCalendarDate(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]), Number(dateOnlyMatch[3]));
    return text;
  }

  const localMatch = LOCAL_DATE_TIME.exec(text);
  if (localMatch && !EXPLICIT_OFFSET.test(text)) {
    chileDateKey(localMatch[1]);
    return localMatch[1];
  }

  if (!EXPLICIT_OFFSET.test(text)) {
    throw new TypeError(`La fecha "${text}" debe usar YYYY-MM-DD o un ISO 8601 con zona explícita.`);
  }
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) throw new TypeError(`La fecha "${text}" no es válida.`);
  return formatInstant(instant);
}

/** Returns signed civil days from start to end, ignoring DST hour changes. */
export function chileDaysBetween(startValue, endValue) {
  return epochDay(chileDateKey(endValue)) - epochDay(chileDateKey(startValue));
}

/** Adds calendar days and returns a Chilean date key (YYYY-MM-DD). */
export function addChileDays(value, amount) {
  if (!Number.isInteger(amount)) throw new TypeError("La cantidad de días debe ser un entero.");
  const target = new Date((epochDay(chileDateKey(value)) + amount) * DAY_MS);
  return target.toISOString().slice(0, 10);
}

/** Compares two values by their Chilean civil day. */
export function compareChileDates(left, right) {
  return Math.sign(chileDaysBetween(right, left));
}

function formatInstant(value) {
  const parts = Object.fromEntries(
    SANTIAGO_DATE_FORMATTER.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function epochDay(dateKey) {
  const match = DATE_ONLY.exec(dateKey);
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

function assertCalendarDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new TypeError("La fecha no es válida.");
  }
}
