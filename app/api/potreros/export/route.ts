import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";
import {
  paddockExportHeaders,
  parsePaddockExportRequest,
  privateNoStoreHeaders,
  serializePaddocksToGeoJson,
  serializePaddocksToKml,
} from "@/src/modules/potreros/export/serialize";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return withPrivateExportHeaders(access);

    const parsed = parsePaddockExportRequest(request.url);
    if (!parsed.ok) return exportError(parsed.error, parsed.status);
    const forbidden = requireContextField(access, parsed.fundoId);
    if (forbidden) return withPrivateExportHeaders(forbidden);

    const [fundos, paddocks] = await Promise.all([
      listFundos(access),
      listPotreros(access, parsed.fundoId),
    ]);
    const fundo = fundos.find(({ id }) => id === parsed.fundoId);
    if (!fundo) return exportError("El fundo no existe o no está disponible.", 404);

    const body = parsed.format === "geojson"
      ? serializePaddocksToGeoJson(fundo.name, paddocks)
      : serializePaddocksToKml(fundo.name, paddocks);
    const currentAccess = await reauthorizeApiAccess(access, "view", parsed.fundoId);
    if (isAccessResponse(currentAccess)) return withPrivateExportHeaders(currentAccess);
    return new Response(body, { headers: paddockExportHeaders(fundo.name, parsed.format) });
  } catch {
    return exportError("No fue posible exportar los potreros.", 500);
  }
}

function exportError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status, headers: privateNoStoreHeaders() });
}

function withPrivateExportHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
