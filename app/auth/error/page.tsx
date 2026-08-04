import Link from "next/link";

const MESSAGES: Record<string, string> = {
  denied: "Cancelaste el acceso con Google. No se comparti\u00f3 informaci\u00f3n con FundoSmart.",
  expired: "La solicitud de ingreso expir\u00f3. Int\u00e9ntalo nuevamente.",
  failed: "Google no pudo confirmar tu identidad. Int\u00e9ntalo nuevamente.",
  invalid_request: "La solicitud de ingreso no es v\u00e1lida o ya fue utilizada.",
  unavailable: "El ingreso con Google todav\u00eda no est\u00e1 disponible en este entorno.",
};

type AuthErrorPageProps = {
  searchParams: Promise<{ code?: string | string[] }>;
};

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const params = await searchParams;
  const code = Array.isArray(params.code) ? params.code[0] : params.code;
  const message = MESSAGES[code ?? ""] ?? MESSAGES.failed;

  return (
    <main className="grid min-h-screen place-items-center bg-bg-steel px-5 text-ink">
      <section className="w-full max-w-lg rounded-card border border-line-steel bg-surface p-8 text-center shadow-sm sm:p-10">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-ink-muted">FundoSmart</p>
        <h1 className="mt-3 text-3xl font-black tracking-[-0.04em]">No pudimos completar el acceso</h1>
        <p className="mt-4 leading-7 text-ink-muted">{message}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link className="rounded-card bg-chrome px-5 py-3 text-sm font-black text-white" href="/cuenta?modo=personal&returnTo=%2Fapp">Intentar nuevamente</Link>
          <Link className="rounded-card border border-line-strong px-5 py-3 text-sm font-black" href="/">Volver al inicio</Link>
        </div>
      </section>
    </main>
  );
}
