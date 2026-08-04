import { requireAppUser } from "@/app/auth";
import {
  reauthorizeLegalPage,
  safeLegalReturnPath,
} from "@/app/legal-access";
import { getLegalAcceptanceStatus } from "@/src/modules/legal/server/legal-acceptance-repository";
import { env } from "cloudflare:workers";
import { CheckCircle2, FileCheck2, ShieldCheck } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

type LegalAcceptancePageProps = {
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

const LABELS = {
  privacy: "Política de Privacidad",
  terms: "Términos de Servicio",
} as const;

export default async function LegalAcceptancePage({
  searchParams,
}: LegalAcceptancePageProps) {
  const user = await requireAppUser("/app/cuenta/legal");
  const params = await searchParams;
  const requestedReturnTo = Array.isArray(params.returnTo)
    ? params.returnTo[0]
    : params.returnTo;
  const returnTo = safeLegalReturnPath(requestedReturnTo);
  const status = await getLegalAcceptanceStatus(env.DB, user.subject);
  const currentUser = await reauthorizeLegalPage(
    user,
    "/app/cuenta/legal",
    { requireCurrentAcceptance: false },
  );
  const requestId = crypto.randomUUID();

  return (
    <main className="min-h-screen bg-surface-alt px-5 py-10 text-ink sm:px-8 lg:py-16">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-3 text-accent">
          <ShieldCheck size={28} />
          <p className="text-xs font-black uppercase tracking-[0.2em]">
            Cuenta y privacidad
          </p>
        </div>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">
          Revisa los documentos vigentes
        </h1>
        <p className="mt-4 text-base leading-7 text-ink-muted">
          Hola, {currentUser.displayName}. FundoSmart registra cada documento
          por separado, con su versión, fecha y huella SHA-256.
        </p>

        <section className="mt-8 rounded-3xl border border-line-steel bg-white p-6 shadow-sm sm:p-8">
          <div className="space-y-4">
            {status.requirements.map((requirement) => (
              <div
                className="flex flex-col gap-3 rounded-2xl border border-line-steel p-5 sm:flex-row sm:items-center sm:justify-between"
                key={requirement.kind}
              >
                <div>
                  <p className="font-black">{LABELS[requirement.kind]}</p>
                  <p className="mt-1 text-sm text-ink-muted">
                    Versión {requirement.version} · publicada el{" "}
                    {requirement.publishedOn}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {requirement.accepted && (
                    <span className="inline-flex items-center gap-1 text-xs font-black text-accent">
                      <CheckCircle2 size={15} /> Aceptada
                    </span>
                  )}
                  <Link
                    className="text-sm font-black text-accent underline underline-offset-4"
                    href={requirement.route}
                    target="_blank"
                  >
                    Leer
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {!status.complete ? (
            <form action="/api/cuenta/legal" className="mt-7 space-y-4" method="post">
              <input name="requestId" type="hidden" value={requestId} />
              <input name="returnTo" type="hidden" value={returnTo} />
              {status.requirements.map((requirement) => (
                <input
                  key={requirement.kind}
                  name={`${requirement.kind}Version`}
                  type="hidden"
                  value={requirement.version}
                />
              ))}
              <label className="flex items-start gap-3 rounded-2xl bg-surface-alt p-4 text-sm font-semibold">
                <input className="mt-1 size-4" name="acceptTerms" required type="checkbox" />
                <span>
                  Acepto los Términos de Servicio vigentes para el uso de mi
                  cuenta personal en FundoSmart.
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-2xl bg-surface-alt p-4 text-sm font-semibold">
                <input
                  className="mt-1 size-4"
                  name="acknowledgePrivacy"
                  required
                  type="checkbox"
                />
                <span>
                  Confirmo que leí la Política de Privacidad vigente. Esta
                  confirmación no sustituye las bases legales aplicables a cada
                  tratamiento.
                </span>
              </label>
              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-5 py-3 text-sm font-black text-white"
                type="submit"
              >
                <FileCheck2 size={18} /> Registrar aceptación
              </button>
            </form>
          ) : (
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                className="inline-flex flex-1 items-center justify-center rounded-xl bg-ink px-5 py-3 text-sm font-black text-white"
                href={returnTo}
              >
                Continuar a FundoSmart
              </Link>
              <a
                className="inline-flex flex-1 items-center justify-center rounded-xl border border-line-steel px-5 py-3 text-sm font-black"
                href="/api/cuenta/legal?download=1"
              >
                Descargar recibos JSON
              </a>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
