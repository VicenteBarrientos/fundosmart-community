import type { PaddockNdviListingItem, PaddockNdviValue } from "../domain/paddock-ndvi";

export type PaddockNdviMonthSlot = Readonly<{
  key: string;
  label: string;
  value: PaddockNdviValue | null;
}>;

export function buildPaddockNdviMonthSeries(item: PaddockNdviListingItem | null): PaddockNdviMonthSlot[] {
  const history = item?.history?.length ? item.history : item?.value ? [item.value] : [];
  const anchorKey = paddockNdviMonthKey(history[0]?.month ?? item?.value?.month ?? "");
  if (!anchorKey) return [];
  const [anchorYear, anchorMonth] = anchorKey.split("-").map(Number);
  const byMonth = new Map(history.map((value) => [paddockNdviMonthKey(value.month), value]));
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(anchorYear, anchorMonth - 1 - (5 - index), 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      key,
      label: date.toLocaleDateString("es-CL", { month: "short", timeZone: "UTC" }).replace(".", ""),
      value: byMonth.get(key) ?? null,
    };
  });
}

export function paddockNdviMonthKey(value: string) {
  return /^\d{4}-\d{2}/.exec(value)?.[0] ?? null;
}
