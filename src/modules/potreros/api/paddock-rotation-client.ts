import type {
  PaddockRotationSettingsOperationResult,
  PaddockRotationSettingsUpdateRequest,
  PaddockRotationSnapshot,
} from "../domain/cells-rotation";

export class PaddockRotationApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "PaddockRotationApiError";
  }
}

export async function fetchPaddockRotation(
  fieldId: string,
  referenceDate?: string,
): Promise<PaddockRotationSnapshot> {
  const query = new URLSearchParams({ fundoId: fieldId });
  if (referenceDate) query.set("fecha", referenceDate);
  const response = await fetch(`/api/potreros/rotacion?${query}`, { cache: "no-store" });
  const payload = await responseJson<{ rotation?: PaddockRotationSnapshot; error?: string; code?: string }>(response);
  if (!response.ok || !payload.rotation) throw apiError(response, payload, "No fue posible calcular la rotación.");
  return payload.rotation;
}

export async function savePaddockRotationSettings(
  request: PaddockRotationSettingsUpdateRequest,
): Promise<PaddockRotationSettingsOperationResult> {
  const response = await fetch("/api/potreros/rotacion", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ result?: PaddockRotationSettingsOperationResult; error?: string; code?: string }>(response);
  if (!response.ok || !payload.result) throw apiError(response, payload, "No fue posible guardar los umbrales.");
  return payload.result;
}

function apiError(
  response: Response,
  payload: { error?: string; code?: string },
  fallback: string,
): PaddockRotationApiError {
  return new PaddockRotationApiError(payload.error ?? fallback, response.status, payload.code);
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
