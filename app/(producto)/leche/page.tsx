import { LechePage } from "@/src/modules/leche/LechePage";
import { requirePageAccess, reauthorizePageSnapshotAccess } from "@/app/access";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import {
  MILK_MODULE_SECTIONS,
  type MilkModuleSection,
} from "@/src/modules/leche/domain/types";
import { listMilkSettlements } from "@/src/modules/leche/server/milk-settlement-repository";
import { getMilkModuleSnapshot } from "@/src/modules/leche/server/milk-snapshot-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";

export const dynamic = "force-dynamic";

export default async function MilkRoute({
  searchParams,
}: {
  searchParams: Promise<{
    fieldId?: string | string[];
    section?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const access = await requirePageAccess("/app/leche");
  const canViewFinance = roleHasCapability(access.role, "manage_finance");
  const requestedSection = firstSearchParam(params.section);
  const initialSection = MILK_MODULE_SECTIONS.includes(requestedSection as MilkModuleSection)
    ? requestedSection as MilkModuleSection
    : "settlements";
  const needsOperationalSnapshot = initialSection !== "settlements" && initialSection !== "simulator";
  const [fundos, settlements, snapshot] = await Promise.all([
    listFundos(access),
    canViewFinance ? listMilkSettlements(access) : Promise.resolve([]),
    needsOperationalSnapshot ? getMilkModuleSnapshot(access) : Promise.resolve(null),
  ]);
  const allowedFields = new Set(access.fieldIds);
  const visibleFundos = fundos.filter((fundo) => allowedFields.has(fundo.id));
  const requestedFieldId = firstSearchParam(params.fieldId);
  const initialFieldId = visibleFundos.some((fundo) => fundo.id === requestedFieldId)
    ? requestedFieldId
    : "all";
  const visibleSettlements = settlements.filter((settlement) =>
    allowedFields.has(settlement.fieldId),
  );
  const visibleSnapshot = canViewFinance || !snapshot
    ? snapshot
    : { ...snapshot, reconciliation: [] };
  await reauthorizePageSnapshotAccess(access, "/app/leche", {
    capability: canViewFinance ? "manage_finance" : "view",
    fieldIds: access.fieldIds,
  });
  return (
    <LechePage
      canViewFinance={canViewFinance}
      fundos={visibleFundos}
      initialFieldId={initialFieldId}
      initialSection={initialSection}
      initialSettlements={visibleSettlements}
      initialSnapshot={visibleSnapshot}
      isDemo={access.email === DEMO_EMAIL}
      organizationId={access.organizationId}
      organizationName={access.organizationName}
      userName={access.displayName}
    />
  );
}

function firstSearchParam(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.trim() || undefined;
}
