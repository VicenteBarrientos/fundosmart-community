"use client";

import type { ReactNode } from "react";

export { Panel, PanelHeader, StatCard, MiniStat, EmptyState, EmptyState as SmallEmpty } from "@/src/ui/primitives";
export { Field, ErrorMessage, parseOptionalNumber } from "@/src/ui/form";

export function FilterSelect({ children, label, onChange, value }: { children: ReactNode; label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label>
      <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-subtle">{label}</span>
      <select
        className="h-11 w-full rounded-card border border-line-steel bg-surface-alt px-3 text-xs font-bold text-ink outline-none focus:border-accent"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}
