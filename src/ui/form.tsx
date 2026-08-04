"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { HelpTip } from "./Hint";
import type { HelpKey } from "./help-copy";

/* Announced error. Existing `<ErrorMessage text={…} />` calls keep working —
   they are now read out by screen readers via role="alert". */
export function ErrorMessage({ text, id }: { text: string; id?: string }) {
  return (
    <p className="mt-3 rounded-tag bg-alert-bg px-3 py-2 text-xs font-medium text-alert-ink" id={id} role="alert">
      {text}
    </p>
  );
}

/* Label + single control, with the error wired to the input via
   aria-describedby + aria-invalid. Pass a single element child.
   <Field label="Arete" error={errors.tag}><input className="input-base" … /></Field> */
export function Field({
  label,
  children,
  error,
  required = false,
  help,
  helpText,
}: {
  label: string;
  children: ReactNode;
  error?: string;
  required?: boolean;
  help?: HelpKey;
  helpText?: string;
}) {
  const uid = useId();
  const errorId = `${uid}-error`;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: uid,
        ...(error ? { "aria-invalid": true, "aria-describedby": errorId } : {}),
      })
    : children;
  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1 text-xs font-bold uppercase tracking-[0.09em] text-ink-muted" htmlFor={uid}>
        {label}{required ? <span className="ml-0.5 text-accent">*</span> : null}
        <HelpTip help={help} label={label} text={helpText} />
      </label>
      {control}
      {error ? <ErrorMessage id={errorId} text={error} /> : null}
    </div>
  );
}

export function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
