function activeAnimalCount(lot, animals) {
  if (lot.trackingMode !== "individual") return lot.status === "active" ? lot.animalCount : 0;
  return animals.filter((animal) => animal.lotId === lot.id && animal.status === "active").length;
}

function aggregateMilkPeriod(settlements, period, canViewFinance) {
  const rows = settlements.filter((settlement) => settlement.period === period);
  const totalLiters = rows.reduce((sum, settlement) => sum + settlement.totalLiters, 0);
  const operationalMetrics = {
    period,
    totalLiters,
  };
  if (!canViewFinance) return operationalMetrics;

  const netAmountClp = rows.reduce((sum, settlement) => sum + settlement.netAmountClp, 0);
  const grossAmountClp = rows.reduce((sum, settlement) => sum + settlement.grossAmountClp, 0);
  return {
    ...operationalMetrics,
    grossAmountClp,
    netAmountClp,
    netPricePerLiterClp: totalLiters > 0 ? netAmountClp / totalLiters : 0,
  };
}

function daysInPeriod(period) {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function calculateDashboardMetrics({
  activities,
  activityCostsByPeriod = null,
  animals,
  canViewFinance,
  expenses,
  lots,
  settlements,
}) {
  const activeLots = lots.filter((lot) => lot.status === "active");
  const activeAnimals = activeLots.reduce((sum, lot) => sum + activeAnimalCount(lot, animals), 0);
  const milkingCows = activeLots
    .filter((lot) => lot.category === "dairy_cow")
    .reduce((sum, lot) => sum + activeAnimalCount(lot, animals), 0);

  const individualAnimalIds = new Set(
    animals
      .filter((animal) => animal.status === "active" && activeLots.some((lot) => lot.id === animal.lotId && lot.trackingMode === "individual"))
      .map((animal) => animal.id),
  );
  const weighedAnimals = animals.filter(
    (animal) => individualAnimalIds.has(animal.id) && animal.latestWeightDate,
  );
  const latestWeightDate = weighedAnimals
    .map((animal) => animal.latestWeightDate)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const periods = [...new Set(settlements.map((settlement) => settlement.period))].sort().reverse();
  const latestMilk = periods[0] ? aggregateMilkPeriod(settlements, periods[0], canViewFinance) : null;
  const previousMilk = periods[1] ? aggregateMilkPeriod(settlements, periods[1], canViewFinance) : null;
  const milkChangePercent = latestMilk && previousMilk && previousMilk.totalLiters > 0
    ? ((latestMilk.totalLiters - previousMilk.totalLiters) / previousMilk.totalLiters) * 100
    : null;
  const litersPerMilkingCowDay = latestMilk && milkingCows > 0
    ? latestMilk.totalLiters / daysInPeriod(latestMilk.period) / milkingCows
    : null;

  const financePeriod = latestMilk?.period ?? null;
  const activityCostsClp = financePeriod
    ? activityCostsByPeriod
      ? activityCostsByPeriod
          .filter((cost) => cost.period === financePeriod)
          .reduce((sum, cost) => sum + cost.costClp, 0)
      : activities
          .filter((activity) => activity.occurredAt.startsWith(financePeriod))
          .reduce((sum, activity) => sum + (activity.costClp ?? 0), 0)
    : 0;
  const periodCostsClp = canViewFinance && financePeriod
    ? expenses
        .filter((expense) => expense.date?.startsWith(financePeriod))
        .reduce((sum, expense) => sum + expense.amountClp, 0)
      + activityCostsClp
    : null;

  return {
    activeAnimals,
    activeLots: activeLots.length,
    latestMilk,
    latestWeightDate,
    litersPerMilkingCowDay,
    milkChangePercent,
    milkingCows,
    operatingResultClp: latestMilk?.netAmountClp !== undefined && periodCostsClp !== null
      ? latestMilk.netAmountClp - periodCostsClp
      : null,
    periodCostsClp,
    weightCoveragePercent: individualAnimalIds.size > 0
      ? (weighedAnimals.length / individualAnimalIds.size) * 100
      : null,
  };
}
