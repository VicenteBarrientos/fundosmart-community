import { authorizeApiAccess, isAccessResponse, requireContextField, requireResourceField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  deepVerifyImportOriginal,
  OriginalDeepVerificationLimitError,
  OriginalIntegrityScopeError,
  verifyImportOriginals,
} from "@/src/modules/integraciones/cooprinsem/server/original-integrity-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const fieldId = new URL(request.url).searchParams.get("fieldId")?.trim() ?? "";
  if (!fieldId) return Response.json({ error: "Falta el fundo que deseas verificar." }, { status: 400 });
  const forbidden = requireContextField(access, fieldId);
  if (forbidden) return forbidden;
  const repositoryAccess = { membershipId: access.membershipId, organizationId: access.organizationId, fieldIds: access.fieldIds };
  try {
    const integrity = await verifyImportOriginals({ fieldId, actor: access.email, ...repositoryAccess });
    if (!integrity) return Response.json({ error: "El fundo seleccionado no existe." }, { status: 404 });
    return Response.json({ integrity }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof OriginalIntegrityScopeError) {
      return Response.json({ error: cause.message }, { status: 409 });
    }
    return Response.json({ error: "No fue posible consultar el almacenamiento privado R2." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const body = await readJsonObject<{ importJobId?: unknown }>(request);
  if (body instanceof Response) return body;
  const importJobId = typeof body.importJobId === "string" ? body.importJobId.trim() : "";
  if (!importJobId) return Response.json({ error: "Falta la importación que deseas verificar." }, { status: 400 });
  const forbidden = await requireResourceField(access, "import_job", importJobId);
  if (forbidden) return forbidden;
  const repositoryAccess = { membershipId: access.membershipId, organizationId: access.organizationId, fieldIds: access.fieldIds };
  try {
    const verification = await deepVerifyImportOriginal({ importJobId, actor: access.email, ...repositoryAccess });
    if (!verification) return Response.json({ error: "La importación no existe." }, { status: 404 });
    return Response.json({ verification }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof OriginalDeepVerificationLimitError) {
      return Response.json({ error: cause.message }, { status: 413 });
    }
    if (cause instanceof OriginalIntegrityScopeError) {
      return Response.json({ error: cause.message }, { status: 409 });
    }
    return Response.json({ error: "No fue posible releer el original desde el almacenamiento privado R2." }, { status: 503 });
  }
}
