import Link from "next/link";
import { RouteFallback } from "@/src/core/layout/RouteFallback";

export default function NotFound() {
  return (
    <RouteFallback
      actions={
        <>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition hover:-translate-y-0.5 hover:shadow-md"
            href="/"
          >
            Volver a la portada
          </Link>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-6 py-3 text-sm font-semibold text-primary transition hover:bg-secondary"
            href="/app"
          >
            Ingresar a FundoSmart
          </Link>
        </>
      }
      description="La dirección puede haber cambiado o ya no estar disponible. Desde la portada puedes retomar el camino hacia el producto o la cuenta demo."
      eyebrow="Ruta no encontrada · 404"
      title="Este camino no lleva a ningún potrero."
    />
  );
}
