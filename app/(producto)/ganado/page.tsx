import { reauthorizePageSnapshotAccess, requirePageAccess } from "@/app/access";
import { roleHasCapability, roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { GanadoPage } from "@/src/modules/ganado/GanadoPage";
import { listHerdOperations } from "@/src/modules/ganado/server/herd-operations-repository";
import { listLivestockAnimals } from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockFinance, listLivestockFinanceAudit } from "@/src/modules/ganado/server/livestock-finance-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import { listLivestockWeighings } from "@/src/modules/ganado/server/livestock-weighing-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";

export const dynamic = "force-dynamic";

export default async function LivestockRoute() {
  const access = await requirePageAccess("/app/ganado");
  const canViewFinance = roleHasCapability(access.role, "manage_finance");
  const canViewOrganizationFinance = canViewFinance && roleHasGlobalFieldAccess(access.role);
  const financeScope = {
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
    allowOrganizationWide: canViewOrganizationFinance,
  };
  const [fundos, lots, animals, weighings, finance, financeAudit] = await Promise.all([
    listFundos(access),
    listLivestockLots(access),
    listLivestockAnimals(access),
    listLivestockWeighings(access),
    canViewFinance
      ? listLivestockFinance(financeScope)
      : Promise.resolve({ partners: [], contributions: [], expenses: [] }),
    canViewFinance ? listLivestockFinanceAudit(financeScope) : Promise.resolve([]),
  ]);
  const allowedFields = new Set(access.fieldIds);
  const visibleFundos = fundos.filter((fundo) => allowedFields.has(fundo.id));
  const visibleLots = lots.filter((lot) => allowedFields.has(lot.fieldId));
  const visibleLotIds = new Set(visibleLots.map((lot) => lot.id));
  const visibleAnimals = animals.filter((animal) => visibleLotIds.has(animal.lotId));
  const visibleAnimalIds = new Set(visibleAnimals.map((animal) => animal.id));
  const visibleWeighings = weighings.filter((weighing) => visibleAnimalIds.has(weighing.animalId));
  const visibleExpenses = canViewFinance
    ? finance.expenses.filter((expense) => !expense.fieldId || allowedFields.has(expense.fieldId))
    : [];
  const operationsWithFinance = await listHerdOperations({
    fieldIds: access.fieldIds,
    lots: visibleLots,
    animals: visibleAnimals,
    weighings: visibleWeighings,
    expenses: visibleExpenses,
  });
  const initialOperations = canViewFinance
    ? operationsWithFinance
    : { ...operationsWithFinance, animalMargins: [], lotMargins: [] };
  const currentAccess = await reauthorizePageSnapshotAccess(
    access,
    "/app/ganado",
    {
      capability: canViewOrganizationFinance
        ? "manage_members"
        : canViewFinance
          ? "manage_finance"
          : "view",
      fieldIds: access.fieldIds,
    },
  );
  const offlineScope = [
    currentAccess.membershipId,
    currentAccess.role,
    ...[...currentAccess.fieldIds].sort(),
  ].join(".");

  return (
    <GanadoPage
      canManageFinance={canViewFinance}
      canManageOrganizationFinance={canViewOrganizationFinance}
      fundos={visibleFundos}
      initialAnimals={visibleAnimals}
      initialContributions={canViewOrganizationFinance ? finance.contributions : []}
      initialExpenses={finance.expenses}
      initialFeedConsumptions={[]}
      initialFeedInventory={[]}
      initialFeedingPlans={[]}
      initialFinanceAudit={financeAudit}
      initialLots={visibleLots}
      initialOperations={initialOperations}
      initialPartners={canViewOrganizationFinance ? finance.partners : []}
      initialWeighings={visibleWeighings}
      isDemo={currentAccess.email === DEMO_EMAIL}
      offlineScope={offlineScope}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      potreros={[]}
      userName={currentAccess.displayName}
    />
  );
}
