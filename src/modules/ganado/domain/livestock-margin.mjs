/**
 * Pure domain logic for calculating individual and lot economic margin with transparent imputation rules.
 */

/**
 * Calculates individual economic margin for a livestock animal.
 */
export function calculateAnimalMargin(input) {
  const {
    animal,
    saleLink = null,
    feedConsumptions = [],
    expenses = [],
    categoryAvgDailyFeedCostClp = 0,
    daysInField = 0,
  } = input;

  // Revenue
  const allocatedSaleClp = saleLink?.allocatedAmountClp ?? animal?.salePriceClp ?? null;
  const isReconciled = Boolean(saleLink);

  // Feed costs
  const measuredFeedCost = feedConsumptions.reduce((sum, item) => sum + Number(item.costClp || 0), 0);
  const isFeedMeasured = feedConsumptions.length > 0;
  const imputedFeedCost = !isFeedMeasured && categoryAvgDailyFeedCostClp > 0 && daysInField > 0
    ? Math.round(categoryAvgDailyFeedCostClp * daysInField)
    : 0;

  const totalFeedCost = measuredFeedCost + imputedFeedCost;

  // Expenses
  const expensesCost = expenses.reduce((sum, item) => sum + Number(item.amountClp || 0), 0);

  // Total cost and margin
  const totalCost = totalFeedCost + expensesCost;
  const marginClp = allocatedSaleClp !== null ? allocatedSaleClp - totalCost : null;

  const imputationRule = isFeedMeasured
    ? "medido"
    : imputedFeedCost > 0
      ? "imputado_por_categoria"
      : "sin_costo_registrado";

  const imputationExplanation = isFeedMeasured
    ? "Costo de alimentación medido por consumo registrado."
    : imputedFeedCost > 0
      ? `Costo imputado por categoría (${categoryAvgDailyFeedCostClp} CLP/día × ${daysInField} días en predio).`
      : "Sin registros de consumo de alimento.";

  return {
    revenueClp: allocatedSaleClp,
    feedCostClp: totalFeedCost,
    isFeedMeasured,
    imputedFeedCostClp: imputedFeedCost,
    expensesCostClp: expensesCost,
    totalCostClp: totalCost,
    marginClp,
    isReconciled,
    imputationRule,
    imputationExplanation,
  };
}

/**
 * Calculates lot economic margin across multiple animals and lot-level documents.
 */
export function calculateLotMargin(input) {
  const {
    lot,
    animals = [],
    saleDocumentLinks = [],
    feedConsumptions = [],
    expenses = [],
    categoryAvgDailyFeedCostClp = 0,
  } = input;

  const totalRevenue = saleDocumentLinks.reduce((sum, link) => sum + Number(link.allocatedAmountClp || 0), 0);
  const isReconciled = saleDocumentLinks.length > 0;

  const measuredFeedCost = feedConsumptions.reduce((sum, item) => sum + Number(item.costClp || 0), 0);
  const isFeedMeasured = feedConsumptions.length > 0;

  const totalDaysInField = animals.reduce((sum, a) => sum + Number(a.daysInField || 0), 0);
  const imputedFeedCost = !isFeedMeasured && categoryAvgDailyFeedCostClp > 0 && totalDaysInField > 0
    ? Math.round(categoryAvgDailyFeedCostClp * totalDaysInField)
    : 0;

  const totalFeedCost = measuredFeedCost + imputedFeedCost;
  const expensesCost = expenses.reduce((sum, item) => sum + Number(item.amountClp || 0), 0);

  const totalCost = totalFeedCost + expensesCost;
  const marginClp = isReconciled || totalRevenue > 0 ? totalRevenue - totalCost : null;

  return {
    lotId: lot?.id || null,
    lotName: lot?.name || "Sin Lote",
    animalCount: animals.length,
    revenueClp: totalRevenue,
    feedCostClp: totalFeedCost,
    isFeedMeasured,
    imputedFeedCostClp: imputedFeedCost,
    expensesCostClp: expensesCost,
    totalCostClp: totalCost,
    marginClp,
    isReconciled,
  };
}
