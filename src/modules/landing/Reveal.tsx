"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type RevealProps = {
  as?: "article" | "div" | "li" | "section" | "span";
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
};

export function Reveal({
  as: Tag = "div",
  children,
  className = "",
  delay = 0,
  y = 24,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!element || reducedMotion || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const style: CSSProperties = {
    opacity: shown ? 1 : 0,
    transform: shown ? "translate3d(0,0,0)" : `translate3d(0, ${y}px, 0)`,
    transition: `opacity 700ms cubic-bezier(.2,.7,.2,1) ${delay}ms, transform 900ms cubic-bezier(.2,.7,.2,1) ${delay}ms`,
    willChange: "opacity, transform",
  };

  return (
    // React's ref type cannot infer an element from a runtime-selected tag.
    // @ts-expect-error dynamic semantic element
    <Tag className={className} ref={ref} style={style}>
      {children}
    </Tag>
  );
}
