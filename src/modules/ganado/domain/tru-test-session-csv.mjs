export const MAX_TRU_TEST_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_TRU_TEST_CSV_ROWS = 2_000;

const DELIMITERS = [",", ";", "\t"];

const VISUAL_IDENTIFIER_HEADERS = new Set([
  "vid",
  "visualid",
  "visualtag",
  "visualnumber",
  "lid",
  "localid",
  "tag",
  "tagid",
  "animalid",
  "animalnumber",
  "animalno",
  "livestockid",
  "diio",
  "arete",
  "caravana",
  "rp",
  "numvaca",
  "nroanimal",
  "numeroanimal",
  "idvisual",
  "identificacionvisual",
]);

const ELECTRONIC_IDENTIFIER_HEADERS = new Set([
  "eid",
  "electronicid",
  "electronictag",
  "electronictagid",
  "rfid",
  "idelectronico",
  "identificacionelectronica",
]);

const WEIGHT_HEADERS = new Set([
  "weight",
  "weightkg",
  "liveweight",
  "liveweightkg",
  "livewt",
  "livewtkg",
  "wt",
  "wtkg",
  "peso",
  "pesokg",
  "pesovivo",
  "pesovivokg",
  "kg",
]);

const DATE_HEADERS = new Set([
  "date",
  "datetime",
  "sessiondate",
  "weighdate",
  "weighdatetime",
  "weighingdate",
  "recorddate",
  "recordedat",
  "fecha",
  "fechahora",
  "fechasesion",
  "fechadelasesion",
  "fechapesaje",
  "fechadepesaje",
  "fecharegistro",
  "fechaderegistro",
]);

export class TruTestCsvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TruTestCsvError";
    this.code = code;
  }
}

export function parseTruTestSessionCsv(input) {
  if (typeof input !== "string") {
    throw new TruTestCsvError("CSV_INVALID", "El archivo Tru-Test no contiene texto válido.");
  }
  const text = input.replace(/^\uFEFF/, "");
  if (!text.trim()) {
    throw new TruTestCsvError("CSV_EMPTY", "El archivo Tru-Test está vacío.");
  }
  if (new TextEncoder().encode(text).byteLength > MAX_TRU_TEST_CSV_BYTES) {
    throw new TruTestCsvError("CSV_TOO_LARGE", "El CSV Tru-Test supera el máximo de 2 MB.");
  }

  const analyses = [];
  let quotedFieldError = null;
  for (const delimiter of DELIMITERS) {
    try {
      analyses.push(analyzeDialect(text, delimiter));
    } catch (cause) {
      if (cause instanceof TruTestCsvError && cause.code === "CSV_UNTERMINATED_QUOTE") quotedFieldError = cause;
    }
  }
  const analysis = analyses
    .filter((candidate) => candidate.headerIndex >= 0)
    .sort((left, right) => right.score - left.score)[0];
  if (!analysis) {
    if (quotedFieldError) throw quotedFieldError;
    throw new TruTestCsvError(
      "CSV_HEADERS_MISSING",
      "No encontré las columnas VID/EID y Weight. Exporta una sesión desde Tru-Test Data Link incluyendo identificador y peso.",
    );
  }

  const sourceRows = analysis.rows
    .slice(analysis.headerIndex + 1)
    .filter((row) => row.some((cell) => cell.trim()));
  if (sourceRows.length > MAX_TRU_TEST_CSV_ROWS) {
    throw new TruTestCsvError(
      "CSV_TOO_MANY_ROWS",
      `El CSV contiene más de ${MAX_TRU_TEST_CSV_ROWS.toLocaleString("es-CL")} filas. Importa una sesión más pequeña.`,
    );
  }

  const issues = [];
  const rows = [];
  const dateColumn = analysis.columns.dateColumn;
  if (!dateColumn) {
    issues.push({
      code: "DATE_COLUMN_MISSING",
      level: "warning",
      rowNumber: null,
      message: "El archivo no incluye fecha; se conservará la fecha seleccionada en el formulario.",
    });
  }

  sourceRows.forEach((cells, index) => {
    const rowNumber = analysis.headerIndex + index + 2;
    const identifiers = analysis.columns.identifierColumns
      .map((column) => ({
        kind: column.kind,
        header: analysis.headers[column.index],
        value: (cells[column.index] ?? "").trim(),
      }))
      .filter((identifier) => identifier.value);
    if (identifiers.length === 0) {
      issues.push({
        code: "IDENTIFIER_MISSING",
        level: "error",
        rowNumber,
        message: "Falta VID, EID o DIIO.",
      });
      return;
    }

    const rawWeight = (cells[analysis.columns.weightColumn.index] ?? "").trim();
    const weightKg = parseWeightKg(rawWeight);
    if (weightKg === null) {
      issues.push({
        code: "WEIGHT_INVALID",
        level: "error",
        rowNumber,
        message: `El peso “${rawWeight || "vacío"}” no está entre 0 y 2.000 kg.`,
      });
      return;
    }

    let recordedAt = null;
    if (dateColumn) {
      const rawDate = (cells[dateColumn.index] ?? "").trim();
      if (rawDate) {
        const parsedDate = parseDate(rawDate);
        if (parsedDate) {
          recordedAt = parsedDate.value;
          if (parsedDate.ambiguous) {
            issues.push({
              code: "DATE_AMBIGUOUS",
              level: "warning",
              rowNumber,
              message: `La fecha “${rawDate}” se interpretó como día/mes/año; revísala antes de guardar.`,
            });
          }
        } else {
          issues.push({
            code: "DATE_INVALID",
            level: "warning",
            rowNumber,
            message: `No reconocí la fecha “${rawDate}”; se conservará la fecha seleccionada.`,
          });
        }
      }
    }

    rows.push({ rowNumber, identifiers, weightKg, recordedAt });
  });

  return {
    delimiter: analysis.delimiter,
    headerRowNumber: analysis.headerIndex + 1,
    dataRowCount: sourceRows.length,
    detectedColumns: {
      identifiers: analysis.columns.identifierColumns.map((column) => analysis.headers[column.index]),
      weight: analysis.headers[analysis.columns.weightColumn.index],
      date: dateColumn ? analysis.headers[dateColumn.index] : null,
    },
    dates: [...new Set(rows.map((row) => row.recordedAt).filter(Boolean))].sort(),
    rows,
    issues,
  };
}

