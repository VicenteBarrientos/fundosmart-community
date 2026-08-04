import type { CooprinsemImportErrorStatus } from "../domain/types";

export class IssueResolutionError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export function normalizeIssueResolution(input: unknown): {
  status: CooprinsemImportErrorStatus;
  resolutionNotes: string | null;
};
