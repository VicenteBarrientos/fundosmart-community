"use client";

import { ChevronDown, ListFilter, Rows3, Search, SlidersHorizontal, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  compareTableSortValues,
  detectTableSortKind,
  normalizeTableText,
  tableRowMatches,
} from "./table-explorer.mjs";

type TableFilter = {
  allLabel: string;
  columnIndex: number;
  label: string;
};

type TableExplorerProps = {
  children: ReactNode;
  className?: string;
  defaultCompact?: boolean;
  defaultOpen?: boolean;
  description: string;
  filter?: TableFilter;
  id: string;
  maxHeight?: string;
  rowLabel?: {
    plural: string;
    singular: string;
  };
  searchPlaceholder?: string;
  title: string;
};

type FilterOption = {
  label: string;
  value: string;
};

type TableSummary = {
  total: number;
  visible: number;
};

type TableSortDirection = "ascending" | "descending";
type TableSortKind = "date" | "number" | "text";

type TableSortState = {
  columnIndex: number;
  direction: TableSortDirection;
};

const EMPTY_SUMMARY: TableSummary = { total: 0, visible: 0 };
const SORTABLE_HEADING_CLASSES = [
  "cursor-pointer",
  "select-none",
  "transition-colors",
  "hover:text-ink",
  "focus-visible:outline-none",
  "focus-visible:ring-2",
  "focus-visible:ring-inset",
  "focus-visible:ring-accent",
  "after:ml-1.5",
  "after:inline-block",
  "after:text-[11px]",
  "after:text-ink-subtle",
  "after:content-[attr(data-table-sort-indicator)]",
];

function readPreference(key: string): boolean | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
}

function writePreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    return;
  }
}

function sameOptions(left: FilterOption[], right: FilterOption[]): boolean {
  return left.length === right.length
    && left.every((option, index) => option.label === right[index]?.label && option.value === right[index]?.value);
}

