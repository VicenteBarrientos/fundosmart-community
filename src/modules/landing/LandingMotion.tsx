"use client";

import { useEffect } from "react";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-landing-motion-root]");
    if (!root) return;

    const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-landing-motion]"));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (reducedMotion.matches) {
      root.dataset.motion = "reduced";
      sections.forEach((section) => {
        section.style.setProperty("--section-offset", "0px");
        section.style.setProperty("--section-progress", "0");
      });
      return;
    }

    let frame = 0;

    const updateSections = () => {
      frame = 0;
      const viewportHeight = window.innerHeight;

      sections.forEach((section) => {
        const bounds = section.getBoundingClientRect();
        const centerOffset = bounds.top + bounds.height / 2 - viewportHeight / 2;
        const travel = (bounds.height + viewportHeight) / 2;
        const progress = clamp(centerOffset / travel, -1, 1);
        section.style.setProperty("--section-offset", `${(progress * 28).toFixed(2)}px`);
        section.style.setProperty("--section-progress", progress.toFixed(4));
      });
    };

    const requestUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateSections);
    };

    const updatePointer = (event: PointerEvent) => {
      root.style.setProperty("--landing-pointer-x", `${(event.clientX / window.innerWidth) * 100}%`);
      root.style.setProperty("--landing-pointer-y", `${(event.clientY / window.innerHeight) * 100}%`);
    };

    root.dataset.motion = "ready";
    updateSections();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("pointermove", updatePointer, { passive: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      window.removeEventListener("pointermove", updatePointer);
    };
  }, []);

  return null;
}
