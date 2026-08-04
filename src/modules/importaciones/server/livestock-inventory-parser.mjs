import JSZip from "jszip";

import { parseXlsxWorksheetGrid } from "./tabular-parser.mjs";

export const LIVESTOCK_INVENTORY_PROFILE_KEY = "livestock.inventory.xlsx.v1";
export const LIVESTOCK_INVENTORY_MAX_ROWS = 800;

/** Rows searched for a header before the sheet is rejected. */
const HEADER_SEARCH_DEPTH = 8;
const MAX_COLUMNS = 30;

export class LivestockInventoryParseError extends Error {
  constructor(message, code = "LIVESTOCK_INVENTORY_INVALID") {
    super(message);
    this.name = "LivestockInventoryParseError";
    this.code = code;
  }
}

/**
 * Closed vocabulary of the single column that carries both lot membership and exit
 * state. Anything outside it is a conflict for a person to resolve, never a guess:
 * inventing a lot from unknown text would silently fabricate herd structure.
 */
const LOT_VOCABULARY = Object.freeze([
  Object.freeze({ match: /^lecheria$/, kind: "lot", lotName: "Lechería" }),
  Object.freeze({ match: /^lote\s*(\d+)$/, kind: "lot", lotName: (groups) => `Lote ${groups[1]}` }),
  Object.freeze({ match: /^toros?$/, kind: "lot", lotName: "Toros" }),
  Object.freeze({ match: /^feria(?:\s+(\d{4}))?$/, kind: "exit", exitKind: "sold_market" }),
  Object.freeze({ match: /^muerta?(?:\s+(\d{4}))?$/, kind: "exit", exitKind: "died" }),
  Object.freeze({ match: /^abigeato(?:\s+(\d{4}))?$/, kind: "exit", exitKind: "rustled" }),
]);

const PREGNANCY_VOCABULARY = Object.freeze([
  Object.freeze({ match: /^prena$/, status: "pregnant" }),
  Object.freeze({ match: /^vacia$/, status: "empty" }),
]);

const HEADER_ROLES = Object.freeze([
  Object.freeze({ role: "animalId", match: /^n\s*°?\s*vaca$/ }),
  Object.freeze({ role: "lot", match: /^lote$/ }),
  Object.freeze({ role: "calvingDates", match: /^fecha\s+paricion$/, repeatable: true }),
  Object.freeze({ role: "observations", match: /^observaciones$/ }),
  Object.freeze({ role: "offspring", match: /^cria$/ }),
  Object.freeze({ role: "dryOffDate", match: /^fecha\s+secado$/ }),
  Object.freeze({ role: "heatDate", match: /^celo$/ }),
  Object.freeze({ role: "winterHeatDate", match: /^celo\s+invierno$/ }),
  Object.freeze({ role: "palpation", match: /^palpacion\b/ }),
]);

/**
 * Reads the multi-sheet inventory workbook into staging rows.
 *
 * The workbook is evidence, not a canonical source: one column mixes lot membership
 * with three different exit reasons, dates arrive both as Excel serials and as
 * dd/mm/yyyy text, the calving header repeats once per birth, and the free-text
 * columns carry body condition, breed and stray identifiers all at once. Every one of
 * those is separated or flagged here, and none is resolved automatically.
 */
