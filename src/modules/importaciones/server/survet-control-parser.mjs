import { parseXlsxWorksheetGrid, TabularParseError } from "./tabular-parser.mjs";

export const SURVET_MAX_ROWS = 200;

const SURVET_SHEET = "ORDEN DIIO";
const XLSX_SCAN_ROWS = 260;
const XLSX_SCAN_COLUMNS = 21;
const RCS_MULTIPLIER = 1000;
const MONTHS = new Map([
  ["ENE", 1],
  ["FEB", 2],
  ["MAR", 3],
  ["ABR", 4],
  ["MAY", 5],
  ["JUN", 6],
  ["JUL", 7],
  ["AGO", 8],
  ["SEP", 9],
  ["SEPT", 9],
  ["OCT", 10],
  ["NOV", 11],
  ["DIC", 12],
]);

export class SurvetControlParseError extends Error {
  constructor(message, code = "SURVET_CONTROL_INVALID") {
    super(message);
    this.name = "SurvetControlParseError";
    this.code = code;
  }
}

export async function parseSurvetControlWorkbook(input) {
  let worksheet;
  try {
    worksheet = await parseXlsxWorksheetGrid(input, {
      sheetName: SURVET_SHEET,
      maxRows: XLSX_SCAN_ROWS,
      maxColumns: XLSX_SCAN_COLUMNS,
    });
  } catch (cause) {
    if (cause instanceof TabularParseError) {
      throw new SurvetControlParseError(cause.message, cause.code);
    }
    throw cause;
  }
  if (worksheet.truncated) {
    throw new SurvetControlParseError(
      "La hoja ORDEN DIIO supera el límite seguro de lectura.",
      "SURVET_SHEET_ROW_LIMIT",
    );
  }

  const signature = normalizedText(cellAt(worksheet.rows, 1, 3));
  const title = normalizedText(cellAt(worksheet.rows, 5, 3));
  if (!signature.includes("DIAGNOSTICO VETERINARIO SURVET")
    || title !== "PLANILLA DE CONTROL LECHERO") {
    throw new SurvetControlParseError(
      "El libro no coincide con el perfil Survet Planilla de Control Lechero v1.",
      "SURVET_PROFILE_MISMATCH",
    );
  }

  const header = worksheet.rows.find((row) =>
    row.rowNumber <= 20
    && normalizedText(row.values[0]) === "N°"
    && normalizedText(row.values[2]).includes("VACA")
    && normalizedText(row.values[9]) === "TOTAL");
  if (!header) {
    throw new SurvetControlParseError(
      "No se encontró el encabezado esperado de ORDEN DIIO.",
      "SURVET_HEADER_MISSING",
    );
  }
  const secondaryHeader = worksheet.rows.find((row) => row.rowNumber === header.rowNumber + 1);
  const currentRcsPeriodLabel = shortText(secondaryHeader?.values[6]);
  const currentRcsMonth = MONTHS.get(normalizedText(currentRcsPeriodLabel));
  if (!currentRcsMonth) {
    throw new SurvetControlParseError(
      "No fue posible identificar el período RCS actual de la planilla.",
      "SURVET_RCS_PERIOD_INVALID",
    );
  }

  const generatedAtLocal = findWorkbookDate(
    worksheet.rows.filter((row) => row.rowNumber < header.rowNumber),
    worksheet.date1904,
  );
  if (!generatedAtLocal) {
    throw new SurvetControlParseError(
      "No fue posible leer la fecha actual declarada por la planilla Survet.",
      "SURVET_CONTROL_DATE_MISSING",
    );
  }
  const controlDate = generatedAtLocal.slice(0, 10);
  const controlPeriod = resolveControlPeriod(controlDate, currentRcsMonth);
  const identityRow = worksheet.rows.find((row) => row.rowNumber === header.rowNumber - 1);
  const producerName = labeledText(identityRow?.values, "NOMBRE");
  const farmName = labeledText(identityRow?.values, "PREDIO");

  const dataRows = worksheet.rows
    .filter((row) => row.rowNumber > header.rowNumber + 1)
    .filter((row) => positiveInteger(row.values[0]) !== null)
    .filter(hasAnimalRowContent);
  if (dataRows.length === 0) {
    throw new SurvetControlParseError(
      "La hoja ORDEN DIIO no contiene filas de animales.",
      "SURVET_ROWS_MISSING",
    );
  }
  if (dataRows.length > SURVET_MAX_ROWS) {
    throw new SurvetControlParseError(
      `El perfil Survet admite hasta ${SURVET_MAX_ROWS} filas por libro.`,
      "SURVET_ROW_LIMIT",
    );
  }

  const rows = dataRows.map((row) => parseAnimalRow(row, {
    controlDate,
    date1904: worksheet.date1904,
  }));
  markDuplicateIdentifiers(rows);

  return {
    document: {
      kind: "survet_milk_control",
      schemaVersion: "fundosmart.survet.milk-control.v1",
      worksheetName: worksheet.sheetName,
      producerName,
      farmName,
      generatedAtLocal,
      controlDate,
      controlPeriod,
      previousRcsPeriodLabel: shortText(secondaryHeader?.values[5]) || null,
      currentRcsPeriodLabel,
      sourceRowCount: rows.length,
      sourceMilkUnit: "kg",
      rcsReportedUnit: "thousand_cells_per_ml",
      rcsCanonicalUnit: "cells_per_ml",
      rcsMultiplier: RCS_MULTIPLIER,
      limitations: [
        "La fecha canónica corresponde a la fecha actual declarada por el libro; la planilla no entrega un día de muestreo separado.",
        "Survet informa producción en kg. La confirmación conserva esos valores y registra explícitamente su equivalencia operativa 1:1 en el modelo histórico.",
        "El perfil no genera diagnósticos, tratamientos ni eventos reproductivos.",
      ],
    },
    rows,
  };
}

