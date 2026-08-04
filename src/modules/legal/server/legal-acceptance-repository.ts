import {
  CURRENT_LEGAL_DOCUMENT_RELEASES,
  canonicalLegalEvidenceJson,
  createLegalAcceptancePlan,
  evaluateLegalAcceptance,
  type LegalAcceptanceEvidence,
  type LegalAcceptanceStatus,
} from "@/src/modules/legal/legal-acceptance.mjs";

type LegalAcceptanceRow = {
  id: string;
  identityId: string;
  documentKind: "privacy" | "terms";
  documentVersion: string;
  documentPublishedOn: string;
  documentContentSha256: string;
  acceptedAt: string;
  evidenceVersion: number;
  evidenceJson: string;
  requestId: string;
};

export type LegalAcceptanceReceipt = Readonly<{
  id: string;
  identityId: string;
  documentKind: "privacy" | "terms";
  documentVersion: string;
  documentPublishedOn: string;
  documentContentSha256: string;
  acceptedAt: string;
  evidenceVersion: number;
  evidence: LegalAcceptanceEvidence;
  requestId: string;
}>;

export class LegalAcceptancePersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegalAcceptancePersistenceError";
    this.code = code;
  }
}

export function isLegalAcceptanceExemptSubject(subject: string): boolean {
  return subject === "demo" || subject.startsWith("dev:");
}

/* Las columnas que basta leer para decidir si la aceptación está vigente. La
   sesión las trae en su mismo viaje (ver `findSessionUserWithLegalAcceptances`),
   así que el veredicto se arma desde filas ya leídas o desde esta consulta. */
export type LegalAcceptanceStatusRow = {
  documentKind: "privacy" | "terms";
  documentVersion: string;
  documentContentSha256: string;
  evidenceVersion: number;
  evidenceJson: string;
  documentPublishedOn: string;
  requestId: string;
  acceptedAt: string;
};

export function legalAcceptanceStatusFromRows(
  identityId: string,
  rows: readonly LegalAcceptanceStatusRow[],
): LegalAcceptanceStatus {
  if (isLegalAcceptanceExemptSubject(identityId)) {
    const requirements = Object.values(CURRENT_LEGAL_DOCUMENT_RELEASES).map((release) => ({
      ...release,
      accepted: true as const,
      acceptedAt: null,
    }));
    return Object.freeze({
      complete: true,
      missingKinds: Object.freeze([]),
      requirements: Object.freeze(requirements),
    });
  }
  return evaluateLegalAcceptance(rows.map((row) => ({
    ...row,
    identityId,
    evidence: parseEvidence(row.evidenceJson),
  })));
}

export async function getLegalAcceptanceStatus(
  database: D1Database,
  identityId: string,
): Promise<LegalAcceptanceStatus> {
  if (isLegalAcceptanceExemptSubject(identityId)) {
    return legalAcceptanceStatusFromRows(identityId, []);
  }
  const rows = await database.withSession("first-primary").prepare(`
    SELECT
      document_kind AS documentKind,
      document_version AS documentVersion,
      document_published_on AS documentPublishedOn,
      document_content_sha256 AS documentContentSha256,
      evidence_version AS evidenceVersion,
      evidence_json AS evidenceJson,
      request_id AS requestId,
      accepted_at AS acceptedAt
    FROM legal_acceptances
    WHERE identity_id = ?
    ORDER BY accepted_at, id
  `).bind(identityId).all<LegalAcceptanceStatusRow>();
  return legalAcceptanceStatusFromRows(identityId, rows.results ?? []);
}

export async function listLegalAcceptanceReceipts(
  database: D1Database,
  identityId: string,
): Promise<readonly LegalAcceptanceReceipt[]> {
  if (isLegalAcceptanceExemptSubject(identityId)) return Object.freeze([]);
  const rows = await database.withSession("first-primary").prepare(`
    SELECT
      id,
      identity_id AS identityId,
      document_kind AS documentKind,
      document_version AS documentVersion,
      document_published_on AS documentPublishedOn,
      document_content_sha256 AS documentContentSha256,
      accepted_at AS acceptedAt,
      evidence_version AS evidenceVersion,
      evidence_json AS evidenceJson,
      request_id AS requestId
    FROM legal_acceptances
    WHERE identity_id = ?
    ORDER BY accepted_at, document_kind, id
  `).bind(identityId).all<LegalAcceptanceRow>();
  return Object.freeze((rows.results ?? []).map((row) => Object.freeze({
    id: row.id,
    identityId: row.identityId,
    documentKind: row.documentKind,
    documentVersion: row.documentVersion,
    documentPublishedOn: row.documentPublishedOn,
    documentContentSha256: row.documentContentSha256,
    acceptedAt: row.acceptedAt,
    evidenceVersion: Number(row.evidenceVersion),
    evidence: parseEvidence(row.evidenceJson),
    requestId: row.requestId,
  })));
}

