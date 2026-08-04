const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const GREEN = "0.071 0.231 0.169";
const LIME = "0.784 0.925 0.455";
const INK = "0.09 0.13 0.11";
const MUTED = "0.36 0.43 0.39";
const BORDER = "0.84 0.88 0.85";

export function renderTraceabilityDocumentPdf(projection) {
  assertProjection(projection);
  const pageModels = projection.metadata.kind === "FMA"
    ? fmaPages(projection)
    : deaPages(projection);
  const pageStreams = pageModels.map((page, index) => renderPage(page, projection, index + 1, pageModels.length));
  return buildPdf(pageStreams);
}

export function traceabilityDocumentObjectKey(projection) {
  assertProjection(projection);
  const { documentId, kind, revision } = projection.metadata;
  const organizationId = safeSegment(projection.content.organizationId);
  const fieldId = safeSegment(projection.content.fieldId);
  return `trazabilidad/${organizationId}/${fieldId}/${kind.toLowerCase()}/${safeSegment(documentId)}/v${revision}.pdf`;
}

export async function sha256Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function fmaPages(projection) {
  const animals = Array.isArray(projection.content.animals) ? projection.content.animals : [];
  return chunk(animals, 26).map((rows) => ({ kind: "FMA", rows }));
}

function deaPages(projection) {
  const rows = Array.isArray(projection.content.rows) ? projection.content.rows : [];
  return chunk(rows, 24).map((pageRows) => ({ kind: "DEA", rows: pageRows }));
}

function renderPage(page, projection, pageNumber, pageCount) {
  const stream = [];
  rectangle(stream, 0, 770, PAGE_WIDTH, 72, GREEN);
  text(stream, 38, 810, "FundoSmart", { font: "F2", size: 20, color: "1 1 1" });
  text(stream, 38, 790, projection.metadata.kind === "FMA" ? "Formulario de Movimiento Animal" : "Declaración de Existencias Anual", { size: 11, color: "1 1 1" });
  rectangle(stream, 391, 791, 166, 28, LIME);
  text(stream, 404, 802, projection.metadata.state === "issued" ? "EMITIDO INTERNO - NO SAG" : "BORRADOR - NO DECLARADO", { font: "F2", size: 8.5, color: GREEN });

  let y = 744;
  text(stream, 38, y, projection.metadata.folio ? `Folio interno ${projection.metadata.folio}` : `Documento ${projection.metadata.documentId}`, { font: "F2", size: 12 });
  text(stream, 340, y, `Revisión ${projection.metadata.revision} · Formato ${projection.metadata.formVersion}`, { size: 8.5, color: MUTED });
  y -= 18;
  text(stream, 38, y, `Generado: ${formatInstant(projection.metadata.generatedAt)}`, { size: 8.5, color: MUTED });
  text(stream, 340, y, projection.metadata.fakeData ? "DATOS FICTICIOS DE DEMOSTRACIÓN" : "Revisión y firma del responsable requeridas", { font: "F2", size: 8.5, color: projection.metadata.fakeData ? "0.72 0.25 0.12" : MUTED });

  y -= 31;
  const establishment = projection.content.establishment ?? {};
  sectionTitle(stream, y, "Establecimiento de origen");
  y -= 22;
  keyValue(stream, 38, y, "RUP", establishment.rup ?? "Sin RUP");
  keyValue(stream, 250, y, "Titular", establishment.holderName ?? "Sin titular");
  y -= 18;
  keyValue(stream, 38, y, "Comuna", establishment.commune ?? "Sin comuna");
  keyValue(stream, 250, y, "Dirección", establishment.address ?? "Sin dirección");

  if (page.kind === "FMA") y = renderFma(stream, projection.content, page.rows, y - 31);
  else y = renderDea(stream, projection.content, page.rows, y - 31);

  const footerY = 34;
  line(stream, 38, footerY + 25, 557, footerY + 25, BORDER);
  text(stream, 38, footerY + 9, projection.metadata.state === "issued"
    ? "Emisión interna FundoSmart. Formato y envío SAG pendientes; no acredita una declaración."
    : "Formato oficial SAG pendiente de confirmación. Este documento no acredita una declaración.", { size: 7.5, color: MUTED });
  text(stream, 500, footerY + 9, `${pageNumber} / ${pageCount}`, { font: "F2", size: 8, color: MUTED });
  if (y < footerY + 45) throw new RangeError("El documento de trazabilidad excede el área imprimible.");
  return concatBytes(stream);
}

