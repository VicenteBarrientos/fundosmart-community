import { requirePageAccess, reauthorizePageSnapshotAccess } from "@/app/access";
import { roleHasCapability, roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { listLivestockAnimals } from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockFinance } from "@/src/modules/ganado/server/livestock-finance-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import { listMilkSettlements } from "@/src/modules/leche/server/milk-settlement-repository";
import { ReportesPage } from "@/src/modules/reportes/ReportesPage";
import { buildOperationalReport } from "@/src/modules/reportes/operational-report.mjs";
import { listActivities } from "@/src/modules/potreros/server/activity-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";

export const dynamic = "force-dynamic";

export default async function ReportsRoute() {
  const access = await requirePageAccess("/app/reportes");
  const canViewFinance = roleHasCapability(access.role, "manage_finance");
  const canViewOrganizationFinance = canViewFinance && roleHasGlobalFieldAccess(access.role);
  const financeScope = {
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
    allowOrganizationWide: canViewOrganizationFinance,
  };
  const [fundos, potreros, activities, lots, animals, settlements, finance] = await Promise.all([
    listFundos(access),
    listPotreros(access),
    listActivities(access),
    listLivestockLots(access),
    listLivestockAnimals(access),
    listMilkSettlements(access),
    canViewFinance
      ? listLivestockFinance(financeScope)
      : Promise.resolve({ partners: [], contributions: [], expenses: [] }),
  ]);
  const allowedFields = new Set(access.fieldIds);
  const visibleFundos = fundos.filter((fundo) => allowedFields.has(fundo.id));
  const visiblePotreros = potreros.filter((potrero) => allowedFields.has(potrero.fieldId));
  const visiblePaddockIds = new Set(visiblePotreros.map((potrero) => potrero.id));
  const visibleLots = lots.filter((lot) => allowedFields.has(lot.fieldId));
  const visibleLotIds = new Set(visibleLots.map((lot) => lot.id));
  const generatedAt = new Date().toISOString();
  const report = buildOperationalReport({
    activities: activities.filter((activity) => visiblePaddockIds.has(activity.potreroId)),
    animals: animals.filter((animal) => visibleLotIds.has(animal.lotId)),
    canViewFinance,
    expenses: finance.expenses,
    fundos: visibleFundos,
    generatedAt,
    lots: visibleLots,
    potreros: visiblePotreros,
    settlements: settlements.filter((settlement) => allowedFields.has(settlement.fieldId)),
  });
  await reauthorizePageSnapshotAccess(access, "/app/reportes", {
    capability: canViewFinance ? "manage_finance" : "view",
    fieldIds: access.fieldIds,
  });

  return (
    <ReportesPage
      isDemo={access.email === DEMO_EMAIL}
      organizationId={access.organizationId}
      organizationName={access.organizationName}
      report={report}
      userName={access.displayName}
    />
  );
}
