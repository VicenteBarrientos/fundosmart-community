"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Inbox,
  LoaderCircle,
  Mail,
  RefreshCw,
  Save,
  Search,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_IMPACT_LABELS,
  FEEDBACK_PRIORITY_LABELS,
  FEEDBACK_STATUS_LABELS,
  type FeedbackCategory,
  type FeedbackPriority,
  type FeedbackStatus,
  type ProductFeedbackItem,
  type ProductFeedbackSummary,
} from "./domain/types";

type StaffFeedbackInboxProps = {
  organizations: Array<{ id: string; name: string }>;
};

type FeedbackResponse = {
  items: ProductFeedbackItem[];
  summary: ProductFeedbackSummary;
};

const EMPTY_SUMMARY: ProductFeedbackSummary = {
  total: 0,
  new: 0,
  reviewing: 0,
  planned: 0,
  resolved: 0,
  closed: 0,
};

export function StaffFeedbackInbox({ organizations }: StaffFeedbackInboxProps) {
  const [category, setCategory] = useState<FeedbackCategory | "all">("all");
  const [status, setStatus] = useState<FeedbackStatus | "all">("all");
  const [priority, setPriority] = useState<FeedbackPriority | "unassigned" | "all">("all");
  const [organizationId, setOrganizationId] = useState("all");
  const [search, setSearch] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [data, setData] = useState<FeedbackResponse>({ items: [], summary: EMPTY_SUMMARY });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queryString = useMemo(() => feedbackQuery({
    category,
    status,
    priority,
    organizationId,
    search,
  }), [category, organizationId, priority, search, status]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadError(null);
      void fetch(`/app/api/staff/feedback?${queryString}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json().catch(() => null) as (FeedbackResponse & { error?: string }) | null;
          if (!response.ok || !payload?.items || !payload.summary) {
            throw new Error(payload?.error ?? "No fue posible cargar los comentarios.");
          }
          setData({ items: payload.items, summary: payload.summary });
          setSelectedId((current) => {
            if (current && payload.items.some((item) => item.id === current)) return current;
            return payload.items[0]?.id ?? null;
          });
        })
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setLoadError(cause instanceof Error ? cause.message : "No fue posible cargar los comentarios.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [queryString, refreshVersion]);

  const selected = data.items.find((item) => item.id === selectedId) ?? null;

  const exportBase = `/app/api/staff/feedback?${queryString}`;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-emerald">Voz de usuarios</p>
          <h2 className="mt-1 text-2xl font-black tracking-[-0.04em] text-ink">Comentarios del producto</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">
            Errores, mejoras y recomendaciones enviados desde FundoSmart. Los estados y notas son internos.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            aria-label="Actualizar comentarios"
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition hover:bg-surface-alt"
            onClick={() => setRefreshVersion((value) => value + 1)}
            type="button"
          >
            <RefreshCw className={loading ? "animate-spin" : ""} size={14} /> Actualizar
          </button>
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition hover:bg-surface-alt"
            href={`${exportBase}&format=csv`}
          >
            <Download size={14} /> CSV
          </a>
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-ink px-3 text-xs font-black text-white transition hover:bg-chrome"
            href={`${exportBase}&format=json`}
          >
            <Download size={14} /> JSON
          </a>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard label="Total" value={data.summary.total} />
        <SummaryCard active label="Nuevos" value={data.summary.new} />
        <SummaryCard label="En revisión" value={data.summary.reviewing} />
        <SummaryCard label="Planificados" value={data.summary.planned} />
        <SummaryCard label="Resueltos" value={data.summary.resolved} />
        <SummaryCard label="Cerrados" value={data.summary.closed} />
      </div>

      <div className="mt-5 rounded-2xl border border-line-steel bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1.5fr_repeat(4,minmax(0,1fr))]">
          <label className="relative">
            <span className="sr-only">Buscar comentarios</span>
            <Search className="pointer-events-none absolute left-3.5 top-3.5 text-ink-subtle" size={15} />
            <input
              className="h-11 w-full rounded-xl border border-line-steel bg-surface-alt pl-10 pr-3 text-xs font-semibold text-ink outline-none focus:border-accent"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar comentario, persona u organización"
              value={search}
            />
          </label>
          <FilterSelect
            label="Tipo"
            onChange={(value) => setCategory(value as FeedbackCategory | "all")}
            value={category}
          >
            <option value="all">Todos los tipos</option>
            {Object.entries(FEEDBACK_CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Estado"
            onChange={(value) => setStatus(value as FeedbackStatus | "all")}
            value={status}
          >
            <option value="all">Todos los estados</option>
            {Object.entries(FEEDBACK_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Prioridad"
            onChange={(value) => setPriority(value as FeedbackPriority | "unassigned" | "all")}
            value={priority}
          >
            <option value="all">Todas las prioridades</option>
            <option value="unassigned">Sin asignar</option>
            {Object.entries(FEEDBACK_PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </FilterSelect>
          <FilterSelect label="Organización" onChange={setOrganizationId} value={organizationId}>
            <option value="all">Todas las organizaciones</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>{organization.name}</option>
            ))}
          </FilterSelect>
        </div>
      </div>

      {loadError && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-alert-bar/25 bg-alert-bar/8 px-4 py-3 text-xs font-bold text-alert-ink" role="alert">
          <AlertTriangle className="mt-0.5 shrink-0" size={16} /> {loadError}
        </div>
      )}

      <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.8fr)]">
        <div className="min-w-0 rounded-3xl border border-line-steel bg-white p-3 shadow-sm sm:p-4">
          <div className="flex items-center justify-between gap-3 border-b border-line-steel px-1 pb-3">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-ink-muted">
              {data.items.length} comentario{data.items.length === 1 ? "" : "s"} visible{data.items.length === 1 ? "" : "s"}
            </p>
            {loading && <LoaderCircle className="animate-spin text-accent" size={16} aria-label="Cargando" />}
          </div>
          <div className="divide-y divide-line-steel">
            {data.items.map((item) => {
              const active = item.id === selectedId;
              return (
                <button
                  aria-pressed={active}
                  className={`w-full px-2 py-4 text-left transition sm:px-3 ${
                    active ? "bg-band" : "hover:bg-surface-alt/60"
                  }`}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  type="button"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={categoryTone(item.category)}>{categoryShort(item.category)}</Badge>
                    <Badge tone={statusTone(item.status)}>{FEEDBACK_STATUS_LABELS[item.status]}</Badge>
                    {item.priority && <Badge tone={priorityTone(item.priority)}>{item.priority.toUpperCase()}</Badge>}
                    <span className="ml-auto text-[11px] font-semibold text-ink-subtle">
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm font-bold leading-5 text-ink">{item.message}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-ink-subtle">
                    <span>{item.reporterName}</span>
                    <span>{item.organizationName}</span>
                    <span className="font-mono">{item.pagePath}</span>
                  </div>
                </button>
              );
            })}
            {!loading && data.items.length === 0 && (
              <div className="grid min-h-56 place-items-center px-5 py-10 text-center">
                <div>
                  <Inbox className="mx-auto text-ink-subtle" size={28} />
                  <p className="mt-3 text-sm font-black text-ink">No hay comentarios con estos filtros</p>
                  <p className="mt-1 text-xs text-ink-subtle">Prueba otra búsqueda o espera nuevos envíos.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="min-w-0">
          {selected ? (
            <FeedbackTriagePanel
              feedback={selected}
              key={selected.id}
              onSaved={(feedback) => {
                setData((current) => {
                  const previous = current.items.find((item) => item.id === feedback.id);
                  return {
                    items: current.items.map((item) => item.id === feedback.id ? feedback : item),
                    summary: previous
                      ? moveSummaryStatus(current.summary, previous.status, feedback.status)
                      : current.summary,
                  };
                });
              }}
            />
          ) : (
            <div className="grid min-h-64 place-items-center rounded-3xl border border-dashed border-line-steel bg-white p-6 text-center">
              <div>
                <Inbox className="mx-auto text-ink-subtle" size={28} />
                <p className="mt-3 text-sm font-black text-ink">Selecciona un comentario</p>
                <p className="mt-1 text-xs text-ink-subtle">Aquí podrás priorizarlo y registrar decisiones internas.</p>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function FeedbackTriagePanel({
  feedback,
  onSaved,
}: {
  feedback: ProductFeedbackItem;
  onSaved: (feedback: ProductFeedbackItem) => void;
}) {
  const [draftStatus, setDraftStatus] = useState<FeedbackStatus>(feedback.status);
  const [draftPriority, setDraftPriority] = useState<FeedbackPriority | "unassigned">(
    feedback.priority ?? "unassigned",
  );
  const [draftNote, setDraftNote] = useState(feedback.staffNote ?? "");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const dirty = draftStatus !== feedback.status
    || (draftPriority === "unassigned" ? null : draftPriority) !== feedback.priority
    || (draftNote.trim() || null) !== feedback.staffNote;

  async function saveTriage() {
    if (!dirty) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await fetch("/app/api/staff/feedback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedbackId: feedback.id,
          expectedVersion: feedback.version,
          status: draftStatus,
          priority: draftPriority === "unassigned" ? null : draftPriority,
          staffNote: draftNote,
        }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        feedback?: ProductFeedbackItem;
      } | null;
      if (!response.ok || !payload?.feedback) {
        throw new Error(payload?.error ?? "No fue posible actualizar el comentario.");
      }
      onSaved(payload.feedback);
      setSaveMessage({ type: "success", text: "Seguimiento guardado." });
    } catch (cause) {
      setSaveMessage({
        type: "error",
        text: cause instanceof Error ? cause.message : "No fue posible actualizar el comentario.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-3xl border border-line-steel bg-white p-5 shadow-sm lg:sticky lg:top-24">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={categoryTone(feedback.category)}>{FEEDBACK_CATEGORY_LABELS[feedback.category]}</Badge>
        <Badge tone="neutral">{FEEDBACK_IMPACT_LABELS[feedback.impact]}</Badge>
        <Badge tone="neutral">Plan {feedback.planCode}</Badge>
      </div>
      <h3 className="mt-4 text-lg font-black tracking-[-0.03em] text-ink">Detalle del comentario</h3>
      <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">{feedback.message}</p>

      <div className="mt-5 grid gap-2 rounded-2xl bg-surface-alt p-3 text-[11px] font-semibold text-ink-muted">
        <ContextRow icon={UserRound} label="Persona" value={`${feedback.reporterName} · ${feedback.reporterEmail}`} />
        <ContextRow icon={Mail} label="Contacto" value={feedback.contactAllowed ? "Autorizado" : "No autorizado"} />
        <ContextRow label="Organización" value={`${feedback.organizationName}${feedback.fieldName ? ` · ${feedback.fieldName}` : ""}`} />
        <ContextRow label="Pantalla" value={feedback.pagePath} mono />
        <ContextRow label="Versión" value={feedback.releaseSha.slice(0, 12)} mono />
        <ContextRow
          label="Dispositivo"
          value={[
            feedback.viewportWidth && feedback.viewportHeight
              ? `${feedback.viewportWidth}×${feedback.viewportHeight}`
              : null,
            feedback.online ? "con conexión" : "sin conexión",
          ].filter(Boolean).join(" · ")}
        />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <FilterSelect
          label="Estado interno"
          onChange={(value) => setDraftStatus(value as FeedbackStatus)}
          value={draftStatus}
        >
          {Object.entries(FEEDBACK_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </FilterSelect>
        <FilterSelect
          label="Prioridad"
          onChange={(value) => setDraftPriority(value as FeedbackPriority | "unassigned")}
          value={draftPriority}
        >
          <option value="unassigned">Sin asignar</option>
          {Object.entries(FEEDBACK_PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </FilterSelect>
      </div>

      <label className="mt-4 block">
        <span className="text-[11px] font-black uppercase tracking-[0.1em] text-ink-muted">Nota interna</span>
        <textarea
          className="mt-1.5 min-h-28 w-full resize-y rounded-xl border border-line-steel bg-white px-3 py-2.5 text-xs font-medium leading-5 text-ink outline-none focus:border-accent"
          maxLength={2000}
          onChange={(event) => setDraftNote(event.target.value)}
          placeholder="Contexto, decisión o siguiente paso para el equipo…"
          value={draftNote}
        />
        <span className="mt-1 block text-right text-[10px] font-semibold text-ink-subtle">{draftNote.length} / 2.000</span>
      </label>

      {saveMessage && (
        <div className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs font-bold ${
          saveMessage.type === "success"
            ? "bg-emerald/8 text-emerald"
            : "bg-alert-bar/8 text-alert-ink"
        }`} role={saveMessage.type === "error" ? "alert" : "status"}>
          {saveMessage.type === "success"
            ? <CheckCircle2 className="mt-0.5 shrink-0" size={15} />
            : <AlertTriangle className="mt-0.5 shrink-0" size={15} />}
          {saveMessage.text}
        </div>
      )}

      <button
        className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white transition hover:bg-chrome disabled:cursor-not-allowed disabled:opacity-45"
        disabled={!dirty || saving}
        onClick={() => void saveTriage()}
        type="button"
      >
        {saving ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />}
        {saving ? "Guardando…" : "Guardar seguimiento"}
      </button>
    </div>
  );
}