export async function parseLivestockInventoryWorkbook(input, options = {}) {
  const located = await locateInventorySheet(input, options.sheetName ?? null);
  const { grid, headerRowIndex, columnMap, sheetNames } = located;

  const birthDateColumn = resolveBirthDateColumn(grid.rows[headerRowIndex], columnMap);
  const body = grid.rows.slice(headerRowIndex + 1);
  const headerLabels = (grid.rows[headerRowIndex].values ?? []).map((value) => String(value ?? "").trim());

  const seenIds = new Map();
  const rows = [];
  let recordNumber = 0;

  for (const row of body) {
    const values = row.values ?? [];
    if (!values.some((value) => String(value ?? "").trim() !== "")) continue;
    recordNumber += 1;

    const issues = [];
    const rawRecord = {};
    for (const [index, label] of headerLabels.entries()) {
      if (!label) continue;
      const key = rawRecord[label] === undefined ? label : `${label} (${index})`;
      rawRecord[key] = values[index] ?? null;
    }

    const animalExternalId = normalizeIdentifier(values[columnMap.animalId]);
    if (!animalExternalId) {
      issues.push(issue("N° VACA", "ANIMAL_ID_MISSING", "error", "La fila no trae identificador de animal.", values[columnMap.animalId]));
    } else if (seenIds.has(animalExternalId)) {
      issues.push(issue(
        "N° VACA",
        "ANIMAL_ID_DUPLICATED",
        "error",
        `El identificador ${animalExternalId} ya apareció en la fila ${seenIds.get(animalExternalId)}.`,
        animalExternalId,
      ));
    } else {
      seenIds.set(animalExternalId, row.rowNumber);
    }

    const lot = classifyLotCell(values[columnMap.lot]);
    if (lot.conflict) {
      issues.push(issue(
        "LOTE",
        "LOT_TEXT_UNRECOGNIZED",
        "error",
        `«${lot.rawText}» no corresponde a un lote ni a una salida conocida; requiere decisión humana.`,
        lot.rawText,
      ));
    }

    const birthDate = birthDateColumn === null
      ? { value: null, issue: null }
      : readDateCell(values[birthDateColumn], grid.date1904, "fecha de nacimiento");
    if (birthDate.issue) {
      issues.push(issue("FECHA NACIMIENTO", "BIRTH_DATE_UNREADABLE", "warning", birthDate.issue, values[birthDateColumn]));
    }

    const calvingDates = [];
    let repeatedCalvingDates = 0;
    for (const index of columnMap.calvingDates) {
      const read = readDateCell(values[index], grid.date1904, "fecha de parición");
      if (read.value) {
        // The same date appears twice across the repeated calving columns in eight of
        // the observed rows. Emitting it twice would create two births on the same day
        // for one animal when the import is confirmed.
        if (calvingDates.includes(read.value)) repeatedCalvingDates += 1;
        else calvingDates.push(read.value);
      } else if (read.issue) {
        issues.push(issue(
          "FECHA PARICION",
          read.shapeMismatch ? "DATE_COLUMN_HOLDS_OTHER_DATA" : "CALVING_DATE_UNREADABLE",
          "warning",
          read.issue,
          values[index],
        ));
      }
    }
    if (repeatedCalvingDates > 0) {
      issues.push(issue(
        "FECHA PARICION",
        "CALVING_DATE_REPEATED",
        "warning",
        `${repeatedCalvingDates} fecha(s) de parición estaban repetidas en la fila y se conservó una sola.`,
        null,
      ));
    }

    const dryOffDate = readOptionalDate(values, columnMap.dryOffDate, grid.date1904, "fecha de secado", issues, "FECHA SECADO", "DRY_OFF_DATE_UNREADABLE");
    const heatDate = readOptionalDate(values, columnMap.heatDate, grid.date1904, "fecha de celo", issues, "CELO", "HEAT_DATE_UNREADABLE");
    const winterHeatDate = readOptionalDate(values, columnMap.winterHeatDate, grid.date1904, "fecha de celo de invierno", issues, "CELO INVIERNO", "HEAT_DATE_UNREADABLE");

    const pregnancy = classifyPregnancyCell(values[columnMap.palpation]);
    if (pregnancy.conflict) {
      issues.push(issue(
        "PALPACION",
        "PREGNANCY_STATUS_UNRECOGNIZED",
        "warning",
        `«${pregnancy.rawText}» no es un resultado de palpación reconocido.`,
        pregnancy.rawText,
      ));
    }

    const offspring = classifyOffspringCell(values[columnMap.offspring]);
    if (offspring.conflict) {
      issues.push(issue(
        "CRIA",
        "OFFSPRING_AMBIGUOUS",
        "warning",
        `«${offspring.rawText}» no permite deducir sexo e identificador de la cría sin confirmación.`,
        offspring.rawText,
      ));
    }

    const observations = columnMap.observations === null
      ? ""
      : String(values[columnMap.observations] ?? "").trim();

    const normalizedRecord = {
      animalExternalId,
      birthDate: birthDate.value,
      lotName: lot.lotName,
      exit: lot.exit,
      calvingDates,
      dryOffDate,
      heatDate,
      winterHeatDate,
      pregnancyStatus: pregnancy.status,
      offspring: offspring.offspring,
      // Free text stays verbatim. It carries body condition, breed, udder notes and
      // stray identifiers in the same cell; interpreting it here would invent data.
      observations,
    };

    rows.push({
      recordNumber,
      rowNumber: row.rowNumber,
      rawRecord,
      normalizedRecord,
      status: issues.some((entry) => entry.severity === "error") ? "error" : issues.length > 0 ? "warning" : "valid",
      issues,
    });
  }

  return {
    document: {
      profileKey: LIVESTOCK_INVENTORY_PROFILE_KEY,
      sheetName: grid.sheetName,
      sheetNames,
      headerRowNumber: grid.rows[headerRowIndex].rowNumber,
      columnMap: { ...columnMap, birthDate: birthDateColumn },
      date1904: grid.date1904,
      truncated: grid.truncated,
    },
    rows,
    summary: summarize(rows),
  };
}

