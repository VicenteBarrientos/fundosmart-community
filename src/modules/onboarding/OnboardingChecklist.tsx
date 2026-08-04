"use client";

import { FeedbackDialog } from "@/src/modules/feedback/FeedbackDialog";
import {
  buildOnboardingSteps,
  dismissOnboarding,
  loadOnboardingState,
  reconcileOnboardingState,
  resumeOnboarding,
  saveOnboardingState,
  selectOnboardingPath,
  type OnboardingFacts,
  type OnboardingPath,
  type OnboardingState,
  type OnboardingStorage,
} from "./domain/onboarding-progress.mjs";
import {
  ArrowRight,
  Check,
  Circle,
  Database,
  FileSpreadsheet,
  PencilLine,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type OnboardingChecklistProps = {
  canImport: boolean;
  facts: OnboardingFacts & {
    firstFieldId: string | null;
  };
  scope: string;
};

const PATH_OPTIONS: Array<{
  path: OnboardingPath;
  title: string;
  detail: string;
  icon: LucideIcon;
}> = [
  {
    path: "cooprinsem",
    title: "Migrar Cooprinsem",
    detail: "Trae tus DBF al flujo de conciliación auditable.",
    icon: Database,
  },
  {
    path: "spreadsheet",
    title: "Importar una planilla",
    detail: "Parte desde un CSV o XLSX y revisa el mapeo antes de guardar.",
    icon: FileSpreadsheet,
  },
  {
    path: "manual",
    title: "Empezar manualmente",
    detail: "Crea el fundo, dibuja potreros y registra el primer manejo.",
    icon: PencilLine,
  },
];

export function OnboardingChecklist({
  canImport,
  facts,
  scope,
}: OnboardingChecklistProps) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const canonicalFacts = useMemo<OnboardingFacts>(() => ({
    fieldCount: facts.fieldCount,
    paddockCount: facts.paddockCount,
    hasFirstAction: facts.hasFirstAction,
  }), [facts.fieldCount, facts.hasFirstAction, facts.paddockCount]);

  useEffect(() => {
    const hydration = window.setTimeout(() => {
      const now = new Date().toISOString();
      const storage = browserStorage();
      const reconciled = reconcileOnboardingState(
        loadOnboardingState(storage, scope, now),
        canonicalFacts,
        now,
      );
      saveOnboardingState(storage, scope, reconciled);
      setState(reconciled);
    }, 0);
    return () => window.clearTimeout(hydration);
  }, [canonicalFacts, scope]);

  const steps = useMemo(
    () => state ? buildOnboardingSteps(state, canonicalFacts) : [],
    [canonicalFacts, state],
  );

  if (!state || state.status === "completed") return null;

  function persist(next: OnboardingState) {
    setState(next);
    saveOnboardingState(browserStorage(), scope, next);
  }

  if (state.status === "dismissed") {
    return (
      <section
        aria-label="Onboarding pausado"
        className="mt-6 flex flex-col gap-3 rounded-[18px] border border-line-steel bg-white px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-band text-accent">
            <Sparkles size={16} />
          </span>
          <div>
            <p className="text-xs font-black text-ink">Tu guía quedó pausada</p>
            <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">
              Tus fundos, potreros y registros siguen intactos. Puedes retomarla cuando quieras.
            </p>
          </div>
        </div>
        <button
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white"
          onClick={() => persist(resumeOnboarding(state))}
          type="button"
        >
          <RotateCcw size={14} /> Retomar configuración
        </button>
      </section>
    );
  }

  const completedSteps = steps.filter((step) => step.completed).length;
  const recommendation = recommendedAction(state.path, facts, canImport);

  return (
    <section
      aria-labelledby="onboarding-title"
      className="mt-6 overflow-hidden rounded-[24px] border border-accent/30 bg-white shadow-[0_16px_45px_rgba(23,59,45,0.08)]"
    >
      <header className="flex flex-col gap-4 bg-[linear-gradient(110deg,#173b2d_0%,#214f3c_68%,#527a2a_100%)] px-5 py-5 text-white sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent text-white">
            <Sparkles size={20} />
          </span>
          <div>
            <p className="text-[12px] font-black uppercase tracking-[0.16em] text-white/55">
              Primer valor · menos de 30 minutos
            </p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.035em]" id="onboarding-title">
              Pon tu espacio en marcha
            </h2>
            <p className="mt-1 max-w-2xl text-xs font-semibold leading-5 text-white/68">
              Elige una ruta. El avance real se confirma desde tus datos, no desde casillas marcadas a mano.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-black">
            {completedSteps} de {steps.length} pasos
          </span>
          <button
            aria-label="Cerrar guía de inicio por ahora"
            className="grid size-10 place-items-center rounded-xl bg-white/10 text-white/75 transition hover:bg-white/15 hover:text-white"
            onClick={() => persist(dismissOnboarding(state))}
            title="Cerrar por ahora"
            type="button"
          >
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="grid gap-6 px-5 py-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] lg:px-6">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.12em] text-ink-subtle">
            ¿Cómo quieres comenzar?
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {PATH_OPTIONS.map((option) => (
              <PathOption
                detail={option.detail}
                disabled={!canImport && option.path !== "manual"}
                href={pathDestination(option.path, facts)}
                icon={option.icon}
                key={option.path}
                onChoose={() => persist(selectOnboardingPath(state, option.path))}
                selected={state.path === option.path}
                title={option.title}
              />
            ))}
          </div>
          {!canImport && (
            <p className="mt-2 rounded-xl bg-surface-alt px-3 py-2 text-[11px] font-bold leading-4 text-ink-subtle">
              Tu rol puede empezar manualmente. Un owner, admin o manager debe realizar importaciones.
            </p>
          )}

          <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-accent/25 bg-band p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.12em] text-accent">
                Siguiente paso recomendado
              </p>
              <p className="mt-1 text-sm font-black text-ink">{recommendation.title}</p>
              <p className="mt-1 text-[12px] leading-5 text-ink-muted">{recommendation.detail}</p>
            </div>
            <Link
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white"
              href={recommendation.href}
              onClick={() => {
                if (recommendation.path && state.path !== recommendation.path) {
                  persist(selectOnboardingPath(state, recommendation.path));
                }
              }}
            >
              {recommendation.action} <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        <ol className="space-y-2" aria-label="Progreso del onboarding">
          {steps.map((step, index) => (
            <li
              className={`flex gap-3 rounded-2xl border px-3.5 py-3 ${
                step.completed
                  ? "border-accent/20 bg-band"
                  : index === steps.findIndex((candidate) => !candidate.completed)
                    ? "border-accent bg-white"
                    : "border-line-steel bg-surface-alt"
              }`}
              key={step.id}
            >
              <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ${
                step.completed ? "bg-accent text-white" : "bg-white text-ink-subtle"
              }`}>
                {step.completed ? <Check size={14} strokeWidth={3} /> : <Circle size={13} />}
              </span>
              <div>
                <p className="text-xs font-black text-ink">{step.label}</p>
                <p className="mt-0.5 text-[11px] font-semibold leading-4 text-ink-subtle">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <footer className="flex flex-col gap-3 border-t border-line-steel bg-surface-alt px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 shrink-0 text-accent" size={16} />
          <p className="max-w-2xl text-[11px] font-semibold leading-5 text-ink-muted">
            La demo usa datos ficticios y cambia temporalmente al espacio “Fundo El Ejemplo”.
            Vuelve a “Mi cuenta” desde la barra superior para continuar con tus datos.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-[11px] font-black text-accent"
            href="/demo?returnTo=%2Fapp"
          >
            <Sparkles size={13} /> Explorar demo
          </a>
          <FeedbackDialog variant="onboarding" />
        </div>
      </footer>
    </section>
  );
}

function PathOption({
  detail,
  disabled,
  href,
  icon: Icon,
  onChoose,
  selected,
  title,
}: {
  detail: string;
  disabled: boolean;
  href: string;
  icon: LucideIcon;
  onChoose: () => void;
  selected: boolean;
  title: string;
}) {
  const content = (
    <>
      <span className={`grid size-9 place-items-center rounded-xl ${
        selected ? "bg-accent text-white" : "bg-surface-alt text-accent"
      }`}>
        <Icon size={17} />
      </span>
      <span className="mt-3 block text-xs font-black text-ink">{title}</span>
      <span className="mt-1 block text-[11px] font-semibold leading-4 text-ink-subtle">{detail}</span>
      <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-black text-accent">
        {selected ? "Continuar por aquí" : "Elegir esta ruta"} <ArrowRight size={12} />
      </span>
    </>
  );

  if (disabled) {
    return (
      <div
        aria-disabled="true"
        className="min-h-44 rounded-2xl border border-line-steel bg-surface-alt p-3 opacity-60"
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      aria-current={selected ? "step" : undefined}
      className={`min-h-44 rounded-2xl border p-3 transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        selected
          ? "border-accent bg-band shadow-[0_0_0_1px_rgba(82,156,78,0.16)]"
          : "border-line-steel bg-white hover:-translate-y-0.5 hover:border-accent hover:shadow-sm"
      }`}
      href={href}
      onClick={onChoose}
    >
      {content}
    </Link>
  );
}

function pathDestination(
  path: OnboardingPath,
  facts: OnboardingChecklistProps["facts"],
) {
  if (facts.fieldCount === 0 || !facts.firstFieldId) {
    return "/app/potreros?onboarding=first-field";
  }
  if (path === "cooprinsem") {
    return `/app/integraciones/cooprinsem?fieldId=${encodeURIComponent(facts.firstFieldId)}`;
  }
  if (path === "spreadsheet") {
    return `/app/importaciones?fieldId=${encodeURIComponent(facts.firstFieldId)}&profile=generic.pasture_measurements.table.v1`;
  }
  return facts.paddockCount === 0
    ? "/app/potreros?onboarding=first-paddock"
    : "/app/potreros?onboarding=first-action";
}

function recommendedAction(
  path: OnboardingPath | null,
  facts: OnboardingChecklistProps["facts"],
  canImport: boolean,
): {
  action: string;
  detail: string;
  href: string;
  path: OnboardingPath | null;
  title: string;
} {
  if (!path) {
    const suggestedPath: OnboardingPath = canImport ? "spreadsheet" : "manual";
    return {
      action: "Elegir ruta",
      detail: canImport
        ? "Si ya tienes datos, una planilla suele ser el inicio más rápido."
        : "Empieza creando la estructura mínima de tu campo.",
      href: pathDestination(suggestedPath, facts),
      path: suggestedPath,
      title: canImport ? "Importa una planilla o elige otra ruta" : "Empieza manualmente",
    };
  }
  if (facts.fieldCount === 0 || !facts.firstFieldId) {
    return {
      action: "Crear fundo",
      detail: "Agrega nombre y ubicación; después dibuja el límite sin perder la ruta elegida.",
      href: "/app/potreros?onboarding=first-field",
      path: null,
      title: "Crea tu primer fundo",
    };
  }
  if (facts.paddockCount === 0) {
    return {
      action: "Dibujar potrero",
      detail: "Marca sus esquinas en el mapa. La superficie se calcula automáticamente.",
      href: "/app/potreros?onboarding=first-paddock",
      path: null,
      title: "Delimita tu primer potrero",
    };
  }
  if (path === "cooprinsem" && canImport) {
    return {
      action: "Abrir Cooprinsem",
      detail: "Carga el DBF, revisa la conciliación y confirma únicamente las filas válidas.",
      href: pathDestination(path, facts),
      path: null,
      title: "Importa tu historia Cooprinsem",
    };
  }
  if (path === "spreadsheet" && canImport) {
    return {
      action: "Abrir importador",
      detail: "Selecciona CSV o XLSX, mapea columnas y revisa la vista previa antes de confirmar.",
      href: pathDestination(path, facts),
      path: null,
      title: "Importa tu primera planilla",
    };
  }
  return {
    action: "Registrar manejo",
    detail: "Abre el mapa, selecciona un potrero y registra una actividad que ya ocurrió.",
    href: "/app/potreros?onboarding=first-action",
    path: null,
    title: "Registra tu primera acción útil",
  };
}

function browserStorage(): OnboardingStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