export function reconcileTruTestRows(rows, animals) {
  const exactLookup = new Map();
  const numericLookup = new Map();
  for (const animal of animals) {
    const exact = normalizeIdentifier(animal.tag);
    if (!exact) continue;
    addLookup(exactLookup, exact, animal);
    if (/^\d+$/.test(exact)) addLookup(numericLookup, stripLeadingZeroes(exact), animal);
  }

  const issues = [];
  const candidates = [];
  for (const row of rows) {
    const matchedAnimals = new Map();
    for (const identifier of row.identifiers) {
      const exact = normalizeIdentifier(identifier.value);
      if (!exact) continue;
      const exactMatches = exactLookup.get(exact);
      const matches = exactMatches?.size
        ? exactMatches
        : /^\d+$/.test(exact)
          ? numericLookup.get(stripLeadingZeroes(exact))
          : null;
      for (const animal of matches ?? []) matchedAnimals.set(animal.id, animal);
    }

    if (matchedAnimals.size === 0) {
      issues.push({
        code: "ANIMAL_NOT_FOUND",
        level: "warning",
        rowNumber: row.rowNumber,
        message: `No encontré ${row.identifiers.map((item) => item.value).join(" / ")} entre los animales activos del lote.`,
      });
      continue;
    }
    if (matchedAnimals.size > 1) {
      issues.push({
        code: "ANIMAL_AMBIGUOUS",
        level: "error",
        rowNumber: row.rowNumber,
        message: `Los identificadores ${row.identifiers.map((item) => item.value).join(" / ")} coinciden con más de un animal.`,
      });
      continue;
    }
    candidates.push({ row, animal: [...matchedAnimals.values()][0] });
  }

  const byAnimal = new Map();
  for (const candidate of candidates) {
    const current = byAnimal.get(candidate.animal.id) ?? [];
    current.push(candidate);
    byAnimal.set(candidate.animal.id, current);
  }

  const matches = [];
  for (const group of byAnimal.values()) {
    const signatures = new Set(group.map(({ row }) => `${row.weightKg}|${row.recordedAt ?? ""}`));
    if (signatures.size > 1) {
      issues.push({
        code: "ANIMAL_WEIGHT_CONFLICT",
        level: "error",
        rowNumber: group[0].row.rowNumber,
        message: `El animal ${group[0].animal.tag} aparece con pesos o fechas diferentes; no se precargó.`,
      });
      continue;
    }
    if (group.length > 1) {
      issues.push({
        code: "DUPLICATE_ROW_IGNORED",
        level: "warning",
        rowNumber: group[0].row.rowNumber,
        message: `El animal ${group[0].animal.tag} aparece repetido con el mismo dato; se usará una sola fila.`,
      });
    }
    const selected = group[0];
    matches.push({
      animalId: selected.animal.id,
      animalTag: selected.animal.tag,
      rowNumber: selected.row.rowNumber,
      weightKg: selected.row.weightKg,
      recordedAt: selected.row.recordedAt,
    });
  }

  return {
    matches: matches.sort((left, right) => left.rowNumber - right.rowNumber),
    issues,
  };
}