export async function recordCurrentLegalAcceptance(
  database: D1Database,
  input: {
    identityId: string;
    requestId: string;
    acceptedAt: string;
    acceptedVersions: Readonly<{ privacy: string; terms: string }>;
    confirmed: true;
    userAgentSha256: string | null;
    idFactory?: (label: string) => string;
    beforeCommit?: () => Promise<void>;
  },
): Promise<LegalAcceptanceStatus> {
  if (isLegalAcceptanceExemptSubject(input.identityId)) {
    return getLegalAcceptanceStatus(database, input.identityId);
  }
  const existing = await getLegalAcceptanceStatus(database, input.identityId);
  if (existing.complete) return existing;
  const plan = createLegalAcceptancePlan({
    identityId: input.identityId,
    requestId: input.requestId,
    acceptedAt: input.acceptedAt,
    acceptedVersions: input.acceptedVersions,
    confirmed: input.confirmed,
    userAgentSha256: input.userAgentSha256,
    idFactory: input.idFactory ?? (() => crypto.randomUUID()),
  });
  const session = database.withSession("first-primary");
  const statements = plan.acceptances.map((acceptance) => session.prepare(`
    INSERT INTO legal_acceptances (
      id,
      identity_id,
      document_kind,
      document_version,
      document_published_on,
      document_content_sha256,
      accepted_at,
      evidence_version,
      evidence_json,
      request_id
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM auth_identities WHERE id = ?
    )
    ON CONFLICT(identity_id, document_kind, document_version) DO NOTHING
  `).bind(
    acceptance.id,
    acceptance.identityId,
    acceptance.documentKind,
    acceptance.documentVersion,
    acceptance.documentPublishedOn,
    acceptance.evidence.document.contentSha256,
    acceptance.acceptedAt,
    acceptance.evidence.evidenceVersion,
    canonicalLegalEvidenceJson(acceptance.evidence),
    input.requestId,
    acceptance.identityId,
  ));
  statements.push(
    session.prepare(`
      INSERT INTO personal_data_events (
        id,
        identity_id,
        organization_id,
        request_id,
        event_type,
        entity_type,
        entity_id,
        payload_json,
        occurred_at
      )
      SELECT ?, ?, NULL, ?, ?, 'legal_acceptance', ?, ?, ?
      WHERE (
        SELECT COUNT(*)
        FROM legal_acceptances
        WHERE identity_id = ?
          AND (
            (document_kind = 'privacy' AND document_version = ?)
            OR (document_kind = 'terms' AND document_version = ?)
          )
      ) = 2
        AND EXISTS (
          SELECT 1
          FROM legal_acceptances
          WHERE identity_id = ?
            AND request_id = ?
            AND (
              (document_kind = 'privacy' AND document_version = ?)
              OR (document_kind = 'terms' AND document_version = ?)
            )
        )
      ON CONFLICT(identity_id, request_id, event_type) DO NOTHING
    `).bind(
      plan.event.id,
      plan.event.identityId,
      plan.event.requestId,
      plan.event.action,
      plan.event.identityId,
      canonicalLegalEvidenceJson(plan.event.payload),
      plan.event.occurredAt,
      plan.event.identityId,
      CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
      CURRENT_LEGAL_DOCUMENT_RELEASES.terms.version,
      plan.event.identityId,
      plan.event.requestId,
      CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
      CURRENT_LEGAL_DOCUMENT_RELEASES.terms.version,
    ),
    session.prepare(`
      SELECT CASE WHEN
        (
          SELECT COUNT(*)
          FROM legal_acceptances
          WHERE identity_id = ?1
            AND (
              (
                document_kind = 'privacy'
                AND document_version = ?2
                AND document_content_sha256 = ?3
                AND evidence_version = 1
                AND json_extract(evidence_json, '$.confirmed') = 1
                AND json_extract(evidence_json, '$.document.contentSha256') = ?3
              )
              OR (
                document_kind = 'terms'
                AND document_version = ?4
                AND document_content_sha256 = ?5
                AND evidence_version = 1
                AND json_extract(evidence_json, '$.confirmed') = 1
                AND json_extract(evidence_json, '$.document.contentSha256') = ?5
              )
            )
        ) = 2
        AND EXISTS (
          SELECT 1
          FROM personal_data_events
          WHERE identity_id = ?1
            AND request_id = ?6
            AND event_type = 'legal.acceptance.recorded'
            AND entity_type = 'legal_acceptance'
            AND entity_id = ?1
            AND id = ?7
            AND payload_json = ?8
            AND occurred_at = ?9
        )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
      ?1 AS identityId
    `).bind(
      plan.event.identityId,
      CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
      CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.contentSha256,
      CURRENT_LEGAL_DOCUMENT_RELEASES.terms.version,
      CURRENT_LEGAL_DOCUMENT_RELEASES.terms.contentSha256,
      plan.event.requestId,
      plan.event.id,
      canonicalLegalEvidenceJson(plan.event.payload),
      plan.event.occurredAt,
    ),
  );

  let results: D1Result<Record<string, unknown>>[];
  if (input.beforeCommit) await input.beforeCommit();
  try {
    results = await session.batch<Record<string, unknown>>(statements);
  } catch (cause) {
    throw new LegalAcceptancePersistenceError(
      "LEGAL_ACCEPTANCE_NOT_RECORDED",
      "No fue posible registrar la aceptación legal.",
      { cause },
    );
  }
  const sentinel = results.at(-1)?.results?.[0];
  if (
    Number(sentinel?.complete) !== 1
    || sentinel?.identityId !== input.identityId
  ) {
    throw new LegalAcceptancePersistenceError(
      "LEGAL_ACCEPTANCE_NOT_RECORDED",
      "No fue posible confirmar la aceptación legal.",
    );
  }
  return getLegalAcceptanceStatus(database, input.identityId);
}

function parseEvidence(value: string): LegalAcceptanceEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new LegalAcceptancePersistenceError(
      "LEGAL_ACCEPTANCE_EVIDENCE_INVALID",
      "La evidencia legal persistida no es válida.",
      { cause },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LegalAcceptancePersistenceError(
      "LEGAL_ACCEPTANCE_EVIDENCE_INVALID",
      "La evidencia legal persistida no es válida.",
    );
  }
  return Object.freeze(parsed as LegalAcceptanceEvidence);
}
