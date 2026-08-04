import { compareTableSortValues } from "./table-explorer.mjs";

export function nextSortState(current, column) {
  return {
    column,
    direction: current?.column === column && current.direction === "ascending"
      ? "descending"
      : "ascending",
  };
}

export function stableSortData(items, sort, columns) {
  if (!sort) return [...items];
  const column = columns[sort.column];

  return items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .sort((left, right) => {
      const comparison = compareTableSortValues(
        column.value(left.item),
        column.value(right.item),
        column.kind,
        sort.direction,
      );
      return comparison || left.sourceIndex - right.sourceIndex;
    })
    .map(({ item }) => item);
}
