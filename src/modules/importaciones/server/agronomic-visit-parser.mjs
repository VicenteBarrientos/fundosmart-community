const SECTION_HEADINGS = new Set(["manejos agronomicos.", "plan agronomico."]);
const GROUP_HEADING = /^(?:establecimientos?\b|coles forrajeras\b|siembras?\b|potreros?\s+\d|fertilizacion de praderas\b|senecio en potreros\b|cardos en potreros\b)/;

export class AgronomicVisitParseError extends Error {
  constructor(message, code = "AGRONOMIC_VISIT_INVALID") {
    super(message);
    this.name = "AgronomicVisitParseError";
    this.code = code;
  }
}

export function parseAgronomicVisitText(input) {
  const lines = (Array.isArray(input) ? input : String(input).split(/\r?\n/))
    .map(cleanLine)
    .filter(Boolean);
  const comparable = lines.map(ascii);
  if (
    !comparable[0]?.startsWith("cliente:")
    || !comparable.includes("temas revisados en la visita.")
    || !comparable.includes("consultor")
  ) {
    throw new AgronomicVisitParseError(
      "El PDF no coincide con el perfil de informe de visita agronómica v1.",
      "AGRONOMIC_PROFILE_MISMATCH",
    );
  }

  const dateLine = lines.find((line) => ascii(line).startsWith("fecha:"));
  const visitDate = spanishSourceDate(dateLine?.slice(dateLine.indexOf(":") + 1));
  const sectionIndex = comparable.findIndex((line) => SECTION_HEADINGS.has(line));
  if (sectionIndex < 0) {
    throw new AgronomicVisitParseError(
      "El informe corresponde a una visita, pero no contiene una sección explícita de manejos o plan agronómico.",
      "AGRONOMIC_SECTION_MISSING",
    );
  }
  const footerIndex = comparable.indexOf("consultor", sectionIndex + 1);
  if (footerIndex < 0 || footerIndex - sectionIndex < 2) {
    throw new AgronomicVisitParseError(
      "La sección agronómica del informe está incompleta.",
      "AGRONOMIC_SECTION_INVALID",
    );
  }

  const actionGroups = parseActionGroups(lines.slice(sectionIndex + 1, Math.max(sectionIndex + 1, footerIndex - 1)));
  if (actionGroups.length === 0) {
    throw new AgronomicVisitParseError(
      "No se encontraron bloques de manejo dentro de la sección agronómica.",
      "AGRONOMIC_ACTION_GROUPS_MISSING",
    );
  }
  if (!actionGroups.some((group) => group.externalPaddockKeys.length > 0)) {
    throw new AgronomicVisitParseError(
      "La sección agronómica no contiene referencias explícitas a potreros que puedan conciliarse.",
      "AGRONOMIC_PADDOCK_REFERENCES_MISSING",
    );
  }

  return {
    kind: "agronomic_visit_report",
    schemaVersion: "fundosmart.agronomic.visit-report.v1",
    sourceLabel: "Asesoría agronómica",
    visitDate,
    sectionHeading: lines[sectionIndex],
    reportedIndicators: reportedIndicators(lines, sectionIndex),
    actionGroups,
    limitations: [
      "Cada etiqueta de potrero debe conciliarse manualmente con un potrero activo de FundoSmart.",
      "Las superficies corresponden al bloque informado y no se distribuyen entre potreros individuales.",
      "Las recomendaciones se conservan como evidencia del asesor; no crean actividades, compras, dosis ni reservas.",
      "Los grupos sin una etiqueta explícita de potrero se conservan en el documento, pero no generan una fila conciliable.",
    ],
  };
}

