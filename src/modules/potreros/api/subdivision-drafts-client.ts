import type { Coordinate, ScopedSubdivisionDraft, SubdivisionDraft, SubdivisionScopeKind } from "../types";

export class SubdivisionDraftApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "SubdivisionDraftApiError";
  }
}

export async function fetchSubdivisionDraft(fieldId: string): Promise<SubdivisionDraft | null> {
  const response = await fetch(`/api/subdivisiones?fundoId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("No fue posible recuperar el borrador.");
  const payload = (await response.json()) as { draft: SubdivisionDraft | null };
  return payload.draft;
}

export async function persistSubdivisionDraft(fieldId: string, history: Coordinate[][][], line: Coordinate[]): Promise<SubdivisionDraft> {
  const response = await fetch("/api/subdivisiones", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fieldId, history, line }),
  });
  if (!response.ok) throw new Error("No fue posible guardar el borrador.");
  const payload = (await response.json()) as { draft: SubdivisionDraft };
  return payload.draft;
}

export async function removeSubdivisionDraft(fieldId: string): Promise<void> {
  const response = await fetch(`/api/subdivisiones?fundoId=${encodeURIComponent(fieldId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("No fue posible eliminar el borrador.");
}

export async function fetchScopedSubdivisionDraft(
  fieldId: string,
  scopeKind: SubdivisionScopeKind,
  scopeId: string,
): Promise<{ draft: ScopedSubdivisionDraft | null; baseSnapshotToken: string }> {
  const query = new URLSearchParams({ fundoId: fieldId, scopeKind, scopeId });
  const response = await fetch(`/api/subdivisiones?${query.toString()}`, { cache: "no-store" });
  const payload = (await response.json()) as { draft?: ScopedSubdivisionDraft | null; baseSnapshotToken?: string; error?: string };
  if (!response.ok || !payload.baseSnapshotToken) throw new SubdivisionDraftApiError(payload.error ?? "No fue posible recuperar el borrador.", response.status);
  return { draft: payload.draft ?? null, baseSnapshotToken: payload.baseSnapshotToken };
}

export async function persistScopedSubdivisionDraft(
  draft: ScopedSubdivisionDraft,
  expectedUpdatedAt: string | null = draft.updatedAt || null,
): Promise<ScopedSubdivisionDraft> {
  const response = await fetch("/api/subdivisiones", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...draft, expectedUpdatedAt }),
  });
  const payload = (await response.json()) as { draft?: ScopedSubdivisionDraft; error?: string; code?: string };
  if (!response.ok || !payload.draft) throw new SubdivisionDraftApiError(payload.error ?? "No fue posible guardar el borrador.", response.status, payload.code);
  return payload.draft;
}

export async function removeScopedSubdivisionDraft(
  fieldId: string,
  scopeKind: SubdivisionScopeKind,
  scopeId: string,
  expectedUpdatedAt: string,
): Promise<void> {
  const query = new URLSearchParams({ fundoId: fieldId, scopeKind, scopeId, updatedAt: expectedUpdatedAt });
  const response = await fetch(`/api/subdivisiones?${query.toString()}`, { method: "DELETE" });
  const payload = (await response.json()) as { error?: string; code?: string };
  if (!response.ok) throw new SubdivisionDraftApiError(payload.error ?? "No fue posible eliminar el borrador.", response.status, payload.code);
}
