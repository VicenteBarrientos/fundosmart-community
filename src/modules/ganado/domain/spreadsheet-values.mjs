/**
 * Cómo se lee y se escribe un valor dentro de una celda, en formato chileno.
 *
 * Vive aparte de cada planilla porque el separador decimal, el orden de las fechas y la
 * comparación de texto sin acentos son las mismas decisiones para un animal, un pesaje o
 * un egreso. Cuando cada planilla las resuelve por su cuenta, la más nueva termina
 * interpretando "1.234" distinto que la anterior, y nadie se entera hasta que un peso o
 * un monto quedan mal guardados.
 */

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/;

/** Texto comparable: sin acentos, sin mayúsculas, sin espacios de más. */
export function normalizeLookupText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Interpreta un número escrito a la chilena, tolerando lo que llega pegado desde Excel.
 *
 * La regla del punto: con coma presente el punto es separador de miles ("1.234,5"). Solo,
 * seguido de exactamente tres dígitos, también es de miles ("1.234" son mil doscientos
 * treinta y cuatro, que es lo que muestra la app). En cualquier otro caso el punto es
 * decimal, para que "312.5" pegado desde un Excel en inglés no se vuelva 3125.
 *
 * Es una regla ambigua por naturaleza, y por eso la pantalla de revisión muestra el
 * número ya interpretado antes de confirmar.
 */
export function parseSpreadsheetNumber(text) {
  const raw = String(text ?? "").replace(/\s/g, "").replace(/^\$/, "");
  if (raw === "") return { value: null, error: null };
  if (!/^-?[\d.,]+$/.test(raw)) return { value: null, error: "No es un número." };

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;

  if (hasComma && hasDot) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (hasComma) normalized = raw.replace(",", ".");
  else if (hasDot) {
    const groups = raw.split(".");
    const thousands = groups.length > 2 || (groups.length === 2 && groups[1].length === 3);
    normalized = thousands ? groups.join("") : raw;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return { value: null, error: "No es un número." };
  return { value, error: null };
}

/**
 * Interpreta una fecha en formato ISO o chileno (día primero) y la devuelve como ISO.
 *
 * Valida contra el calendario: 31/02 no es una fecha, aunque tenga la forma de una.
 */
export function parseSpreadsheetDate(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return { value: null, error: null };

  let year;
  let month;
  let day;
  const iso = ISO_DATE_PATTERN.exec(raw);
  if (iso) {
    [, year, month, day] = iso;
  } else {
    const local = LOCAL_DATE_PATTERN.exec(raw);
    if (!local) return { value: null, error: "No es una fecha. Usa 17/07/2026 o 2026-07-17." };
    [, day, month, year] = local;
    if (year.length === 2) year = `20${year}`;
  }

  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const candidate = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (
    candidate.getUTCFullYear() !== yearNumber
    || candidate.getUTCMonth() !== monthNumber - 1
    || candidate.getUTCDate() !== dayNumber
  ) {
    return { value: null, error: "Esa fecha no existe en el calendario." };
  }

  const padded = `${String(yearNumber).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
  return { value: padded, error: null };
}

/** "2026-07-17" → "17/07/2026", que es como se lee una planilla acá. */
export function formatSpreadsheetDate(value) {
  const match = ISO_DATE_PATTERN.exec(String(value ?? ""));
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** Miles con punto y decimales con coma, sin símbolo de moneda para no ensuciar la celda. */
export function formatSpreadsheetNumber(value, maximumFractionDigits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value.toLocaleString("es-CL", { maximumFractionDigits, useGrouping: true });
}

/** Elige la opción cuyo texto coincide, comparando sin acentos ni mayúsculas. */
export function matchSpreadsheetOption(options, text) {
  const normalized = normalizeLookupText(text);
  return options.find((option) => normalizeLookupText(option.label) === normalized)
    ?? options.find((option) => normalizeLookupText(option.value) === normalized)
    ?? null;
}

/** Un monto en pesos: entero, no negativo, escrito como sea que Excel lo haya dejado. */
export function parseSpreadsheetClp(text) {
  const parsed = parseSpreadsheetNumber(text);
  if (parsed.error) return parsed;
  if (parsed.value === null) return { value: null, error: null };
  if (parsed.value < 0) return { value: null, error: "El monto no puede ser negativo." };
  if (!Number.isInteger(parsed.value)) return { value: null, error: "El dinero se registra en pesos enteros." };
  return { value: parsed.value, error: null };
}
