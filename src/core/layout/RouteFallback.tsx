import Link from "next/link";
import type { ReactNode } from "react";
import { FundoSmartMark } from "../brand/FundoSmartMark";

type RouteFallbackProps = {
  actions: ReactNode;
  announce?: boolean;
  description: string;
  eyebrow: string;
  title: string;
};

export function RouteFallback({ actions, announce = false, description, eyebrow, title }: RouteFallbackProps) {
  return (
    <main className="landing-page relative grid min-h-screen place-items-center overflow-hidden bg-cream px-5 py-12 text-foreground">
      <div aria-hidden="true" className="absolute -left-28 top-12 size-80 rounded-full bg-clay/20 blur-3xl" />
      <div aria-hidden="true" className="absolute -right-32 bottom-0 size-96 rounded-full bg-primary/15 blur-3xl" />

      <section
        aria-live={announce ? "assertive" : undefined}
        className="relative w-full max-w-2xl overflow-hidden rounded-[2rem] border border-border bg-white/95 p-7 shadow-[0_24px_80px_rgba(23,32,28,0.12)] sm:p-10"
        role={announce ? "alert" : undefined}
      >
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-primary via-clay to-primary" />
        <Link aria-label="FundoSmart, volver a la portada" className="inline-flex items-center gap-3 text-primary" href="/">
          <span className="grid size-10 shrink-0 place-items-center">
            <FundoSmartMark className="size-full" size={40} />
          </span>
          <span className="font-display text-xl font-semibold tracking-tight">FundoSmart</span>
        </Link>

        <p className="mt-12 text-xs font-bold uppercase tracking-[0.2em] text-primary/70">{eyebrow}</p>
        <h1 className="mt-3 max-w-xl font-display text-4xl leading-tight tracking-tight text-slate-volcanic sm:text-5xl">
          {title}
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">{description}</p>

        <div className="mt-8 flex flex-wrap gap-3">{actions}</div>

        <p className="mt-10 border-t border-border pt-5 text-xs text-muted-foreground">
          FundoSmart · Gestión ganadera hecha en el Sur de Chile
        </p>
      </section>
    </main>
  );
}
