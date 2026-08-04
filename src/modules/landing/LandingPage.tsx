import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleDollarSign,
  Database,
  FileCheck2,
  HeartPulse,
  Layers,
  MapPin,
  Milk,
  PlayCircle,
  ShieldCheck,
  Sprout,
  Users,
} from "lucide-react";
import Image from "next/image";
import { FundoSmartLogo } from "../../core/brand/FundoSmartLogo";
import { FundoSmartShield } from "../../core/brand/FundoSmartShield";
import { LandingMotion } from "./LandingMotion";
import { InstagramIcon, LandingNavigation, LinkedinIcon } from "./LandingNavigation";
import { ProductShowcase } from "./ProductShowcase";
import { Reveal } from "./Reveal";

const MODULES = [
  {
    description:
      "Predios, sectores, potreros y celdas. Subdivide y gestiona la rotación sobre mapas satelitales en tiempo real.",
    icon: MapPin,
    title: "Potreros y Pastoreo",
  },
  {
    description:
      "Maestro animal con DIIO oficial de 9 dígitos, RP y genealogía. Lotes, pesajes y movimientos entre praderas.",
    icon: Layers,
    title: "Ganado y Trazabilidad",
  },
  {
    description:
      "Controles lecheros, lactancias, eventos sanitarios, partos y reproducción en una sola ficha clínica 360.",
    icon: HeartPulse,
    title: "Ficha 360",
  },
  {
    description:
      "Producción diaria y liquidaciones comerciales. Vincula el galpón de ordeña con la planta y el retorno económico.",
    icon: Milk,
    title: "Producción de Leche",
  },
  {
    description:
      "Egresos, insumos y visión económica del predio. Entiende el costo real por litro de leche y kilo ganado.",
    icon: CircleDollarSign,
    title: "Costos y Margen",
  },
  {
    description:
      "Importación directa de archivos DBF y Excel de CLDigital, CLIWIN y Potreros sin alterar tus originales.",
    icon: Database,
    title: "Migración Cooprinsem",
  },
  {
    description:
      "Roles y permisos acotados por predio. El dueño, el administrador, el veterinario y el personal ven solo lo suyo.",
    icon: Users,
    title: "Accesos por Fundo",
  },
  {
    description:
      "Respaldo portable v1 por fundo o importación, con manifiesto de inclusiones y exclusiones. Portable workspace v2 autoservicio para owner/admin, con 33 secciones D1 y huellas. La organización controla el acceso a su información operacional.",
    icon: ShieldCheck,
    title: "Respaldo Auditable",
  },
];

const FAQ_ITEMS = [
  {
    answer:
      "No. Las herramientas de Cooprinsem construyeron la historia lechera del Sur. FundoSmart es un sistema moderno propio del predio diseñado para interoperar con esa historia y traer tus datos existentes de forma auditable.",
    question: "¿FundoSmart reemplaza a Cooprinsem?",
  },
  {
    answer:
      "Sí. Puedes cargar archivos DBF y Excel provenientes de CLDigital, CLIWIN, Potreros y Winrac. El sistema genera una vista previa, advierte inconsistencias y confirma el ingreso sin duplicar ni sobrescribir.",
    question: "¿Puedo importar mis datos existentes?",
  },
  {
    answer:
      "El foco inicial es la lechería y ganadería bovina del Sur de Chile, donde el vocabulario y las exigencias de pradera son más específicos. La base de animales, potreros y trazabilidad ganadera con vocabulario SAG también sirve para planteles de carne o mixtos.",
    question: "¿Sirve solo para lechería o también para carne?",
  },
  {
    answer:
      "Sí. El plan Gratis autogestionado incluye hasta 2 fundos y 200 potreros activos en total. Los roles y accesos se mantienen separados por predio.",
    question: "¿Funciona con varios fundos y usuarios?",
  },
  {
    answer:
      "Sí. Tus archivos originales quedan intactos y resguardados. La migración registra exactamente qué se leyó, cuándo y por quién, emitiendo un comprobante de integridad.",
    question: "¿Mis archivos originales se conservan intactos?",
  },
];

