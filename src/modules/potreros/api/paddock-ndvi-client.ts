import type {
  PaddockNdviListing,
  PaddockNdviRefresh,
  PaddockNdviRefreshRequest,
} from "../domain/paddock-ndvi";

export class PaddockNdviApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "PaddockNdviApiError";
  }
}

export async function fetchPaddockNdvi(fieldId: string): Promise<PaddockNdviListing> {
  const query = new URLSearchParams({ fundoId: fieldId });
  const response = await fetch(`/api/potreros/ndvi?${query}`, { cache: "no-store" });
  const payload = await responseJson<{ ndvi?: PaddockNdviListing; error?: string; code?: string }>(response);
  if (!response.ok || !payload.ndvi) throw apiError(response, payload, "No fue posible cargar el NDVI.");
  return payload.ndvi;
}

export async function refreshPaddockNdvi(request: PaddockNdviRefreshRequest): Promise<PaddockNdviRefresh> {
  const response = await fetch("/api/potreros/ndvi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await responseJson<{ ndvi?: PaddockNdviRefresh; error?: string; code?: string }>(response);
  if (!response.ok || !payload.ndvi) throw apiError(response, payload, "No fue posible actualizar el NDVI.");
  return payload.ndvi;
}

function apiError(
  response: Response,
  payload: { error?: string; code?: string },
  fallback: string,
): PaddockNdviApiError {
  return new PaddockNdviApiError(payload.error ?? fallback, response.status, payload.code);
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
