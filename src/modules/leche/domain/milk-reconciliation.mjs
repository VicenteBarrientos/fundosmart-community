/**
 * Builds one economic/physical reconciliation row per field and month.
 * When several physical sources coexist, tank totals take precedence over
 * deliveries, which take precedence over milk-meter rollups. Within the same
 * kind and date, equipment takes precedence over CLO and manual data. This
 * prevents counting the same milk twice while keeping manual entry usable first.
 */
export function buildMilkReconciliation(production, settlements) {
  const keys = new Set();
  for (const row of production)
    keys.add(`${row.fieldId}:${row.recordedAt.slice(0, 7)}`);
  for (const row of settlements) keys.add(`${row.fieldId}:${row.period}`);
  return [...keys]
    .map((key) => {
      const separator = key.indexOf(":");
      const fieldId = key.slice(0, separator);
      const period = key.slice(separator + 1);
      const periodProduction = production.filter(
        (row) => row.fieldId === fieldId && row.recordedAt.startsWith(period),
      );
      const preferredKind = periodProduction.some(
        (row) => row.kind === "tank_total",
      )
        ? "tank_total"
        : periodProduction.some((row) => row.kind === "delivery")
          ? "delivery"
          : "milk_meter_rollup";
      const preferredRows = periodProduction.filter(
        (row) => row.kind === preferredKind,
      );
      const litersProduced = [
        ...new Set(preferredRows.map((row) => row.recordedAt)),
      ].reduce((sum, recordedAt) => {
        const sameDate = preferredRows.filter(
          (row) => row.recordedAt === recordedAt,
        );
        const preferredSource = ["equipment", "cooprinsem_clo", "manual"].find(
          (source) => sameDate.some((row) => row.source === source),
        );
        return (
          sum +
          sameDate
            .filter((row) => row.source === preferredSource)
            .reduce((dateSum, row) => dateSum + row.volumeLiters, 0)
        );
      }, 0);
      const periodSettlements = settlements.filter(
        (row) => row.fieldId === fieldId && row.period === period,
      );
      const litersSettled = periodSettlements.reduce(
        (sum, row) => sum + row.totalLiters,
        0,
      );
      const netAmountClp = periodSettlements.reduce(
        (sum, row) => sum + row.netAmountClp,
        0,
      );
      const deltaLiters = litersSettled - litersProduced;
      return {
        fieldId,
        period,
        litersProduced,
        litersSettled,
        deltaLiters,
        deltaPercent:
          litersProduced > 0
            ? round((deltaLiters / litersProduced) * 100, 2)
            : null,
        netAmountClp,
        realPricePerLiterClp:
          litersProduced > 0 ? round(netAmountClp / litersProduced, 4) : null,
      };
    })
    .sort(
      (left, right) =>
        right.period.localeCompare(left.period) ||
        left.fieldId.localeCompare(right.fieldId),
    );
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