function HeroMockup() {
  return (
    <div className="relative mx-auto mt-12 w-full max-w-4xl lg:mt-16">
      <div className="absolute -inset-1.5 rounded-3xl bg-gradient-to-r from-emerald-500/30 via-lime/20 to-clay/30 blur-2xl opacity-75" />
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-[#151B21]/95 p-4 shadow-2xl backdrop-blur-xl sm:p-6">
        {/* Mockup Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-black font-bold text-white shadow-md">
              <FundoSmartLogo height={20} inverse />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-cream">Fundo El Ejemplo</h3>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-lime border border-emerald-500/30">
                  130,14 ha · Datos sintéticos
                </span>
              </div>
              <p className="text-xs text-cream/60">Fundo demo · ubicación ficticia</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-cream/80 border border-white/10">
              <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
              NDVI Satelital Actualizado
            </span>
            <span className="inline-flex items-center gap-1 rounded-lg bg-clay/20 px-3 py-1.5 text-xs font-bold text-clay border border-clay/30">
              32 Potreros
            </span>
          </div>
        </div>

        {/* Mockup Body Grid */}
        <div className="mt-4 grid gap-4 lg:grid-cols-12">
          {/* Map Preview Mockup (7 cols) */}
          <div className="relative min-h-[220px] overflow-hidden rounded-xl border border-white/10 bg-slate-800/80 lg:col-span-7">
            <Image
              alt="Vista ilustrativa de potreros de la cuenta demo"
              className="object-cover opacity-80 transition-transform duration-700 hover:scale-105"
              fill
              src="/landing/fundosmart-community-hero.webp"
              unoptimized
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#151B21] via-transparent to-black/30" />

            {/* Polygon Overlay Simulator */}
            <div className="absolute inset-4 rounded-lg border-2 border-dashed border-lime/70 bg-emerald-950/30 p-3 backdrop-blur-[2px]">
              <div className="flex items-center justify-between">
                <span className="rounded bg-black/70 px-2 py-1 text-[11px] font-bold text-lime">
                  PAMPA 1 · 2,97 ha (Disponible)
                </span>
                <span className="rounded bg-black/60 px-2 py-1 text-[10px] text-cream/80">
                  Descanso: 24 días
                </span>
              </div>
              <div className="mt-12 flex items-center justify-between text-xs text-cream">
                <span className="rounded bg-black/70 px-2 py-1 text-[10px] font-medium text-cream/90">
                  🐄 Carga Animal: 0,84 UA/ha
                </span>
                <span className="rounded bg-emerald-600/80 px-2.5 py-1 text-[10px] font-bold text-white shadow">
                  Rotación sugerida hoy
                </span>
              </div>
            </div>
          </div>

          {/* Stats Cards (5 cols) */}
          <div className="grid gap-3 lg:col-span-5">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 backdrop-blur-md">
              <div className="flex items-center justify-between text-xs text-cream/70">
                <span>Producción de Leche Hoy</span>
                <Milk className="size-4 text-lime" />
              </div>
              <p className="mt-1 font-display text-2xl font-bold text-cream">
                4.820 <span className="text-sm font-normal text-cream/60">Lts/día</span>
              </p>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-400">
                <BarChart3 className="size-3.5" /> +4.2% vs semana anterior
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 backdrop-blur-md">
              <div className="flex items-center justify-between text-xs text-cream/70">
                <span>Trazabilidad interna & DIIO</span>
                <ShieldCheck className="size-4 text-clay" />
              </div>
              <p className="mt-1 font-display text-2xl font-bold text-cream">
                184 <span className="text-sm font-normal text-cream/60">Bovinos DIIO</span>
              </p>
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-cream/80">
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-lime">FMA interno</span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-cream/70">Formato SIPEC pendiente</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Tab Bar Simulator */}
        <div className="mt-4 flex items-center justify-around rounded-xl bg-black/60 p-2 text-xs font-semibold text-cream/70 border border-white/5">
          <span className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-cream">
            <MapPin className="size-3.5 text-lime" /> RESUMEN
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 hover:text-cream">
            <Sprout className="size-3.5" /> POTREROS
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 hover:text-cream">
            <Layers className="size-3.5" /> GANADO
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 hover:text-cream">
            <Milk className="size-3.5" /> LECHE
          </span>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative isolate min-h-[90svh] overflow-hidden bg-[#151B21]" id="inicio">
      {/* Background Image: 100% Full Opacity */}
      <Image
        alt="Vacas lecheras en una pradera con el Volcán Osorno al fondo"
        className="object-cover object-center opacity-100 transition-opacity duration-700"
        fill
        priority
        sizes="100vw"
        src="/landing/fundosmart-community-hero.webp"
        unoptimized
      />

      {/* Ultra-subtle Left Fade for Text Legibility (Right 70% 100% Unshaded) */}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/20 to-transparent" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#151B21] to-transparent" />

      <div className="container-page relative z-10 pb-20 pt-28 sm:pb-28 sm:pt-36">
        <div className="flex flex-col items-start text-left max-w-2xl">
          {/* Regional Roots Badge */}
          <div className="fs-fade-up mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/40 px-4 py-1.5 text-xs font-semibold tracking-wide text-cream backdrop-blur-md">
            <MapPin aria-hidden="true" className="size-3.5 text-lime" />
            <span>Osorno · Región de Los Lagos · Sur de Chile</span>
            <span className="ml-1 rounded-full bg-lime/20 px-2 py-0.5 text-[10px] text-lime">AgTech Local</span>
          </div>

          {/* Main Editorial Headline */}
          <h1 className="fs-fade-up font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-cream sm:text-6xl lg:text-7xl text-left drop-shadow-lg">
            El fundo completo,
            <br />
            <span className="bg-gradient-to-r from-cream via-lime to-emerald-300 bg-clip-text text-transparent italic">
              en un solo sistema.
            </span>
          </h1>

          <div className="fs-fade-up my-5 h-1 w-20 rounded-full bg-clay shadow-md" />

          <p className="fs-fade-up max-w-xl text-base leading-relaxed text-cream/95 sm:text-lg drop-shadow-md">
            Decide qué hacer hoy con tus potreros, ganado, leche y costos, conservando tu historia
            Cooprinsem sin volver a la planilla.
          </p>

          <div className="fs-fade-up mt-8 flex flex-wrap items-center justify-start gap-4">
            <a
              className="group inline-flex items-center gap-2.5 rounded-full bg-clay px-7 py-4 text-base font-bold text-slate-volcanic shadow-2xl transition-all hover:-translate-y-0.5 hover:brightness-110 glow-clay-button"
              href="/demo?returnTo=%2Fapp"
            >
              Probar demo sin registro
              <PlayCircle aria-hidden="true" className="size-5" />
            </a>
            <a
              className="group inline-flex items-center gap-2 rounded-full border border-cream/40 bg-black/35 px-7 py-4 text-base font-semibold text-cream shadow-lg backdrop-blur-md transition-all hover:border-cream/70 hover:bg-black/55"
              href="/cuenta?modo=personal&returnTo=%2Fapp"
            >
              Crear cuenta gratis
              <ArrowRight aria-hidden="true" className="size-5 transition-transform group-hover:translate-x-1" />
            </a>
          </div>

          <p className="fs-fade-up mt-3.5 text-xs font-semibold text-cream/90 drop-shadow">
            Sin aprobación manual · hasta 2 fundos y 200 potreros activos.
          </p>

          <ul className="fs-fade-up mt-7 flex max-w-2xl flex-wrap gap-2 text-xs font-semibold text-cream drop-shadow sm:text-sm">
            {["Mapas satelitales de potreros", "Trazabilidad DIIO con documentos internos", "Migración Cooprinsem auditable"].map((item) => (
              <li className="flex items-center gap-2 rounded-full border border-white/15 bg-black/35 px-3 py-2 backdrop-blur-md" key={item}>
                <span className="grid size-4 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/30 text-lime">
                  <Check aria-hidden="true" className="size-3.5 text-lime" />
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <a
        aria-label="Continuar hacia el producto"
        className="absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 flex-col items-center gap-1 text-cream/70 transition-colors hover:text-cream sm:flex"
        href="#producto"
      >
        <span className="text-[11px] uppercase tracking-[0.2em]">Descubrir</span>
        <ChevronDown aria-hidden="true" className="size-4 animate-bounce" />
      </a>
    </section>
  );
}

function ProductStory() {
  const pains = [
    { label: "En terreno", text: "Información repartida entre cuadernos de campo, planillas Excel y llamados." },
    { label: "En el tiempo", text: "Historial que se pierde al cambiar de encargado, administrador o computador." },
    { label: "Entre equipos", text: "Dificultad para conciliar DIIO, partidas y eventos entre galpón y oficina." },
    { label: "Al decidir", text: "Falta de visibilidad inmediata del costo real por litro de leche o kilo ganado." },
  ];
  const model = [
    { icon: MapPin, label: "Territorio", desc: "Potreros & Celdas" },
    { icon: Layers, label: "Animales", desc: "DIIO & Lotes" },
    { icon: Milk, label: "Producción", desc: "Ordeña & Planta" },
    { icon: HeartPulse, label: "Sanidad", desc: "Ficha 360°" },
    { icon: CircleDollarSign, label: "Costos", desc: "Margen Predial" },
  ];

  return (
    <>
      <section
        className="landing-motion-section landing-challenge-section relative overflow-hidden border-t border-white/10 bg-[#171E24] py-24 text-cream sm:py-32"
        data-landing-motion
      >
        <div aria-hidden="true" className="landing-contour landing-contour-challenge" />
        <div aria-hidden="true" className="landing-section-index">03</div>
        <div className="container-page relative grid items-center gap-16 lg:grid-cols-[0.82fr_1.18fr] lg:gap-24">
          <Reveal className="landing-drift lg:sticky lg:top-28 lg:self-start" y={34}>
            <Eyebrow light>El desafío actual</Eyebrow>
            <h2 className="mt-4 max-w-xl font-display text-4xl font-bold leading-[1.06] text-cream sm:text-5xl md:text-6xl">
              Hoy la información de tu fundo vive en demasiados lugares.
            </h2>
            <p className="mt-6 max-w-lg text-base leading-relaxed text-cream/70 sm:text-lg">
              Las planillas sueltas y los programas tradicionales construyeron la industria lechera del Sur.
              FundoSmart trae esa operativa al presente en un solo sistema moderno, ordenado y trazable.
            </p>
            <div className="mt-8 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.16em] text-lime/75">
              <span className="h-px w-14 bg-lime/45" /> Del dato disperso a una decisión clara
            </div>
          </Reveal>
          <ul className="landing-challenge-list relative space-y-3">
            {pains.map((pain, index) => (
              <Reveal
                as="li"
                className={`landing-challenge-card group relative flex gap-5 overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/[0.045] p-5 backdrop-blur-md sm:p-6 ${index % 2 ? "lg:ml-10" : "lg:mr-10"}`}
                delay={index * 110}
                key={pain.label}
                y={38}
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-clay/30 bg-clay/15 font-display text-lg font-bold text-clay transition-transform duration-500 group-hover:-rotate-6 group-hover:scale-110">
                  0{index + 1}
                </span>
                <span>
                  <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-lime/65">{pain.label}</span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-cream/85 sm:text-base">{pain.text}</span>
                </span>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      <section
        className="landing-motion-section landing-model-section relative overflow-hidden bg-[#17351f] py-24 text-cream sm:py-32"
        data-landing-motion
      >
        <div aria-hidden="true" className="landing-model-orbit landing-drift" />
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-black/45 via-transparent to-[#08140d]/55" />
        <div className="container-page relative z-10">
          <Reveal className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end" y={30}>
            <div className="max-w-3xl">
              <Eyebrow light>La solución FundoSmart</Eyebrow>
              <h2 className="mt-4 font-display text-4xl font-bold leading-[1.05] sm:text-5xl md:text-6xl">
                Cinco capas.<br />Una sola memoria.
              </h2>
              <p className="mt-6 max-w-2xl text-cream/75 sm:text-lg leading-relaxed">
                El mapa, los animales, la leche, la sanidad y los costos comparten un flujo operativo
                y una historia auditable.
              </p>
            </div>
            <div className="landing-live-pill inline-flex shrink-0 items-center gap-3 self-start rounded-full border border-lime/25 bg-lime/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.15em] text-lime lg:self-auto">
              <span className="size-2 rounded-full bg-lime" /> Datos conectados
            </div>
          </Reveal>

          <div className="landing-model-grid relative mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:gap-3">
            <div aria-hidden="true" className="landing-model-connector" />
            {model.map((item, index) => (
              <Reveal
                className={`landing-node-card group relative rounded-[1.6rem] border border-white/15 bg-black/15 p-6 backdrop-blur-md ${index % 2 ? "lg:mt-8" : ""}`}
                delay={index * 110}
                key={item.label}
                y={44}
              >
                <span className="landing-node-icon mb-8 grid size-12 place-items-center rounded-2xl bg-clay text-slate-volcanic font-bold shadow-lg">
                  <item.icon aria-hidden="true" className="size-6" />
                </span>
                <span className="absolute right-5 top-5 font-display text-3xl font-bold text-white/[0.08]">0{index + 1}</span>
                <p className="font-display text-xl font-bold text-cream">{item.label}</p>
                <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-lime/75">{item.desc}</p>
              </Reveal>
            ))}
          </div>
        </div>

        <div aria-hidden="true" className="landing-data-stream mt-20 border-y border-white/10 bg-black/15 py-3">
          <div className="landing-data-stream-track">
            <span>MAPA SATELITAL</span><i /> <span>DIIO</span><i /> <span>LECHE</span><i /> <span>SANIDAD</span><i /> <span>COSTOS</span><i /> <span>TRAZABILIDAD</span><i />
            <span>MAPA SATELITAL</span><i /> <span>DIIO</span><i /> <span>LECHE</span><i /> <span>SANIDAD</span><i /> <span>COSTOS</span><i /> <span>TRAZABILIDAD</span><i />
          </div>
        </div>
      </section>
    </>
  );
}

function Modules() {
  const layouts = [
    "sm:col-span-2 lg:col-span-6 lg:row-span-2",
    "lg:col-span-3",
    "lg:col-span-3",
    "lg:col-span-3",
    "lg:col-span-3",
    "sm:col-span-2 lg:col-span-6",
    "lg:col-span-3",
    "lg:col-span-3",
  ];

  return (
    <section
      className="landing-motion-section landing-modules-section relative overflow-hidden bg-[#11171C] py-24 text-cream sm:py-32"
      data-landing-motion
      id="modulos"
    >
      <div aria-hidden="true" className="landing-contour landing-contour-modules" />
      <div className="container-page relative">
        <Reveal className="mb-14 flex flex-col justify-between gap-8 lg:flex-row lg:items-end" y={32}>
          <div className="max-w-3xl">
            <Eyebrow light>Módulos de la plataforma</Eyebrow>
            <h2 className="mt-4 font-display text-4xl font-bold leading-[1.04] text-cream sm:text-5xl md:text-6xl">
              Todo el fundo.<br />Sin cambiar de contexto.
            </h2>
          </div>
          <p className="max-w-md border-l border-clay/50 pl-5 text-base leading-7 text-cream/65">
            Ocho capacidades operativas que comparten la misma cuenta, el mismo fundo y la misma historia.
          </p>
        </Reveal>

        <div className="grid auto-rows-[minmax(12rem,auto)] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12">
          {MODULES.map((item, index) => (
            <Reveal
              className={`landing-module-card group relative flex min-h-[13rem] flex-col overflow-hidden rounded-[1.6rem] border border-white/10 bg-white/[0.045] p-6 backdrop-blur-md sm:p-7 ${layouts[index]}`}
              delay={(index % 4) * 90}
              key={item.title}
              y={36}
            >
              <div aria-hidden="true" className="landing-module-sheen" />
              <div className="flex items-start justify-between gap-4">
                <span className="grid size-11 place-items-center rounded-2xl border border-emerald-500/30 bg-emerald-500/15 text-lime transition-all duration-500 group-hover:-rotate-6 group-hover:scale-110 group-hover:bg-lime group-hover:text-slate-volcanic">
                <item.icon aria-hidden="true" className="size-5" />
                </span>
                <span className="font-display text-4xl font-bold text-white/[0.07] transition-colors group-hover:text-clay/30">0{index + 1}</span>
              </div>
              <div className="mt-auto pt-8">
                <h3 className={`${index === 0 || index === 5 ? "text-2xl sm:text-3xl" : "text-xl"} font-display font-bold text-cream`}>{item.title}</h3>
                <p className="mt-3 max-w-lg text-sm leading-relaxed text-cream/65">{item.description}</p>
              </div>
              <span aria-hidden="true" className="landing-module-line mt-5 h-px w-full bg-gradient-to-r from-lime/60 via-clay/25 to-transparent" />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Migration() {
  const steps = [
    ["01", "Sube tu archivo", "Carga archivos DBF o Excel exportados desde CLDigital, CLIWIN o Potreros. Tus originales quedan resguardados intactos."],
    ["02", "Vista previa y validación", "FundoSmart analiza los datos, muestra una vista previa clara y advierte cualquier inconsistencia antes de importar."],
    ["03", "Resolución de duplicados", "Los DIIO repetidos, IDs o datos incompletos se marcan para que los resuelvas con contexto de campo."],
    ["04", "Confirmación auditable", "El traspaso ingresa la información emitiendo un comprobante verificable con fecha, usuario y archivo de origen."],
  ];

  return (
    <section
      className="landing-motion-section landing-migration-section relative overflow-hidden border-y border-white/10 bg-[#0D1216] py-24 text-cream sm:py-32"
      data-landing-motion
      id="migracion"
    >
      <div aria-hidden="true" className="landing-migration-grid" />
      <div className="container-page relative grid gap-16 lg:grid-cols-[0.86fr_1.14fr] lg:gap-24">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Reveal y={34}>
            <Eyebrow light>Migración auditable</Eyebrow>
            <h2 className="mt-4 font-display text-4xl font-bold leading-[1.04] text-cream sm:text-5xl md:text-6xl">
              Tu historia entra.<br />Tus originales no cambian.
            </h2>
            <p className="mt-6 max-w-xl text-cream/70 sm:text-lg leading-relaxed">
              FundoSmart importa datos históricos de forma segura y auditable, sin ejecutar programas antiguos y sin alterar los archivos de origen.
            </p>
          </Reveal>

          <div aria-hidden="true" className="landing-import-orbit mt-10">
            <div className="landing-import-ring landing-import-ring-one" />
            <div className="landing-import-ring landing-import-ring-two" />
            <div className="landing-import-core">
              <FileCheck2 className="size-7" />
              <span>Historia</span>
            </div>
            <span className="landing-orbit-node landing-orbit-node-a">DBF</span>
            <span className="landing-orbit-node landing-orbit-node-b">XLS</span>
            <span className="landing-orbit-node landing-orbit-node-c">DIIO</span>
            <span className="landing-orbit-node landing-orbit-node-d">SHA</span>
          </div>
        </div>

        <ol className="landing-migration-steps relative space-y-4">
          {steps.map(([number, title, description], index) => (
            <Reveal
              as="li"
              className="landing-migration-step group relative flex gap-5 overflow-hidden rounded-[1.6rem] border border-white/10 bg-white/[0.045] p-6 backdrop-blur-md sm:gap-7 sm:p-7"
              delay={index * 120}
              key={number}
              y={44}
            >
              <span className="landing-step-number font-display text-4xl font-extrabold text-clay">{number}</span>
              <div className="relative z-10">
                <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.17em] text-lime/60">
                  Etapa {index + 1} de 4 <span className="h-px w-8 bg-lime/30" />
                </div>
                <h3 className="font-display text-xl font-bold text-cream sm:text-2xl">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-cream/65">{description}</p>
              </div>
            </Reveal>
          ))}
        </ol>

        <Reveal className="lg:col-start-2" y={20}>
          <div className="flex items-start gap-3 rounded-2xl border border-lime/15 bg-lime/[0.06] p-5 text-sm text-cream/75">
            <FileCheck2 className="mt-0.5 size-5 shrink-0 text-lime" />
            <div>
              <strong className="mb-1 block font-semibold text-cream">Cada importación deja evidencia.</strong>
              Maestro animal, DIIO, genealogía y lotes quedan vinculados a quién confirmó, cuándo y desde qué archivo.
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ["Configura tu fundo", "Define predios, sectores y potreros sobre el mapa satelital. Invita a tu equipo con los permisos adecuados."],
    ["Carga tu ganado", "Importa la historia desde Cooprinsem o crea el maestro animal directamente con DIIO y RP."],
    ["Opera el día a día", "Registra ordeña, partos, sanidad, movimientos entre potreros y peso desde terreno."],
    ["Decide y audita", "Obtén reportes claros, métricas por potrero y documentos internos de apoyo. La importación, el formato de exportación y el envío oficial SAG/SIPEC siguen pendientes."],
  ];

  return (
    <section
      className="landing-motion-section landing-route-section relative overflow-hidden bg-[#E8E2D4] py-24 text-[#131A1F] sm:py-32"
      data-landing-motion
      id="como-funciona"
    >
      <div aria-hidden="true" className="landing-route-contour" />
      <div className="container-page relative">
        <Reveal className="mb-16 flex flex-col justify-between gap-7 lg:flex-row lg:items-end" y={32}>
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-widest text-[#9A5D25]">Paso a paso</p>
            <h2 className="mt-4 font-display text-4xl font-bold leading-[1.03] sm:text-5xl md:text-6xl">
              Del primer potrero<br />a la decisión diaria.
            </h2>
          </div>
          <p className="max-w-sm text-base leading-7 text-[#344149]">
            Una ruta concreta para pasar de la configuración inicial a una operación que se puede revisar y auditar.
          </p>
        </Reveal>

        <div className="landing-route-grid relative grid gap-4 md:grid-cols-2 lg:grid-cols-4 lg:gap-3">
          <div aria-hidden="true" className="landing-route-line" />
          {steps.map(([title, description], index) => (
            <Reveal
              className={`landing-route-card group relative overflow-hidden rounded-[1.6rem] border border-black/10 bg-white/55 p-6 shadow-[0_20px_60px_rgba(30,42,36,0.08)] backdrop-blur-md sm:p-7 ${index % 2 ? "lg:mt-10" : ""}`}
              delay={index * 120}
              key={title}
              y={46}
            >
              <span className="absolute -right-2 -top-5 font-display text-[7rem] font-black leading-none text-[#163C25]/[0.055]">{index + 1}</span>
              <span className="landing-route-dot mb-10 grid size-12 place-items-center rounded-full bg-[#173D26] font-display text-xl font-bold text-white shadow-lg">
                0{index + 1}
              </span>
              <h3 className="relative font-display text-xl font-bold text-[#131A1F] sm:text-2xl">{title}</h3>
              <p className="relative mt-3 text-sm leading-relaxed text-[#46535A]">{description}</p>
            </Reveal>
          ))}
        </div>

        <div className="mt-20 flex items-center justify-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-[#536158] lg:mt-28">
          <span className="h-px flex-1 bg-black/10" /> Configura · opera · decide <span className="h-px flex-1 bg-black/10" />
        </div>
      </div>
    </section>
  );
}

function RegionalStory() {
  return (
    <section className="landing-motion-section landing-regional-section relative isolate overflow-hidden" data-landing-motion>
      <Image
        alt="Pradera del Sur de Chile con vacas y el Volcán Osorno"
        className="landing-regional-image object-cover"
        fill
        sizes="100vw"
        src="/landing/fundosmart-community-hero.webp"
        unoptimized
      />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-[#10171b]/75 via-[#0b1512]/70 to-[#10171b]/95" />
      <div aria-hidden="true" className="landing-regional-light" />
      <div className="container-page relative z-10 py-32 text-center text-cream sm:py-44">
        <Reveal className="mx-auto max-w-5xl" y={46}>
          <span aria-hidden="true" className="block font-display text-8xl leading-[0.5] text-clay/70 sm:text-9xl">“</span>
          <p className="mt-6 font-display text-3xl font-semibold leading-[1.18] text-cream sm:text-4xl md:text-6xl">
            Construido en el Sur<br />para el trabajo de verdad.
          </p>
          <p className="mx-auto mt-7 max-w-3xl text-base leading-7 text-cream/70 sm:text-lg">
            Entre el Volcán Osorno y las praderas, la lechería y la ganadería son memoria, rutina y decisiones que no pueden perderse.
          </p>
        </Reveal>
        <div className="mt-10 flex flex-wrap justify-center gap-2 text-[10px] font-bold uppercase tracking-[0.17em] text-cream/75">
          {['Osorno', 'Los Lagos', 'Los Ríos', 'Sur de Chile'].map((place) => (
            <span className="rounded-full border border-white/15 bg-black/20 px-4 py-2 backdrop-blur-md" key={place}>{place}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function FrequentlyAskedQuestions() {
  return (
    <section
      className="landing-motion-section landing-faq-section relative overflow-hidden bg-[#151B21] py-24 text-cream sm:py-32"
      data-landing-motion
      id="preguntas"
    >
      <div aria-hidden="true" className="landing-faq-glow" />
      <div className="container-page relative grid gap-14 lg:grid-cols-[0.72fr_1.28fr] lg:gap-24">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Reveal y={32}>
            <Eyebrow light>Preguntas frecuentes</Eyebrow>
            <h2 className="mt-4 font-display text-4xl font-bold leading-[1.05] text-cream sm:text-5xl md:text-6xl">
              Antes de dar<br />el primer paso.
            </h2>
            <p className="mt-6 max-w-md leading-relaxed text-cream/65">
              Respuestas directas sobre transición, datos, alcance ganadero y la cuenta gratis.
            </p>
            <a className="group mt-8 inline-flex items-center gap-2 text-sm font-bold text-lime" href="#contacto">
              ¿Quedó otra duda? Conversemos <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-1" />
            </a>
          </Reveal>
        </div>

        <div className="space-y-3">
          {FAQ_ITEMS.map((item, index) => (
            <Reveal delay={index * 70} key={item.question} y={28}>
              <FaqItem {...item} index={index} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FaqItem({ answer, index, question }: { answer: string; index: number; question: string }) {
  return (
    <details className="landing-faq-item group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]">
      <summary className="flex cursor-pointer list-none items-center gap-4 p-5 text-left sm:p-6">
        <span className="font-display text-sm font-bold text-clay">0{index + 1}</span>
        <span className="flex-1 font-display text-lg font-bold text-cream sm:text-xl">{question}</span>
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-white/10 bg-black/15 transition-colors group-open:border-lime/30 group-open:bg-lime/10">
          <ChevronDown aria-hidden="true" className="size-4 text-lime transition-transform duration-500 group-open:rotate-180" />
        </span>
      </summary>
      <div className="landing-faq-answer px-5 pb-6 pl-[4.25rem] pr-12 text-sm leading-relaxed text-cream/65 sm:text-base">{answer}</div>
    </details>
  );
}

function Contact() {
  return (
    <section
      className="landing-motion-section relative overflow-hidden bg-[#10161A] py-16 text-cream sm:py-24"
      data-landing-motion
      id="contacto"
    >
      <div className="container-page relative">
        <div className="landing-cta-panel relative overflow-hidden rounded-[2rem] border border-white/10 px-6 py-16 sm:px-10 sm:py-20 lg:px-16">
          <div aria-hidden="true" className="landing-cta-beam" />
          <div aria-hidden="true" className="landing-cta-rings" />
          <div className="relative z-10 grid gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-20">
            <Reveal y={38}>
              <Eyebrow light>Comienza gratis hoy</Eyebrow>
              <h2 className="mt-4 max-w-2xl font-display text-4xl font-bold leading-[1.02] sm:text-5xl md:text-6xl">
                Ordena el fundo.<br />Conserva su historia.
              </h2>
              <p className="mt-6 max-w-2xl text-cream/75 sm:text-lg leading-relaxed">
                Crea tu cuenta gratis en menos de 2 minutos y administra hasta 2 fundos y 200 potreros sin costo. Sin tarjeta ni aprobación manual.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <a
                  className="group inline-flex items-center gap-2 rounded-full bg-clay px-7 py-4 text-base font-bold text-slate-volcanic transition hover:-translate-y-0.5 hover:brightness-110 glow-clay-button"
                  href="/cuenta?modo=personal&returnTo=%2Fapp"
                >
                  Crear cuenta gratis <ArrowRight aria-hidden="true" className="size-5 transition-transform group-hover:translate-x-1" />
                </a>
                <a
                  className="inline-flex items-center gap-2 rounded-full border border-cream/25 bg-black/15 px-6 py-4 text-base font-semibold text-cream backdrop-blur-md transition hover:border-lime/50 hover:bg-white/10"
                  href="/demo?returnTo=%2Fapp"
                >
                  Explorar demo <PlayCircle aria-hidden="true" className="size-5 text-lime" />
                </a>
              </div>

              <div className="mt-8 flex items-center gap-4 text-xs font-semibold text-cream/55">
                <span>Sin tarjeta</span><i className="size-1 rounded-full bg-lime" /><span>Sin espera</span><i className="size-1 rounded-full bg-lime" /><span>Datos demo aislados</span>
              </div>
            </Reveal>

            <Reveal className="landing-security-card relative rounded-[1.75rem] border border-white/15 bg-white/[0.075] p-7 backdrop-blur-xl sm:p-9" delay={140} y={46}>
              <div className="landing-security-shield relative grid size-14 place-items-center rounded-2xl bg-clay text-slate-volcanic font-bold shadow-lg">
                <FundoSmartShield className="size-8" />
              </div>
              <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.18em] text-lime/75">Control por organización</p>
              <h3 className="mt-3 font-display text-2xl font-bold sm:text-3xl">Tu organización controla el acceso a sus datos.</h3>
              <p className="mt-4 text-sm leading-relaxed text-cream/70 sm:text-base">
                Los permisos se acotan por predio, los originales no cambian y cada importación emite evidencia verificable.
              </p>

              <ul className="mt-7 grid gap-3 text-sm font-medium text-cream/85 sm:grid-cols-2">
                {["Acceso seguro por identidad", "Roles separados por predio", "Respaldo portable v1 con exclusiones declaradas", "Portable workspace v2 para owner/admin con 33 secciones D1"].map((item) => (
                  <li className="flex items-center gap-2" key={item}>
                    <span className="grid size-5 place-items-center rounded-full bg-lime/10"><Check aria-hidden="true" className="size-3.5 text-lime" /></span> {item}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs font-semibold text-cream/55">
          <span>FundoSmart · Osorno</span>
          <a className="inline-flex items-center gap-2 transition-colors hover:text-lime" href="https://www.instagram.com/fundosmart/?hl=es-la" rel="noopener noreferrer" target="_blank"><InstagramIcon className="size-4" /> Instagram</a>
          <a className="inline-flex items-center gap-2 transition-colors hover:text-lime" href="https://www.linkedin.com/company/fundosmart/?viewAsMember=true" rel="noopener noreferrer" target="_blank"><LinkedinIcon className="size-4" /> LinkedIn</a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-[#12171C] py-14 text-cream/70 border-t border-white/10">
      <div className="container-page">
        <div className="flex flex-col justify-between gap-8 border-b border-white/10 pb-10 md:flex-row md:items-start">
          <div className="max-w-sm text-cream">
            <FundoSmartLogo height={32} inverse />
            <p className="mt-3 text-xs leading-relaxed text-cream/65">
              Plataforma de gestión ganadera y predial del Sur de Chile. Diseñada con mirada local para el campo de verdad.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-4">
            <FooterLinks heading="Producto" links={[["Módulos", "#modulos"], ["Migración", "#migracion"], ["Cómo funciona", "#como-funciona"]]} />
            <FooterLinks
              heading="Recursos"
              links={[
                ["Preguntas", "#preguntas"],
                ["Contacto", "#contacto"],
                ["Privacidad", "/privacidad"],
                ["Términos", "/terminos"],
              ]}
            />
            <div>
              <p className="mb-3 font-semibold text-cream">Redes Sociales</p>
              <ul className="space-y-2 text-xs">
                <li>
                  <a
                    className="inline-flex items-center gap-2 text-cream/75 hover:text-lime transition-colors"
                    href="https://www.instagram.com/fundosmart/?hl=es-la"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <InstagramIcon className="size-4 text-lime" />
                    <span>Instagram</span>
                  </a>
                </li>
                <li>
                  <a
                    className="inline-flex items-center gap-2 text-cream/75 hover:text-lime transition-colors"
                    href="https://www.linkedin.com/company/fundosmart/?viewAsMember=true"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <LinkedinIcon className="size-4 text-lime" />
                    <span>LinkedIn</span>
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-3 font-semibold text-cream">Acceso</p>
              <a className="text-cream/75 hover:text-lime text-xs block mb-2" href="/app">Ingresar a FundoSmart</a>
              <a className="text-lime font-bold text-xs hover:underline" href="/cuenta?modo=personal&returnTo=%2Fapp">Crear Cuenta Gratis</a>
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-4 pt-6 text-xs text-cream/60 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} FundoSmart · Osorno, Chile</p>
          <div className="flex items-center gap-4">
            <a
              className="flex items-center gap-1.5 text-cream/75 hover:text-lime transition-colors"
              href="https://www.instagram.com/fundosmart/?hl=es-la"
              rel="noopener noreferrer"
              target="_blank"
            >
              <InstagramIcon className="size-3.5 text-lime" /> Instagram
            </a>
            <span className="text-white/20">•</span>
            <a
              className="flex items-center gap-1.5 text-cream/75 hover:text-lime transition-colors"
              href="https://www.linkedin.com/company/fundosmart/?viewAsMember=true"
              rel="noopener noreferrer"
              target="_blank"
            >
              <LinkedinIcon className="size-3.5 text-lime" /> LinkedIn
            </a>
          </div>
          <p>Cuenta Gratis autogestionada · Orgullosamente del Sur.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterLinks({ heading, links }: { heading: string; links: string[][] }) {
  return (
    <div>
      <p className="mb-3 font-semibold text-cream">{heading}</p>
      <ul className="space-y-2">
        {links.map(([label, href]) => (
          <li key={href}>
            <a className="text-xs text-cream/75 hover:text-lime transition-colors" href={href}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Eyebrow({ children, light = false }: { children: string; light?: boolean }) {
  return (
    <p className={`text-xs font-bold uppercase tracking-widest ${light ? "text-clay" : "text-lime"}`}>
      {children}
    </p>
  );
}

function InteractiveShowcase() {
  return (
    <section className="landing-field-grid relative overflow-hidden border-t border-white/10 bg-[#11171C] py-20 text-cream sm:py-28" id="producto">
      <div aria-hidden="true" className="absolute -right-24 top-24 size-96 rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="container-page relative">
        <div className="max-w-4xl">
          <Eyebrow light>Producto real · cuenta demo</Eyebrow>
          <h2 className="mt-4 max-w-3xl font-display text-4xl font-bold leading-[1.05] text-cream sm:text-5xl md:text-6xl">
            No imagines el sistema. Recorre el fundo demo.
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-cream/65 sm:text-lg">
            Estas son pantallas reales de FundoSmart con datos ficticios y aislados. La misma experiencia
            conecta el trabajo diario, el territorio y la historia de cada animal.
          </p>
          <div className="mt-6 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full border border-lime/25 bg-lime/10 px-3 py-1.5 text-lime">Trazabilidad interna &amp; DIIO</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-cream/65">FMA interno</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-cream/65">Formato SIPEC pendiente</span>
          </div>
        </div>

        <ProductShowcase />

        <noscript>
          <div className="mt-10">
            <HeroMockup />
          </div>
        </noscript>

        <div className="mt-10 flex flex-col gap-4 border-t border-white/10 pt-7 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-cream/55">
            Entra sin registrarte. La demo no toca información real y permite recorrer potreros, ganado,
            leche, costos e importaciones.
          </p>
          <a
            className="group inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-lime px-5 py-3 text-sm font-bold text-[#11171C] transition hover:-translate-y-0.5 hover:brightness-105"
            href="/demo?returnTo=%2Fapp"
          >
            Abrir Fundo El Ejemplo
            <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-1" />
          </a>
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <div className="landing-page min-h-screen bg-[#151B21] font-landing text-cream">
      <LandingNavigation />
      <main>
        <Hero />
        <InteractiveShowcase />
        <div className="landing-motion-root" data-landing-motion-root>
          <LandingMotion />
          <ProductStory />
          <Modules />
          <Migration />
          <HowItWorks />
          <RegionalStory />
          <FrequentlyAskedQuestions />
          <Contact />
        </div>
      </main>
      <Footer />
    </div>
  );
}
