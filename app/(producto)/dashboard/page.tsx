import { reauthorizePageSnapshotAccess, requirePageAccess } from "@/app/access";
import { roleHasCapability, roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import {
  countConfirmedImportsForOnboarding,
  createDashboardOnboardingScope,
  listAgendaManagement,
} from "@/src/modules/dashboard/agenda-repository";
import { listAgronomicAgendaSignals } from "@/src/modules/dashboard/agronomic-agenda-repository";
import { DashboardPage } from "@/src/modules/dashboard/DashboardPage";
import { calculateDashboardMetrics } from "@/src/modules/dashboard/dashboard-metrics.mjs";
import { getDashboardOperationalSnapshot } from "@/src/modules/dashboard/dashboard-operational-snapshot-repository";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { listLivestockFinance } from "@/src/modules/ganado/server/livestock-finance-repository";
import { listMilkSettlements } from "@/src/modules/leche/server/milk-settlement-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";

export const dynamic = "force-dynamic";

export default async function DashboardRoute() {
  const access = await requirePageAccess("/app");
  const canViewFinance = roleHasCapability(access.role, "manage_finance");
  const canManageAgenda = roleHasCapability(access.role, "operate");
  const canManageImports = roleHasCapability(access.role, "manage_imports");
  const hasGlobalFinance = canViewFinance && roleHasGlobalFieldAccess(access.role);
  const financeScope = {
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
    allowOrganizationWide: hasGlobalFinance,
  };
  const [
    fundos,
    potreros,
    operationalSnapshot,
    finance,
    settlements,
    agendaManagement,
    agronomicAgendaSignals,
    confirmedImportCount,
  ] = await Promise.all([
    listFundos(access),
    listPotreros(access),
    /* El dashboard no edita animales: evita calcular tokens de concurrencia con
       toda su historia y trae su agenda operativa en un único batch de D1. */
    getDashboardOperationalSnapshot(access, { includeActivityCosts: canViewFinance }),
    canViewFinance
      ? listLivestockFinance(financeScope)
      : Promise.resolve({ partners: [], contributions: [], expenses: [] }),
    canViewFinance ? listMilkSettlements(access) : Promise.resolve([]),
    listAgendaManagement(access),
    listAgronomicAgendaSignals(access),
    canManageImports
      ? countConfirmedImportsForOnboarding(access)
      : Promise.resolve(0),
  ]);
  const allowedFields = new Set(access.fieldIds);
  const visibleFundos = fundos.filter((fundo) => allowedFields.has(fundo.id));
  const visiblePotreros = potreros.filter((potrero) => allowedFields.has(potrero.fieldId));
  const visiblePaddocks = new Set(visiblePotreros.map((potrero) => potrero.id));
  const visibleActivities = operationalSnapshot.activities.filter((activity) =>
    visiblePaddocks.has(activity.potreroId));
  const visibleLots = operationalSnapshot.lots.filter((lot) => allowedFields.has(lot.fieldId));
  const visibleLotIds = new Set(visibleLots.map((lot) => lot.id));
  const visibleAnimals = operationalSnapshot.animals.filter((animal) => visibleLotIds.has(animal.lotId));
  const visibleAnimalIds = new Set(visibleAnimals.map((animal) => animal.id));
  const visibleHerdWorkItems = operationalSnapshot.herdWorkItems.filter((item) =>
    allowedFields.has(item.fieldId) && visibleAnimalIds.has(item.animalId));
  const visibleMammaryWorkItems = operationalSnapshot.mammaryWorkItems.filter((item) =>
    allowedFields.has(item.fieldId) && visibleAnimalIds.has(item.animalId));
  const visibleSettlements = settlements.filter((settlement) => allowedFields.has(settlement.fieldId));
  const visibleExpenses = finance.expenses;

  const metricsFor = (fieldId?: string) => {
    const scopedLots = fieldId ? visibleLots.filter((lot) => lot.fieldId === fieldId) : visibleLots;
    const scopedLotIds = new Set(scopedLots.map((lot) => lot.id));
    const scopedPaddockIds = new Set(
      visiblePotreros.filter((potrero) => !fieldId || potrero.fieldId === fieldId).map((potrero) => potrero.id),
    );
    return calculateDashboardMetrics({
      activities: visibleActivities.filter((activity) => scopedPaddockIds.has(activity.potreroId)),
      activityCostsByPeriod: operationalSnapshot.activityCostsByPeriod.filter((cost) =>
        !fieldId || cost.fieldId === fieldId),
      animals: visibleAnimals.filter((animal) => scopedLotIds.has(animal.lotId)),
      canViewFinance,
      expenses: visibleExpenses.filter((expense) => fieldId ? expense.fieldId === fieldId : true),
      lots: scopedLots,
      settlements: visibleSettlements.filter((settlement) => !fieldId || settlement.fieldId === fieldId),
    });
  };
  const metrics = {
    all: metricsFor(),
    byField: Object.fromEntries(visibleFundos.map((fundo) => [fundo.id, metricsFor(fundo.id)])),
  };
  const currentAccess = await reauthorizePageSnapshotAccess(access, "/app", {
    capability: canViewFinance ? "manage_finance" : canManageAgenda ? "operate" : "view",
    fieldIds: access.fieldIds,
  });
  const onboardingScope = canManageAgenda
    ? await createDashboardOnboardingScope(currentAccess)
    : "";
  const hasFirstAction = visibleActivities.length > 0
    || visibleAnimals.length > 0
    || visibleSettlements.length > 0
    || visibleExpenses.length > 0
    || confirmedImportCount > 0
    || agendaManagement.states.some((state) => state.status === "completed");

  return (
    <DashboardPage
      activities={visibleActivities}
      agronomicAgendaSignals={agronomicAgendaSignals}
      agendaManagement={agendaManagement}
      canManageAgenda={canManageAgenda}
      canManageImports={canManageImports}
      canViewFinance={canViewFinance}
      generatedAt={new Date().toISOString()}
      herdSummary={{ workItems: visibleHerdWorkItems }}
      isDemo={currentAccess.email === DEMO_EMAIL}
      metrics={metrics}
      milkSummary={{ mammaryWorkItems: visibleMammaryWorkItems }}
      onboardingFacts={{
        fieldCount: visibleFundos.length,
        paddockCount: visiblePotreros.length,
        hasFirstAction,
        firstFieldId: visibleFundos[0]?.id ?? null,
      }}
      onboardingScope={onboardingScope}
      organizationId={currentAccess.organizationId}
      fundos={visibleFundos}
      organizationName={currentAccess.organizationName}
      potreros={visiblePotreros}
      userName={currentAccess.displayName}
    />
  );
}
