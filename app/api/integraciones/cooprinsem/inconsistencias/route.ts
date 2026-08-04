import { authorizeApiAccess, isAccessResponse, requireResourceField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  getImportDashboard,
  ImportAccessChangedError,
  setImportIssueResolution,
} from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import {
  IssueResolutionError,
  normalizeIssueResolution,
} from "@/src/modules/integraciones/cooprinsem/server/issue-resolution.mjs";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const importAccess = {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };

  const payload = await readJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;

  const id = typeof (payload as { id?: unknown })?.id === "string"
    ? (payload as { id: string }).id.trim()
    : "";
  if (!id) return Response.json({ error: "Falta la inconsistencia que deseas actualizar." }, { status: 400 });
  const forbidden = await requireResourceField(access, "import_error", id);
  if (forbidden) return forbidden;

  try {
    const resolution = normalizeIssueResolution(payload);
    const updated = await setImportIssueResolution({
      id,
      membershipId: access.membershipId,
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      email: access.email,
      ...resolution,
    });
    if (!updated) {
      return Response.json({ error: "La inconsistencia no existe o no está disponible para este usuario." }, { status: 404 });
    }
    return Response.json({ dashboard: await getImportDashboard(importAccess) });
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    if (cause instanceof IssueResolutionError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 400 });
    }
    return Response.json({ error: "No fue posible registrar la resolución." }, { status: 500 });
  }
}
