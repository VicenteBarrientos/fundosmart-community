"use client";

import type { SortDirection, SortState } from "./sortable-data";

type SortableGridHeaderProps<Key extends string> = {
  align?: "left" | "right";
  className?: string;
  column: Key;
  label: string;
  onSort: (column: Key) => void;
  sort: SortState<Key> | null;
};

type SortableDataSelectProps<Key extends string> = {
  className?: string;
  defaultLabel?: string;
  label: string;
  onChange: (sort: SortState<Key> | null) => void;
  options: readonly { column: Key; label: string }[];
  sort: SortState<Key> | null;
};

const DIRECTION_LABELS: Record<SortDirection, string> = {
  ascending: "ascendente",
  descending: "descendente",
};

export function SortableGridHeader<Key extends string>({
  align = "left",
  className = "",
  column,
  label,
  onSort,
  sort,
}: SortableGridHeaderProps<Key>) {
  const active = sort?.column === column;
  const direction = active ? sort.direction : null;
  const nextDirection = direction === "ascending" ? "descendente" : "ascendente";
  const accessibleLabel = direction
    ? `${label}, orden ${DIRECTION_LABELS[direction]}. Activar para ordenar ${nextDirection}.`
    : `${label}, sin ordenar. Activar para ordenar ascendente.`;

  return (
    <button
      aria-label={accessibleLabel}
      aria-pressed={active}
      className={`group flex min-h-8 w-full items-center gap-1.5 rounded-md px-1.5 py-1 transition hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        align === "right" ? "justify-end text-right" : "justify-start text-left"
      } ${active ? "text-accent" : ""} ${className}`}
      data-sort-column={column}
      data-sort-direction={direction ?? "none"}
      onClick={() => onSort(column)}
      type="button"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span
        aria-hidden="true"
        className={`shrink-0 text-[0.9em] leading-none ${active ? "text-accent" : "text-ink-subtle/65 group-hover:text-ink-muted"}`}
      >
        {direction === "ascending" ? "↑" : direction === "descending" ? "↓" : "↕"}
      </span>
    </button>
  );
}

export function SortableDataSelect<Key extends string>({
  className = "",
  defaultLabel = "Orden original",
  label,
  onChange,
  options,
  sort,
}: SortableDataSelectProps<Key>) {
  const value = sort ? `${sort.column}:${sort.direction}` : "";

  return (
    <label className={className}>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        className="h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        onChange={(event) => {
          const selected = event.target.value;
          if (!selected) {
            onChange(null);
            return;
          }
          const [column, direction] = selected.split(":");
          const option = options.find((entry) => entry.column === column);
          if (!option || (direction !== "ascending" && direction !== "descending")) return;
          onChange({ column: option.column, direction });
        }}
        value={value}
      >
        <option value="">{defaultLabel}</option>
        {options.flatMap((option) => [
          <option key={`${option.column}:ascending`} value={`${option.column}:ascending`}>
            {option.label}: ascendente
          </option>,
          <option key={`${option.column}:descending`} value={`${option.column}:descending`}>
            {option.label}: descendente
          </option>,
        ])}
      </select>
    </label>
  );
}
