const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 12 * 1024 * 1024;
const latin1 = new TextDecoder("windows-1252");

export class PdfTextExtractionError extends Error {
  constructor(message, code = "PDF_TEXT_UNSUPPORTED") {
    super(message);
    this.name = "PdfTextExtractionError";
    this.code = code;
  }
}

export async function extractPdfText(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfTextExtractionError("El PDF debe tener contenido y no superar 10 MB.", "PDF_SIZE_INVALID");
  }

  const raw = latin1.decode(bytes);
  if (!raw.slice(0, 1024).includes("%PDF-")) {
    throw new PdfTextExtractionError("El archivo no tiene una cabecera PDF válida.", "PDF_HEADER_INVALID");
  }
  if (/\/Encrypt\b/.test(raw)) {
    throw new PdfTextExtractionError("El PDF está protegido. Exporta una copia sin contraseña antes de importarlo.", "PDF_ENCRYPTED");
  }

  const objects = pdfObjects(raw, bytes);
  const strings = [];
  const lines = [];
  let decodedBytes = 0;
  let streamCount = 0;

  for (const object of objects) {
    if (!object.stream || /\/Subtype\s*\/Image\b/.test(object.dictionary)) continue;
    let content;
    try {
      if (/\/FlateDecode\b/.test(object.dictionary)) {
        content = await inflateLimited(object.stream, MAX_DECOMPRESSED_BYTES - decodedBytes);
      } else if (/\/Filter\b/.test(object.dictionary)) {
        continue;
      } else {
        content = object.stream;
      }
    } catch (cause) {
      if (cause instanceof PdfTextExtractionError) throw cause;
      continue;
    }
    decodedBytes += content.byteLength;
    if (decodedBytes > MAX_DECOMPRESSED_BYTES) {
      throw new PdfTextExtractionError("El PDF descomprimido supera el límite seguro de lectura.", "PDF_EXPANSION_LIMIT");
    }

    const operations = latin1.decode(content);
    if (!/\bBT\b/.test(operations) || !/\b(?:Tj|TJ)\b/.test(operations)) continue;
    streamCount += 1;
    strings.push(...literalStrings(operations));
    lines.push(...positionedLines(operations));
  }

  const cleaned = strings.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new PdfTextExtractionError(
      "No se encontró texto utilizable. Si el documento es una imagen escaneada, conviértelo a PDF con texto antes de importarlo.",
      "PDF_TEXT_NOT_FOUND",
    );
  }
  const cleanedLines = lines.map(cleanText).filter(Boolean);
  const readableLines = cleanedLines.length > 0 ? cleanedLines : cleaned;
  return {
    strings: cleaned,
    lines: readableLines,
    streamCount,
    text: cleaned.join("\n"),
    lineText: readableLines.join("\n"),
  };
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new PdfTextExtractionError("No fue posible leer los bytes del PDF.", "PDF_INPUT_INVALID");
}

function pdfObjects(raw, bytes) {
  const matches = [...raw.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g)];
  const objects = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const bodyStart = match.index + match[0].length;
    const nextStart = matches[index + 1]?.index ?? raw.length;
    const endObject = raw.indexOf("endobj", bodyStart);
    const bodyEnd = endObject >= 0 && endObject < nextStart ? endObject : nextStart;
    const body = raw.slice(bodyStart, bodyEnd);
    const marker = /\bstream[ \t]*(?:\r\n|\n|\r)/.exec(body);
    if (!marker) {
      objects.push({ number: Number(match[1]), dictionary: body, stream: null });
      continue;
    }

    const markerStart = bodyStart + marker.index;
    const streamStart = markerStart + marker[0].length;
    const dictionary = raw.slice(bodyStart, markerStart);
    const directLength = /\/Length\s+(\d+)\b/.exec(dictionary);
    let streamEnd = directLength ? streamStart + Number(directLength[1]) : raw.indexOf("endstream", streamStart);
    if (streamEnd < streamStart || streamEnd > bodyEnd) continue;
    if (!directLength) {
      while (streamEnd > streamStart && (bytes[streamEnd - 1] === 10 || bytes[streamEnd - 1] === 13)) streamEnd -= 1;
    }
    objects.push({
      number: Number(match[1]),
      dictionary,
      stream: bytes.slice(streamStart, streamEnd),
    });
  }
  return objects.sort((left, right) => left.number - right.number);
}

