import type { CooprinsemProjectionIdentifier, ImportRecord } from "../domain/types";

export class ProjectionRuleError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export const COOPRINSEM_QUARANTINE_LOT_NAME: string;

export function buildProjectionCandidate(record: ImportRecord, context?: { effectiveAt?: string | null }): {
  identifiers: CooprinsemProjectionIdentifier[];
  canonicalTag: string | null;
  sourceKey: string | null;
  fieldCode: string | null;
  normalizedFieldCode: string | null;
  groupCode: string | null;
  normalizedGroupCode: string | null;
  effectiveAt: string | null;
  issues: string[];
};

export function normalizeExternalIdentifier(value: unknown): string;
export function deterministicProjectionId(prefix: string, parts: unknown[]): string;
export function projectionQuarantineLotId(fieldId: string): string;
export function projectionIdentityKey(identifier: Pick<CooprinsemProjectionIdentifier, "kind" | "normalizedValue">): string;
export function resolveProjectionMatches(
  identifiers: CooprinsemProjectionIdentifier[],
  existingByIdentity: Map<string, Set<string> | string[]>,
  proposedByIdentity?: Map<string, string>,
): { animalIds: string[]; identityKeys: string[]; matchedBy: string[] };
