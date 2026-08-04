"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { Hint } from "./Hint";
import type { HelpKey } from "./help-copy";

/* localStorage helpers — safe under SSR and privacy mode (no throw escapes). */
function readStore(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function writeStore(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    return;
  }
}

type DisclosureProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  icon?: LucideIcon;
  meta?: ReactNode;
  help?: HelpKey;
  helpText?: string;
};

/* Shared presentation: squared card, uppercase header, grid-rows height animation.
   Collapsed content is `inert`, so it is removed from tab order and the a11y tree.

   La ayuda se monta como envoltorio y no como botón ⓘ dentro de la cabecera:
   un botón anidado dentro de otro botón no es HTML válido. */
function Disclosure({ title, open, onToggle, children, icon: Icon, meta, help, helpText }: DisclosureProps) {
  const uid = useId();
  const panelId = `${uid}-panel`;
  const buttonId = `${uid}-button`;

  return (
    <section className="overflow-hidden rounded-card border border-line-strong bg-surface-steel">
      <Hint className="block" help={help} text={helpText}>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className="flex w-full items-center gap-3 bg-band px-4 py-3 text-left transition-colors hover:bg-line-steel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          id={buttonId}
          onClick={onToggle}
          type="button"
        >
          {Icon ? <Icon aria-hidden="true" className="shrink-0 text-accent" size={16} /> : null}
          <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink">{title}</span>
          {meta ? <span className="ml-auto text-[12px] font-semibold text-ink-muted">{meta}</span> : null}
          <ChevronDown
            aria-hidden="true"
            className={`${meta ? "ml-2" : "ml-auto"} shrink-0 text-ink-muted transition-transform duration-200 motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
            size={16}
          />
        </button>
      </Hint>
      <div
        aria-labelledby={buttonId}
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
        id={panelId}
        inert={!open || undefined}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-line-steel px-4 py-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

type CollapsibleProps = {
  title: string;
  children: ReactNode;
  icon?: LucideIcon;
  meta?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  persistKey?: string;
  help?: HelpKey;
  helpText?: string;
};

/* Standalone collapsible.
   - Uncontrolled by default (`defaultOpen`).
   - Controlled via `open` + `onOpenChange`.
   - `persistKey` remembers the open state in localStorage (uncontrolled only). */
export function Collapsible({
  title,
  children,
  icon,
  meta,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  persistKey,
  help,
  helpText,
}: CollapsibleProps) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);

  useEffect(() => {
    if (isControlled || !persistKey) return;
    const stored = readStore(persistKey);
    if (stored !== null) setInternalOpen(stored);
  }, [isControlled, persistKey]);

  const open = isControlled ? Boolean(openProp) : internalOpen;

  const toggle = () => {
    const next = !open;
    onOpenChange?.(next);
    if (isControlled) return;
    setInternalOpen(next);
    if (persistKey) writeStore(persistKey, next);
  };

  return (
    <Disclosure help={help} helpText={helpText} icon={icon} meta={meta} onToggle={toggle} open={open} title={title}>
      {children}
    </Disclosure>
  );
}

/* Accordion: a group where at most one item is open at a time. */
type AccordionContextValue = { openKey: string | null; toggle: (key: string) => void };
const AccordionContext = createContext<AccordionContextValue | null>(null);

export function Accordion({
  children,
  defaultOpenKey = null,
}: {
  children: ReactNode;
  defaultOpenKey?: string | null;
}) {
  const [openKey, setOpenKey] = useState<string | null>(defaultOpenKey);
  const toggle = (key: string) => setOpenKey((current) => (current === key ? null : key));
  return (
    <div className="space-y-2">
      <AccordionContext.Provider value={{ openKey, toggle }}>{children}</AccordionContext.Provider>
    </div>
  );
}

export function AccordionItem({
  itemKey,
  title,
  children,
  icon,
  meta,
  help,
  helpText,
}: {
  itemKey: string;
  title: string;
  children: ReactNode;
  icon?: LucideIcon;
  meta?: ReactNode;
  help?: HelpKey;
  helpText?: string;
}) {
  const ctx = useContext(AccordionContext);
  if (!ctx) throw new Error("AccordionItem must be used inside <Accordion>.");
  const open = ctx.openKey === itemKey;
  return (
    <Disclosure
      help={help}
      helpText={helpText}
      icon={icon}
      meta={meta}
      onToggle={() => ctx.toggle(itemKey)}
      open={open}
      title={title}
    >
      {children}
    </Disclosure>
  );
}