function moveSummaryStatus(
  summary: ProductFeedbackSummary,
  previous: FeedbackStatus,
  next: FeedbackStatus,
): ProductFeedbackSummary {
  if (previous === next) return summary;
  return {
    ...summary,
    [previous]: Math.max(0, summary[previous] - 1),
    [next]: summary[next] + 1,
  };
}

function SummaryCard({ active = false, label, value }: { active?: boolean; label: string; value: number }) {
  return (
    <div className={`rounded-2xl border p-3 ${active ? "border-accent/25 bg-accent/8" : "border-line-steel bg-white"}`}>
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-ink-subtle">{label}</p>
      <p className="mt-1 text-2xl font-black tracking-[-0.05em] text-ink">{value.toLocaleString("es-CL")}</p>
    </div>
  );
}

function FilterSelect({
  children,
  label,
  onChange,
  value,
}: {
  children: React.ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        className="h-11 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none focus:border-accent"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "alert" | "accent" | "info" | "neutral" | "success" | "warning";
}) {
  const classes = {
    alert: "bg-alert-bar/10 text-alert-ink",
    accent: "bg-accent/10 text-emerald",
    info: "bg-blue-50 text-blue-700",
    neutral: "bg-surface-alt text-ink-muted",
    success: "bg-emerald/10 text-emerald",
    warning: "bg-warn-bg text-warn-ink",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.06em] ${classes[tone]}`}>
      {children}
    </span>
  );
}

function ContextRow({
  icon: Icon,
  label,
  mono = false,
  value,
}: {
  icon?: typeof UserRound;
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
      <span className="flex items-center gap-1.5 font-black text-ink-subtle">
        {Icon && <Icon size={12} />} {label}
      </span>
      <span className={`min-w-0 break-words text-ink ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

function feedbackQuery(input: {
  category: FeedbackCategory | "all";
  status: FeedbackStatus | "all";
  priority: FeedbackPriority | "unassigned" | "all";
  organizationId: string;
  search: string;
}): string {
  const params = new URLSearchParams();
  if (input.category !== "all") params.set("category", input.category);
  if (input.status !== "all") params.set("status", input.status);
  if (input.priority !== "all") params.set("priority", input.priority);
  if (input.organizationId !== "all") params.set("organizationId", input.organizationId);
  if (input.search.trim()) params.set("search", input.search.trim());
  return params.toString();
}

function categoryShort(category: FeedbackCategory): string {
  return category === "bug" ? "Error" : category === "improvement" ? "Mejora" : "Recomendación";
}

function categoryTone(category: FeedbackCategory): "alert" | "accent" | "info" {
  return category === "bug" ? "alert" : category === "improvement" ? "accent" : "info";
}

function statusTone(status: FeedbackStatus): "accent" | "neutral" | "success" | "warning" {
  if (status === "new") return "accent";
  if (status === "reviewing" || status === "planned") return "warning";
  if (status === "resolved") return "success";
  return "neutral";
}

function priorityTone(priority: FeedbackPriority): "alert" | "neutral" | "warning" {
  if (priority === "p0") return "alert";
  if (priority === "p1") return "warning";
  return "neutral";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("es-CL", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(date);
}
