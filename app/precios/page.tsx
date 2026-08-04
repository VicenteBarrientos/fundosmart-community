import Link from "next/link";
import { ArrowLeft, Check, Sparkles, Zap, ChevronRight } from "lucide-react";
import { PLAN_CATALOG } from "@/src/modules/plan/catalog.mjs";

export const metadata = {
  title: "Planes y Precios · FundoSmart",
  description: "Planes de gestión agrícola y lechera FundoSmart. Transparencia total sin cobros sorpresa.",
};

export default function PreciosPage() {
  const freePlan = PLAN_CATALOG.free;
  const proPlan = PLAN_CATALOG.pro;

  return (
    <main className="min-h-screen bg-surface-alt py-12 px-4 sm:px-6 lg:px-8 font-sans text-ink">
      <div className="mx-auto max-w-5xl">
        <Link
          className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wider text-accent hover:underline mb-8"
          href="/"
        >
          <ArrowLeft size={14} /> Volver a FundoSmart
        </Link>

        <div className="text-center max-w-3xl mx-auto">
          <span className="inline-flex items-center gap-2 rounded-full bg-band px-3 py-1 text-xs font-black text-accent uppercase tracking-wider mb-4">
            <Zap size={14} /> Precios Transparentes
          </span>
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-ink">
            Planes diseñados para la realidad del campo chileno
          </h1>
          <p className="mt-3 text-sm sm:text-base text-ink-muted leading-relaxed">
            Comienza gratis con tu cuenta personal y escala a Pro solo cuando tu equipo lo necesite. Sin contratos amarrados ni cobros ocultos.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch">
          {/* Plan Gratis */}
          <div className="rounded-3xl border border-line-steel bg-white p-8 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black text-ink">{freePlan.name}</h2>
                <span className="rounded-full bg-surface-alt px-3 py-1 text-xs font-bold text-ink-subtle">Autoservicio</span>
              </div>
              <p className="mt-2 text-xs text-ink-muted leading-5">{freePlan.description}</p>

              <div className="mt-6 flex items-baseline">
                <span className="text-4xl font-black text-ink">$0</span>
                <span className="ml-2 text-xs font-bold text-ink-subtle">/ mes para siempre</span>
              </div>

              <ul className="mt-8 space-y-3 text-xs text-ink">
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Hasta <strong>2 fundos</strong> activos</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Hasta <strong>200 potreros</strong> activos</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Hasta <strong>5 colaboradores</strong> por espacio</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Agenda diaria &ldquo;Hoy en el fundo&rdquo;</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Importación de control lechero Survet / Watt&apos;s</span>
                </li>
              </ul>
            </div>

            <div className="mt-8 pt-6 border-t border-line-steel">
              <Link
                className="w-full inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line-strong bg-white font-black text-ink text-xs transition hover:bg-surface-alt"
                href="/cuenta?modo=personal"
              >
                Comenzar Gratis
              </Link>
            </div>
          </div>

          {/* Plan Pro */}
          <div className="rounded-3xl border-2 border-accent bg-white p-8 shadow-md flex flex-col justify-between relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-accent text-ink text-[11px] font-black uppercase px-4 py-1 rounded-bl-xl tracking-wider">
              Recomendado
            </div>

            <div>
              <div className="flex items-center gap-2">
                <Sparkles size={20} className="text-accent" />
                <h2 className="text-2xl font-black text-ink">{proPlan.name}</h2>
              </div>
              <p className="mt-2 text-xs text-ink-muted leading-5">{proPlan.description}</p>

              <div className="mt-6 flex items-baseline">
                <span className="text-4xl font-black text-ink">$49.000</span>
                <span className="ml-2 text-xs font-bold text-ink-subtle">CLP + IVA / mes</span>
              </div>

              <ul className="mt-8 space-y-3 text-xs text-ink">
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Fundos <strong>ilimitados</strong></span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Hasta <strong>2.000 potreros</strong> activos</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Colaboradores <strong>ilimitados</strong></span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Alertas sanitarias mamarias avanzadas</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Exportación masiva de reportes y auditorías</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={16} className="text-accent shrink-0" />
                  <span>Soporte prioritario directo con ingenieros</span>
                </li>
              </ul>
            </div>

            <div className="mt-8 pt-6 border-t border-line-steel">
              <Link
                className="w-full inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent text-ink font-black text-xs transition hover:bg-accent-hover"
                href="mailto:soporte@fundosmart.com?subject=Solicitud%20Plan%20Pro%20FundoSmart"
              >
                Solicitar Plan Pro <ChevronRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
