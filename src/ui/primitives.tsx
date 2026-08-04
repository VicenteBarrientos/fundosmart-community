import { Sprout, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { HelpTip } from "./Hint";
import type { HelpKey } from "./help-copy";

/* Canonical card primitives (steel tokens). Replaces the duplicated Panel /
   PanelHeader / StatCard defined in DashboardPage.tsx and ganado/components/ui.tsx.

   Todas aceptan `help` (clave del glosario) o `helpText` (texto libre) y dibujan
   un marcador ⓘ junto al título. Se omite en tarjetas cuyo título ya se explica
   solo. */

export function Panel({
  children,
  eyebrow,
  icon,
  title,
  actions,
  help,
  helpText,
}: {
  children: ReactNode;
  eyebrow?: string;
  icon?: LucideIcon;
  title?: string;
  actions?: ReactNode;
  help?: HelpKey;
  helpText?: string;
}) {
  return (
    <article className="rounded-card border border-line-strong bg-surface p-5 sm:p-6">
      {title ? (
        <PanelHeader actions={actions} eyebrow={eyebrow} help={help} helpText={helpText} icon={icon} title={title} />
      ) : null}
      {children}
    </article>
  );
}

export function PanelHeader({
  eyebrow,
  icon: Icon,
  title,
  actions,
  help,
  helpText,
}: {
  eyebrow?: string;
  icon?: LucideIcon;
  title: string;
  actions?: ReactNode;
  help?: HelpKey;
  helpText?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {Icon ? (
        <span className="grid size-10 shrink-0 place-items-center rounded-card bg-band text-accent">
          <Icon size={18} />
        </span>
      ) : null}
      <div className="min-w-0">
        {eyebrow ? <p className="text-xs font-bold uppercase tracking-[0.12em] text-accent">{eyebrow}</p> : null}
        <h2 className="mt-1 flex items-center gap-1.5 text-base font-bold tracking-[-0.02em] text-ink">
          {title}
          <HelpTip help={help} label={title} text={helpText} />
        </h2>
      </div>
      {actions ? <div className="ml-auto">{actions}</div> : null}
    </div>
  );
}

type StatTone = "default" | "dark" | "amber" | "positive";
const STAT_TONES: Record<StatTone, { card: string; chip: string; label: string; value: string; detail: string }> = {
  default: { card: "bg-surface", chip: "bg-band text-accent", label: "text-ink-subtle", value: "text-ink", detail: "text-ink-subtle" },
  dark: { card: "bg-chrome", chip: "bg-white/10 text-white", label: "text-white/60", value: "text-white", detail: "text-white/60" },
  amber: { card: "bg-warn-bg", chip: "bg-white/60 text-warn-ink", label: "text-warn-ink", value: "text-warn-ink", detail: "text-warn-ink" },
  positive: { card: "bg-ok-bg", chip: "bg-white/60 text-ok-ink", label: "text-ok-ink", value: "text-ok-ink", detail: "text-ok-ink" },
};

export function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "default",
  help,
  helpText,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone?: StatTone;
  help?: HelpKey;
  helpText?: string;
}) {
  const t = STAT_TONES[tone];
  return (
    <article className={`flex items-start justify-between gap-3 rounded-card border border-line-strong p-4 ${t.card}`}>
      <div className="min-w-0">
        <p className={`flex items-center gap-1 text-xs font-bold uppercase tracking-[0.1em] ${t.label}`}>
          {label}
          <HelpTip help={help} label={label} text={helpText} tone={tone === "dark" ? "inverse" : "muted"} />
        </p>
        <p className={`mt-2 truncate font-mono text-2xl font-medium tracking-tight ${t.value}`}>{value}</p>
        <p className={`mt-1 text-xs font-medium ${t.detail}`}>{detail}</p>
      </div>
      <span className={`grid size-9 shrink-0 place-items-center rounded-tag ${t.chip}`}>
        <Icon size={17} />
      </span>
    </article>
  );
}

export function MiniStat({
  label,
  value,
  help,
  helpText,
}: {
  label: string;
  value: string;
  help?: HelpKey;
  helpText?: string;
}) {
  return (
    <div className="rounded-tag bg-surface-alt p-3">
      <p className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-subtle">
        {label}
        <HelpTip help={help} label={label} text={helpText} />
      </p>
      <p className="mt-1 font-mono text-sm font-medium text-ink">{value}</p>
    </div>
  );
}

export function EmptyState({ text, action, href }: { text: string; action?: string; href?: string }) {
  return (
    <div className="mt-5 grid min-h-40 place-items-center rounded-card border border-dashed border-line-strong bg-surface-alt p-5 text-center">
      <div>
        <Sprout aria-hidden="true" className="mx-auto text-ink-subtle" size={24} />
        <p className="mt-2 text-sm font-bold text-ink">{text}</p>
        {action && href ? (
          <Link className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-accent" href={href}>
            {action}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
