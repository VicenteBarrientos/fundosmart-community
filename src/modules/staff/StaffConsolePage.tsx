"use client";

import { AppShell } from "@/src/core/layout/AppShell";
import { StaffFeedbackInbox } from "@/src/modules/feedback/StaffFeedbackInbox";
import { SortableGridHeader } from "@/src/ui/SortableGridHeader";
import {
  nextSortState,
  stableSortData,
  type SortColumn,
  type SortState,
} from "@/src/ui/sortable-data";
import {
  Building2,
  Users,
  Sliders,
  History,
  Plus,
  Search,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  Settings2,
  MessageSquareText,
} from "lucide-react";
import { useState, useMemo } from "react";

type Organization = {
  id: string;
  name: string;
  kind: "shared" | "personal" | "demo";
  createdAt: string;
};

type Field = {
  id: string;
  organizationId: string;
  name: string;
  location: string;
  isDemo: boolean;
};

type Membership = {
  id: string;
  organizationId: string;
  userEmail: string;
  normalizedEmail: string;
  displayName: string;
  role: "owner" | "admin" | "manager" | "operator" | "viewer";
  status: "active" | "suspended";
  createdAt: string;
};

type FieldAccess = {
  id: string;
  membershipId: string;
  fieldId: string;
};

type FeatureFlag = {
  id: string;
  organizationId: string;
  fieldId: string | null;
  feature: "trazabilidad" | "pastoreo" | "analitica" | "benchmarking";
  enabled: boolean;
};

type AuditLogEntry = {
  id: string;
  organizationId: string;
  fieldId: string | null;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
};

type StaffDashboardData = {
  organizations: Organization[];
  fields: Field[];
  memberships: Membership[];
  membershipFieldAccess: FieldAccess[];
  featureFlags: FeatureFlag[];
  auditLogs: AuditLogEntry[];
};

type StaffConsolePageProps = {
  initialData: StaffDashboardData;
  userName: string;
};

const ROLE_LABELS = {
  owner: "Propietario",
  admin: "Administrador",
  manager: "Encargado",
  operator: "Operador",
  viewer: "Solo lectura",
};

const KIND_LABELS = {
  shared: "Espacio compartido",
  personal: "Sandbox personal",
  demo: "Demostración",
};

type WorkspaceTableRow = {
  fieldCount: number;
  membershipCount: number;
  organization: Organization;
};

type StaffUserTableRow = {
  email: string;
  memberships: Membership[];
  name: string;
};

type WorkspaceSortColumn = "coverage" | "id" | "kind" | "workspace";
type MembershipSortColumn = "email" | "name" | "role" | "status" | "workspaces";
type AuditSortColumn = "action" | "actor" | "entity" | "occurredAt" | "organization" | "values";

const WORKSPACE_SORT_COLUMNS: Record<WorkspaceSortColumn, SortColumn<WorkspaceTableRow>> = {
  workspace: { kind: "text", value: (row) => row.organization.name },
  kind: { kind: "text", value: (row) => KIND_LABELS[row.organization.kind] },
  coverage: { kind: "text", value: (row) => `${row.fieldCount} fundos ${row.membershipCount} membresías` },
  id: { kind: "text", value: (row) => row.organization.id },
};

const WORKSPACE_SORT_OPTIONS = [
  { column: "workspace", label: "Espacio" },
  { column: "kind", label: "Tipo" },
  { column: "coverage", label: "Fundos / Membresías" },
  { column: "id", label: "ID" },
] as const satisfies readonly { column: WorkspaceSortColumn; label: string }[];

const MEMBERSHIP_SORT_COLUMNS: Record<MembershipSortColumn, SortColumn<StaffUserTableRow>> = {
  name: { kind: "text", value: (user) => user.name },
  email: { kind: "text", value: (user) => user.email },
  workspaces: { kind: "number", value: (user) => user.memberships.length },
  role: {
    kind: "text",
    value: (user) => user.memberships.map((membership) => ROLE_LABELS[membership.role]).sort().join(" "),
  },
  status: {
    kind: "text",
    value: (user) => user.memberships.map((membership) => membership.status).sort().join(" "),
  },
};

const MEMBERSHIP_SORT_OPTIONS = [
  { column: "name", label: "Persona" },
  { column: "email", label: "Mail" },
  { column: "workspaces", label: "Espacios habilitados" },
  { column: "role", label: "Rol" },
  { column: "status", label: "Estado" },
] as const satisfies readonly { column: MembershipSortColumn; label: string }[];

const AUDIT_SORT_COLUMNS: Record<AuditSortColumn, SortColumn<AuditLogEntry>> = {
  occurredAt: { kind: "number", value: (log) => Date.parse(log.occurredAt) },
  actor: { kind: "text", value: (log) => log.actor },
  action: { kind: "text", value: (log) => log.action },
  entity: { kind: "text", value: (log) => `${log.entityType} ${log.entityId}` },
  organization: { kind: "text", value: (log) => log.organizationId },
  values: { kind: "text", value: (log) => log.after ? JSON.stringify(log.after) : null },
};

