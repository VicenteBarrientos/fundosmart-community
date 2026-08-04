import type { LivestockContribution } from "@/src/core/domain/types";
import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import {
  deleteLivestockContribution,
  upsertLivestockContribution,
} from "@/src/modules/ganado/server/livestock-finance-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    if (!roleHasGlobalFieldAccess(access.role)) return organizationFinanceRequired();
    const payload = await readJsonObject<Partial<LivestockContribution>>(request);
    if (payload instanceof Response) return payload;
    const error = validateContribution(payload);
    if (error) return Response.json({ error }, { status: 400 });
    if (!("snapshotToken" in payload)) return contributionVersionConflict();
    if (payload.snapshotToken !== null && !isContributionSnapshotToken(payload.snapshotToken)) {
      return Response.json({ error: "La versión del aporte no es válida." }, { status: 400 });
    }

    const writeAccess = await reauthorizeApiAccess(access, "manage_finance");
    if (isAccessResponse(writeAccess)) return writeAccess;
    if (!roleHasGlobalFieldAccess(writeAccess.role)) return organizationFinanceRequired();
    const result = await upsertLivestockContribution({
      id: payload.id!.trim(),
      partnerId: payload.partnerId!.trim(),
      amountClp: payload.amountClp!,
      date: payload.date ?? null,
      description: payload.description?.trim() ?? "",
      createdAt: payload.createdAt ?? new Date().toISOString(),
      snapshotToken: payload.snapshotToken,
    }, {
      organizationId: writeAccess.organizationId,
      actorEmail: access.email,
      membershipId: writeAccess.membershipId,
    });
    const responseAccess = await reauthorizeApiAccess(writeAccess, "manage_finance");
    if (isAccessResponse(responseAccess)) return responseAccess;
    if (!roleHasGlobalFieldAccess(responseAccess.role)) return organizationFinanceRequired();
    return Response.json({ contribution: result.value, auditEntry: result.auditEntry }, { status: 201 });
  } catch (cause) {
    if (cause instanceof DomainRuleError) return financeDomainFailure(cause);
    return unexpectedApiFailure("livestock.contribution.save", "No fue posible guardar el aporte.", cause);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    if (!roleHasGlobalFieldAccess(access.role)) return organizationFinanceRequired();
    const query = new URL(request.url).searchParams;
    const id = query.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del aporte." }, { status: 400 });
    const snapshotToken = query.get("snapshotToken")?.trim();
    if (!snapshotToken) return contributionVersionConflict();
    if (!isContributionSnapshotToken(snapshotToken)) {
      return Response.json({ error: "La versión del aporte no es válida." }, { status: 400 });
    }
    const writeAccess = await reauthorizeApiAccess(access, "manage_finance");
    if (isAccessResponse(writeAccess)) return writeAccess;
    if (!roleHasGlobalFieldAccess(writeAccess.role)) return organizationFinanceRequired();
    const result = await deleteLivestockContribution(
      id,
      {
        organizationId: writeAccess.organizationId,
        actorEmail: access.email,
        membershipId: writeAccess.membershipId,
      },
      snapshotToken,
    );
    const responseAccess = await reauthorizeApiAccess(writeAccess, "manage_finance");
    if (isAccessResponse(responseAccess)) return responseAccess;
    if (!roleHasGlobalFieldAccess(responseAccess.role)) return organizationFinanceRequired();
    if (!result.deleted) return Response.json({ error: "El aporte no existe." }, { status: 404 });
    return Response.json(result);
  } catch (cause) {
    if (cause instanceof DomainRuleError) return financeDomainFailure(cause);
    return unexpectedApiFailure("livestock.contribution.delete", "No fue posible eliminar el aporte.", cause);
  }
}

function isContributionSnapshotToken(value: unknown): value is string {
  return typeof value === "string" && /^livestock-contribution:v1:[a-f0-9]{64}$/.test(value);
}

function contributionVersionConflict(): Response {
  return Response.json({
    error: "El aporte cambió desde la última carga. Recarga la página antes de continuar.",
    code: "FINANCE_CONTRIBUTION_VERSION_CONFLICT",
  }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
}

function financeDomainFailure(cause: DomainRuleError): Response {
  if (cause.code === "FINANCE_CONTRIBUTION_VERSION_CONFLICT" || cause.code === "FINANCE_SCOPE_CONFLICT") {
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

function validateContribution(payload: Partial<LivestockContribution>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del aporte.";
  if (!payload.partnerId?.trim()) return "Selecciona un socio.";
  if (!Number.isInteger(payload.amountClp) || (payload.amountClp as number) <= 0) return "El monto debe ser un CLP entero mayor que cero.";
  if (payload.date && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return "La fecha del aporte no es válida.";
  return null;
}