function parseAnimalRow(row, { controlDate, date1904 }) {
  const rawRecord = {
    sourceRowNumber: row.rowNumber,
    sequenceNumber: sourceValue(row.values[0]),
    group: sourceValue(row.values[1]),
    animalIdentifier: sourceValue(row.values[2]),
    wandIdentifier: sourceValue(row.values[3]),
    previousMilkKg: sourceValue(row.values[4]),
    previousRcsReported: sourceValue(row.values[5]),
    currentRcsReported: sourceValue(row.values[6]),
    afternoonMilkKg: sourceValue(row.values[7]),
    morningMilkKg: sourceValue(row.values[8]),
    totalMilkKg: sourceValue(row.values[9]),
    observations: sourceValue(row.values[10]),
    calvingDate: sourceValue(row.values[11]),
    daysInMilk: sourceValue(row.values[12]),
    parity: sourceValue(row.values[13]),
    reproductiveStatus: sourceValue(row.values[14]),
    breedingDate: sourceValue(row.values[15]),
    gestationDays: sourceValue(row.values[16]),
    calfCount: sourceValue(row.values[17]),
    calfSex: sourceValue(row.values[18]),
    calfSire: sourceValue(row.values[19]),
    sourceCurrentDate: sourceValue(row.values[20]),
  };
  const issues = [];
  const externalAnimalId = identifierText(row.values[2]);
  if (!externalAnimalId) {
    issues.push(issue(
      "externalAnimalId",
      "SURVET_DIIO_REQUIRED",
      "error",
      `La fila ${row.rowNumber} no contiene un DIIO utilizable.`,
      row.values[2],
    ));
  }

  const morningMilkKg = nonNegativeNumber(row.values[8]);
  const afternoonMilkKg = nonNegativeNumber(row.values[7]);
  const totalMilkKg = positiveNumber(row.values[9]);
  validateOptionalNonNegative(issues, row.rowNumber, "morningMilkKg", "ordeña AM", row.values[8]);
  validateOptionalNonNegative(issues, row.rowNumber, "afternoonMilkKg", "ordeña PM", row.values[7]);
  if (totalMilkKg === null) {
    issues.push(issue(
      "totalMilkKg",
      "SURVET_TOTAL_MILK_INVALID",
      "error",
      `La fila ${row.rowNumber} necesita un total de leche positivo.`,
      row.values[9],
    ));
  } else if (morningMilkKg !== null && afternoonMilkKg !== null
    && Math.abs((morningMilkKg + afternoonMilkKg) - totalMilkKg) > 0.2) {
    issues.push(issue(
      "totalMilkKg",
      "SURVET_MILK_COMPONENT_MISMATCH",
      "warning",
      `La fila ${row.rowNumber} no cuadra entre AM + PM y el total; se conservará el total explícito.`,
      row.values[9],
    ));
  }

  const rcsReported = nonNegativeInteger(row.values[6]);
  let somaticCellCount = null;
  if (isPresent(row.values[6]) && rcsReported === null) {
    issues.push(issue(
      "somaticCellCount",
      "SURVET_RCS_INVALID",
      "error",
      `La fila ${row.rowNumber} contiene un RCS no válido.`,
      row.values[6],
    ));
  } else if (rcsReported === null || rcsReported === 0) {
    issues.push(issue(
      "somaticCellCount",
      "SURVET_RCS_MISSING",
      "warning",
      `La fila ${row.rowNumber} no informa un RCS actual positivo.`,
      row.values[6],
    ));
  } else {
    somaticCellCount = rcsReported * RCS_MULTIPLIER;
    if (!Number.isSafeInteger(somaticCellCount)) {
      issues.push(issue(
        "somaticCellCount",
        "SURVET_RCS_RANGE",
        "error",
        `La fila ${row.rowNumber} supera el rango seguro de RCS.`,
        row.values[6],
      ));
      somaticCellCount = null;
    }
  }

  const normalizedRecord = {
    sourceRowNumber: row.rowNumber,
    externalAnimalId,
    animalId: null,
    animalTag: null,
    matchedBy: [],
    controlDate,
    morningMilkKg,
    afternoonMilkKg,
    totalMilkKg,
    canonicalMorningLiters: morningMilkKg,
    canonicalAfternoonLiters: afternoonMilkKg,
    canonicalTotalLiters: totalMilkKg,
    productionSourceUnit: "kg",
    productionCanonicalUnit: "liter_equivalent",
    productionConversion: "source_value_preserved_1_to_1",
    somaticCellCountReported: rcsReported && rcsReported > 0 ? rcsReported : null,
    somaticCellCountReportedUnit: "thousand_cells_per_ml",
    somaticCellCount,
    notes: shortText(row.values[10]) || null,
    calvingDate: excelDate(row.values[11], date1904),
    daysInMilk: nonNegativeNumber(row.values[12]),
    parity: nonNegativeInteger(row.values[13]),
    reproductiveStatus: shortText(row.values[14]) || null,
    breedingDate: excelDate(row.values[15], date1904),
    gestationDays: nonNegativeNumber(row.values[16]),
  };
  return {
    recordNumber: row.rowNumber,
    rawRecord,
    normalizedRecord,
    status: rowStatus(issues, "pending"),
    issues,
  };
}