function analyzeDialect(text, delimiter) {
  const rows = parseDelimitedRows(text, delimiter);
  let best = { headerIndex: -1, score: -1, columns: null, headers: [] };
  const candidateCount = Math.min(rows.length, 20);
  for (let index = 0; index < candidateCount; index += 1) {
    const headers = rows[index].map((header) => header.trim());
    const columns = detectColumns(headers);
    if (!columns.identifierColumns.length || !columns.weightColumn) continue;
    const score = 1_000
      + columns.identifierColumns.length * 20
      + (columns.dateColumn ? 10 : 0)
      - index;
    if (score > best.score) best = { headerIndex: index, score, columns, headers };
  }
  return { delimiter, rows, ...best };
}

function detectColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  const identifierColumns = [];
  for (const [kind, aliases] of [["VID", VISUAL_IDENTIFIER_HEADERS], ["EID", ELECTRONIC_IDENTIFIER_HEADERS]]) {
    normalized.forEach((header, index) => {
      if (aliases.has(header) && !identifierColumns.some((column) => column.index === index)) {
        identifierColumns.push({ index, kind });
      }
    });
  }
  const weightIndex = normalized.findIndex((header) => WEIGHT_HEADERS.has(header));
  const dateIndex = normalized.findIndex((header) => DATE_HEADERS.has(header));
  return {
    identifierColumns,
    weightColumn: weightIndex >= 0 ? { index: weightIndex } : null,
    dateColumn: dateIndex >= 0 ? { index: dateIndex } : null,
  };
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (character === "\"") {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === "\"" && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\r" || character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new TruTestCsvError("CSV_UNTERMINATED_QUOTE", "El CSV contiene una celda entre comillas sin cerrar.");
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function parseWeightKg(raw) {
  let normalized = raw
    .trim()
    .replace(/\s+/g, "")
    .replace(/(?:kilogramos?|kilograms?|kilos?|kgs?)$/i, "");
  if (!normalized) return null;

  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) normalized = normalized.replace(/\./g, "").replace(",", ".");
    else normalized = normalized.replace(/,/g, "");
  } else if (comma >= 0) {
    normalized = normalized.replace(",", ".");
  }

  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 && value <= 2_000 ? value : null;
}

function parseDate(raw) {
  const value = raw.trim();
  let match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), false);

  match = value.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), false);

  match = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\D|$)/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  if (first <= 12 && second > 12) return validDate(year, first, second, false);
  return validDate(year, second, first, first <= 12 && second <= 12 && first !== second);
}

function validDate(year, month, day, ambiguous) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return {
    value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    ambiguous,
  };
}

function normalizeHeader(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeIdentifier(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function stripLeadingZeroes(value) {
  return value.replace(/^0+(?=\d)/, "");
}

function addLookup(lookup, key, animal) {
  const values = lookup.get(key) ?? new Set();
  values.add(animal);
  lookup.set(key, values);
}
