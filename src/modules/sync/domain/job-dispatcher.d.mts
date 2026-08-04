export function dispatchScheduledCandidates<TCandidate, TClaim>(
  candidates: TCandidate[],
  callbacks: {
    claim(candidate: TCandidate): Promise<{ candidate: TCandidate; claim: TClaim } | null>;
    execute(candidate: TCandidate): Promise<void>;
    succeed(candidate: TCandidate, claim: TClaim): Promise<"completed" | "superseded">;
    fail(candidate: TCandidate, claim: TClaim, cause: unknown): Promise<"failed" | "superseded">;
  },
): Promise<{ claimed: number; completed: number; failures: number; superseded: number }>;
