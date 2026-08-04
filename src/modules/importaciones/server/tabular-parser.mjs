import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

const MAX_COLUMNS = 50;
const MAX_ROWS = 100;
const MAX_XML_BYTES = 8 * 1024 * 1024;

export class TabularParseError extends Error {
  constructor(message, code = "TABULAR_FILE_INVALID") {
    super(message);
    this.name = "TabularParseError";
    this.code = code;
  }
}

export async function parseTabularFile(input, { filename = "", maxRows = MAX_ROWS } = {}) {
  const extension = String(filename ?? "").toLowerCase().split(".").pop();
  if (extension === "csv") return parseCsv(input, maxRows);
  if (extension === "xlsx") return parseXlsx(input, maxRows);
  if (extension === "xls") {
    throw new TabularParseError(
      "El formato .xls antiguo no se procesa de forma segura. Guárdalo como .xlsx o .csv y vuelve a cargarlo.",
      "XLS_LEGACY_UNSUPPORTED",
    );
  }
  throw new TabularParseError("Este perfil admite archivos .csv y .xlsx.", "TABULAR_EXTENSION_UNSUPPORTED");
}

export function parseDelimited(text, delimiter) {
  return parseDelimitedBounded(text, delimiter, {
    maxColumns: Number.POSITIVE_INFINITY,
    maxRows: Number.POSITIVE_INFINITY,
  }).rows;
}

function parseDelimitedBounded(text, delimiter, { maxColumns, maxRows }) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  const pushCell = () => {
    if (row.length >= maxColumns) {
      throw new TabularParseError(`La planilla no puede superar ${MAX_COLUMNS} columnas.`, "TABULAR_COLUMN_LIMIT");
    }
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (pushRow()) {
        truncated = index < text.length - 1;
        break;
      }
    } else {
      cell += char;
    }
  }
  if (truncated) return { rows, truncated };
  if (quoted) throw new TabularParseError("El CSV contiene una celda entre comillas sin cierre.", "CSV_QUOTE_UNCLOSED");
  pushRow();
  return { rows, truncated: false };
}

function parseCsv(input, maxRows) {
  const bytes = toBytes(input);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  text = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const parsed = parseDelimitedBounded(text, delimiter, {
    maxColumns: MAX_COLUMNS,
    maxRows: maxRows + 2,
  });
  return tabularResult(parsed.rows, {
    maxRows,
    sheetName: null,
    sourceHasMoreRows: parsed.truncated,
  });
}

async function parseXlsx(input, maxRows) {
  const parsed = await readXlsxSheet(input, {
    maxRows: maxRows + 2,
    maxColumns: MAX_COLUMNS,
  });
  const matrix = parsed.rows.map((row) => row.values);
  return tabularResult(matrix, {
    maxRows,
    sheetName: parsed.sheetName,
    sourceHasMoreRows: parsed.truncated || matrix.length > maxRows + 1,
  });
}

export async function parseXlsxWorksheetGrid(
  input,
  { sheetName, maxRows = 250, maxColumns = MAX_COLUMNS } = {},
) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1_000) {
    throw new TabularParseError("El límite de filas XLSX no es válido.", "XLSX_ROW_LIMIT_INVALID");
  }
  if (!Number.isInteger(maxColumns) || maxColumns < 1 || maxColumns > MAX_COLUMNS) {
    throw new TabularParseError(
      `La lectura XLSX admite entre 1 y ${MAX_COLUMNS} columnas.`,
      "XLSX_COLUMN_LIMIT_INVALID",
    );
  }
  return readXlsxSheet(input, { sheetName, maxRows, maxColumns });
}

