import {
  nextSortState as nextSortStateCore,
  stableSortData as stableSortDataCore,
} from "./sortable-data-core.mjs";

export type SortDirection = "ascending" | "descending";
export type SortKind = "date" | "number" | "text";

export type SortState<Key extends string> = {
  column: Key;
  direction: SortDirection;
};

export type SortColumn<Item> = {
  kind: SortKind;
  value: (item: Item) => number | string | null | undefined;
};

export function nextSortState<Key extends string>(
  current: SortState<Key> | null,
  column: Key,
): SortState<Key> {
  return nextSortStateCore(current, column) as SortState<Key>;
}

export function stableSortData<Item, Key extends string>(
  items: readonly Item[],
  sort: SortState<Key> | null,
  columns: Record<Key, SortColumn<Item>>,
): Item[] {
  return stableSortDataCore(items, sort, columns) as Item[];
}
