import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import { getOriginalRetentionDashboard } from "@/src/modules/integraciones/cooprinsem/server/retention-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const fieldId = new URL(request.url).searchParams.get("fieldId")?.trim() ?? "";
  if (!fieldId) return Response.json({ error: "Falta el fundo que deseas evaluar." }, { status: 400 });
  const forbidden = requireContextField(access, fieldId);
  if (forbidden) return forbidden;
  const retention = await getOriginalRetentionDashboard({
    actorEmail: access.email,
    fieldId,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
    membershipId: access.membershipId,
  });
  if (!retention) return Response.json({ error: "El fundo seleccionado no existe." }, { status: 404 });
  return Response.json({ retention }, { headers: { "Cache-Control": "no-store" } });
}
