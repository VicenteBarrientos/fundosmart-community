export type DeviceWeightRow = { tag: string; weightKg: number; line: number };

export function parseDeviceWeightText(content: string): DeviceWeightRow[] {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  const first = splitLine(lines[0], delimiter).map(normalizeHeader);
  const tagIndex = first.findIndex((value) => ["diio", "eid", "id", "animal", "tag", "caravana", "identificador"].includes(value));
  const weightIndex = first.findIndex((value) => ["peso", "pesokg", "weight", "weightkg", "kg"].includes(value));
  const hasHeader = tagIndex >= 0 || weightIndex >= 0;
  const rows: DeviceWeightRow[] = [];
  for (let index = hasHeader ? 1 : 0; index < lines.length; index += 1) {
    const cells = splitLine(lines[index], delimiter);
    const tag = String(cells[tagIndex >= 0 ? tagIndex : 0] ?? "").trim();
    const rawWeight = String(cells[weightIndex >= 0 ? weightIndex : 1] ?? "").trim().replace(/\s*kg$/i, "").replace(",", ".");
    const weightKg = Number(rawWeight);
    if (tag && Number.isFinite(weightKg) && weightKg > 0) rows.push({ tag, weightKg, line: index + 1 });
  }
  return rows;
}

function detectDelimiter(line: string): string { const candidates = [";", "\t", ","]; return candidates.sort((a, b) => line.split(b).length - line.split(a).length)[0]; }
function splitLine(line: string, delimiter: string): string[] { return line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, "")); }
function normalizeHeader(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