/**
 * Picks the inventory sheet by header signature.
 *
 * The same workbook also holds pharmacological and medicine-control templates whose
 * headers are split across three rows. Selecting "the first sheet" would parse one of
 * those as a herd, so a sheet without both an animal identifier and the lot column is
 * rejected outright.
 */
async function locateInventorySheet(input, requestedSheetName) {
  const sheetNames = await listSheetNames(input);
  if (sheetNames.length === 0) {
    throw new LivestockInventoryParseError("El libro no contiene hojas visibles.", "LIVESTOCK_INVENTORY_NO_SHEETS");
  }

  const candidates = requestedSheetName ? [requestedSheetName] : sheetNames;
  const rejected = [];

  for (const sheetName of candidates) {
    let grid;
    try {
      grid = await parseXlsxWorksheetGrid(input, {
        sheetName,
        maxRows: LIVESTOCK_INVENTORY_MAX_ROWS,
        maxColumns: MAX_COLUMNS,
      });
    } catch (cause) {
      rejected.push(`${sheetName}: ${cause.message}`);
      continue;
    }

    for (const [headerRowIndex, row] of grid.rows.slice(0, HEADER_SEARCH_DEPTH).entries()) {
      const columnMap = mapHeaderRow(row.values ?? []);
      if (columnMap.animalId === null || columnMap.lot === null) continue;
      return { grid, headerRowIndex, columnMap, sheetNames };
    }
    rejected.push(`${sheetName}: sin cabecera de inventario`);
  }

  throw new LivestockInventoryParseError(
    `Ninguna hoja tiene la cabecera de inventario (se requieren «N° VACA» y «LOTE»). Revisadas: ${rejected.join("; ")}.`,
    "LIVESTOCK_INVENTORY_HEADER_NOT_FOUND",
  );
}

