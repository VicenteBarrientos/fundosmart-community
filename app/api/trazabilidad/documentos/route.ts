import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  getTraceabilityDocument,
  TraceabilityRequestError,
} from "@/src/modules/trazabilidad/server/traceability-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const fieldId = params.get("fieldId")?.trim() || "";
    const documentId = params.get("documentId")?.trim() || "";
    const kind = params.get("kind") === "dea" ? "dea" : params.get("kind") === "fma" ? "fma" : null;
    if (!fieldId || !documentId || !kind) return privateJson({ error: "La referencia del documento no es válida." }, 400);
    const access = await authorizeApiAccess("trazabilidad:read", fieldId);
    if (isAccessResponse(access)) return access;
    const document = await getTraceabilityDocument(access, { fieldId, documentId, kind });
    return new Response(document.bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.filename.replace(/[^A-Za-z0-9._-]/gu, "-")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (cause) {
    if (cause instanceof TraceabilityRequestError) return privateJson({ error: cause.message, code: cause.code }, cause.status);
    return unexpectedApiFailure("trazabilidad.document.download", "No fue posible descargar el documento privado.", cause);
  }
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
