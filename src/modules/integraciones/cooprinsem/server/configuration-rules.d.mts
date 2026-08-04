import type {
  CooprinsemGenealogyResolutionRow,
  CooprinsemGenealogyResolutionStatus,
} from "../domain/types";

export function normalizeCooprinsemGroupCode(value: unknown): string;

export function resolveGenealogyCandidate(input: {
  damAnimalId: string;
  occurredAt: string;
  sex: "female" | "male" | "unknown";
  matches: Array<{
    animalId: string;
    tag: string;
    sex: "female" | "male" | "unknown";
    birthDate: string | null;
    matchedBy: string[];
  }>;
}): {
  status: CooprinsemGenealogyResolutionStatus;
  candidateAnimalId: string | null;
  candidateTag: string | null;
  matchedBy: string[];
  issues: string[];
};

export function markDuplicateGenealogyCandidates(rows: CooprinsemGenealogyResolutionRow[]): CooprinsemGenealogyResolutionRow[];
export function buildConfirmationToken(namespace: string, payload: unknown): Promise<string>;