function renderFma(stream, content, animals, startY) {
  let y = startY;
  sectionTitle(stream, y, "Movimiento y transporte");
  y -= 22;
  keyValue(stream, 38, y, "Destino", content.destination?.rup ?? "-");
  keyValue(stream, 250, y, "Comuna", content.destination?.commune ?? "-");
  y -= 18;
  keyValue(stream, 38, y, "Salida", `${content.departure?.date ?? "-"} ${content.departure?.time ?? ""}`.trim());
  keyValue(stream, 250, y, "Llegada estimada", `${content.expectedArrival?.date ?? "-"} ${content.expectedArrival?.time ?? ""}`.trim());
  y -= 18;
  keyValue(stream, 38, y, "Transportista", content.transport?.carrierName ?? "-");
  keyValue(stream, 250, y, "Patente", content.transport?.vehiclePlate ?? "-");
  y -= 31;
  sectionTitle(stream, y, `Animales incluidos (${animals.length})`);
  y -= 24;
  tableHeader(stream, y, [
    [38, 150, "DIIO"], [188, 130, "Especie"], [318, 190, "Categoría"], [508, 49, "Estado"],
  ]);
  y -= 21;
  for (const [index, animal] of animals.entries()) {
    if (index % 2 === 0) rectangle(stream, 38, y - 3, 519, 15, "0.965 0.975 0.968");
    text(stream, 44, y + 1, fit(animal.diio, 20), { font: "F2", size: 8 });
    text(stream, 194, y + 1, fit(animal.speciesLabel, 18), { size: 8 });
    text(stream, 324, y + 1, fit(animal.categoryLabel, 28), { size: 8 });
    text(stream, 514, y + 1, "OK", { font: "F2", size: 7.5, color: GREEN });
    y -= 15;
  }
  return y;
}

function renderDea(stream, content, rows, startY) {
  let y = startY;
  sectionTitle(stream, y, "Declaración derivada del inventario");
  y -= 22;
  keyValue(stream, 38, y, "Período", content.period ?? "-");
  keyValue(stream, 250, y, "Fecha de corte", content.asOfDate ?? "-");
  y -= 31;
  tableHeader(stream, y, [
    [38, 170, "Especie"], [208, 250, "Categoría"], [458, 99, "Cantidad"],
  ]);
  y -= 21;
  for (const [index, row] of rows.entries()) {
    if (index % 2 === 0) rectangle(stream, 38, y - 4, 519, 19, "0.965 0.975 0.968");
    text(stream, 44, y + 2, fit(row.speciesLabel, 24), { size: 8.5 });
    text(stream, 214, y + 2, fit(row.categoryLabel, 36), { size: 8.5 });
    text(stream, 500, y + 2, String(row.quantity ?? 0), { font: "F2", size: 8.5 });
    y -= 19;
  }
  y -= 8;
  line(stream, 380, y + 16, 557, y + 16, BORDER);
  text(stream, 390, y, "Total de animales", { font: "F2", size: 9 });
  text(stream, 514, y, String(content.totalAnimals ?? 0), { font: "F2", size: 10, color: GREEN });
  return y;
}

function sectionTitle(stream, y, label) {
  rectangle(stream, 38, y - 5, 519, 22, "0.92 0.95 0.93");
  text(stream, 48, y + 2, label, { font: "F2", size: 9, color: GREEN });
}

