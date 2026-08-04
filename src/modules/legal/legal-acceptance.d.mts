export type LegalDocumentKind = "privacy" | "terms";

export type LegalDocumentRelease = Readonly<{
  kind: LegalDocumentKind;
  version: string;
  publishedOn: string;
  route: string;
  contentSha256: string;
}>;

export type LegalAcceptanceRecord = Readonly<{
  identityId: string;
  requestId: string;
  documentKind: LegalDocumentKind;
  documentVersion: string;
  documentPublishedOn: string;
  documentContentSha256: string;
  evidenceVersion: number;
  evidence: LegalAcceptanceEvidence;
  acceptedAt: string;
}>;

export type LegalAcceptanceRequirement = LegalDocumentRelease & Readonly<{
  accepted: boolean;
  acceptedAt: string | null;
}>;

export type LegalAcceptanceStatus = Readonly<{
  complete: boolean;
  missingKinds: readonly LegalDocumentKind[];
  requirements: readonly LegalAcceptanceRequirement[];
}>;

export type LegalAcceptanceEvidence = Readonly<{
  evidenceVersion: number;
  source: "authenticated_web";
  confirmed: true;
  requestId: string;
  acceptedAt: string;
  identityId: string;
  userAgentSha256: string | null;
  document: LegalDocumentRelease;
}>;

export type LegalAcceptancePlan = Readonly<{
  acceptances: readonly Readonly<{
    id: string;
    identityId: string;
    documentKind: LegalDocumentKind;
    documentVersion: string;
    documentPublishedOn: string;
    acceptedAt: string;
    evidence: LegalAcceptanceEvidence;
  }>[];
  event: Readonly<{
    id: string;
    identityId: string;
    requestId: string;
    action: "legal.acceptance.recorded";
    occurredAt: string;
    payload: Readonly<{
      acceptedVersions: Readonly<Record<LegalDocumentKind, string>>;
      evidenceVersion: number;
    }>;
  }>;
}>;

export const LEGAL_DOCUMENT_KINDS: readonly LegalDocumentKind[];
export const LEGAL_ACCEPTANCE_SOURCE: "authenticated_web";
export const LEGAL_ACCEPTANCE_EVIDENCE_VERSION: 1;
export const CURRENT_LEGAL_DOCUMENT_RELEASES: Readonly<
  Record<LegalDocumentKind, LegalDocumentRelease>
>;

export class LegalAcceptanceError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function currentLegalDocumentRequirements(): readonly LegalDocumentRelease[];
export function evaluateLegalAcceptance(
  records: readonly LegalAcceptanceRecord[],
): LegalAcceptanceStatus;
export function createLegalAcceptancePlan(input: {
  acceptedAt: string;
  acceptedVersions: Readonly<Record<LegalDocumentKind, string>>;
  confirmed: true;
  idFactory: (label: string) => string;
  identityId: string;
  requestId: string;
  userAgentSha256: string | null;
}): LegalAcceptancePlan;
export function canonicalLegalEvidenceJson(value: unknown): string;
