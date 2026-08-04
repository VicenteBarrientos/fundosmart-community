export const LEGAL_DOCUMENT_KINDS = Object.freeze(["privacy", "terms"]);
export const LEGAL_ACCEPTANCE_SOURCE = "authenticated_web";
export const LEGAL_ACCEPTANCE_EVIDENCE_VERSION = 1;

export const CURRENT_LEGAL_DOCUMENT_RELEASES = deepFreeze({
  privacy: {
    kind: "privacy",
    version: "1.2",
    publishedOn: "2026-07-29",
    route: "/privacidad",
    contentSha256: "a0745d4708bc57e430f61ed660e98560c51eeaba26795b65bfd8ed6e74afb2a3",
  },
  terms: {
    kind: "terms",
    version: "1.2",
    publishedOn: "2026-07-29",
    route: "/terminos",
    contentSha256: "cb98ea7ed1d6f95c2efa9021548475904ba3362b732ba15ddd36a3e7423a3a7e",
  },
});

const PLAN_INPUT_KEYS = Object.freeze([
  "acceptedAt",
  "acceptedVersions",
  "confirmed",
  "idFactory",
  "identityId",
  "requestId",
  "userAgentSha256",
]);
const VERSION_KEYS = Object.freeze([...LEGAL_DOCUMENT_KINDS]);
const MAX_ID_LENGTH = 320;

export class LegalAcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LegalAcceptanceError";
    this.code = code;
  }
}

export function currentLegalDocumentRequirements() {
  return LEGAL_DOCUMENT_KINDS.map((kind) => CURRENT_LEGAL_DOCUMENT_RELEASES[kind]);
}

export function evaluateLegalAcceptance(records) {
  if (!Array.isArray(records)) {
    fail("INVALID_ACCEPTANCE_RECORDS", "Los registros de aceptación deben ser un arreglo.");
  }
  const acceptedAtByKind = new Map();
  for (const [index, record] of records.entries()) {
    if (!isPlainRecord(record)) {
      fail("INVALID_ACCEPTANCE_RECORD", `La aceptación ${index} no es válida.`);
    }
    const kind = requiredDocumentKind(record.documentKind);
    const version = requiredToken(record.documentVersion, "INVALID_ACCEPTANCE_RECORD", 80);
    const contentSha256 = requiredSha256(
      record.documentContentSha256,
      "INVALID_ACCEPTANCE_RECORD",
    );
    if (record.evidenceVersion !== LEGAL_ACCEPTANCE_EVIDENCE_VERSION) continue;
    const acceptedAt = exactIsoTimestamp(record.acceptedAt);
    const current = CURRENT_LEGAL_DOCUMENT_RELEASES[kind];
    if (version !== current.version || contentSha256 !== current.contentSha256) continue;
    if (!hasCurrentBoundEvidence(record, current, acceptedAt)) continue;
    const previous = acceptedAtByKind.get(kind);
    if (!previous || acceptedAt > previous) acceptedAtByKind.set(kind, acceptedAt);
  }

  const requirements = currentLegalDocumentRequirements().map((release) => deepFreeze({
    ...release,
    acceptedAt: acceptedAtByKind.get(release.kind) ?? null,
    accepted: acceptedAtByKind.has(release.kind),
  }));
  return deepFreeze({
    complete: requirements.every((requirement) => requirement.accepted),
    missingKinds: requirements
      .filter((requirement) => !requirement.accepted)
      .map((requirement) => requirement.kind),
    requirements,
  });
}

