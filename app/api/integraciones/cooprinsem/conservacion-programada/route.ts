import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  getOriginalIntegritySweepDashboard,
  IntegritySweepScopeError,
  runOriginalIntegritySweepBatch,
} from "@/src/modules/integraciones/cooprinsem/server/integrity-sweep-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const fieldId = new URL(request.url).searchParams.get("fieldId")?.trim() ?? "";
  if (!fieldId) return Response.json({ error: "Falta el fundo que deseas consultar." }, { status: 400 });
  const forbidden = requireContextField(access, fieldId);
  if (forbidden) return forbidden;
  const repositoryAccess = {
    actorEmail: access.email,
    fieldIds: access.fieldIds,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
  };
  const sweep = await getOriginalIntegritySweepDashboard({ fieldId, ...repositoryAccess });
  if (!sweep) return Response.json({ error: "El fundo seleccionado no existe." }, { status: 404 });
  return Response.json({ sweep }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const body = await readJsonObject<{ action?: unknown; fieldId?: unknown }>(request);
  if (body instanceof Response) return body;
  const fieldId = typeof body.fieldId === "string" ? body.fieldId.trim() : "";
  if (body.action !== "run_next_batch" || !fieldId) {
    return Response.json({ error: "Indica action=run_next_batch y un fundo válido." }, { status: 400 });
  }
  const forbidden = requireContextField(access, fieldId);
  if (forbidden) return forbidden;
  const repositoryAccess = {
    actorEmail: access.email,
    fieldIds: access.fieldIds,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
  };
  try {
    const result = await runOriginalIntegritySweepBatch({
      fieldId,
      trigger: "manual",
      actor: access.email,
      force: true,
      access: repositoryAccess,
    });
    const sweep = await getOriginalIntegritySweepDashboard({ fieldId, ...repositoryAccess });
    return Response.json({ result, sweep }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof IntegritySweepScopeError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    return Response.json({
      error: "El lote se interrumpió y quedó preparado para reintento.",
    }, { status: 503 });
  }
}
