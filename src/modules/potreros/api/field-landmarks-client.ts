import type {
  FieldLandmarkDeleteRequest,
  FieldLandmarkListing,
  FieldLandmarkOperationRequest,
  FieldLandmarkOperationResult,
  FieldLandmarkUpsertRequest,
} from "../domain/field-landmarks";

export class FieldLandmarkApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "FieldLandmarkApiError";
  }
}

export function fieldLandmarkOutboxKey(request: FieldLandmarkOperationRequest): string {
  return `field-landmark:${request.operationId}`;
}

export async function fetchFieldLandmarks(fieldId: string): Promise<FieldLandmarkListing> {
  const query = new URLSearchParams({ fundoId: fieldId });
  const response = await fetch(`/api/potreros/hitos?${query}`, { cache: "no-store" });
  const payload = await responseJson<{ landmarks?: FieldLandmarkListing; error?: string; code?: string }>(response);
  if (!response.ok || !payload.landmarks) {
    throw apiError(response, payload, "No fue posible cargar los hitos del fundo.");
  }
  return payload.landmarks;
}

export async function saveFieldLandmark(
  request: FieldLandmarkUpsertRequest,
): Promise<FieldLandmarkOperationResult> {
  return mutateFieldLandmark("PUT", request, "No fue posible guardar el hito.");
}

export async function deleteFieldLandmark(
  request: FieldLandmarkDeleteRequest,
): Promise<FieldLandmarkOperationResult> {
  return mutateFieldLandmark("DELETE", request, "No fue posible archivar el hito.");
}

async function mutateFieldLandmark(
  method: "PUT" | "DELETE",
  request: FieldLandmarkOperationRequest,
  fallback: string,
): Promise<FieldLandmarkOperationResult> {
  const response = await fetch("/api/potreros/hitos", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ result?: FieldLandmarkOperationResult; error?: string; code?: string }>(response);
  if (!response.ok || !payload.result) throw apiError(response, payload, fallback);
  return payload.result;
}

function apiError(
  response: Response,
  payload: { error?: string; code?: string },
  fallback: string,
): FieldLandmarkApiError {
  return new FieldLandmarkApiError(payload.error ?? fallback, response.status, payload.code);
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
