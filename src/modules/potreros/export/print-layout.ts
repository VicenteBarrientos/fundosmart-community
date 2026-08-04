export function splitPrintLegendRows<T>(rows: readonly T[], maximumRowsPerColumn = 15): T[][] {
  const columnSize = Math.max(1, Math.floor(maximumRowsPerColumn));
  const columns: T[][] = [];
  for (let index = 0; index < rows.length; index += columnSize) {
    columns.push(rows.slice(index, index + columnSize));
  }
  return columns;
}
