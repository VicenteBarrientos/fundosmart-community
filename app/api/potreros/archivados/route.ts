import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { listArchivedPotreros } from "@/src/modules/potreros/server/potrero-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const fieldId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const potreros = await listArchivedPotreros(access, fieldId);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ potreros });
  } catch {
    return privateJson({ error: "No fue posible cargar los potreros archivados." }, 500);
  }
}

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
