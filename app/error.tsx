"use client";

import Link from "next/link";
import { RouteFallback } from "@/src/core/layout/RouteFallback";

export default function ErrorBoundary({ reset }: { reset: () => void }) {
  return (
    <RouteFallback
      actions={
        <>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition hover:-translate-y-0.5 hover:shadow-md"
            onClick={() => reset()}
            type="button"
          >
            Intentar de nuevo
          </button>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-6 py-3 text-sm font-semibold text-primary transition hover:bg-secondary"
            href="/"
          >
            Ir a la portada
          </Link>
        </>
      }
      announce
      description="No pudimos completar esta vista. Intenta cargarla nuevamente o vuelve a la portada para continuar desde un punto seguro."
      eyebrow="Interrupción temporal"
      title="Algo se enredó en el camino."
    />
  );
}
