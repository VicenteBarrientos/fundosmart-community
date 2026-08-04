"use client";

import { ArrowRight, Menu, PlayCircle, X } from "lucide-react";
import { useState } from "react";
import { FundoSmartLogo } from "../../core/brand/FundoSmartLogo";

const NAVIGATION = [
  { href: "#producto", label: "Producto" },
  { href: "#como-funciona", label: "Cómo funciona" },
  { href: "/precios", label: "Precios" },
  { href: "#preguntas", label: "Preguntas" },
];

export function InstagramIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <rect height="18" rx="5" ry="5" width="18" x="3" y="3" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

export function LinkedinIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
    </svg>
  );
}

export function LandingNavigation() {
  const [open, setOpen] = useState(false);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 transition-all sm:px-5">
      <div className="container-page flex h-14 max-w-6xl items-center justify-between rounded-full border border-white/12 bg-[#11171C]/90 px-4 shadow-[0_18px_55px_rgba(0,0,0,0.28)] backdrop-blur-xl sm:h-16 sm:px-5">
        <a aria-label="FundoSmart, volver al inicio" className="flex items-center gap-2" href="#inicio">
          <FundoSmartLogo height={30} inverse />
        </a>
        <nav aria-label="Navegación del sitio" className="hidden items-center gap-7 lg:flex">
          {NAVIGATION.map((item) => (
            <a
              className="relative py-2 text-sm font-medium text-cream/65 transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-right after:scale-x-0 after:bg-lime after:transition-transform hover:text-cream hover:after:origin-left hover:after:scale-x-100"
              href={item.href}
              key={item.href}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-3 lg:flex">
          <a className="text-sm font-semibold text-cream/80 hover:text-cream" href="/cuenta?modo=personal&returnTo=%2Fapp">
            Ingresar
          </a>
          <a
            className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-cream transition hover:border-white/30 hover:bg-white/10"
            href="/cuenta?modo=personal&returnTo=%2Fapp"
          >
            Crear cuenta gratis
          </a>
          <a
            className="inline-flex items-center gap-1.5 rounded-full bg-clay px-4 py-2 text-sm font-bold text-slate-volcanic shadow-[0_10px_30px_rgba(208,145,77,0.2)] transition hover:-translate-y-0.5 hover:brightness-110"
            href="/demo?returnTo=%2Fapp"
          >
            Explorar demo <PlayCircle aria-hidden="true" className="size-4" />
          </a>
        </div>
        <button
          aria-expanded={open}
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          className="rounded-lg p-2 text-cream lg:hidden"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? <X aria-hidden="true" className="size-6" /> : <Menu aria-hidden="true" className="size-6" />}
        </button>
      </div>
      {open && (
        <div className="container-page mt-2 max-w-6xl overflow-hidden rounded-3xl border border-white/12 bg-[#11171C]/95 shadow-2xl backdrop-blur-xl lg:hidden">
          <div className="flex flex-col gap-1 p-4">
            {NAVIGATION.map((item) => (
              <a
                className="rounded-lg px-3 py-2.5 text-base text-cream/85 hover:bg-white/5 hover:text-lime"
                href={item.href}
                key={item.href}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </a>
            ))}
            <a
              className="mt-3 inline-flex items-center justify-center gap-2 rounded-full bg-clay px-5 py-3 text-sm font-bold text-slate-volcanic"
              href="/demo?returnTo=%2Fapp"
              onClick={() => setOpen(false)}
            >
              <PlayCircle aria-hidden="true" className="size-4" /> Explorar demo sin registro
            </a>
            <a
              className="mt-1 inline-flex items-center justify-center gap-2 rounded-full border border-cream/25 bg-white/[0.05] px-5 py-3 text-sm font-semibold text-cream"
              href="/cuenta?modo=personal&returnTo=%2Fapp"
              onClick={() => setOpen(false)}
            >
              Crear cuenta gratis <ArrowRight aria-hidden="true" className="size-4" />
            </a>
            <a className="mt-1 py-2 text-center text-sm font-semibold text-cream/65" href="/cuenta?modo=personal&returnTo=%2Fapp">Ingresar</a>
          </div>
        </div>
      )}
    </header>
  );
}
