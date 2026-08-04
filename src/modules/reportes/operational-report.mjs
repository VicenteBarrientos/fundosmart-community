import { calculateDashboardMetrics } from "../dashboard/dashboard-metrics.mjs";

const RECENT_ACTIVITY_DAYS = 30;

export function buildOperationalReport({
  activities,
  animals,
  canViewFinance,
  expenses,
  fundos,
  generatedAt,
  lots,
  potreros,
  settlements,
}) {
  const buildRow = (fundo) => {
    const scopedPotreros = fundo ? potreros.filter((potrero) => potrero.fieldId === fundo.id) : potreros;
    const scopedPaddockIds = new Set(scopedPotreros.map((potrero) => potrero.id));
    const scopedActivities = activities.filter((activity) => scopedPaddockIds.has(activity.potreroId));
    const scopedLots = fundo ? lots.filter((lot) => lot.fieldId === fundo.id) : lots;
    const scopedLotIds = new Set(scopedLots.map((lot) => lot.id));
    const scopedAnimals = animals.filter((animal) => scopedLotIds.has(animal.lotId));
    const scopedSettlements = fundo
      ? settlements.filter((settlement) => settlement.fieldId === fundo.id)
      : settlements;
    const scopedExpenses = fundo
      ? expenses.filter((expense) => expense.fieldId === fundo.id)
      : expenses;
    const metrics = calculateDashboardMetrics({
      activities: scopedActivities,
      animals: scopedAnimals,
      canViewFinance,
      expenses: scopedExpenses,
      lots: scopedLots,
      settlements: scopedSettlements,
    });
    const fieldAreaHectares = fundo
      ? fundo.areaHectares
      : fundos.reduce((sum, item) => sum + item.areaHectares, 0);
    const delimitedAreaHectares = scopedPotreros.reduce((sum, potrero) => sum + potrero.areaHectares, 0);
    const lastActivityDate = scopedActivities.map((activity) => activity.occurredAt).sort().at(-1) ?? null;
    const base = {
      activeAnimals: metrics.activeAnimals,
      activeLots: metrics.activeLots,
      activities30Days: scopedActivities.filter((activity) => isRecent(activity.occurredAt, generatedAt)).length,
      availablePaddocks: scopedPotreros.filter((potrero) => potrero.status === "Disponible").length,
      coveragePercent: fieldAreaHectares > 0 ? Math.min(100, (delimitedAreaHectares / fieldAreaHectares) * 100) : 0,
      delimitedAreaHectares,
      fieldAreaHectares,
      fieldId: fundo?.id ?? "all",
      fieldName: fundo?.name ?? "Todos los fundos",
      grazingPaddocks: scopedPotreros.filter((potrero) => potrero.status === "En pastoreo").length,
      lastActivityDate,
      latestMilkPeriod: metrics.latestMilk?.period ?? null,
      latestMilkTotalLiters: metrics.latestMilk?.totalLiters ?? null,
      latestWeightDate: metrics.latestWeightDate,
      litersPerMilkingCowDay: metrics.litersPerMilkingCowDay,
      milkChangePercent: metrics.milkChangePercent,
      milkingCows: metrics.milkingCows,
      paddockCount: scopedPotreros.length,
      restingPaddocks: scopedPotreros.filter((potrero) => potrero.status === "En descanso").length,
      weightCoveragePercent: metrics.weightCoveragePercent,
    };

    if (!canViewFinance) return base;
    return {
      ...base,
      finance: {
        latestMilkNetAmountClp: metrics.latestMilk?.netAmountClp ?? null,
        latestMilkNetPricePerLiterClp: metrics.latestMilk?.netPricePerLiterClp ?? null,
        operatingResultClp: metrics.operatingResultClp,
        periodCostsClp: metrics.periodCostsClp,
      },
    };
  };

  return {
    canViewFinance,
    fields: fundos.map((fundo) => buildRow(fundo)),
    generatedAt,
    total: buildRow(null),
  };
}

function isRecent(value, referenceDate) {
  const occurredAt = new Date(`${value}T12:00:00.000Z`).getTime();
  const reference = new Date(referenceDate).getTime();
  if (!Number.isFinite(occurredAt) || !Number.isFinite(reference)) return false;
  const ageDays = Math.floor((reference - occurredAt) / 86_400_000);
  return ageDays >= 0 && ageDays < RECENT_ACTIVITY_DAYS;
}