async function inflateLimited(bytes, remainingLimit) {
  if (remainingLimit <= 0) throw new Error("limit");
  try {
    return await decompressLimited(bytes, "deflate", remainingLimit);
  } catch (cause) {
    if (cause instanceof PdfTextExtractionError || bytes.byteLength <= 6 || (bytes[1] & 0x20) !== 0) throw cause;
    return decompressLimited(bytes.slice(2, -4), "deflate-raw", remainingLimit);
  }
}

async function decompressLimited(bytes, format, remainingLimit) {
  const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const reader = decompressed.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > remainingLimit) {
        await reader.cancel();
        throw new PdfTextExtractionError("El PDF descomprimido supera el límite seguro de lectura.", "PDF_EXPANSION_LIMIT");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function literalStrings(content) {
  const values = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "(") continue;
    const parsed = readLiteral(content, index + 1);
    if (!parsed) continue;
    values.push(parsed.value);
    index = parsed.end;
  }
  return values;
}

function positionedLines(content) {
  const runs = [];
  let order = 0;
  const blocks = content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g);
  for (const blockMatch of blocks) {
    const body = blockMatch[1];
    const matrices = [...body.matchAll(TEXT_MATRIX)];
    for (let index = 0; index < matrices.length; index += 1) {
      const matrix = matrices[index];
      const segmentStart = matrix.index + matrix[0].length;
      const segmentEnd = matrices[index + 1]?.index ?? body.length;
      const segment = body.slice(segmentStart, segmentEnd);
      if (!/\b(?:Tj|TJ)\b/.test(segment)) continue;
      const text = literalStrings(segment).join("");
      if (!text) continue;
      runs.push({
        x: Number(matrix[5]),
        y: Number(matrix[6]),
        text,
        order,
      });
      order += 1;
    }
  }
  if (runs.length === 0) return [];

  const grouped = [];
  for (const run of runs) {
    let line = grouped.find((candidate) => Math.abs(candidate.y - run.y) <= 0.5);
    if (!line) {
      line = { y: run.y, firstOrder: run.order, runs: [] };
      grouped.push(line);
    }
    line.runs.push(run);
    line.firstOrder = Math.min(line.firstOrder, run.order);
  }

  return grouped
    .sort((left, right) => left.firstOrder - right.firstOrder)
    .map((line) => line.runs
      .sort((left, right) => left.x - right.x || left.order - right.order)
      .map((run) => run.text)
      .join(""));
}

const PDF_NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const TEXT_MATRIX = new RegExp(
  String.raw`(${PDF_NUMBER})\s+(${PDF_NUMBER})\s+(${PDF_NUMBER})\s+(${PDF_NUMBER})\s+(${PDF_NUMBER})\s+(${PDF_NUMBER})\s+Tm\b`,
  "g",
);

function cleanText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function readLiteral(content, start) {
  let depth = 1;
  let value = "";
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\\") {
      const next = content[index + 1];
      if (next === "\r" || next === "\n") {
        if (next === "\r" && content[index + 2] === "\n") index += 1;
        index += 1;
        continue;
      }
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (Object.hasOwn(escapes, next)) {
        value += escapes[next];
        index += 1;
        continue;
      }
      if (/[0-7]/.test(next ?? "")) {
        const octal = content.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
        value += String.fromCharCode(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
      value += next ?? "";
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      value += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { value, end: index };
      value += char;
      continue;
    }
    value += char;
  }
  return null;
}