async function listSheetNames(input) {
  // parseXlsxWorksheetGrid resolves one sheet at a time, so the roster comes from a
  // probe of the default sheet plus the names the workbook advertises.
  const probe = await parseXlsxWorksheetGrid(input, { maxRows: 1, maxColumns: 1 }).catch(() => null);
  const names = [];
  if (probe?.sheetName) names.push(probe.sheetName);
  for (const name of await workbookSheetNames(input)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

async function workbookSheetNames(input) {
  try {
    const zip = await JSZip.loadAsync(input);
    const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
    if (!workbookXml) return [];
    return [...workbookXml.matchAll(/<sheet\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => !/state="hidden"/.test(tag))
      .map((tag) => tag.match(/name="([^"]*)"/)?.[1] ?? null)
      .filter((name) => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}

function mapHeaderRow(values) {
  const map = {
    animalId: null,
    lot: null,
    calvingDates: [],
    observations: null,
    offspring: null,
    dryOffDate: null,
    heatDate: null,
    winterHeatDate: null,
    palpation: null,
  };

  for (const [index, value] of values.entries()) {
    const label = normalizeText(value);
    if (!label) continue;
    for (const role of HEADER_ROLES) {
      if (!role.match.test(label)) continue;
      if (role.repeatable) {
        map[role.role].push(index);
      } else if (map[role.role] === null) {
        map[role.role] = index;
      }
      break;
    }
  }
  return map;
}

/**
 * The birth-date column is unlabelled in the observed workbook: it sits immediately
 * after the identifier with an empty header. It is only adopted when that neighbour
 * is genuinely unlabelled, so a future file that labels it is not misread.
 */
function resolveBirthDateColumn(headerRow, columnMap) {
  const values = headerRow.values ?? [];
  const candidate = columnMap.animalId + 1;
  if (candidate >= MAX_COLUMNS) return null;
  if (candidate === columnMap.lot) return null;
  return normalizeText(values[candidate]) === "" ? candidate : null;
}

function classifyLotCell(value) {
  const rawText = String(value ?? "").trim();
  const normalized = normalizeText(value);
  if (!normalized) return { lotName: null, exit: null, conflict: false, rawText };

  for (const entry of LOT_VOCABULARY) {
    const groups = normalized.match(entry.match);
    if (!groups) continue;
    if (entry.kind === "lot") {
      const lotName = typeof entry.lotName === "function" ? entry.lotName(groups) : entry.lotName;
      return { lotName, exit: null, conflict: false, rawText };
    }
    // A year is not a date. "FERIA 2025" says the animal left during 2025 and nothing
    // more, so the exact date stays unknown rather than being invented as 1 January.
    const year = groups[1] ? Number(groups[1]) : null;
    return {
      lotName: null,
      exit: { kind: entry.exitKind, year: Number.isInteger(year) ? year : null, rawText },
      conflict: false,
      rawText,
    };
  }
  return { lotName: null, exit: null, conflict: true, rawText };
}

function classifyPregnancyCell(value) {
  const rawText = String(value ?? "").trim();
  const normalized = normalizeText(value);
  if (!normalized) return { status: null, conflict: false, rawText };
  for (const entry of PREGNANCY_VOCABULARY) {
    if (entry.match.test(normalized)) return { status: entry.status, conflict: false, rawText };
  }
  return { status: null, conflict: true, rawText };
}

/**
 * Offspring is recorded as a sex prefix, sometimes with an identifier, sometimes with
 * a name or an abortion note in the same cell. Only the unambiguous shapes are
 * normalized; everything else is preserved and flagged.
 */
function classifyOffspringCell(value) {
  const rawText = String(value ?? "").trim();
  if (!rawText) return { offspring: null, conflict: false, rawText };

  const sexOnly = rawText.match(/^([HM])$/i);
  if (sexOnly) return { offspring: { sex: sexFrom(sexOnly[1]), externalId: null }, conflict: false, rawText };

  const sexThenId = rawText.match(/^([HM])\s*-\s*(\d{5,10})$/i);
  if (sexThenId) {
    return { offspring: { sex: sexFrom(sexThenId[1]), externalId: sexThenId[2] }, conflict: false, rawText };
  }

  const idThenSex = rawText.match(/^(\d{5,10})\s*\/\s*([HM])$/i);
  if (idThenSex) {
    return { offspring: { sex: sexFrom(idThenSex[2]), externalId: idThenSex[1] }, conflict: false, rawText };
  }

  // "H-" with no identifier, "M-MUERTO", "M-MARIA", "ABORTO 21/2": a person decides.
  const danglingSex = rawText.match(/^([HM])\s*-\s*$/i);
  if (danglingSex) {
    return { offspring: { sex: sexFrom(danglingSex[1]), externalId: null }, conflict: true, rawText };
  }
  return { offspring: null, conflict: true, rawText };
}

function sexFrom(letter) {
  return letter.toUpperCase() === "H" ? "female" : "male";
}

function readOptionalDate(values, columnIndex, date1904, label, issues, fieldName, ruleCode) {
  if (columnIndex === null) return null;
  const read = readDateCell(values[columnIndex], date1904, label);
  if (read.issue) {
    issues.push(issue(
      fieldName,
      read.shapeMismatch ? "DATE_COLUMN_HOLDS_OTHER_DATA" : ruleCode,
      "warning",
      read.issue,
      values[columnIndex],
    ));
  }
  return read.value;
}

/**
 * Accepts the two formats the workbook actually mixes — Excel day serials and
 * dd/mm/yyyy text — and reports anything else instead of coercing it.
 */
function readDateCell(value, date1904, label) {
  if (value === null || value === undefined) return { value: null, issue: null };
  const text = String(value).trim();
  if (!text) return { value: null, issue: null };

  const slashed = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashed) {
    const day = Number(slashed[1]);
    const month = Number(slashed[2]);
    const rawYear = Number(slashed[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const iso = composeIsoDate(year, month, day);
    return iso
      ? { value: iso, issue: null }
      : { value: null, issue: `«${text}» no es una ${label} válida.` };
  }

  if (/^\d{1,6}(?:[.,]\d+)?$/.test(text)) {
    const serial = Number(text.replace(",", "."));
    const iso = isoFromExcelSerial(serial, date1904);
    return iso
      ? { value: iso, issue: null }
      : { value: null, issue: `El serial ${text} está fuera del rango de fechas admitido para la ${label}.` };
  }

  // A date column that holds offspring codes is not a malformed date: it means the
  // sheet's columns drift from what the header promises, and a person has to see that
  // rather than read "unreadable date" 37 times.
  if (OFFSPRING_SHAPED.test(text)) {
    return {
      value: null,
      shapeMismatch: true,
      issue: `La columna de ${label} contiene «${text}», que tiene forma de dato de cría: la hoja no respeta su propia cabecera en esta fila.`,
    };
  }
  return { value: null, issue: `«${text}» no se pudo leer como ${label}.` };
}

/** "M", "H", "H/", "H/99000021", "H/ 99000049" — synthetic examples of the offspring-column shape. */
const OFFSPRING_SHAPED = /^[HM]\s*(?:[/-]\s*\d{0,10})?$/i;

function isoFromExcelSerial(serial, date1904) {
  if (!Number.isFinite(serial)) return null;
  const days = Math.trunc(serial);
  // Serials below 1000 are almost always a stray number rather than a 1902 date.
  if (days < 1_000 || days > 80_000) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const stamp = epoch + days * 86_400_000;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function composeIsoDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeIdentifier(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const digits = text.replace(/\s+/g, "");
  return /^\d{4,12}$/.test(digits) ? digits : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9°]+/g, " ")
    .trim();
}

function issue(fieldName, ruleCode, severity, message, sourceValue) {
  return { fieldName, ruleCode, severity, message, sourceValue: sourceValue ?? null };
}

function summarize(rows) {
  return {
    rowCount: rows.length,
    validRowCount: rows.filter((row) => row.status === "valid").length,
    warningRowCount: rows.filter((row) => row.status === "warning").length,
    errorRowCount: rows.filter((row) => row.status === "error").length,
    skippedRowCount: 0,
  };
}
