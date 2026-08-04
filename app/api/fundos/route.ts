import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { getOrganizationPlanUsage } from "@/src/modules/access/server/organization-plan-repository";
import { listFundos, upsertFundo } from "@/src/modules/potreros/server/fundo-repository";
import type { Fundo } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const [fundos, plan] = await Promise.all([
      listFundos(access),
      getOrganizationPlanUsage(access.organizationId),
    ]);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ fundos, plan }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return unexpectedApiFailure("fields.list", "No fue posible cargar los fundos.", cause);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_members");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<Fundo>>(request);
    if (payload instanceof Response) return payload;
    if (!payload.id?.trim() || !payload.name?.trim() || !payload.location?.trim()) {
      return Response.json({ error: "Completa el nombre y la ubicación del fundo." }, { status: 400 });
    }
    if (!Array.isArray(payload.coordinates) || payload.coordinates.length < 3) {
      return Response.json({ error: "El fundo necesita un límite geográfico válido." }, { status: 400 });
    }
    if (!Number.isFinite(payload.areaHectares) || Number(payload.areaHectares) <= 0) {
      return Response.json({ error: "La superficie calculada del fundo no es válida." }, { status: 400 });
    }
    if (access.fieldIds.includes(payload.id) && !payload.snapshotToken?.trim()) {
      return Response.json({ error: "Actualiza los fundos antes de editar." }, { status: 409 });
    }
    const saved = await upsertFundo(payload as Fundo, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", saved.id);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ fundo: saved }, { status: 201 });
  } catch (cause) {
    if (cause instanceof DomainRuleError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    return unexpectedApiFailure("fields.save", "No fue posible guardar el fundo.", cause);
  }
}
