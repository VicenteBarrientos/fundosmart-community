import type {
  PaddockOperationCommitRequest,
  PaddockOperationPlanRequest,
  PaddockOperationPreview,
  PaddockOperationResult,
} from "../types";

export class PaddockOperationApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "PaddockOperationApiError";
  }
}

export async function fetchPaddockOperationPreview(
  request: PaddockOperationPlanRequest,
): Promise<PaddockOperationPreview> {
  const response = await fetch("/api/potreros/operaciones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ preview?: PaddockOperationPreview; error?: string; code?: string }>(response);
  if (!response.ok || !payload.preview) throw new PaddockOperationApiError(payload.error ?? "No fue posible preparar la operación.", response.status, payload.code);
  return payload.preview;
}

export async function confirmPaddockOperation(
  request: PaddockOperationCommitRequest,
): Promise<PaddockOperationResult> {
  const response = await fetch("/api/potreros/operaciones", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ result?: PaddockOperationResult; error?: string; code?: string }>(response);
  if (!response.ok || !payload.result) throw new PaddockOperationApiError(payload.error ?? "No fue posible confirmar la operación.", response.status, payload.code);
  return payload.result;
}

export async function fetchPaddockOperationResult(operationId: string): Promise<PaddockOperationResult> {
  const response = await fetch(`/api/potreros/operaciones?operationId=${encodeURIComponent(operationId)}`, { cache: "no-store" });
  const payload = await responseJson<{ result?: PaddockOperationResult; error?: string; code?: string }>(response);
  if (!response.ok || !payload.result) throw new PaddockOperationApiError(payload.error ?? "No fue posible recuperar la operación.", response.status, payload.code);
  return payload.result;
}

export function paddockUndoPlan(fieldId: string, sourceOperationId: string): PaddockOperationPlanRequest {
  return { fieldId, kind: "undo", parentPaddockIds: [], proposedPaddocks: [], sourceOperationId };
}

export async function fetchPaddockUndoPreview(fieldId: string, sourceOperationId: string) {
  return fetchPaddockOperationPreview(paddockUndoPlan(fieldId, sourceOperationId));
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
