import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { InstallGuide } from "@/src/modules/landing/InstallGuide";

export const metadata = {
  title: "Instalar FundoSmart · FundoSmart",
  description: "Instala FundoSmart en tu teléfono o computador para abrirlo en un toque y capturar en terreno sin señal.",
};

export default function InstalarPage() {
  return (
    <main className="min-h-screen bg-surface-alt py-12 px-4 sm:px-6 lg:px-8 font-sans text-ink">
      <div className="mx-auto max-w-3xl">
        <Link
          className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wider text-accent hover:underline mb-6"
          href="/"
        >
          <ArrowLeft size={14} /> Volver a FundoSmart
        </Link>

        <InstallGuide />

        <p className="mt-6 text-center text-xs text-ink/60">
          ¿Ya tienes cuenta? <Link className="font-black text-accent hover:underline" href="/app">Entra a FundoSmart</Link>
        </p>
      </div>
    </main>
  );
}