function keyValue(stream, x, y, label, value) {
  text(stream, x, y, `${label}:`, { font: "F2", size: 8, color: MUTED });
  const valueOffset = Math.max(64, label.length * 4.7 + 12);
  text(stream, x + valueOffset, y, fit(value, x < 100 ? 28 : 34), { size: 8.5, color: INK });
}

function tableHeader(stream, y, columns) {
  rectangle(stream, 38, y - 5, 519, 22, GREEN);
  for (const [x, width, label] of columns) {
    text(stream, x + 6, y + 2, fit(label, Math.max(4, Math.floor(width / 6))), { font: "F2", size: 8, color: "1 1 1" });
  }
}

function rectangle(stream, x, y, width, height, color) {
  stream.push(ascii(`${color} rg ${x} ${y} ${width} ${height} re f\n`));
}

function line(stream, x1, y1, x2, y2, color) {
  stream.push(ascii(`${color} RG 0.7 w ${x1} ${y1} m ${x2} ${y2} l S\n`));
}

function text(stream, x, y, value, options = {}) {
  const font = options.font ?? "F1";
  const size = options.size ?? 9;
  const color = options.color ?? INK;
  stream.push(ascii(`BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm (`));
  stream.push(winAnsiLiteral(value));
  stream.push(ascii(") Tj ET\n"));
}

function buildPdf(pageStreams) {
  const pageCount = pageStreams.length;
  const regularFontId = 3 + pageCount * 2;
  const boldFontId = regularFontId + 1;
  const objects = [];
  objects[1] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = ascii(`<< /Type /Pages /Count ${pageCount} /Kids [${pageStreams.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`);
  for (const [index, pageStream] of pageStreams.entries()) {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    objects[pageId] = ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects[contentId] = concatBytes([ascii(`<< /Length ${pageStream.length} >>\nstream\n`), pageStream, ascii("\nendstream")]);
  }
  objects[regularFontId] = ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects[boldFontId] = ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const parts = [concatBytes([ascii("%PDF-1.7\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")])];
  const offsets = [0];
  let length = parts[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = length;
    const object = concatBytes([ascii(`${id} 0 obj\n`), objects[id], ascii("\nendobj\n")]);
    parts.push(object);
    length += object.length;
  }
  const xrefOffset = length;
  const xref = [`xref\n0 ${objects.length}\n`, "0000000000 65535 f \n"];
  for (let id = 1; id < objects.length; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  parts.push(ascii(xref.join("")));
  parts.push(ascii(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return concatBytes(parts);
}

function winAnsiLiteral(value) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/[‐‑‒–—―]/gu, "-")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[\r\n\t]+/gu, " ");
  const bytes = [];
  for (const character of normalized) {
    const code = character.codePointAt(0);
    if (character === "(" || character === ")" || character === "\\") bytes.push(0x5c);
    bytes.push(code >= 32 && code <= 255 ? code : 0x3f);
  }
  return new Uint8Array(bytes);
}

function ascii(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function chunk(items, size) {
  if (items.length === 0) return [[]];
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function fit(value, maxCharacters) {
  const normalized = String(value ?? "-").trim() || "-";
  return normalized.length <= maxCharacters ? normalized : `${normalized.slice(0, Math.max(1, maxCharacters - 3))}...`;
}

function formatInstant(value) {
  const instant = new Date(String(value));
  if (!Number.isFinite(instant.getTime())) return String(value ?? "-");
  return instant.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function safeSegment(value) {
  const segment = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(segment) || segment.includes("..")) throw new TypeError("La identidad documental no es válida.");
  return segment;
}

function assertProjection(projection) {
  if (!projection?.metadata || !projection?.content || !["FMA", "DEA"].includes(projection.metadata.kind)) {
    throw new TypeError("La proyección documental de trazabilidad no es válida.");
  }
  safeSegment(projection.metadata.documentId);
  if (!Number.isInteger(projection.metadata.revision) || projection.metadata.revision < 1) throw new TypeError("La revisión documental no es válida.");
}
