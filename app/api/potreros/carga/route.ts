import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { getFieldStockingLoad } from "@/src/modules/potreros/server/paddock-stocking-load-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;
    const fieldId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const load = await getFieldStockingLoad(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ load });
  } catch {
    return privateJson({ error: "No fue posible calcular la carga animal." }, 500);
  }
}

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
