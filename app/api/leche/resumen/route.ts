import { authorizeApiAccess, isAccessResponse, reauthorizeApiSnapshotAccess } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { getMilkModuleSnapshot } from "@/src/modules/leche/server/milk-snapshot-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const asOf =
      new URL(request.url).searchParams.get("asOf")?.trim() || undefined;
    if (asOf && !isIsoDate(asOf)) {
      return Response.json(
        { error: "La fecha de corte no es válida." },
        { status: 400 },
      );
    }
    const canViewFinance = roleHasCapability(access.role, "manage_finance");
    const snapshot = await getMilkModuleSnapshot(access, asOf);
    const visibleSnapshot = canViewFinance
      ? snapshot
      : { ...snapshot, reconciliation: [] };
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: canViewFinance ? "manage_finance" : "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { snapshot: visibleSnapshot },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return unexpectedApiFailure(
      "milk.dashboard.snapshot",
      "No fue posible actualizar el tablero lechero.",
      cause,
    );
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}