export function agronomicVisitPreviewRows(snapshot) {
  const rows = [];
  for (const group of snapshot.actionGroups) {
    for (const externalPaddockKey of group.externalPaddockKeys) {
      rows.push({
        recordNumber: rows.length + 1,
        rawRecord: {
          actionGroupNumber: group.sequenceNumber,
          actionHeading: group.heading,
          externalPaddockKey,
          recommendationText: group.recommendationText,
          reportedGroupAreaHa: group.reportedGroupAreaHa,
        },
        normalizedRecord: {
          actionKind: "agronomic_recommendation",
          actionGroupNumber: group.sequenceNumber,
          actionHeading: group.heading,
          externalPaddockKey,
          paddockId: null,
          visitDate: snapshot.visitDate,
          recommendationText: group.recommendationText,
          reportedGroupAreaHa: group.reportedGroupAreaHa,
        },
        status: "warning",
        issues: [{
          fieldName: "paddockId",
          ruleCode: "PADDOCK_RECONCILIATION_PENDING",
          severity: "warning",
          message: `Concilia el potrero externo ${externalPaddockKey} antes de confirmar esta recomendación.`,
          sourceValue: externalPaddockKey,
        }],
      });
    }
  }
  return rows;
}

function parseActionGroups(lines) {
  const groups = [];
  let current = null;
  for (const line of lines) {
    if (isGroupHeading(line)) {
      if (current) groups.push(finalizeGroup(current, groups.length + 1));
      current = { heading: line, detailLines: [] };
      continue;
    }
    if (current) current.detailLines.push(line);
  }
  if (current) groups.push(finalizeGroup(current, groups.length + 1));
  return groups;
}

function finalizeGroup(group, sequenceNumber) {
  const sourceLines = [group.heading, ...group.detailLines];
  return {
    sequenceNumber,
    heading: group.heading,
    recommendationText: joinWrapped(group.detailLines),
    externalPaddockKeys: extractPaddockKeys(sourceLines),
    reportedGroupAreaHa: reportedArea(group.heading),
  };
}

function reportedIndicators(lines, sectionIndex) {
  const indicators = [];
  for (const line of lines.slice(1, sectionIndex)) {
    const match = /^([^:]{2,50}):\s*(.+)$/.exec(line);
    if (!match || ascii(match[1]) === "fecha") continue;
    const label = cleanLine(match[1]);
    const value = cleanLine(match[2]);
    if (!label || !value) continue;
    indicators.push({ label, value });
  }
  return indicators.slice(0, 20);
}

function extractPaddockKeys(lines) {
  const keys = [];
  for (const line of lines) {
    const matches = line.matchAll(/\bpotreros?\s+((?:\d+[a-z]?\s*(?:(?:,|y|-)\s*)?)+)/gi);
    for (const match of matches) {
      for (const key of match[1].match(/\d+[a-z]?/gi) ?? []) {
        const normalized = key.toUpperCase();
        if (!keys.includes(normalized)) keys.push(normalized);
      }
    }
  }
  return keys;
}

function isGroupHeading(value) {
  return GROUP_HEADING.test(ascii(value));
}

function reportedArea(value) {
  const match = /\((\d+(?:[.,]\d+)?)\s*ha\)/i.exec(value);
  if (!match) return null;
  const parsed = Number(match[1].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function spanishSourceDate(value) {
  const normalized = ascii(value ?? "");
  const match = /^(\d{1,2}) de ([a-z]+) (\d{4})\.?$/.exec(normalized);
  const months = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
  };
  const month = match ? months[match[2]] : null;
  if (!match || !month) {
    throw new AgronomicVisitParseError(
      "No fue posible leer la fecha del informe agronómico.",
      "AGRONOMIC_VISIT_DATE_INVALID",
    );
  }
  const day = Number(match[1]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    day < 1
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new AgronomicVisitParseError(
      "La fecha del informe agronómico no es válida.",
      "AGRONOMIC_VISIT_DATE_INVALID",
    );
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function joinWrapped(lines) {
  return lines.reduce((text, line) => {
    if (!text) return line;
    return text.endsWith("-") && /^\d/.test(line) ? `${text}${line}` : `${text} ${line}`;
  }, "");
}

function cleanLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function ascii(value) {
  return cleanLine(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
