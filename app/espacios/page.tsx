import { ACTIVE_ORGANIZATION_COOKIE, safeProductReturnPath } from "@/app/account-mode";
import { getAppUser } from "@/app/auth";
import {
  reauthorizeLegalPage,
  requirePageLegalAcceptance,
} from "@/app/legal-access";
import type { AppUser } from "@/app/auth";
import type { OrganizationKind, OrganizationMembershipRole } from "@/src/modules/access/domain/types";
import {
  AccessDeniedError,
  listAccessibleOrganizations,
} from "@/src/modules/access/server/access-repository";
import { ArrowRight, Building2, Check, House, Sprout, Users } from "lucide-react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<OrganizationMembershipRole, string> = {
  owner: "Propietario",
  admin: "Administrador",
  manager: "Encargado",
  operator: "Operador",
  viewer: "Solo lectura",
};

const KIND_LABELS: Record<OrganizationKind, string> = {
  shared: "Espacio compartido",
  personal: "Espacio personal",
  demo: "Demostración",
};

type WorkspaceSelectionPageProps = {
  searchParams: Promise<{ returnTo?: string | string[]; error?: string | string[] }>;
};

export default async function WorkspaceSelectionPage({ searchParams }: WorkspaceSelectionPageProps) {
  const user = await getAppUser();
  if (!user) redirect(`/cuenta?modo=personal&returnTo=${encodeURIComponent("/app/espacios")}`);
  await requirePageLegalAcceptance(user, "/app/espacios");

  const params = await searchParams;
  const requestedReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = safeProductReturnPath(requestedReturnTo ?? null);
  const organizations = await listOrganizationsOrRecover(user);
  const activeOrganizationId = (await cookies()).get(ACTIVE_ORGANIZATION_COOKIE)?.value;
  const hasError = Boolean(Array.isArray(params.error) ? params.error[0] : params.error);
  const currentUser = await reauthorizeLegalPage(user, "/app/espacios");
  const currentOrganizations = await listOrganizationsOrRecover(currentUser);
  if (JSON.stringify(currentOrganizations) !== JSON.stringify(organizations)) {
    redirect("/app/espacios?error=access-changed");
  }

  return (
    <main className="min-h-screen bg-surface-alt px-5 py-10 text-ink sm:px-8 lg:py-16">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-ink text-white"><Sprout size={23} /></div>
          <div><p className="text-xs font-black uppercase tracking-[0.2em] text-ink-muted">FundoSmart</p><p className="font-black">Espacios de trabajo</p></div>
        </div>

        <div className="mt-12 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-ink-subtle">Hola, {currentUser.displayName}</p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.05em] sm:text-5xl">¿En qué espacio quieres trabajar?</h1>
          <p className="mt-4 text-base leading-7 text-ink-muted">Cada espacio mantiene separados sus fundos, animales, documentos y permisos. Puedes volver aquí para cambiar de contexto.</p>
        </div>

        {hasError && <p className="mt-6 rounded-2xl border border-alert-bar/25 bg-surface-alt px-4 py-3 text-sm font-semibold text-alert-ink">Ese espacio ya no está disponible para tu cuenta. Elige otro para continuar.</p>}

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {currentOrganizations.map((organization) => {
            const active = organization.id === activeOrganizationId;
            const Icon = organization.kind === "personal" ? House : Users;
            return (
              <section className="flex min-h-64 flex-col rounded-3xl border border-black/10 bg-white p-6 shadow-sm" key={organization.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="grid size-12 place-items-center rounded-2xl bg-band text-accent"><Icon size={23} /></div>
                  {active && <span className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-black"><Check size={14} /> Actual</span>}
                </div>
                <p className="mt-6 text-xs font-black uppercase tracking-[0.16em] text-ink-subtle">{KIND_LABELS[organization.kind]} · {ROLE_LABELS[organization.role]}</p>
                <h2 className="mt-2 text-2xl font-black tracking-[-0.03em]">{organization.name}</h2>
                <p className="mt-3 text-sm leading-6 text-ink-muted">{organization.fieldNames.length > 0 ? organization.fieldNames.join(" · ") : "Sin fundos todavía"}</p>
                <form action="/api/cuenta/organizacion" className="mt-auto pt-7" method="post">
                  <input name="organizationId" type="hidden" value={organization.id} />
                  <input name="returnTo" type="hidden" value={returnTo} />
                  <button className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-black text-white transition hover:bg-ink" type="submit">Entrar a {organization.name} <ArrowRight size={17} /></button>
                </form>
              </section>
            );
          })}

          <section className="flex min-h-64 flex-col rounded-3xl border border-accent bg-band p-6 shadow-sm">
            <div className="grid size-12 place-items-center rounded-2xl bg-accent text-accent"><Building2 size={23} /></div>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.16em] text-ink-muted">Demo pública · Solo lectura</p>
            <h2 className="mt-2 text-2xl font-black tracking-[-0.03em]">Demo</h2>
            <p className="mt-3 text-sm leading-6 text-ink-muted">Fundo El Ejemplo, con potreros, ganado, leche, costos y todas las variables ficticias para recorrer la aplicación.</p>
            <a className="mt-auto inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-black text-ink transition hover:bg-accent" href="/demo?returnTo=/app">Abrir demo <ArrowRight size={17} /></a>
          </section>
        </div>
      </div>
    </main>
  );
}

async function listOrganizationsOrRecover(user: AppUser) {
  try {
    return await listAccessibleOrganizations(user);
  } catch (cause) {
    if (
      cause instanceof AccessDeniedError
      && cause.code === "ACCOUNT_CLOSURE_ACTIVE"
    ) {
      redirect("/app/sin-acceso?code=ACCOUNT_CLOSURE_ACTIVE");
    }
    throw cause;
  }
}
