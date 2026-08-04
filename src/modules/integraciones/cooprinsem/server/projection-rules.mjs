const IDENTIFIER_FIELDS = [
  ["NUMVACA", "cooprinsem_numvaca"],
  ["NOMBRE", "cooprinsem_nombre"],
  ["NUMERONEW", "cooprinsem_nombre_nuevo"],
  ["RP", "rp"],
  ["CODBARRA", "barcode"],
];

export const COOPRINSEM_QUARANTINE_LOT_NAME = "Migración Cooprinsem · por clasificar";

export class ProjectionRuleError extends Error {
  constructor(message, code = "PROJECTION_INVALID") {
    super(message);
    this.name = "ProjectionRuleError";
    this.code = code;
  }
}

export function buildProjectionCandidate(record, context = {}) {
  const identifiers = [];
  for (const [fieldName, kind] of IDENTIFIER_FIELDS) {
    const value = identifierText(record?.[fieldName]);
    if (!value) continue;
    identifiers.push({ kind, value, normalizedValue: normalizeExternalIdentifier(value), isPrimary: false });
  }
  const numVaca = identifiers.find((entry) => entry.kind === "cooprinsem_numvaca")?.value ?? null;
  const dv = identifierText(record?.DV);
  if (numVaca && dv) {
    const value = `${numVaca}-${dv}`;
    identifiers.push({ kind: "cooprinsem_numvaca_dv", value, normalizedValue: normalizeExternalIdentifier(value), isPrimary: true });
  }
  const preferred = identifiers.find((entry) => entry.kind === "cooprinsem_numvaca_dv")
    ?? identifiers.find((entry) => entry.kind === "cooprinsem_numvaca")
    ?? identifiers.find((entry) => entry.kind === "rp")
    ?? identifiers.find((entry) => entry.kind === "cooprinsem_nombre")
    ?? identifiers.find((entry) => entry.kind === "barcode")
    ?? null;
  if (preferred && !identifiers.some((entry) => entry.isPrimary)) preferred.isPrimary = true;
  const uniqueIdentifiers = deduplicateIdentifiers(identifiers);
  const fieldCode = identifierText(record?.NUMPREDIO);
  const groupCode = identifierText(record?.GRUPO);
  return {
    identifiers: uniqueIdentifiers,
    canonicalTag: preferred?.value ?? null,
    sourceKey: preferred ? `${preferred.kind}:${preferred.normalizedValue}` : null,
    fieldCode,
    normalizedFieldCode: fieldCode ? normalizeExternalIdentifier(fieldCode) : null,
    groupCode,
    normalizedGroupCode: groupCode ? normalizeExternalIdentifier(groupCode) : null,
    effectiveAt: isoDate(record?.FCONTROL) ?? isoDate(context.effectiveAt) ?? null,
    issues: preferred ? [] : ["La fila no contiene un identificador animal proyectable."],
  };
}

export function normalizeExternalIdentifier(value) {
  const normalized = identifierText(value);
  if (!normalized) throw new ProjectionRuleError("El identificador no puede quedar vacío.", "IDENTIFIER_EMPTY");
  return normalized.normalize("NFKC").toLocaleUpperCase("es");
}

export function deterministicProjectionId(prefix, parts) {
  const encoded = parts.map((part) => encodeURIComponent(String(part))).join(":");
  return `${prefix}:${encoded}`;
}

export function projectionQuarantineLotId(fieldId) {
  return deterministicProjectionId("lot", [fieldId, "cooprinsem-review"]);
}

export function projectionIdentityKey(identifier) {
  return `${identifier.kind}:${identifier.normalizedValue}`;
}

export function resolveProjectionMatches(identifiers, existingByIdentity, proposedByIdentity = new Map()) {
  const identityKeys = identifiers.map(projectionIdentityKey);
  const animalIds = new Set();
  const matchedBy = [];
  for (const key of identityKeys) {
    const existing = existingByIdentity.get(key) ?? [];
    for (const animalId of existing) animalIds.add(animalId);
    if (existing.size > 0 || existing.length > 0) matchedBy.push(key);
    const proposed = proposedByIdentity.get(key);
    if (!proposed) continue;
    animalIds.add(proposed);
    if (!matchedBy.includes(key)) matchedBy.push(key);
  }
  return { animalIds: [...animalIds].sort(), identityKeys, matchedBy };
}

function identifierText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return String(value).trim();
}

function isoDate(value) {
  const text = identifierText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}

function deduplicateIdentifiers(identifiers) {
  const seen = new Set();
  return identifiers.filter((entry) => {
    const key = projectionIdentityKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
