import { authorizeApiAccess, isAccessResponse, requireResourceField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  getImportDashboard,
  getImportPreview,
  ImportAccessChangedError,
} from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import {
  confirmImportProjection,
  getImportProjection,
  ImportProjectionError,
} from "@/src/modules/integraciones/cooprinsem/server/projection-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const importAccess = {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return Response.json({ error: "Falta la importación que deseas simular." }, { status: 400 });
  const forbidden = await requireResourceField(access, "import_job", id);
  if (forbidden) return forbidden;
  try {
    const projection = await getImportProjection(id, importAccess);
    if (!projection) return Response.json({ error: "La importación no existe o no está disponible para este usuario." }, { status: 404 });
    return Response.json({ projection }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) return accessChanged(cause);
    throw cause;
  }
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const importAccess = {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
  const payload = await readJsonObject<{ importJobId?: unknown; confirmation?: unknown }>(request);
  if (payload instanceof Response) return payload;
  const importJobId = typeof payload.importJobId === "string" ? payload.importJobId.trim() : "";
  const confirmation = typeof payload.confirmation === "string" ? payload.confirmation.trim() : "";
  if (!importJobId) return Response.json({ error: "Falta la importación que deseas confirmar." }, { status: 400 });
  const forbidden = await requireResourceField(access, "import_job", importJobId);
  if (forbidden) return forbidden;
  try {
    const result = await confirmImportProjection({
      importJobId,
      membershipId: importAccess.membershipId,
      organizationId: importAccess.organizationId,
      fieldIds: importAccess.fieldIds,
      email: importAccess.email,
      confirmation,
    });
    const [dashboard, preview, projection] = await Promise.all([
      getImportDashboard(importAccess),
      getImportPreview(importJobId, importAccess),
      getImportProjection(importJobId, importAccess),
    ]);
    return Response.json({ result, dashboard, preview, projection });
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) return accessChanged(cause);
    if (cause instanceof ImportProjectionError) return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
    return unexpectedApiFailure(
      "cooprinsem.projection.confirm",
      "No fue posible confirmar la integración.",
      cause,
    );
  }
}

function accessChanged(cause: ImportAccessChangedError): Response {
  return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
}