function markDuplicateIdentifiers(rows) {
  const byIdentifier = new Map();
  for (const row of rows) {
    const identifier = normalizedText(row.normalizedRecord?.externalAnimalId);
    if (!identifier) continue;
    byIdentifier.set(identifier, [...(byIdentifier.get(identifier) ?? []), row]);
  }
  for (const duplicates of byIdentifier.values()) {
    if (duplicates.length < 2) continue;
    for (const row of duplicates) {
      row.issues.push(issue(
        "externalAnimalId",
        "SURVET_DIIO_DUPLICATE",
        "error",
        `El DIIO de la fila ${row.recordNumber} aparece más de una vez en la hoja.`,
        row.normalizedRecord.externalAnimalId,
      ));
      row.status = "error";
    }
  }
}

function findWorkbookDate(rows, date1904) {
  for (const row of [...rows].sort((left, right) => right.rowNumber - left.rowNumber)) {
    for (let column = 16; column < Math.min(row.values.length, XLSX_SCAN_COLUMNS); column += 1) {
      const date = excelDateTime(row.values[column], date1904);
      if (date) return date;
    }
  }
  return null;
}

function resolveControlPeriod(controlDate, sourceMonth) {
  const generatedYear = Number(controlDate.slice(0, 4));
  const generatedMonth = Number(controlDate.slice(5, 7));
  const year = sourceMonth > generatedMonth ? generatedYear - 1 : generatedYear;
  return `${year}-${String(sourceMonth).padStart(2, "0")}`;
}

function labeledText(values, label) {
  for (const value of values ?? []) {
    const text = shortText(value);
    const match = new RegExp(`^${label}\\s*:\\s*(.+)$`, "i").exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function cellAt(rows, rowNumber, columnIndex) {
  return rows.find((row) => row.rowNumber === rowNumber)?.values[columnIndex];
}

function hasAnimalRowContent(row) {
  return isPresent(row.values[2])
    || positiveNumber(row.values[6]) !== null
    || positiveNumber(row.values[7]) !== null
    || positiveNumber(row.values[8]) !== null
    || positiveNumber(row.values[9]) !== null
    || Boolean(shortText(row.values[10]))
    || Boolean(shortText(row.values[14]));
}

function identifierText(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  }
  const text = shortText(value);
  if (!text || !/^[\p{L}\p{N}._\/-]+$/u.test(text)) return "";
  return text.normalize("NFKC").toLocaleUpperCase("es-CL");
}

function excelDate(value, date1904) {
  return excelDateTime(value, date1904)?.slice(0, 10) ?? null;
}

function excelDateTime(value, date1904) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value.trim())) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/Z$/, "");
  }
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial * 86_400_000));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/Z$/, "");
}

function validateOptionalNonNegative(issues, rowNumber, fieldName, label, value) {
  if (!isPresent(value) || nonNegativeNumber(value) !== null) return;
  issues.push(issue(
    fieldName,
    "SURVET_MILK_COMPONENT_INVALID",
    "error",
    `La fila ${rowNumber} contiene un valor no válido para ${label}.`,
    value,
  ));
}

function issue(fieldName, ruleCode, severity, message, sourceValue) {
  return {
    fieldName,
    ruleCode,
    severity,
    message,
    sourceValue: sourceValue ?? null,
  };
}

function rowStatus(issues, fallback) {
  if (issues.some((entry) => entry.severity === "error")) return "error";
  if (issues.some((entry) => entry.severity === "warning")) return "warning";
  return fallback;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  if (!isPresent(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = nonNegativeNumber(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function sourceValue(value) {
  return value === undefined || value === "" ? null : value;
}

function isPresent(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function shortText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizedText(value) {
  return shortText(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleUpperCase("es-CL");
}
