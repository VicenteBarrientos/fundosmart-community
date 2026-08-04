import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import {
  MAX_WORKER_PREVIEW_FILE_BYTES,
  MAX_WORKER_PREVIEW_REQUEST_BYTES,
} from "@/src/modules/potreros/import/limits";
import { previewGisImport } from "@/src/modules/potreros/import/parser";
import { GisImportError } from "@/src/modules/potreros/import/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("manage_imports");
    if (isAccessResponse(access)) return withImportHeaders(access);

    const declaredSize = parseContentLength(request.headers.get("Content-Length"));
    if (declaredSize === "invalid") return importError("Content-Length no es válido.", 400, "INVALID_CONTENT_LENGTH");
    if (declaredSize !== null && declaredSize > MAX_WORKER_PREVIEW_REQUEST_BYTES) {
      return importError("La solicitud supera 2 MiB.", 413, "REQUEST_SIZE_LIMIT");
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data")) {
      return importError("Envía un formulario multipart con fieldId y file.", 400, "MULTIPART_REQUIRED");
    }

    // The outer Worker guard caps undeclared/chunked API bodies at 2 MiB before
    // vinext reaches this route, so formData() never buffers an unbounded body.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return importError("La solicitud no contiene un formulario de archivo válido.", 400, "INVALID_MULTIPART");
    }
    const fieldId = textValue(formData.get("fieldId"));
    if (!fieldId) return importError("Selecciona el fundo de destino.", 400, "FIELD_REQUIRED");
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return withImportHeaders(forbidden);

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return importError("Selecciona un archivo GeoJSON, KML, KMZ o ZIP Shapefile.", 400, "FILE_REQUIRED");
    }
    if (file.size <= 0 || file.size > MAX_WORKER_PREVIEW_FILE_BYTES) {
      return importError(
        `El archivo debe tener contenido y no superar ${MAX_WORKER_PREVIEW_FILE_BYTES} bytes.`,
        413,
        "COMPRESSED_SIZE_LIMIT",
      );
    }

    const preview = await previewGisImport({
      bytes: await file.arrayBuffer(),
      fileName: file.name,
      contentType: file.type || null,
      fieldId,
    });
    return Response.json({ preview }, { headers: privateImportHeaders() });
  } catch (cause) {
    if (cause instanceof GisImportError) return importError(cause.message, cause.status, cause.code);
    return importError("No fue posible analizar el archivo GIS.", 500, "GIS_PREVIEW_FAILED");
  }
}

function parseContentLength(value: string | null): number | null | "invalid" {
  if (value === null) return null;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return "invalid";
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function textValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function importError(error: string, status: number, code: string): Response {
  return Response.json({ error, code }, { status, headers: privateImportHeaders() });
}

function privateImportHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function withImportHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