function readableCellText(cell: HTMLTableCellElement | null): string {
  if (!cell) return "";
  const explicitLabel = cell.getAttribute("data-table-filter-label");
  return (explicitLabel ?? cell.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sortableCellText(cell: HTMLTableCellElement | null): string {
  if (!cell) return "";
  const explicitValue = cell.getAttribute("data-table-sort-value");
  return (explicitValue ?? cell.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sortableHeadingLabel(heading: HTMLTableCellElement): string {
  return (heading.getAttribute("data-table-sort-label") ?? heading.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isTableSortKind(value: string | undefined): value is TableSortKind {
  return value === "date" || value === "number" || value === "text";
}

function headingSortKind(
  heading: HTMLTableCellElement,
  rows: HTMLTableRowElement[],
  label: string,
): TableSortKind {
  const declaredKind = heading.dataset.tableSortType;
  if (isTableSortKind(declaredKind)) return declaredKind;
  const values = rows.map((row) => sortableCellText(row.cells.item(heading.cellIndex)));
  return detectTableSortKind(label, values) as TableSortKind;
}

function nextSortInstruction(kind: TableSortKind, direction: TableSortDirection): string {
  if (kind === "date") {
    return direction === "ascending"
      ? "Ordenar de la fecha más antigua a la más reciente"
      : "Ordenar de la fecha más reciente a la más antigua";
  }
  if (kind === "number") {
    return direction === "ascending" ? "Ordenar de menor a mayor" : "Ordenar de mayor a menor";
  }
  return direction === "ascending" ? "Ordenar de A a Z" : "Ordenar de Z a A";
}

function makeHeadingSortable(
  heading: HTMLTableCellElement,
  label: string,
  kind: TableSortKind,
  sort: TableSortState | null,
): void {
  if (!heading.hasAttribute("data-table-sort-original-aria-label")) {
    heading.dataset.tableSortOriginalAriaLabel = heading.getAttribute("aria-label") ?? "";
  }
  if (!heading.hasAttribute("data-table-sort-original-tab-index")) {
    heading.dataset.tableSortOriginalTabIndex = heading.getAttribute("tabindex") ?? "";
  }

  const active = sort?.columnIndex === heading.cellIndex;
  const nextDirection = active && sort.direction === "ascending" ? "descending" : "ascending";
  const originalLabel = heading.dataset.tableSortOriginalAriaLabel || label;

  heading.dataset.tableSortable = "true";
  heading.dataset.tableSortKind = kind;
  heading.dataset.tableSortIndicator = active
    ? sort.direction === "ascending" ? "↑" : "↓"
    : "↕";
  heading.classList.add(...SORTABLE_HEADING_CLASSES);
  heading.tabIndex = 0;
  heading.setAttribute("aria-label", `${originalLabel}. ${nextSortInstruction(kind, nextDirection)}.`);

  if (active) heading.setAttribute("aria-sort", sort.direction);
  else heading.removeAttribute("aria-sort");
}

export function TableExplorer({
  children,
  className = "",
  defaultCompact = false,
  defaultOpen = true,
  description,
  filter,
  id,
  maxHeight = "28rem",
  rowLabel = { singular: "registro", plural: "registros" },
  searchPlaceholder = "Buscar en esta tabla…",
  title,
}: TableExplorerProps) {
  const generatedId = useId();
  const panelId = `${generatedId}-table-panel`;
  const titleId = `${generatedId}-table-title`;
  const searchId = `${generatedId}-table-search`;
  const filterId = `${generatedId}-table-filter`;
  const hostRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [compact, setCompact] = useState(defaultCompact);
  const [query, setQuery] = useState("");
  const [selectedFilter, setSelectedFilter] = useState("");
  const [filterOptions, setFilterOptions] = useState<FilterOption[]>([]);
  const [summary, setSummary] = useState<TableSummary>(EMPTY_SUMMARY);
  const [sort, setSort] = useState<TableSortState | null>(null);
  const originalRowOrderRef = useRef(new WeakMap<HTMLTableRowElement, number>());
  const nextRowOrderRef = useRef(0);

  useEffect(() => {
    const storedOpen = readPreference(`fundosmart.table.${id}.open`);
    const storedCompact = readPreference(`fundosmart.table.${id}.compact`);
    if (storedOpen !== null) setOpen(storedOpen);
    if (storedCompact !== null) setCompact(storedCompact);
    setSort(null);
    originalRowOrderRef.current = new WeakMap<HTMLTableRowElement, number>();
    nextRowOrderRef.current = 0;
  }, [id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const activateHeading = (heading: HTMLTableCellElement) => {
      if (heading.dataset.tableSortable !== "true") return;
      setSort((current) => ({
        columnIndex: heading.cellIndex,
        direction: current?.columnIndex === heading.cellIndex && current.direction === "ascending"
          ? "descending"
          : "ascending",
      }));
    };

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const heading = event.target.closest<HTMLTableCellElement>("th[data-table-sortable='true']");
      if (!heading || !host.contains(heading)) return;
      const nestedControl = event.target.closest("a, button, input, select, textarea");
      if (nestedControl && nestedControl !== heading) return;
      activateHeading(heading);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof Element)) return;
      const heading = event.target.closest<HTMLTableCellElement>("th[data-table-sortable='true']");
      if (!heading || event.target !== heading || !host.contains(heading)) return;
      event.preventDefault();
      activateHeading(heading);
    };

    host.addEventListener("click", handleClick);
    host.addEventListener("keydown", handleKeyDown);
    return () => {
      host.removeEventListener("click", handleClick);
      host.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const applyTableState = () => {
      const table = host.querySelector("table");
      if (!table) {
        setSummary((current) => current.total === 0 && current.visible === 0 ? current : EMPTY_SUMMARY);
        setFilterOptions((current) => current.length === 0 ? current : []);
        return;
      }

      if (!table.hasAttribute("aria-label") && !table.hasAttribute("aria-labelledby")) {
        table.setAttribute("aria-labelledby", titleId);
      }

      const rows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
      for (const row of rows) {
        if (originalRowOrderRef.current.has(row)) continue;
        originalRowOrderRef.current.set(row, nextRowOrderRef.current);
        nextRowOrderRef.current += 1;
      }

      const headings = Array.from(table.tHead?.querySelectorAll("th") ?? []);
      const headingKinds = new Map<HTMLTableCellElement, TableSortKind>();
      for (const heading of headings) {
        if (!heading.hasAttribute("scope")) heading.setAttribute("scope", "col");
        const label = sortableHeadingLabel(heading);
        if (!label || heading.hasAttribute("data-table-sort-disabled")) continue;
        const kind = headingSortKind(heading, rows, label);
        headingKinds.set(heading, kind);
        makeHeadingSortable(heading, label, kind, sort);
      }

      const activeHeading = sort
        ? headings.find((heading) => heading.cellIndex === sort.columnIndex && headingKinds.has(heading))
        : undefined;
      const activeKind = activeHeading ? headingKinds.get(activeHeading) : undefined;
      if (sort && activeKind) {
        for (const body of Array.from(table.tBodies)) {
          const currentRows = Array.from(body.rows);
          const orderedRows = [...currentRows].sort((left, right) => {
            const comparison = compareTableSortValues(
              sortableCellText(left.cells.item(sort.columnIndex)),
              sortableCellText(right.cells.item(sort.columnIndex)),
              activeKind,
              sort.direction,
            );
            if (comparison !== 0) return comparison;
            return (originalRowOrderRef.current.get(left) ?? 0) - (originalRowOrderRef.current.get(right) ?? 0);
          });

          if (orderedRows.some((row, index) => row !== currentRows[index])) {
            for (const row of orderedRows) body.appendChild(row);
          }
        }
      }

      const options = new Map<string, string>();
      let visible = 0;

      for (const row of rows) {
        const filterText = filter ? readableCellText(row.cells.item(filter.columnIndex)) : "";
        if (filterText) {
          const value = normalizeTableText(filterText);
          if (!options.has(value)) options.set(value, filterText);
        }

        const matches = tableRowMatches({
          query,
          rowFilter: filterText,
          rowText: row.getAttribute("data-table-search") ?? row.textContent ?? "",
          selectedFilter,
        });
        row.hidden = !matches;
        row.dataset.tableVisibility = matches ? "visible" : "filtered";
        if (matches) visible += 1;
      }

      const nextOptions = [...options.entries()]
        .map(([value, label]) => ({ label, value }))
        .sort((left, right) => left.label.localeCompare(right.label, "es-CL", { numeric: true }));
      setFilterOptions((current) => sameOptions(current, nextOptions) ? current : nextOptions);
      setSummary((current) => current.total === rows.length && current.visible === visible
        ? current
        : { total: rows.length, visible });

      if (selectedFilter && !options.has(selectedFilter)) setSelectedFilter("");
    };

    applyTableState();
    const observer = new MutationObserver(applyTableState);
    observer.observe(host, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [filter, query, selectedFilter, sort, titleId]);

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      writePreference(`fundosmart.table.${id}.open`, next);
      return next;
    });
  };

  const toggleCompact = () => {
    setCompact((current) => {
      const next = !current;
      writePreference(`fundosmart.table.${id}.compact`, next);
      return next;
    });
  };

  const resetFilters = () => {
    setQuery("");
    setSelectedFilter("");
  };

  const hasActiveFilters = query.trim().length > 0 || selectedFilter.length > 0;
  const visibleLabel = summary.visible === 1 ? rowLabel.singular : rowLabel.plural;
  const scrollStyle = { "--table-explorer-max-height": maxHeight } as CSSProperties;

  return (
    <section
      className={`overflow-hidden rounded-[18px] border border-line-steel bg-white shadow-[0_10px_32px_rgba(35,50,42,0.05)] ${className}`}
      data-table-explorer={id}
    >
      <header className="flex flex-col gap-4 bg-surface-alt px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Tabla interactiva</p>
          <h3 className="mt-1 text-base font-black tracking-[-0.025em] text-ink" id={titleId}>{title}</h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            aria-pressed={compact}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={toggleCompact}
            type="button"
          >
            <Rows3 aria-hidden="true" size={15} />
            {compact ? "Ampliar filas" : "Compactar filas"}
          </button>
          <button
            aria-controls={panelId}
            aria-expanded={open}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={toggleOpen}
            type="button"
          >
            {open ? "Ocultar tabla" : "Mostrar tabla"}
            <ChevronDown
              aria-hidden="true"
              className={`transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
              size={15}
            />
          </button>
        </div>
      </header>

      <div
        aria-labelledby={titleId}
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
        id={panelId}
        inert={!open || undefined}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-line-steel p-3 sm:p-4">
            <div className={`grid gap-2 ${filter ? "md:grid-cols-[minmax(16rem,1fr)_minmax(13rem,auto)_auto]" : "md:grid-cols-[minmax(16rem,1fr)_auto]"}`}>
              <label className="relative block" htmlFor={searchId}>
                <span className="sr-only">Buscar en {title}</span>
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={15} />
                <input
                  className="h-11 w-full rounded-xl border border-line-steel bg-white pl-9 pr-3 text-xs font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
                  id={searchId}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  type="search"
                  value={query}
                />
              </label>

              {filter ? (
                <label className="relative block" htmlFor={filterId}>
                  <span className="sr-only">{filter.label}</span>
                  <ListFilter aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={15} />
                  <select
                    className="h-11 w-full min-w-0 appearance-none rounded-xl border border-line-steel bg-white pl-9 pr-9 text-xs font-black text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
                    id={filterId}
                    onChange={(event) => setSelectedFilter(event.target.value)}
                    value={selectedFilter}
                  >
                    <option value="">{filter.allLabel}</option>
                    {filterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={15} />
                </label>
              ) : null}

              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!hasActiveFilters}
                onClick={resetFilters}
                type="button"
              >
                {hasActiveFilters ? <X aria-hidden="true" size={15} /> : <SlidersHorizontal aria-hidden="true" size={15} />}
                Limpiar filtros
              </button>
            </div>

            <div
              aria-label={`${title}. Contenido desplazable`}
              className={`table-explorer-scroll mt-3 rounded-xl border border-line-steel ${
                compact ? "table-explorer-density-compact" : ""
              }`}
              ref={hostRef}
              role="region"
              style={scrollStyle}
              tabIndex={0}
            >
              {children}
            </div>

            {summary.total > 0 && summary.visible === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-line-strong bg-surface-alt px-4 py-5 text-center">
                <p className="text-sm font-black text-ink">No hay coincidencias</p>
                <p className="mt-1 text-xs text-ink-muted">Prueba otra búsqueda o limpia los filtros para volver a ver los datos.</p>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] font-semibold text-ink-subtle">
              <p aria-live="polite">
                Mostrando <strong className="text-ink">{summary.visible}</strong> de {summary.total} {visibleLabel}
              </p>
              <p className="sm:hidden">Desliza la tabla para ver todas las columnas.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