const AUDIT_SORT_OPTIONS = [
  { column: "occurredAt", label: "Fecha/Hora" },
  { column: "actor", label: "Actor (Soporte)" },
  { column: "action", label: "Acción" },
  { column: "entity", label: "Entidad" },
  { column: "organization", label: "Espacio" },
  { column: "values", label: "Valores" },
] as const satisfies readonly { column: AuditSortColumn; label: string }[];

export function StaffConsolePage({ initialData, userName }: StaffConsolePageProps) {
  const [data, setData] = useState<StaffDashboardData>(initialData);
  const [activeTab, setActiveTab] = useState<"workspaces" | "memberships" | "features" | "feedback" | "audit">("workspaces");
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);

  // Tab 1: Workspaces & Fields States
  const [searchWorkspace, setSearchWorkspace] = useState("");
  const [workspaceSort, setWorkspaceSort] = useState<SortState<WorkspaceSortColumn> | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceKind, setNewWorkspaceKind] = useState<"shared" | "personal" | "demo">("shared");
  const [showNewWorkspaceModal, setShowNewWorkspaceModal] = useState(false);

  const [newFundoName, setNewFundoName] = useState("");
  const [newFundoLocation, setNewFundoLocation] = useState("");
  const [selectedWorkspaceForFundo, setSelectedWorkspaceForFundo] = useState("");
  const [showNewFundoModal, setShowNewFundoModal] = useState(false);

  // Tab 2: Memberships Rejilla Grid States
  const [searchMembership, setSearchMembership] = useState("");
  const [membershipSort, setMembershipSort] = useState<SortState<MembershipSortColumn> | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [addingWorkspaceForEmail, setAddingWorkspaceForEmail] = useState<string | null>(null);
  const [newSpaceId, setNewSpaceId] = useState("");
  const [newSpaceRole, setNewSpaceRole] = useState<"owner" | "admin" | "manager" | "operator" | "viewer">("viewer");

  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [addUserName, setAddUserName] = useState("");
  const [addUserEmail, setAddUserEmail] = useState("");
  const [addUserOrgId, setAddUserOrgId] = useState(data.organizations[0]?.id ?? "");
  const [addUserRole, setAddUserRole] = useState<"owner" | "admin" | "manager" | "operator" | "viewer">("viewer");;

  // Tab 3: Feature Flags States
  const [selectedFlagOrg, setSelectedFlagOrg] = useState(data.organizations[0]?.id ?? "");
  const [selectedFlagField, setSelectedFlagField] = useState<string>("global");
  const [auditSort, setAuditSort] = useState<SortState<AuditSortColumn> | null>(null);

  // Computed fields
  const filteredWorkspaces = useMemo(() => {
    const organizations = data.organizations.filter(
      (org) =>
        org.name.toLowerCase().includes(searchWorkspace.toLowerCase()) ||
        org.id.toLowerCase().includes(searchWorkspace.toLowerCase())
    );
    const rows = organizations.map((organization) => ({
      organization,
      fieldCount: data.fields.filter((field) => field.organizationId === organization.id).length,
      membershipCount: data.memberships.filter((membership) => membership.organizationId === organization.id).length,
    }));
    return stableSortData(rows, workspaceSort, WORKSPACE_SORT_COLUMNS);
  }, [data.fields, data.memberships, data.organizations, searchWorkspace, workspaceSort]);

  const filteredMemberships = useMemo(() => {
    return data.memberships.filter(
      (member) =>
        member.userEmail.toLowerCase().includes(searchMembership.toLowerCase()) ||
        member.displayName.toLowerCase().includes(searchMembership.toLowerCase()) ||
        member.organizationId.toLowerCase().includes(searchMembership.toLowerCase())
    );
  }, [data.memberships, searchMembership]);

  const workspaceMap = useMemo(() => {
    return new Map(data.organizations.map((org) => [org.id, org]));
  }, [data.organizations]);

  const fieldsByOrg = useMemo(() => {
    const map = new Map<string, Field[]>();
    for (const field of data.fields) {
      const arr = map.get(field.organizationId) ?? [];
      arr.push(field);
      map.set(field.organizationId, arr);
    }
    return map;
  }, [data.fields]);

  const uniqueUsers = useMemo(() => {
    const usersMap = new Map<string, Membership[]>();
    for (const m of filteredMemberships) {
      const list = usersMap.get(m.userEmail) || [];
      list.push(m);
      usersMap.set(m.userEmail, list);
    }
    const users = Array.from(usersMap.entries()).map(([email, userMembers]) => {
      const bestName = userMembers.find(m => m.displayName && m.displayName.trim() !== "")?.displayName || email.split("@")[0];
      return {
        email,
        name: bestName,
        memberships: userMembers,
      };
    });
    return stableSortData(users, membershipSort, MEMBERSHIP_SORT_COLUMNS);
  }, [filteredMemberships, membershipSort]);

  const sortedAuditLogs = useMemo(
    () => stableSortData(data.auditLogs, auditSort, AUDIT_SORT_COLUMNS),
    [auditSort, data.auditLogs],
  );
  const handleWorkspaceSort = (column: WorkspaceSortColumn) => {
    setWorkspaceSort((current) => nextSortState(current, column));
  };
  const handleMembershipSort = (column: MembershipSortColumn) => {
    setMembershipSort((current) => nextSortState(current, column));
  };
  const handleAuditSort = (column: AuditSortColumn) => {
    setAuditSort((current) => nextSortState(current, column));
  };

  // Action methods
  const refreshData = async () => {
    try {
      const res = await fetch("/app/api/staff");
      if (res.ok) {
        const fresh = await res.json() as StaffDashboardData;
        setData(fresh);
      }
    } catch (e) {
      console.error("Error refreshing data", e);
    }
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWorkspaceName.trim()) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/app/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_workspace",
          name: newWorkspaceName,
          kind: newWorkspaceKind,
        }),
      });
      const body = await res.json() as { error?: string; workspaceId?: string };
      if (!res.ok) throw new Error(body.error ?? "Error al crear espacio.");

      setMessage({ text: "Espacio de trabajo creado correctamente.", type: "success" });
      setNewWorkspaceName("");
      setShowNewWorkspaceModal(false);
      await refreshData();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ocurrió un error al crear espacio.";
      setMessage({ text: errMsg, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFundo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFundoName.trim() || !selectedWorkspaceForFundo) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/app/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_fundo",
          name: newFundoName,
          organizationId: selectedWorkspaceForFundo,
          location: newFundoLocation,
        }),
      });
      const body = await res.json() as { error?: string; fundoId?: string };
      if (!res.ok) throw new Error(body.error ?? "Error al crear fundo.");

      setMessage({ text: "Fundo creado e indexado correctamente.", type: "success" });
      setNewFundoName("");
      setNewFundoLocation("");
      setShowNewFundoModal(false);
      await refreshData();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ocurrió un error al crear fundo.";
      setMessage({ text: errMsg, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveInlineWorkspace = async (user: { email: string; name: string; memberships: Membership[] }) => {
    if (!newSpaceId) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/app/api/staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_membership",
          email: user.email,
          displayName: user.name,
          role: newSpaceRole,
          status: "active",
          organizationId: newSpaceId,
          fieldIds: [],
        }),
      });
      const body = await res.json() as { error?: string; success?: boolean };
      if (!res.ok) throw new Error(body.error ?? "Error al guardar membresía.");

      setMessage({ text: `Acceso al espacio agregado con éxito para ${user.name}.`, type: "success" });
      setAddingWorkspaceForEmail(null);
      setNewSpaceId("");
      await refreshData();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ocurrió un error al guardar membresía.";
      setMessage({ text: errMsg, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMembershipRoleOrStatus = async (
    member: Membership,
    newRole: "owner" | "admin" | "manager" | "operator" | "viewer",
    newStatus: "active" | "suspended"
  ) => {
    setLoading(true);
    setMessage(null);
    try {
      const relatedAccess = data.membershipFieldAccess
        .filter((fa) => fa.membershipId === member.id)
        .map((fa) => fa.fieldId);

      const res = await fetch("/app/api/staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_membership",
          email: member.userEmail,
          displayName: member.displayName,
          role: newRole,
          status: newStatus,
          organizationId: member.organizationId,
          fieldIds: relatedAccess,
        }),
      });
      const body = await res.json() as { error?: string; success?: boolean };
      if (!res.ok) throw new Error(body.error ?? "Error al actualizar membresía.");

      setMessage({ text: "Membresía actualizada con éxito.", type: "success" });
      await refreshData();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ocurrió un error al actualizar membresía.";
      setMessage({ text: errMsg, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveNewUser = async () => {
    if (!addUserEmail.trim() || !addUserOrgId) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/app/api/staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_membership",
          email: addUserEmail.trim(),
          displayName: addUserName.trim(),
          role: addUserRole,
          status: "active",
          organizationId: addUserOrgId,
          fieldIds: [],
        }),
      });
      const body = await res.json() as { error?: string; success?: boolean };
      if (!res.ok) throw new Error(body.error ?? "Error al registrar persona.");

      setMessage({ text: "Persona registrada y asociada con éxito.", type: "success" });
      setShowAddUserForm(false);
      setAddUserEmail("");
      setAddUserName("");
      await refreshData();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ocurrió un error al registrar persona.";
      setMessage({ text: errMsg, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFeature = async (feature: "trazabilidad" | "pastoreo" | "analitica" | "benchmarking", currentEnabled: boolean) => {
    setLoading(true);
    setMessage(null);
    const fieldId = selectedFlagField === "global" ? null : selectedFlagField;
    try {
      const res = await fetch("/app/api/staff", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_feature_flags",
          organizationId: selectedFlagOrg,
          fieldId,
          feature,
          enabled: !currentEnabled,
        }),
      });
      const body = await res.json() as { error?: string; success?: boolean };
      if (!res.ok) throw new Error(body.error ?? "Error al actualizar funcionalidad.");

      setMessage({ text: `Funcionalidad '${feature}' actualizada.`, type: "success" });
      await refreshData();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ocurrió un error al actualizar funcionalidad.";
      setMessage({ text: errMsg, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const getFeatureState = (feature: "trazabilidad" | "pastoreo" | "analitica" | "benchmarking") => {
    const fId = selectedFlagField === "global" ? null : selectedFlagField;
    const flag = data.featureFlags.find(
      (ff) =>
        ff.organizationId === selectedFlagOrg &&
        ff.fieldId === fId &&
        ff.feature === feature
    );
    return flag?.enabled ?? false;
  };

  return (
    <AppShell activeSection="settings" organizationName="Administración Global" userName={userName} isStaff={true}>
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-10">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-black/8 pb-6">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald"><ShieldCheck className="inline-block mr-1" size={16} /> FundoSmart Staff</p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink">Consola de Control de Plataforma</h1>
            <p className="mt-2 max-w-3xl text-sm text-ink-muted">Administración global del sistema: gestión de espacios de trabajo, fundos, membresías y banderas de funcionalidades.</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="mt-6 flex border-b border-black/8 overflow-x-auto">
          <button
            onClick={() => { setActiveTab("workspaces"); setMessage(null); }}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition whitespace-nowrap ${activeTab === "workspaces" ? "border-emerald text-emerald" : "border-transparent text-ink-muted hover:text-ink"}`}
          >
            <Building2 size={16} /> Espacios & Fundos
          </button>
          <button
            onClick={() => { setActiveTab("memberships"); setMessage(null); }}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition whitespace-nowrap ${activeTab === "memberships" ? "border-emerald text-emerald" : "border-transparent text-ink-muted hover:text-ink"}`}
          >
            <Users size={16} /> Membresías
          </button>
          <button
            onClick={() => { setActiveTab("features"); setMessage(null); }}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition whitespace-nowrap ${activeTab === "features" ? "border-emerald text-emerald" : "border-transparent text-ink-muted hover:text-ink"}`}
          >
            <Sliders size={16} /> Funcionalidades
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab("feedback"); setMessage(null); }}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition whitespace-nowrap ${activeTab === "feedback" ? "border-emerald text-emerald" : "border-transparent text-ink-muted hover:text-ink"}`}
          >
            <MessageSquareText size={16} /> Comentarios
          </button>
          <button
            onClick={() => { setActiveTab("audit"); setMessage(null); }}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition whitespace-nowrap ${activeTab === "audit" ? "border-emerald text-emerald" : "border-transparent text-ink-muted hover:text-ink"}`}
          >
            <History size={16} /> Logs de Auditoría
          </button>
        </div>

        {/* Status Message */}
        {message && (
          <div className={`mt-6 rounded-2xl border px-4 py-3 text-sm font-semibold flex items-center gap-2 ${message.type === "success" ? "border-emerald/20 bg-emerald/5 text-emerald" : "border-alert-bar/20 bg-alert-bar/5 text-alert-ink"}`}>
            {message.type === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {message.text}
          </div>
        )}

        {/* Tab Content: Workspaces */}
        {activeTab === "workspaces" && (
          <div className="mt-8 grid gap-6 lg:grid-cols-[2fr_1.2fr]">
            <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <h2 className="text-xl font-black text-ink">Espacios de Trabajo ({data.organizations.length})</h2>
                <div className="flex gap-2">
                  <button onClick={() => setShowNewWorkspaceModal(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-xs font-bold text-white"><Plus size={14} /> Nuevo Espacio</button>
                  <button onClick={() => { setSelectedWorkspaceForFundo(data.organizations[0]?.id ?? ""); setShowNewFundoModal(true); }} className="inline-flex items-center gap-1.5 rounded-xl border border-black/10 px-3.5 py-2 text-xs font-bold text-ink"><Plus size={14} /> Nuevo Fundo</button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="relative mb-6">
                <Search className="absolute left-3.5 top-3 text-ink-subtle" size={16} />
                <input
                  type="text"
                  placeholder="Buscar por nombre o ID del espacio..."
                  className="w-full rounded-xl border border-black/12 bg-white pl-10 pr-4 py-2.5 text-sm font-medium text-ink outline-none focus:border-emerald"
                  value={searchWorkspace}
                  onChange={(e) => setSearchWorkspace(e.target.value)}
                />
              </div>

              {/* Workspaces Table */}
              <div className="w-full text-left text-sm">
                <div className="grid grid-cols-[2fr_1.5fr_2.4fr_1.8fr] border-b border-black/8 pb-3 text-xs font-black uppercase tracking-wider text-ink-subtle">
                  {WORKSPACE_SORT_OPTIONS.map((option) => (
                    <SortableGridHeader
                      column={option.column}
                      key={option.column}
                      label={option.label}
                      onSort={handleWorkspaceSort}
                      sort={workspaceSort}
                    />
                  ))}
                </div>
                <div className="divide-y divide-black/5">
                  {filteredWorkspaces.map(({ fieldCount, membershipCount, organization: org }) => {
                    const relatedFields = data.fields.filter(f => f.organizationId === org.id);
                    return (
                      <div key={org.id} className="grid grid-cols-[2fr_1.5fr_2.4fr_1.8fr] py-4 items-center hover:bg-surface-alt/40 transition">
                        <div>
                          <span className="font-bold text-ink block">{org.name}</span>
                          <span className="text-xs text-ink-subtle">Creado: {org.createdAt.slice(0,10)}</span>
                        </div>
                        <div>
                          <span className="inline-flex rounded-full bg-surface-alt px-2.5 py-0.5 text-xs font-bold text-ink-muted">
                            {KIND_LABELS[org.kind]}
                          </span>
                        </div>
                        <div>
                          <span className="block text-xs font-bold text-ink-muted">
                            {fieldCount} fundos · {membershipCount} miembros
                          </span>
                          <span className="text-xs text-ink-subtle block max-w-xs truncate">
                            {relatedFields.map(f => f.name).join(", ") || "(sin fundos)"}
                          </span>
                        </div>
                        <div className="font-mono text-xs text-ink-subtle truncate pr-2">{org.id}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Sidebar info */}
            <div className="space-y-6">
              {showNewWorkspaceModal && (
                <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-black text-ink mb-4">Crear Espacio de Trabajo</h3>
                  <form onSubmit={handleCreateWorkspace} className="space-y-4">
                    <div>
                      <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Nombre</label>
                      <input
                        type="text"
                        className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald"
                        value={newWorkspaceName}
                        onChange={(e) => setNewWorkspaceName(e.target.value)}
                        placeholder="Ej. Fundo San Pedro"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Tipo</label>
                      <select
                        className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald"
                        value={newWorkspaceKind}
                        onChange={(e) => setNewWorkspaceKind(e.target.value as "shared" | "personal" | "demo")}
                      >
                        <option value="shared">Compartido (Multi-usuario)</option>
                        <option value="personal">Sandbox personal</option>
                        <option value="demo">Demostración (Solo lectura por defecto)</option>
                      </select>
                    </div>
                    <div className="flex gap-2 justify-end pt-2">
                      <button type="button" onClick={() => setShowNewWorkspaceModal(false)} className="rounded-xl border border-black/10 px-4 py-2 text-xs font-bold text-ink">Cancelar</button>
                      <button type="submit" disabled={loading} className="rounded-xl bg-ink px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{loading ? "Creando..." : "Crear Espacio"}</button>
                    </div>
                  </form>
                </div>
              )}

              {showNewFundoModal && (
                <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-black text-ink mb-4">Crear Fundo Nuevo</h3>
                  <form onSubmit={handleCreateFundo} className="space-y-4">
                    <div>
                      <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Asignar a Espacio</label>
                      <select
                        className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald"
                        value={selectedWorkspaceForFundo}
                        onChange={(e) => setSelectedWorkspaceForFundo(e.target.value)}
                      >
                        {data.organizations.map(org => (
                          <option key={org.id} value={org.id}>{org.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Nombre del Fundo</label>
                      <input
                        type="text"
                        className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald"
                        value={newFundoName}
                        onChange={(e) => setNewFundoName(e.target.value)}
                        placeholder="Ej. Fundo Norte"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Ubicación (Opcional)</label>
                      <input
                        type="text"
                        className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald"
                        value={newFundoLocation}
                        onChange={(e) => setNewFundoLocation(e.target.value)}
                        placeholder="Ej. Osorno, Región de Los Lagos"
                      />
                    </div>
                    <div className="flex gap-2 justify-end pt-2">
                      <button type="button" onClick={() => setShowNewFundoModal(false)} className="rounded-xl border border-black/10 px-4 py-2 text-xs font-bold text-ink">Cancelar</button>
                      <button type="submit" disabled={loading} className="rounded-xl bg-ink px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{loading ? "Creando..." : "Crear Fundo"}</button>
                    </div>
                  </form>
                </div>
              )}

              <div className="rounded-3xl border border-emerald/10 bg-emerald/5 p-6 text-sm text-ink-muted leading-relaxed">
                <h4 className="font-black text-emerald flex items-center gap-1 mb-2"><CheckCircle2 size={16} /> Aislamiento de Espacios</h4>
                De acuerdo con el modelo del sistema, cada espacio de trabajo funciona como un tenant aislado. Los nuevos fundos heredan el estado Demo si se crean dentro de un espacio tipo Demostración.
              </div>
            </div>
          </div>
        )}

        {/* Tab Content: Memberships */}
        {activeTab === "memberships" && (
          <div className="mt-8 rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-black text-ink mb-1">Membresías e Inquilinos</h3>
                <p className="text-xs text-ink-subtle">Administra los accesos, roles y estados de los usuarios en cada espacio de trabajo.</p>
              </div>
            </div>

            {/* Search and Filters */}
            <div className="relative mb-6">
              <Search className="absolute left-3.5 top-3 text-ink-subtle" size={16} />
              <input
                type="text"
                placeholder="Buscar persona por nombre, correo o ID de espacio..."
                className="w-full rounded-xl border border-black/12 bg-white pl-10 pr-4 py-2.5 text-sm font-medium text-ink outline-none focus:border-emerald"
                value={searchMembership}
                onChange={(e) => setSearchMembership(e.target.value)}
              />
            </div>

            {/* Rejilla/Grid Table */}
            <div className="w-full text-left text-sm overflow-x-auto">
              <div className="min-w-[800px]">
                {/* Header */}
                <div className="grid grid-cols-[1.5fr_2.2fr_5fr] border-b border-black/8 pb-3 text-xs font-black uppercase tracking-wider text-ink-subtle">
                  {MEMBERSHIP_SORT_OPTIONS.slice(0, 2).map((option) => (
                    <SortableGridHeader
                      column={option.column}
                      key={option.column}
                      label={option.label}
                      onSort={handleMembershipSort}
                      sort={membershipSort}
                    />
                  ))}
                  <div className="grid grid-cols-[2.5fr_1.3fr_1.2fr] gap-2">
                    {MEMBERSHIP_SORT_OPTIONS.slice(2).map((option) => (
                      <SortableGridHeader
                        column={option.column}
                        key={option.column}
                        label={option.label}
                        onSort={handleMembershipSort}
                        sort={membershipSort}
                      />
                    ))}
                  </div>
                </div>

                {/* Body */}
                <div className="divide-y divide-black/5">
                  {uniqueUsers.map((user) => {
                    const isUserExpanded = expandedUsers[user.email] || false;
                    const displayedMemberships = user.memberships.length > 3 && !isUserExpanded
                      ? user.memberships.slice(0, 3)
                      : user.memberships;

                    return (
                      <div key={user.email} className="grid grid-cols-[1.5fr_2.2fr_5fr] py-4 items-start hover:bg-surface-alt/10 transition">
                        {/* Persona */}
                        <div className="font-bold text-ink pr-2 mt-1">{user.name}</div>

                        {/* mail */}
                        <div className="text-ink-subtle truncate pr-4 mt-1">{user.email}</div>

                        {/* spaces / roles / statuses nested stack */}
                        <div className="space-y-3.5 pr-2">
                          {displayedMemberships.map((m) => {
                            const org = workspaceMap.get(m.organizationId);
                            return (
                              <div key={m.id} className="grid grid-cols-[2.5fr_1.3fr_1.2fr] items-center gap-2 text-xs">
                                {/* Workspace Name */}
                                <div className="text-ink font-semibold truncate pr-2">{org?.name ?? "Desconocido"}</div>
                                {/* Role Select */}
                                <div>
                                  <select
                                    className="rounded-lg border border-black/12 bg-white px-2 py-1 text-xs outline-none focus:border-emerald font-medium disabled:opacity-50"
                                    value={m.role}
                                    onChange={(e) => handleUpdateMembershipRoleOrStatus(m, e.target.value as "owner" | "admin" | "manager" | "operator" | "viewer", m.status)}
                                    disabled={loading}
                                  >
                                    {Object.entries(ROLE_LABELS).map(([val, label]) => (
                                      <option key={val} value={val}>{label}</option>
                                    ))}
                                  </select>
                                </div>
                                {/* Status Select */}
                                <div>
                                  <select
                                    className={`rounded-lg border border-black/12 bg-white px-2 py-1 text-xs outline-none focus:border-emerald font-bold ${m.status === "active" ? "text-emerald" : "text-alert-ink"} disabled:opacity-50`}
                                    value={m.status}
                                    onChange={(e) => handleUpdateMembershipRoleOrStatus(m, m.role, e.target.value as "active" | "suspended")}
                                    disabled={loading}
                                  >
                                    <option value="active">Activo</option>
                                    <option value="suspended">Suspendido</option>
                                  </select>
                                </div>
                              </div>
                            );
                          })}

                          {/* Expand / Collapse trigger */}
                          {user.memberships.length > 3 && (
                            <button
                              onClick={() => setExpandedUsers(prev => ({ ...prev, [user.email]: !isUserExpanded }))}
                              className="text-[11px] font-black text-emerald hover:underline block mt-1"
                            >
                              {isUserExpanded ? "Contraer espacios" : `Mostrar ${user.memberships.length - 3} más...`}
                            </button>
                          )}

                          {/* Inline Adding Space Form */}
                          {addingWorkspaceForEmail === user.email ? (
                            <div className="mt-3 rounded-2xl border border-emerald/12 bg-emerald/5 p-3.5 grid grid-cols-[2fr_1.5fr_1fr] gap-3 items-end">
                              <div>
                                <label className="block text-[10px] font-black uppercase tracking-wider text-ink-muted mb-1">Espacio</label>
                                <select
                                  className="w-full rounded-lg border border-black/12 bg-white px-2 py-1 text-xs outline-none focus:border-emerald font-medium"
                                  value={newSpaceId}
                                  onChange={(e) => setNewSpaceId(e.target.value)}
                                >
                                  <option value="" disabled>Elegir espacio...</option>
                                  {data.organizations
                                    .filter(org => !user.memberships.some(m => m.organizationId === org.id))
                                    .map(org => (
                                      <option key={org.id} value={org.id}>{org.name}</option>
                                    ))
                                  }
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] font-black uppercase tracking-wider text-ink-muted mb-1">Rol</label>
                                <select
                                  className="w-full rounded-lg border border-black/12 bg-white px-2 py-1 text-xs outline-none focus:border-emerald font-medium"
                                  value={newSpaceRole}
                                  onChange={(e) => setNewSpaceRole(e.target.value as "owner" | "admin" | "manager" | "operator" | "viewer")}
                                >
                                  {Object.entries(ROLE_LABELS).map(([val, label]) => (
                                    <option key={val} value={val}>{label}</option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex gap-1.5 justify-end">
                                <button
                                  onClick={() => setAddingWorkspaceForEmail(null)}
                                  className="rounded-lg border border-black/10 px-2 py-1 text-[10px] font-bold text-ink bg-white hover:bg-surface-alt"
                                >
                                  Cancelar
                                </button>
                                <button
                                  onClick={() => handleSaveInlineWorkspace(user)}
                                  disabled={loading || !newSpaceId}
                                  className="rounded-lg bg-ink px-2.5 py-1 text-[10px] font-bold text-white disabled:opacity-50"
                                >
                                  Guardar
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setAddingWorkspaceForEmail(user.email);
                                setNewSpaceId("");
                                setNewSpaceRole("viewer");
                                setShowAddUserForm(false);
                              }}
                              className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald hover:underline mt-2"
                            >
                              <Plus size={12} /> Agregar Espacio
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* agregar persona bottom button */}
            <div className="border-t border-black/8 mt-6 pt-6">
              <button
                onClick={() => {
                  setShowAddUserForm(true);
                  setAddingWorkspaceForEmail(null);
                  setAddUserEmail("");
                  setAddUserName("");
                  setAddUserOrgId(data.organizations[0]?.id ?? "");
                  setAddUserRole("viewer");
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-black/12 hover:bg-surface-alt px-4 py-2.5 text-xs font-bold text-ink transition"
              >
                <Plus size={14} /> agregar persona
              </button>
            </div>

            {/* Add User/Persona Form Panel */}
            {showAddUserForm && (
              <div className="mt-6 rounded-3xl border border-black/10 bg-white p-5 shadow-sm space-y-4 max-w-xl">
                <h4 className="text-sm font-black text-ink">Registrar Persona</h4>
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Nombre</label>
                    <input
                      type="text"
                      className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-xs outline-none focus:border-emerald font-medium"
                      placeholder="Nombre visible"
                      value={addUserName}
                      onChange={(e) => setAddUserName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Mail</label>
                    <input
                      type="email"
                      className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-xs outline-none focus:border-emerald font-medium"
                      placeholder="correo@ejemplo.com"
                      value={addUserEmail}
                      onChange={(e) => setAddUserEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Espacio Inicial</label>
                    <select
                      className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-xs outline-none focus:border-emerald font-medium"
                      value={addUserOrgId}
                      onChange={(e) => setAddUserOrgId(e.target.value)}
                    >
                      {data.organizations.map(org => (
                        <option key={org.id} value={org.id}>{org.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Rol Inicial</label>
                    <select
                      className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-xs outline-none focus:border-emerald font-medium"
                      value={addUserRole}
                      onChange={(e) => setAddUserRole(e.target.value as "owner" | "admin" | "manager" | "operator" | "viewer")}
                    >
                      {Object.entries(ROLE_LABELS).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowAddUserForm(false)}
                    className="rounded-xl border border-black/10 px-3 py-1.5 text-xs font-bold text-ink hover:bg-surface-alt transition"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleSaveNewUser}
                    disabled={loading || !addUserEmail.trim() || !addUserOrgId}
                    className="rounded-xl bg-ink px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                  >
                    Guardar Persona
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab Content: Feature Flags */}
        {activeTab === "features" && (
          <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_2fr]">
            <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
              <h3 className="text-lg font-black text-ink mb-4 flex items-center gap-1.5"><Settings2 size={18} /> Configurar Contexto</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Espacio de Trabajo</label>
                  <select
                    className="w-full rounded-xl border border-black/12 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-emerald"
                    value={selectedFlagOrg}
                    onChange={(e) => { setSelectedFlagOrg(e.target.value); setSelectedFlagField("global"); }}
                  >
                    {data.organizations.map(org => (
                      <option key={org.id} value={org.id}>{org.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-black uppercase tracking-wider text-ink-muted mb-1">Alcance Funcional</label>
                  <select
                    className="w-full rounded-xl border border-black/12 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-emerald"
                    value={selectedFlagField}
                    onChange={(e) => setSelectedFlagField(e.target.value)}
                  >
                    <option value="global">Global (Todo el espacio de trabajo)</option>
                    {(fieldsByOrg.get(selectedFlagOrg) ?? []).map(field => (
                      <option key={field.id} value={field.id}>Fundo: {field.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
              <h3 className="text-lg font-black text-ink mb-1">Banderas de Características (Feature Flags)</h3>
              <p className="text-xs text-ink-subtle mb-6">Activa o desactiva módulos del producto en caliente para el contexto seleccionado.</p>

              <div className="space-y-4">
                {[
                  { key: "trazabilidad", label: "Trazabilidad Ganadera", desc: "Historial completo de pesajes, lotes, movimientos y trazabilidad del animal." },
                  { key: "pastoreo", label: "Gestión de Praderas", desc: "Planificación de pastoreo, rotación de células y monitoreo NDVI." },
                  { key: "analitica", label: "Analítica en Tiempo Real", desc: "Cálculos matemáticos complejos de biomasa, proyecciones e indicadores." },
                  { key: "benchmarking", label: "Benchmarking", desc: "Comparación agregada y anonimizada de rendimientos productivos entre fundos." },
                ].map((feat) => {
                  const enabled = getFeatureState(feat.key as "trazabilidad" | "pastoreo" | "analitica" | "benchmarking");
                  return (
                    <div key={feat.key} className="flex items-center justify-between gap-6 rounded-2xl border border-black/8 p-4 hover:bg-surface-alt/20 transition">
                      <div className="min-w-0">
                        <p className="font-bold text-ink text-sm">{feat.label}</p>
                        <p className="text-xs text-ink-muted mt-0.5">{feat.desc}</p>
                      </div>
                      <button
                        onClick={() => handleToggleFeature(feat.key as "trazabilidad" | "pastoreo" | "analitica" | "benchmarking", enabled)}
                        disabled={loading}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enabled ? "bg-emerald" : "bg-black/12"}`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enabled ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Tab Content: Product Feedback */}
        {activeTab === "feedback" && (
          <StaffFeedbackInbox organizations={data.organizations} />
        )}

        {/* Tab Content: Audit Logs */}
        {activeTab === "audit" && (
          <div className="mt-8 rounded-3xl border border-black/10 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-black text-ink mb-1">Registro de Auditoría de Plataforma</h3>
            <p className="text-xs text-ink-subtle mb-6">Últimos 100 movimientos administrativos realizados por personal de soporte y bootstrap.</p>

            <div className="w-full text-left text-sm overflow-x-auto">
              <div className="min-w-[800px]">
                <div className="grid grid-cols-[1.5fr_1.8fr_1.5fr_1.8fr_1.2fr_2fr] border-b border-black/8 pb-3 text-xs font-black uppercase tracking-wider text-ink-subtle">
                  {AUDIT_SORT_OPTIONS.map((option) => (
                    <SortableGridHeader
                      column={option.column}
                      key={option.column}
                      label={option.label}
                      onSort={handleAuditSort}
                      sort={auditSort}
                    />
                  ))}
                </div>
                <div className="divide-y divide-black/5 text-xs">
                  {sortedAuditLogs.map((log) => (
                    <div key={log.id} className="grid grid-cols-[1.5fr_1.8fr_1.5fr_1.8fr_1.2fr_2fr] py-3 items-center hover:bg-surface-alt/40 transition">
                      <div className="font-mono text-ink-subtle whitespace-nowrap">{log.occurredAt.replace("T", " ").slice(0, 19)}</div>
                      <div className="font-bold text-ink truncate pr-2">{log.actor}</div>
                      <div>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${log.action.includes("created") ? "bg-emerald/10 text-emerald" : log.action.includes("disabled") ? "bg-alert-bar/10 text-alert-ink" : "bg-surface-alt text-ink-muted"}`}>
                          {log.action}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-ink-muted block truncate">{log.entityType}</span>
                        <span className="block font-mono text-[10px] text-ink-subtle truncate">{log.entityId.slice(0, 20)}</span>
                      </div>
                      <div className="font-mono text-ink-subtle truncate pr-2">{log.organizationId.slice(0, 15)}</div>
                      <div className="font-mono text-[10px] text-ink-subtle max-w-xs truncate pr-2">
                        {log.after ? JSON.stringify(log.after) : "(sin detalles)"}
                      </div>
                    </div>
                  ))}
                  {data.auditLogs.length === 0 && (
                    <div className="py-8 text-center text-ink-subtle font-semibold">Sin registros de auditoría aún.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
