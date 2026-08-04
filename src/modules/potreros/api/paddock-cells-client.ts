import type {
  FieldActivePaddockCellListing,
  PaddockCellCloseRequest,
  PaddockCellGenerationCommitRequest,
  PaddockCellGenerationPlanRequest,
  PaddockCellGenerationPreview,
  PaddockCellListing,
  PaddockCellOperationResult,
} from "../domain/cells-rotation";

export class PaddockCellApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "PaddockCellApiError";
  }
}

export async function fetchPaddockCellPreview(
  request: PaddockCellGenerationPlanRequest,
): Promise<PaddockCellGenerationPreview> {
  const response = await fetch("/api/potreros/celdas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ preview?: PaddockCellGenerationPreview; error?: string; code?: string }>(response);
  if (!response.ok || !payload.preview) throw apiError(response, payload, "No fue posible preparar las franjas.");
  return payload.preview;
}

export async function confirmPaddockCellGeneration(
  request: PaddockCellGenerationCommitRequest,
): Promise<PaddockCellOperationResult> {
  const response = await fetch("/api/potreros/celdas", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ result?: PaddockCellOperationResult; error?: string; code?: string }>(response);
  if (!response.ok || !payload.result) throw apiError(response, payload, "No fue posible confirmar las franjas.");
  return payload.result;
}

export async function fetchPaddockCells(fieldId: string, paddockId: string): Promise<PaddockCellListing> {
  const query = new URLSearchParams({ fundoId: fieldId, potreroId: paddockId });
  const response = await fetch(`/api/potreros/celdas?${query}`, { cache: "no-store" });
  const payload = await responseJson<{ cells?: PaddockCellListing; error?: string; code?: string }>(response);
  if (!response.ok || !payload.cells) throw apiError(response, payload, "No fue posible cargar las celdas.");
  return payload.cells;
}

export async function fetchFieldActivePaddockCells(fieldId: string): Promise<FieldActivePaddockCellListing> {
  const query = new URLSearchParams({ fundoId: fieldId });
  const response = await fetch(`/api/potreros/celdas?${query}`, { cache: "no-store" });
  const payload = await responseJson<{ cells?: FieldActivePaddockCellListing; error?: string; code?: string }>(response);
  if (!response.ok || !payload.cells) throw apiError(response, payload, "No fue posible cargar las franjas del fundo.");
  return payload.cells;
}

export async function closeActivePaddockCells(
  request: PaddockCellCloseRequest,
): Promise<PaddockCellOperationResult> {
  const response = await fetch("/api/potreros/celdas", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ result?: PaddockCellOperationResult; error?: string; code?: string }>(response);
  if (!response.ok || !payload.result) throw apiError(response, payload, "No fue posible cerrar las celdas.");
  return payload.result;
}

function apiError(
  response: Response,
  payload: { error?: string; code?: string },
  fallback: string,
): PaddockCellApiError {
  return new PaddockCellApiError(payload.error ?? fallback, response.status, payload.code);
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
