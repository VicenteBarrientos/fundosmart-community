"use client";

import { ArrowUpRight, Beef, LayoutDashboard, Map as MapIcon } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

const SHOWCASES = [
  {
    alt: "Resumen real de la cuenta demo FundoSmart con superficie, animales y agenda del día",
    description:
      "Superficie, ganado, leche y tareas urgentes convergen en una sola lectura. El equipo empieza por lo que requiere atención, no por buscar datos.",
    facts: ["130,1 ha conectadas", "92 animales", "Agenda priorizada"],
    icon: LayoutDashboard,
    id: "hoy",
    image: "/landing/product-overview.png",
    label: "Hoy",
    title: "Tu campo, en una mirada",
  },
  {
    alt: "Mapa sintético de potreros de la cuenta demo FundoSmart con límites y directorio territorial",
    description:
      "Los potreros dejan de ser nombres en una planilla. Límites, superficie, carga animal y rotación viven sobre el mismo territorio que operas.",
    facts: ["14 potreros", "Carga animal", "Rotación visible"],
    icon: MapIcon,
    id: "potreros",
    image: "/landing/product-paddocks-community.svg",
    label: "Potreros",
    title: "Opera el territorio sobre el mapa",
  },
  {
    alt: "Agenda real de ganado de la cuenta demo FundoSmart con tareas, DIIO y seguimiento",
    description:
      "Cada DIIO termina en una acción concreta. Agenda, lotes, pesajes, reproducción y trazabilidad permanecen unidos al historial del animal.",
    facts: ["DIIO individual", "Pesajes y lotes", "Agenda sanitaria"],
    icon: Beef,
    id: "ganado",
    image: "/landing/product-livestock.png",
    label: "Ganado",
    title: "Cada animal conserva su historia",
  },
] as const;

export function ProductShowcase() {
  const [activeId, setActiveId] = useState<(typeof SHOWCASES)[number]["id"]>("hoy");
  const active = SHOWCASES.find((item) => item.id === activeId) ?? SHOWCASES[0];

  return (
    <div className="mt-10 grid items-center gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-12">
      <div>
        <div aria-label="Vistas reales del producto" className="grid gap-2" role="group">
          {SHOWCASES.map((item, index) => {
            const Icon = item.icon;
            const selected = item.id === active.id;

            return (
              <button
                aria-pressed={selected}
                className={`group flex min-h-16 items-center gap-4 rounded-2xl border px-4 py-3 text-left transition-all duration-300 sm:px-5 ${
                  selected
                    ? "border-lime/45 bg-white/[0.08] text-cream shadow-[0_18px_55px_rgba(0,0,0,0.22)]"
                    : "border-white/10 bg-black/10 text-cream/60 hover:border-white/20 hover:bg-white/[0.04] hover:text-cream"
                }`}
                key={item.id}
                onClick={() => setActiveId(item.id)}
                type="button"
              >
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-xl border ${
                    selected
                      ? "border-lime/35 bg-lime/15 text-lime"
                      : "border-white/10 bg-black/20 text-cream/45 group-hover:text-cream"
                  }`}
                >
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-clay">
                    0{index + 1}
                  </span>
                  <span className="mt-0.5 block text-sm font-bold sm:text-base">{item.label}</span>
                </span>
                <ArrowUpRight
                  aria-hidden="true"
                  className={`size-4 transition-transform ${selected ? "text-lime" : "text-cream/30 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"}`}
                />
              </button>
            );
          })}
        </div>

        <div aria-live="polite" className="mt-7">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-lime">{active.label}</p>
          <h3 className="mt-3 font-display text-3xl font-bold leading-tight text-cream sm:text-4xl">
            {active.title}
          </h3>
          <p className="mt-4 max-w-xl text-sm leading-7 text-cream/65 sm:text-base">
            {active.description}
          </p>
          <ul className="mt-5 flex flex-wrap gap-2">
            {active.facts.map((fact) => (
              <li
                className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-semibold text-cream/75"
                key={fact}
              >
                {fact}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="landing-product-frame relative min-w-0">
        <div aria-hidden="true" className="landing-product-aura" />
        <div className="relative overflow-hidden rounded-[1.35rem] border border-white/15 bg-[#0D1115] shadow-[0_35px_100px_rgba(0,0,0,0.5)]">
          <div className="flex h-11 items-center gap-2 border-b border-white/10 bg-[#11171C] px-4">
            <span className="size-2.5 rounded-full bg-[#EF6B62]" />
            <span className="size-2.5 rounded-full bg-clay" />
            <span className="size-2.5 rounded-full bg-lime" />
            <span className="mx-auto hidden rounded-full border border-white/10 bg-white/[0.04] px-5 py-1 text-[10px] font-medium text-cream/45 sm:block">
              fundosmart.com/app · cuenta demo
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-lime sm:ml-0">
              <span className="size-1.5 rounded-full bg-lime" /> En vivo
            </span>
          </div>
          <div className="relative aspect-[16/10] overflow-hidden bg-[#E9ECEE]">
            <Image
              alt={active.alt}
              className="object-cover object-top"
              fill
              key={active.image}
              sizes="(min-width: 1024px) 58vw, 100vw"
              src={active.image}
              unoptimized
            />
          </div>
        </div>
        <div className="relative mx-auto -mt-px h-4 w-[92%] rounded-b-[2rem] border-x border-b border-white/10 bg-gradient-to-b from-white/10 to-transparent" />
      </div>
    </div>
  );
}