export function createLegalAcceptancePlan(input) {
  assertPlainRecord(input, "INVALID_ACCEPTANCE_INPUT", "La entrada de aceptación no es válida.");
  assertExactKeys(input, PLAN_INPUT_KEYS, "INVALID_ACCEPTANCE_INPUT", "entrada");
  const identityId = requiredToken(input.identityId, "INVALID_IDENTITY", MAX_ID_LENGTH);
  const requestId = requiredToken(input.requestId, "INVALID_REQUEST_ID", 160);
  const acceptedAt = exactIsoTimestamp(input.acceptedAt);
  const userAgentSha256 = optionalSha256(input.userAgentSha256);
  if (input.confirmed !== true) {
    fail("EXPLICIT_CONFIRMATION_REQUIRED", "Debes confirmar expresamente la aceptación.");
  }
  if (typeof input.idFactory !== "function") {
    fail("INVALID_ID_FACTORY", "La fábrica de identificadores no es válida.");
  }
  assertPlainRecord(
    input.acceptedVersions,
    "INVALID_ACCEPTED_VERSIONS",
    "Las versiones aceptadas no son válidas.",
  );
  assertExactKeys(
    input.acceptedVersions,
    VERSION_KEYS,
    "INVALID_ACCEPTED_VERSIONS",
    "acceptedVersions",
  );

  const acceptances = LEGAL_DOCUMENT_KINDS.map((kind) => {
    const release = CURRENT_LEGAL_DOCUMENT_RELEASES[kind];
    if (input.acceptedVersions[kind] !== release.version) {
      fail(
        "STALE_LEGAL_VERSION",
        `La versión aceptada de ${kind} ya no es la versión vigente.`,
      );
    }
    const id = generatedId(input.idFactory, `acceptance:${kind}`);
    const evidence = deepFreeze({
      evidenceVersion: LEGAL_ACCEPTANCE_EVIDENCE_VERSION,
      source: LEGAL_ACCEPTANCE_SOURCE,
      confirmed: true,
      requestId,
      acceptedAt,
      identityId,
      userAgentSha256,
      document: release,
    });
    return deepFreeze({
      id,
      identityId,
      documentKind: kind,
      documentVersion: release.version,
      documentPublishedOn: release.publishedOn,
      acceptedAt,
      evidence,
    });
  });

  const event = deepFreeze({
    id: generatedId(input.idFactory, "event"),
    identityId,
    requestId,
    action: "legal.acceptance.recorded",
    occurredAt: acceptedAt,
    payload: {
      acceptedVersions: Object.fromEntries(
        acceptances.map((acceptance) => [
          acceptance.documentKind,
          acceptance.documentVersion,
        ]),
      ),
      evidenceVersion: LEGAL_ACCEPTANCE_EVIDENCE_VERSION,
    },
  });
  return deepFreeze({ acceptances, event });
}

export function canonicalLegalEvidenceJson(value) {
  return JSON.stringify(portableClone(value, "evidence"));
}

function hasCurrentBoundEvidence(record, current, acceptedAt) {
  const evidence = record.evidence;
  if (!isPlainRecord(evidence) || !isPlainRecord(evidence.document)) return false;
  const userAgentSha256 = evidence.userAgentSha256;
  return (
    typeof record.identityId === "string"
    && record.identityId.length > 0
    && record.identityId === evidence.identityId
    && typeof record.requestId === "string"
    && record.requestId.length > 0
    && record.requestId === evidence.requestId
    && record.documentPublishedOn === current.publishedOn
    && evidence.evidenceVersion === LEGAL_ACCEPTANCE_EVIDENCE_VERSION
    && evidence.source === LEGAL_ACCEPTANCE_SOURCE
    && evidence.confirmed === true
    && evidence.acceptedAt === acceptedAt
    && (userAgentSha256 === null
      || (typeof userAgentSha256 === "string" && /^[a-f0-9]{64}$/u.test(userAgentSha256)))
    && evidence.document.kind === current.kind
    && evidence.document.version === current.version
    && evidence.document.publishedOn === current.publishedOn
    && evidence.document.route === current.route
    && evidence.document.contentSha256 === current.contentSha256
  );
}

function generatedId(factory, label) {
  const value = factory(label);
  return requiredToken(value, "INVALID_GENERATED_ID", 200);
}

function requiredDocumentKind(value) {
  if (!LEGAL_DOCUMENT_KINDS.includes(value)) {
    fail("INVALID_DOCUMENT_KIND", "El tipo de documento legal no es válido.");
  }
  return value;
}

function optionalSha256(value) {
  if (value === null) return null;
  return requiredSha256(value, "INVALID_USER_AGENT_HASH");
}

function requiredSha256(value, code) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(code, "La huella SHA-256 no es válida.");
  }
  return value;
}

function exactIsoTimestamp(value) {
  if (typeof value !== "string") {
    fail("INVALID_TIMESTAMP", "La fecha debe usar formato ISO.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("INVALID_TIMESTAMP", "La fecha debe usar formato ISO exacto.");
  }
  return value;
}

function requiredToken(value, code, maxLength) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
  ) {
    fail(code, "El identificador no es válido.");
  }
  return value;
}

function portableClone(value, path, ancestors = []) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_EVIDENCE", `${path} contiene un número no finito.`);
    return value;
  }
  if (typeof value !== "object" || ancestors.includes(value)) {
    fail("INVALID_EVIDENCE", `${path} no es JSON portable.`);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      portableClone(entry, `${path}[${index}]`, [...ancestors, value]));
  }
  assertPlainRecord(value, "INVALID_EVIDENCE", `${path} no es un objeto simple.`);
  const clone = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key.toLowerCase())) {
      fail("INVALID_EVIDENCE", `${path}.${key} no es una clave segura.`);
    }
    clone[key] = portableClone(value[key], `${path}.${key}`, [...ancestors, value]);
  }
  return clone;
}

function assertExactKeys(value, expected, code, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${label} no coincide con el contrato esperado.`);
  }
}

function assertPlainRecord(value, code, message) {
  if (!isPlainRecord(value)) fail(code, message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code, message) {
  throw new LegalAcceptanceError(code, message);
}
