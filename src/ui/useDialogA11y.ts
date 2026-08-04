"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* Adds Escape-to-close, a focus trap, and focus restore to an existing dialog.
   Usage:
     const ref = useRef<HTMLDivElement>(null);
     useDialogA11y(ref, onClose);
     <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}> … </div> */
export function useDialogA11y(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const items = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    (items()[0] ?? node)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusable = items();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if (!node.contains(activeEl)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [ref, onClose, active]);
}