async function readXlsxSheet(input, { sheetName, maxRows, maxColumns }) {
  let zip;
  try {
    zip = await JSZip.loadAsync(toBytes(input));
  } catch {
    throw new TabularParseError("El archivo .xlsx está dañado o no es un libro válido.", "XLSX_ZIP_INVALID");
  }

  const xmlBudget = { remaining: MAX_XML_BYTES };
  const workbookXml = await requiredXml(zip, "xl/workbook.xml", xmlBudget);
  const relsXml = await requiredXml(zip, "xl/_rels/workbook.xml.rels", xmlBudget);
  const workbook = parseXml(workbookXml, "libro");
  const relationships = parseXml(relsXml, "relaciones");
  const sheets = [...workbook.getElementsByTagName("sheet")];
  const selectedSheet = sheetName
    ? sheets.find((sheet) =>
      sheet.getAttribute("state") !== "hidden"
      && sheet.getAttribute("name") === sheetName)
    : sheets.find((sheet) => sheet.getAttribute("state") !== "hidden");
  if (!selectedSheet) {
    throw new TabularParseError(
      sheetName
        ? `El libro no contiene la hoja visible "${sheetName}".`
        : "El libro no contiene una hoja visible.",
      "XLSX_SHEET_MISSING",
    );
  }
  const relationshipId = selectedSheet.getAttribute("r:id");
  const relationship = [...relationships.getElementsByTagName("Relationship")]
    .find((entry) => entry.getAttribute("Id") === relationshipId);
  if (!relationship) throw new TabularParseError("No fue posible ubicar la hoja del libro.", "XLSX_RELATIONSHIP_MISSING");

  const sheetPath = normalizeZipPath("xl", relationship.getAttribute("Target"));
  const sheetXml = await requiredXml(zip, sheetPath, xmlBudget);
  const sharedStringsFile = zip.file("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsFile
    ? sharedStringValues(parseXml(await limitedText(sharedStringsFile, xmlBudget), "textos compartidos"))
    : [];
  const sheet = parseXml(sheetXml, "hoja");
  const rows = [];
  let truncated = false;
  let fallbackRowNumber = 0;

  for (const rowNode of [...sheet.getElementsByTagName("row")]) {
    fallbackRowNumber += 1;
    const row = [];
    for (const cellNode of [...rowNode.getElementsByTagName("c")]) {
      const address = cellNode.getAttribute("r");
      const columnIndex = columnFromAddress(address);
      if (columnIndex < 0 || columnIndex >= maxColumns) continue;
      row[columnIndex] = cellValue(cellNode, sharedStrings);
    }
    while (row.length > 0 && (row.at(-1) === "" || row.at(-1) === undefined)) row.pop();
    if (!row.some((value) => String(value ?? "").trim() !== "")) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const declaredRowNumber = Number(rowNode.getAttribute("r"));
    rows.push({
      rowNumber: Number.isInteger(declaredRowNumber) && declaredRowNumber > 0
        ? declaredRowNumber
        : fallbackRowNumber,
      values: row,
    });
  }

  const workbookProperties = workbook.getElementsByTagName("workbookPr")[0];
  const date1904Value = workbookProperties?.getAttribute("date1904") ?? "";
  return {
    sheetName: selectedSheet.getAttribute("name") || "Hoja 1",
    date1904: date1904Value === "1" || date1904Value.toLowerCase() === "true",
    rows,
    truncated,
  };
}

function tabularResult(matrix, { maxRows, sheetName, sourceHasMoreRows = false }) {
  if (matrix.length < 2) throw new TabularParseError("La planilla debe contener encabezados y al menos una fila de datos.", "TABULAR_ROWS_MISSING");
  const width = Math.max(...matrix.map((row) => row.length));
  if (width <= 0 || width > MAX_COLUMNS) {
    throw new TabularParseError(`La planilla debe tener entre 1 y ${MAX_COLUMNS} columnas.`, "TABULAR_COLUMN_LIMIT");
  }
  const headers = uniqueHeaders(matrix[0], width);
  const sourceRows = matrix.slice(1).filter((row) => row.some((value) => String(value ?? "").trim() !== ""));
  const visibleRows = sourceRows.slice(0, maxRows);
  return {
    headers,
    rows: visibleRows.map((row) => Object.fromEntries(headers.map((header, index) => [header, scalar(row[index])]))),
    sheetName,
    sourceRowCount: sourceRows.length,
    truncated: sourceHasMoreRows || sourceRows.length > maxRows,
  };
}

function uniqueHeaders(row, width) {
  const used = new Map();
  return Array.from({ length: width }, (_, index) => {
    const base = String(row[index] ?? "").replace(/\s+/g, " ").trim() || `Columna ${index + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function detectDelimiter(text) {
  const candidates = [",", ";", "\t"];
  const scored = candidates.map((delimiter) => ({
    delimiter,
    columns: delimiterColumnScore(text, delimiter),
  }));
  scored.sort((left, right) => right.columns - left.columns);
  if ((scored[0]?.columns ?? 0) < 2) {
    throw new TabularParseError("No fue posible detectar columnas en el CSV.", "CSV_DELIMITER_MISSING");
  }
  return scored[0].delimiter;
}

function delimiterColumnScore(text, delimiter) {
  const sampleLimit = Math.min(text.length, 64 * 1024);
  let best = 0;
  let columns = 1;
  let hasContent = false;
  let lineCount = 0;
  let quoted = false;

  for (let index = 0; index < sampleLimit; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      columns += 1;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (hasContent) {
        best = Math.max(best, columns);
        lineCount += 1;
        if (lineCount >= 5) break;
      }
      columns = 1;
      hasContent = false;
    } else if (!/\s/.test(char)) {
      hasContent = true;
    }
  }
  if (hasContent) best = Math.max(best, columns);
  return best;
}

function sharedStringValues(document) {
  return [...document.getElementsByTagName("si")].map((item) =>
    [...item.getElementsByTagName("t")].map((text) => text.textContent ?? "").join(""));
}

function cellValue(cell, sharedStrings) {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return [...cell.getElementsByTagName("t")].map((entry) => entry.textContent ?? "").join("");
  }
  const raw = cell.getElementsByTagName("v")[0]?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "b") return raw === "1";
  if (type === "str" || type === "d" || type === "e") return raw;
  const number = Number(raw);
  return raw !== "" && Number.isFinite(number) ? number : raw;
}

async function requiredXml(zip, path, budget) {
  const file = zip.file(path);
  if (!file) throw new TabularParseError(`Falta ${path} en el libro .xlsx.`, "XLSX_PART_MISSING");
  return limitedText(file, budget);
}

async function limitedText(file, budget) {
  const declaredSize = Number(file?._data?.uncompressedSize);
  if (Number.isFinite(declaredSize) && declaredSize > budget.remaining) throw xlsxExpansionError();

  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8");
    const parts = [];
    let settled = false;
    let total = 0;
    let stream;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream?.pause();
      reject(error);
    };

    try {
      stream = file.internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > budget.remaining) {
            fail(xlsxExpansionError());
            return;
          }
          parts.push(decoder.decode(chunk, { stream: true }));
        })
        .on("error", () => fail(new TabularParseError(
          "El archivo .xlsx está dañado o no se puede descomprimir.",
          "XLSX_ZIP_INVALID",
        )))
        .on("end", () => {
          if (settled) return;
          settled = true;
          parts.push(decoder.decode());
          budget.remaining -= total;
          resolve(parts.join(""));
        })
        .resume();
    } catch {
      fail(new TabularParseError(
        "El archivo .xlsx está dañado o no se puede descomprimir.",
        "XLSX_ZIP_INVALID",
      ));
    }
  });
}

function xlsxExpansionError() {
  return new TabularParseError(
    "El contenido descomprimido del libro supera el límite seguro de lectura.",
    "XLSX_EXPANSION_LIMIT",
  );
}

function parseXml(text, label) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new TabularParseError(`El XML de ${label} no es válido.`, "XLSX_XML_INVALID");
  }
  return document;
}

function normalizeZipPath(base, target) {
  const parts = `${base}/${target}`.replace(/\\/g, "/").split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function columnFromAddress(address) {
  const letters = /^[A-Z]+/i.exec(address)?.[0]?.toUpperCase();
  if (!letters) return -1;
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function scalar(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value).trim();
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TabularParseError("No fue posible leer los bytes de la planilla.", "TABULAR_INPUT_INVALID");
}
