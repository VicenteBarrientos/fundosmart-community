"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import type { AccessDashboard, AccessMembership, OrganizationMembershipRole, OrganizationMembershipStatus } from "./domain/types";
import { Building2, CheckCircle2, Plus, ShieldCheck, UserRoundCog } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

const ROLE_LABELS: Record<OrganizationMembershipRole, string> = {
  owner: "Propietario",
  admin: "Administrador",
  manager: "Encargado",
  operator: "Operador",
  viewer: "Solo lectura",
};

type Draft = {
  email: string;
  displayName: string;
  role: OrganizationMembershipRole;
  status: OrganizationMembershipStatus;
  fieldIds: string[];
};

const EMPTY_DRAFT: Draft = { email: "", displayName: "", role: "viewer", status: "active", fieldIds: [] };

export function AccessManagementPage({
  initialDashboard,
  userName,
  isStaff = false,
}: {
  initialDashboard: AccessDashboard;
  userName: string;
  isStaff?: boolean;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(initialDashboard.memberships[0]?.email ?? null);
  const [draft, setDraft] = useState<Draft>(() => memberDraft(initialDashboard.memberships[0]));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const globalScope = draft.role === "owner" || draft.role === "admin";
  const selected = useMemo(() => dashboard.memberships.find((member) => member.email === selectedEmail), [dashboard, selectedEmail]);

  function selectMember(member: AccessMembership) {
    setSelectedEmail(member.email);
    setDraft(memberDraft(member));
    setMessage(null);
  }

  function newMember() {
    setSelectedEmail(null);
    setDraft({ ...EMPTY_DRAFT });
    setMessage(null);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/configuracion/accesos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json() as { dashboard?: AccessDashboard; error?: string };
      if (!response.ok || !body.dashboard) throw new Error(body.error ?? "No fue posible guardar la membresía.");
      setDashboard(body.dashboard);
      const saved = body.dashboard.memberships.find((member) => member.email.toLowerCase() === draft.email.toLowerCase());
      if (saved) {
        setSelectedEmail(saved.email);
        setDraft(memberDraft(saved));
      }
      setMessage("Membresía guardada y registrada en la auditoría.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "No fue posible guardar la membresía.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell activeSection="settings" organizationId={dashboard.organizationId} organizationName={dashboard.organizationName} userName={userName} isStaff={isStaff}>
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-ink-subtle">Seguridad organizacional</p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink">Membresías y acceso por fundo</h1>
            <p className="mt-2 max-w-3xl text-sm text-ink-muted">ChatGPT identifica a la persona; estas reglas internas deciden qué datos puede ver y qué operaciones puede ejecutar.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isStaff && (
              <Link className="inline-flex items-center gap-2 rounded-xl border border-emerald/10 bg-emerald/5 px-4 py-2.5 text-sm font-bold text-emerald hover:bg-emerald/10" href="/app/staff">
                <ShieldCheck size={17} /> Panel de Staff
              </Link>
            )}
            <Link className="inline-flex items-center gap-2 rounded-xl border border-black/10 bg-white px-4 py-2.5 text-sm font-bold text-ink" href="/app/espacios"><Building2 size={17} /> Cambiar espacio</Link>
            <button className="inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-sm font-bold text-white" onClick={newMember} type="button"><Plus size={17} /> Nueva membresía</button>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(260px,0.8fr)_minmax(420px,1.4fr)]">
          <aside className="rounded-3xl border border-black/10 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2 px-2 text-sm font-black text-ink"><ShieldCheck size={18} /> Personas autorizadas</div>
            <div className="space-y-2">
              {dashboard.memberships.map((member) => (
                <button className={`w-full rounded-2xl border p-3 text-left transition ${selectedEmail === member.email ? "border-ink bg-surface-alt" : "border-black/8 hover:bg-surface-alt"}`} key={member.id} onClick={() => selectMember(member)} type="button">
                  <span className="block text-sm font-bold text-ink">{member.displayName}</span>
                  <span className="mt-1 block truncate text-xs text-ink-subtle">{member.email}</span>
                  <span className="mt-2 inline-flex rounded-full bg-surface-alt px-2 py-1 text-[12px] font-black uppercase tracking-wide text-ink-muted">{ROLE_LABELS[member.role]} · {member.status === "active" ? "Activo" : "Suspendido"}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-2xl bg-accent text-ink"><UserRoundCog size={20} /></div>
              <div><h2 className="font-black text-ink">{selected ? "Editar membresía" : "Agregar persona"}</h2><p className="text-xs text-ink-subtle">Los cambios sensibles quedan en el registro de auditoría.</p></div>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Field label="Nombre"><input className={inputClass} value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
              <Field label="Correo ChatGPT"><input className={inputClass} disabled={Boolean(selected)} type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></Field>
              <Field label="Rol"><select className={inputClass} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as OrganizationMembershipRole })}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="Estado"><select className={inputClass} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as OrganizationMembershipStatus })}><option value="active">Activo</option><option value="suspended">Suspendido</option></select></Field>
            </div>
            <div className="mt-6">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-ink-muted">Fundos autorizados</p>
              {globalScope ? (
                <div className="mt-3 flex items-center gap-2 rounded-2xl bg-surface-alt p-4 text-sm font-semibold text-ink-muted"><CheckCircle2 size={18} /> Propietarios y administradores acceden a todos los fundos.</div>
              ) : (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {dashboard.fields.map((field) => (
                    <label className="flex items-center gap-3 rounded-2xl border border-black/8 p-3 text-sm font-semibold text-ink-muted" key={field.id}>
                      <input checked={draft.fieldIds.includes(field.id)} onChange={(event) => setDraft({ ...draft, fieldIds: event.target.checked ? [...draft.fieldIds, field.id] : draft.fieldIds.filter((id) => id !== field.id) })} type="checkbox" /> {field.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {message && <p className="mt-5 rounded-xl bg-surface-alt px-4 py-3 text-sm text-ink-muted">{message}</p>}
            <button className="mt-6 rounded-xl bg-accent px-5 py-3 text-sm font-black text-ink disabled:opacity-50" disabled={saving} onClick={save} type="button">{saving ? "Guardando…" : "Guardar acceso"}</button>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function memberDraft(member?: AccessMembership): Draft {
  return member ? { email: member.email, displayName: member.displayName, role: member.role, status: member.status, fieldIds: member.fieldIds } : { ...EMPTY_DRAFT };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="text-xs font-black uppercase tracking-[0.12em] text-ink-muted">{label}<span className="mt-2 block normal-case tracking-normal">{children}</span></label>;
}

const inputClass = "w-full rounded-xl border border-black/12 bg-white px-3 py-2.5 text-sm font-medium text-ink outline-none focus:border-accent disabled:bg-surface-alt";
