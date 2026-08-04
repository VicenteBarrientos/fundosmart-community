const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

export function serializeCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(";"))
    .join("\r\n")}`;
}

export function downloadCsv(filename, headers, rows) {
  downloadCsvText(filename, serializeCsv(headers, rows));
}

/**
 * Downloads a CSV that was already serialized elsewhere, so a builder that owns its
 * own header contract does not have to hand its rows back apart from their headers.
 */
export function downloadCsvText(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = typeof value === "string" && FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
