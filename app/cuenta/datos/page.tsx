import { getAppUser } from "@/app/auth";
import {
  reauthorizeLegalIdentity,
  requirePageLegalAcceptance,
} from "@/app/legal-access";
import {
  AccessDeniedError,
  listAccessibleOrganizations,
} from "@/src/modules/access/server/access-repository";
import {
  listAccountClosureRequests,
} from "@/src/modules/account-lifecycle/server/account-closure-repository";
import { env } from "cloudflare:workers";
import {
  AlertTriangle,
  Download,
  FileCheck2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type AccountDataPageProps = {
  searchParams: Promise<{
    cierre?: string | string[];
    error?: string | string[];
    revocado?: string | string[];
  }>;
};

export default async function AccountDataPage({
  searchParams,
}: AccountDataPageProps) {
  const user = await getAppUser();
  if (!user) {
    redirect("/cuenta?modo=personal&returnTo=%2Fapp%2Fcuenta%2Fdatos");
  }
  await requirePageLegalAcceptance(user, "/app/cuenta/datos");
  const params = await searchParams;
  const now = new Date().toISOString();
  const snapshot = await loadAccountDataSnapshotOrRedirect(user, now);
  const current = await reauthorizeAccountDataSnapshot(user, snapshot, now);
  const currentUser = current.user;
  const { closures, organizations } = current.snapshot;

  const exportOrganizations = organizations.filter(
    (organization) =>
      (organization.role === "owner" || organization.role === "admin")
      && organization.kind !== "demo",
  );
  const ownerOrganizations = organizations.filter(
    (organization) => organization.role === "owner" && organization.kind !== "demo",
  );
  const activeAccountClosure = closures.find(
    (closure) => closure.scope === "account" && closure.status === "grace",
  );
  const hasSuccess = Boolean(first(params.cierre) || first(params.revocado));
  const hasError = Boolean(first(params.error));

  return (
    <main className="min-h-screen bg-surface-alt px-5 py-10 text-ink sm:px-8 lg:py-16">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-3 text-accent">
          <ShieldCheck size={28} />
          <p className="text-xs font-black uppercase tracking-[0.2em]">
            Cuenta y datos
          </p>
        </div>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">
          Controla tus datos y el acceso
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-ink-muted">
          {currentUser.displayName}, desde aquí puedes descargar evidencia legal,
          descargar la exportación portable de un espacio y solicitar una
          suspensión reversible. Ninguna solicitud de esta pantalla elimina datos.
        </p>

        {hasSuccess && (
          <p className="mt-6 rounded-2xl border border-accent/30 bg-band px-4 py-3 text-sm font-bold">
            El cambio quedó registrado y auditado.
          </p>
        )}
        {hasError && (
          <p className="mt-6 rounded-2xl border border-alert-bar/30 bg-white px-4 py-3 text-sm font-bold text-alert-ink">
            El estado cambió durante la operación. Recarga y vuelve a intentarlo.
          </p>
        )}

        <section className="mt-8 grid gap-4 sm:grid-cols-2">
          <a
            className="rounded-3xl border border-line-steel bg-white p-6 shadow-sm"
            href="/api/cuenta/legal?download=1"
          >
            <FileCheck2 className="text-accent" size={24} />
            <h2 className="mt-4 text-xl font-black">Recibos legales</h2>
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              Descarga versiones, fechas y huellas SHA-256 de tus aceptaciones.
            </p>
          </a>
          <section className="rounded-3xl border border-line-steel bg-white p-6 shadow-sm">
            <Download className="text-accent" size={24} />
            <h2 className="mt-4 text-xl font-black">Exportación del espacio</h2>
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              Descarga las 33 secciones habilitadas del respaldo portable v2.
              El manifiesto incluye alcance, conteos, exclusiones y huellas
              SHA-256 por sección y del archivo lógico completo.
            </p>
            {exportOrganizations.length > 0 ? (
              <div className="mt-4 space-y-3">
                {exportOrganizations.map((organization) => (
                  <form
                    action="/api/cuenta/datos/exportacion"
                    key={organization.id}
                    method="post"
                  >
                    <input
                      name="organizationId"
                      type="hidden"
                      value={organization.id}
                    />
                    <input
                      name="requestId"
                      type="hidden"
                      value={crypto.randomUUID()}
                    />
                    <button
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-black text-white"
                      type="submit"
                    >
                      <Download size={16} />
                      Descargar {organization.name}
                    </button>
                  </form>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm font-semibold text-ink-muted">
                La descarga está disponible para propietarios y administradores
                de espacios activos.
              </p>
            )}
          </section>
        </section>

        {closures.length > 0 && (
          <section className="mt-8 rounded-3xl border border-line-steel bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-2xl font-black">Solicitudes registradas</h2>
            <div className="mt-5 space-y-4">
              {closures.map((closure) => (
                <article
                  className="rounded-2xl border border-line-steel p-5"
                  key={closure.id}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-black">
                        {closure.scope === "account"
                          ? "Cuenta personal"
                          : `Organización ${closure.targetId}`}
                      </p>
                      <p className="mt-1 text-sm text-ink-muted">
                        Solicitado {closure.requestedAt} · gracia hasta{" "}
                        {closure.graceEndsAt}
                      </p>
                    </div>
                    <span className="w-fit rounded-full bg-surface-alt px-3 py-1 text-xs font-black uppercase">
                      {closure.state === "grace"
                        ? "En gracia"
                        : closure.state === "expired"
                          ? "Ventana vencida"
                          : "Revocado"}
                    </span>
                  </div>
                  {closure.state === "expired" && (
                    <p className="mt-3 text-sm font-semibold text-alert-ink">
                      La ventana venció: los datos siguen retenidos y el acceso
                      permanece suspendido. No se ejecutó eliminación alguna.
                    </p>
                  )}
                  {closure.revocable && (
                    <form
                      action="/api/cuenta/datos/cierre"
                      className="mt-4"
                      method="post"
                    >
                      <input name="action" type="hidden" value="revoke" />
                      <input
                        name="closureRequestId"
                        type="hidden"
                        value={closure.id}
                      />
                      <input
                        name="requestId"
                        type="hidden"
                        value={crypto.randomUUID()}
                      />
                      <button
                        className="inline-flex items-center gap-2 rounded-xl border border-line-steel px-4 py-2 text-sm font-black"
                        type="submit"
                      >
                        <RotateCcw size={16} /> Revocar y restaurar acceso
                      </button>
                    </form>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {!activeAccountClosure && !currentUser.subject.startsWith("dev:") && (
          <section className="mt-8 rounded-3xl border border-alert-bar/30 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex items-center gap-3 text-alert-ink">
              <AlertTriangle size={24} />
              <h2 className="text-2xl font-black">Suspender mi cuenta</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-ink-muted">
              Suspende todas tus membresías y revoca las sesiones actuales por
              30 días. Durante ese plazo puedes volver a autenticarte sólo para
              revocar la solicitud. No se elimina, anonimiza ni purga ningún dato.
            </p>
            <form
              action="/api/cuenta/datos/cierre"
              className="mt-5 space-y-4"
              method="post"
            >
              <input name="action" type="hidden" value="request" />
              <input name="scope" type="hidden" value="account" />
              <input name="requestId" type="hidden" value={crypto.randomUUID()} />
              <label className="block text-sm font-bold">
                Escribe tu correo exacto: {currentUser.email}
                <input
                  autoComplete="off"
                  className="mt-2 w-full rounded-xl border border-line-steel px-4 py-3"
                  name="confirmation"
                  required
                  type="email"
                />
              </label>
              <Confirmation />
              <button
                className="rounded-xl bg-alert-ink px-5 py-3 text-sm font-black text-white"
                type="submit"
              >
                Solicitar suspensión de cuenta
              </button>
            </form>
          </section>
        )}

        {ownerOrganizations.map((organization) => (
          <section
            className="mt-8 rounded-3xl border border-alert-bar/30 bg-white p-6 shadow-sm sm:p-8"
            key={organization.id}
          >
            <h2 className="text-2xl font-black">
              Suspender {organization.name}
            </h2>
            <p className="mt-3 text-sm leading-6 text-ink-muted">
              Como owner, puedes suspender todas las membresías de este espacio
              durante 30 días. Las sesiones de personas que también usan otros
              espacios no se eliminan. Los datos permanecen intactos.
            </p>
            <form
              action="/api/cuenta/datos/cierre"
              className="mt-5 space-y-4"
              method="post"
            >
              <input name="action" type="hidden" value="request" />
              <input name="scope" type="hidden" value="organization" />
              <input name="targetId" type="hidden" value={organization.id} />
              <input name="requestId" type="hidden" value={crypto.randomUUID()} />
              <label className="block text-sm font-bold">
                Escribe el nombre exacto: {organization.name}
                <input
                  autoComplete="off"
                  className="mt-2 w-full rounded-xl border border-line-steel px-4 py-3"
                  name="confirmation"
                  required
                  type="text"
                />
              </label>
              <Confirmation />
              <button
                className="rounded-xl bg-alert-ink px-5 py-3 text-sm font-black text-white"
                type="submit"
              >
                Solicitar suspensión del espacio
              </button>
            </form>
          </section>
        ))}

        <Link
          className="mt-8 inline-flex text-sm font-black text-accent underline underline-offset-4"
          href="/app"
        >
          Volver a FundoSmart
        </Link>
      </div>
    </main>
  );
}

function Confirmation() {
  return (
    <label className="flex items-start gap-3 rounded-2xl bg-surface-alt p-4 text-sm font-semibold">
      <input className="mt-1 size-4" name="understand" required type="checkbox" />
      <span>
        Entiendo que el acceso se suspende de inmediato, que la revocación sólo
        está disponible durante la gracia y que esta acción no elimina datos.
      </span>
    </label>
  );
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function loadAccountDataSnapshot(
  user: NonNullable<Awaited<ReturnType<typeof getAppUser>>>,
  now: string,
) {
  const closures = await listAccountClosureRequests(env.DB, user.subject, now);
  const accountClosed = closures.some(
    (closure) => closure.scope === "account" && closure.status === "grace",
  );
  const organizations = accountClosed
    ? []
    : await listAccessibleOrganizations(user);
  return Object.freeze({ closures, organizations });
}

async function reauthorizeAccountDataSnapshot(
  user: NonNullable<Awaited<ReturnType<typeof getAppUser>>>,
  expected: Awaited<ReturnType<typeof loadAccountDataSnapshot>>,
  now: string,
) {
  const identity = await reauthorizeLegalIdentity(user);
  if (!identity.ok) {
    redirect("/cuenta?modo=personal&returnTo=%2Fapp%2Fcuenta%2Fdatos");
  }
  const currentSnapshot = await loadAccountDataSnapshotOrRedirect(
    identity.user,
    now,
  );
  if (JSON.stringify(currentSnapshot) !== JSON.stringify(expected)) {
    redirect("/app/cuenta/datos?error=state-changed");
  }
  return Object.freeze({
    user: identity.user,
    snapshot: currentSnapshot,
  });
}

async function loadAccountDataSnapshotOrRedirect(
  user: NonNullable<Awaited<ReturnType<typeof getAppUser>>>,
  now: string,
) {
  try {
    return await loadAccountDataSnapshot(user, now);
  } catch (cause) {
    if (
      cause instanceof AccessDeniedError
      && cause.code === "ACCOUNT_CLOSURE_ACTIVE"
    ) {
      redirect("/app/cuenta/datos?error=state-changed");
    }
    throw cause;
  }
}
