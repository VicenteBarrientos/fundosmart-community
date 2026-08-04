import type { LivestockPartner } from "@/src/core/domain/types";
import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import {
  deleteLivestockPartner,
  listLivestockFinance,
  upsertLivestockPartner,
} from "@/src/modules/ganado/server/livestock-finance-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    if (!roleHasGlobalFieldAccess(access.role)) return organizationFinanceRequired();
    const finance = await listLivestockFinance({
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      allowOrganizationWide: true,
    });
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "manage_members",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(finance, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return unexpectedApiFailure("livestock.finance.list", "No fue posible cargar la información de plata.", cause);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    if (!roleHasGlobalFieldAccess(access.role)) return organizationFinanceRequired();
    const payload = await readJsonObject<Partial<LivestockPartner>>(request);
    if (payload instanceof Response) return payload;
    if (!payload.id?.trim()) return Response.json({ error: "Falta el identificador del socio." }, { status: 400 });
    if (!payload.name?.trim()) return Response.json({ error: "Ingresa el nombre del socio." }, { status: 400 });
    if (!("snapshotToken" in payload)) return partnerVersionConflict();
    if (payload.snapshotToken !== null && !isPartnerSnapshotToken(payload.snapshotToken)) {
      return Response.json({ error: "La versión del socio no es válida." }, { status: 400 });
    }

    const writeAccess = await reauthorizeApiAccess(access, "manage_finance");
    if (isAccessResponse(writeAccess)) return writeAccess;
    if (!roleHasGlobalFieldAccess(writeAccess.role)) return organizationFinanceRequired();
    const result = await upsertLivestockPartner({
      id: payload.id.trim(),
      name: payload.name.trim(),
      email: payload.email?.trim() || null,
      createdAt: payload.createdAt ?? new Date().toISOString(),
      snapshotToken: payload.snapshotToken,
    }, {
      organizationId: writeAccess.organizationId,
      actorEmail: access.email,
      membershipId: writeAccess.membershipId,
    });
    const responseAccess = await reauthorizeApiSnapshotAccess(writeAccess, {
      capability: "manage_members",
      fieldIds: writeAccess.fieldIds,
    });
    if (isAccessResponse(responseAccess)) return responseAccess;
    return Response.json({ partner: result.value, auditEntry: result.auditEntry }, { status: 201 });
  } catch (cause) {
    if (cause instanceof DomainRuleError) return financeDomainFailure(cause);
    return unexpectedApiFailure("livestock.partner.save", "No fue posible guardar el socio.", cause);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    if (!roleHasGlobalFieldAccess(access.role)) return organizationFinanceRequired();
    const query = new URL(request.url).searchParams;
    const id = query.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del socio." }, { status: 400 });
    const snapshotToken = query.get("snapshotToken")?.trim();
    if (!snapshotToken) return partnerVersionConflict();
    if (!isPartnerSnapshotToken(snapshotToken)) {
      return Response.json({ error: "La versión del socio no es válida." }, { status: 400 });
    }
    const writeAccess = await reauthorizeApiAccess(access, "manage_finance");
    if (isAccessResponse(writeAccess)) return writeAccess;
    if (!roleHasGlobalFieldAccess(writeAccess.role)) return organizationFinanceRequired();
    const result = await deleteLivestockPartner(
      id,
      {
        organizationId: writeAccess.organizationId,
        actorEmail: access.email,
        membershipId: writeAccess.membershipId,
      },
      snapshotToken,
    );
    const responseAccess = await reauthorizeApiSnapshotAccess(writeAccess, {
      capability: "manage_members",
      fieldIds: writeAccess.fieldIds,
    });
    if (isAccessResponse(responseAccess)) return responseAccess;
    if (!result.deleted) return Response.json({ error: "El socio no existe." }, { status: 404 });
    return Response.json(result);
  } catch (cause) {
    if (cause instanceof DomainRuleError) return financeDomainFailure(cause);
    return unexpectedApiFailure("livestock.partner.delete", "No fue posible eliminar el socio.", cause);
  }
}

function isPartnerSnapshotToken(value: unknown): value is string {
  return typeof value === "string" && /^livestock-partner:v1:[a-f0-9]{64}$/.test(value);
}

function partnerVersionConflict(): Response {
  return Response.json({
    error: "El socio cambió desde la última carga. Recarga la página antes de continuar.",
    code: "FINANCE_VERSION_CONFLICT",
  }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
}

function financeDomainFailure(cause: DomainRuleError): Response {
  if (cause.code === "FINANCE_VERSION_CONFLICT" || cause.code === "FINANCE_SCOPE_CONFLICT") {
    return Response.json({ error: cause.message, code: cause.code }, {
      status: 409,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
}

function organizationFinanceRequired(): Response {
  return Response.json({
    error: "La administración financiera de toda la organización requiere acceso de propietario o administrador.",
    code: "ORGANIZATION_FINANCE_REQUIRED",
  }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
}
