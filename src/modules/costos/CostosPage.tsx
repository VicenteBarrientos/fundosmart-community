"use client";

import {
  ACTIVITY_TYPE_LABELS,
  LIVESTOCK_EXPENSE_CATEGORY_LABELS,
  type Activity,
  type ActivityType,
  type Fundo,
  type LivestockExpense,
  type LivestockExpenseCategory,
  type Potrero,
} from "@/src/core/domain/types";
import { downloadCsv } from "@/src/core/export/csv.mjs";
import { AppShell } from "@/src/core/layout/AppShell";
import { HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import {
  ArrowRight,
  Beef,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  CircleDollarSign,
  Download,
  Filter,
  MapPinned,
  ReceiptText,
  Sprout,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

type CostosPageProps = {
  fundos: Fundo[];
  potreros: Potrero[];
  activities: Activity[];
  livestockExpenses: LivestockExpense[];
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
};

type Period = "all" | "30" | "season";
type CostOrigin = "all" | "agricultural" | "livestock";

type CostMovement = {
  id: string;
  date: string | null;
  origin: "Agrícola" | "Ganado";
  type: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  fundo: string;
  location: string;
  costClp: number;
};

const ALL = "all";
const SEASON_START = getSeasonStart();
const SEASON_LABEL = `${SEASON_START.slice(0, 4)}–${String(Number(SEASON_START.slice(0, 4)) + 1).slice(-2)}`;

export function CostosPage({ fundos, potreros, activities, isDemo, livestockExpenses, organizationId, organizationName, userName }: CostosPageProps) {
  const [selectedFundoId, setSelectedFundoId] = useState(ALL);
  const [selectedPotreroId, setSelectedPotreroId] = useState(ALL);
  const [selectedType, setSelectedType] = useState<ActivityType | typeof ALL>(ALL);
  const [selectedOrigin, setSelectedOrigin] = useState<CostOrigin>("all");
  const [period, setPeriod] = useState<Period>("all");

  const fundoById = useMemo(() => new Map(fundos.map((fundo) => [fundo.id, fundo])), [fundos]);
  const potreroById = useMemo(() => new Map(potreros.map((potrero) => [potrero.id, potrero])), [potreros]);
  const selectablePotreros = useMemo(
    () => selectedFundoId === ALL ? potreros : potreros.filter((potrero) => potrero.fieldId === selectedFundoId),
    [potreros, selectedFundoId],
  );
  const scopePotreros = useMemo(() => {
    if (selectedPotreroId !== ALL) return potreros.filter((potrero) => potrero.id === selectedPotreroId);
    if (selectedFundoId !== ALL) return potreros.filter((potrero) => potrero.fieldId === selectedFundoId);
    return potreros;
  }, [potreros, selectedFundoId, selectedPotreroId]);

  const filteredActivities = useMemo(() => {
    const cutoff30 = new Date();
    cutoff30.setDate(cutoff30.getDate() - 30);
    cutoff30.setHours(0, 0, 0, 0);

    return activities
      .filter((activity) => (activity.costClp ?? 0) > 0)
      .filter((activity) => {
        if (selectedOrigin === "livestock") return false;
        const potrero = potreroById.get(activity.potreroId);
        if (!potrero) return false;
        if (selectedFundoId !== ALL && potrero.fieldId !== selectedFundoId) return false;
        if (selectedPotreroId !== ALL && activity.potreroId !== selectedPotreroId) return false;
        if (selectedType !== ALL && activity.type !== selectedType) return false;
        if (period === "season" && activity.occurredAt < SEASON_START) return false;
        if (period === "30" && new Date(`${activity.occurredAt}T12:00:00`) < cutoff30) return false;
        return true;
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));
  }, [activities, period, potreroById, selectedFundoId, selectedOrigin, selectedPotreroId, selectedType]);

  const filteredLivestockExpenses = useMemo(() => {
    const cutoff30 = new Date();
    cutoff30.setDate(cutoff30.getDate() - 30);
    cutoff30.setHours(0, 0, 0, 0);

    return livestockExpenses
      .filter((expense) => {
        if (selectedOrigin === "agricultural") return false;
        if (selectedPotreroId !== ALL || selectedType !== ALL) return false;
        if (selectedFundoId !== ALL && expense.fieldId !== selectedFundoId) return false;
        if (period === "season" && (!expense.date || expense.date < SEASON_START)) return false;
        if (period === "30" && (!expense.date || new Date(`${expense.date}T12:00:00`) < cutoff30)) return false;
        return true;
      })
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.createdAt.localeCompare(a.createdAt));
  }, [livestockExpenses, period, selectedFundoId, selectedOrigin, selectedPotreroId, selectedType]);

  const agriculturalCost = filteredActivities.reduce((sum, activity) => sum + (activity.costClp ?? 0), 0);
  const livestockCost = filteredLivestockExpenses.reduce((sum, expense) => sum + expense.amountClp, 0);
  const totalCost = agriculturalCost + livestockCost;
  const totalRecords = filteredActivities.length + filteredLivestockExpenses.length;
  const scopeArea = scopePotreros.reduce((sum, potrero) => sum + potrero.areaHectares, 0);
  const averageCost = totalRecords > 0 ? totalCost / totalRecords : 0;
  const selectedFundo = fundos.find((fundo) => fundo.id === selectedFundoId) ?? null;

  const typeBreakdown = [
    ...(Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[]).map((type) => ({
      type: `activity-${type}`,
      label: ACTIVITY_TYPE_LABELS[type],
      sublabel: "Manejo agrícola",
      total: filteredActivities
        .filter((activity) => activity.type === type)
        .reduce((sum, activity) => sum + (activity.costClp ?? 0), 0),
    })),
    ...(Object.keys(LIVESTOCK_EXPENSE_CATEGORY_LABELS) as LivestockExpenseCategory[]).map((category) => ({
      type: `livestock-${category}`,
      label: LIVESTOCK_EXPENSE_CATEGORY_LABELS[category],
      sublabel: "Ganado",
      total: filteredLivestockExpenses
        .filter((expense) => expense.category === category)
        .reduce((sum, expense) => sum + expense.amountClp, 0),
    })),
  ]
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total);

  const originBreakdown = [
    { key: "agricultural", label: "Manejos agrícolas", sublabel: `${filteredActivities.length} registros`, total: agriculturalCost },
    { key: "livestock", label: "Ganado", sublabel: `${filteredLivestockExpenses.length} egresos`, total: livestockCost },
  ].filter((item) => item.total > 0);

  const potreroBreakdown = scopePotreros
    .map((potrero) => ({
      potrero,
      fundo: fundoById.get(potrero.fieldId),
      total: filteredActivities
        .filter((activity) => activity.potreroId === potrero.id)
        .reduce((sum, activity) => sum + (activity.costClp ?? 0), 0),
    }))
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total);

  const costMovements: CostMovement[] = [
    ...filteredActivities.map((activity) => {
      const potrero = potreroById.get(activity.potreroId);
      const fundo = potrero ? fundoById.get(potrero.fieldId) : null;
      return {
        id: `activity-${activity.id}`,
        date: activity.occurredAt,
        origin: "Agrícola" as const,
        type: ACTIVITY_TYPE_LABELS[activity.type],
        description: activity.description,
        quantity: activity.quantity,
        unit: activity.unit,
        fundo: fundo?.name ?? "Fundo",
        location: potrero?.name ?? "Potrero",
        costClp: activity.costClp ?? 0,
      };
    }),
    ...filteredLivestockExpenses.map((expense) => ({
      id: `livestock-${expense.id}`,
      date: expense.date,
      origin: "Ganado" as const,
      type: LIVESTOCK_EXPENSE_CATEGORY_LABELS[expense.category],
      description: expense.description,
      quantity: null,
      unit: null,
      fundo: expense.fieldId ? fundoById.get(expense.fieldId)?.name ?? "Fundo" : "Sin fundo",
      location: "Libro de ganado",
      costClp: expense.amountClp,
    })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));

  function handleFundoChange(value: string) {
    setSelectedFundoId(value);
    setSelectedPotreroId(ALL);
  }

  function handleOriginChange(value: string) {
    const origin = value as CostOrigin;
    setSelectedOrigin(origin);
    if (origin === "livestock") {
      setSelectedPotreroId(ALL);
      setSelectedType(ALL);
    }
  }

  function exportCsv() {
    if (costMovements.length === 0) return;

    const rows = costMovements.map((movement) => [
      movement.date ?? "",
      movement.origin,
      movement.fundo,
      movement.location,
      movement.type,
      movement.description,
      movement.quantity ?? "",
      movement.unit ?? "",
      movement.costClp,
    ]);
    const headers = ["Fecha", "Origen", "Fundo", "Ubicación", "Tipo", "Descripción", "Cantidad", "Unidad", "Costo CLP"];
    downloadCsv(`fundosmart-costos-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  }

  return (
    <AppShell activeSection="costos" fieldName={selectedFundo?.name ?? "Todos los fundos"} isDemo={isDemo} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> Control económico
              </div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Costos consolidados</h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">Reúne los manejos agrícolas y los egresos reales del ganado sin duplicar registros.</p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                className="flex h-11 items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-4 text-xs font-black text-ink shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
                disabled={costMovements.length === 0}
                onClick={exportCsv}
                type="button"
              >
                <Download size={15} /> Exportar para Excel
              </button>
              <Link className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white shadow-lg shadow-ink/10" href="/app/potreros">
                Registrar manejo <ArrowRight size={15} />
              </Link>
              <Link className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white shadow-lg shadow-accent/10" href="/app/ganado">
                Administrar ganado <Beef size={15} />
              </Link>
            </div>
          </header>

          <section className="mt-6 rounded-[20px] border border-line-steel bg-white p-4 shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
            <div className="mb-3 flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.14em] text-accent"><Filter size={14} /> Filtros</div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <FilterSelect label="Fundo" onChange={handleFundoChange} value={selectedFundoId}>
                <option value={ALL}>Todos los fundos</option>
                {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
              </FilterSelect>
              <FilterSelect label="Origen" onChange={handleOriginChange} value={selectedOrigin}>
                <option value="all">Agrícola y ganado</option>
                <option value="agricultural">Sólo agrícola</option>
                <option value="livestock">Sólo ganado</option>
              </FilterSelect>
              <FilterSelect label="Potrero" onChange={setSelectedPotreroId} value={selectedPotreroId}>
                <option value={ALL}>Todos los potreros</option>
                {selectablePotreros.map((potrero) => <option key={potrero.id} value={potrero.id}>{potrero.name}</option>)}
              </FilterSelect>
              <FilterSelect label="Tipo de manejo" onChange={(value) => setSelectedType(value as ActivityType | typeof ALL)} value={selectedType}>
                <option value={ALL}>Todos los manejos</option>
                {(Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[]).map((type) => <option key={type} value={type}>{ACTIVITY_TYPE_LABELS[type]}</option>)}
              </FilterSelect>
              <FilterSelect label="Período" onChange={(value) => setPeriod(value as Period)} value={period}>
                <option value="all">Todo el historial</option>
                <option value="30">Últimos 30 días</option>
                <option value="season">Temporada {SEASON_LABEL}</option>
              </FilterSelect>
            </div>
          </section>

          <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard helpText="Suma de todo lo gastado en lo que estás filtrando: manejos de potreros más egresos del ganado, sin contar dos veces el mismo registro." icon={CircleDollarSign} label="Gasto total" tone="dark" value={formatClp(totalCost)} detail={totalRecords > 0 ? "Agrícola + ganado según filtros" : "Sin costos en esta selección"} />
            <StatCard helpText="El gasto repartido entre las hectáreas ya dibujadas. Sirve para comparar campos de distinto tamaño." icon={MapPinned} label="Costo por hectárea" value={scopeArea > 0 && totalCost > 0 ? formatClp(totalCost / scopeArea) : formatClp(0)} detail={`${formatNumber(scopeArea, 1)} ha delimitadas`} />
            <StatCard helpText="Cuántos movimientos tienen monto asociado. Si son pocos, el total está incompleto." icon={ReceiptText} label="Registros con costo" value={String(totalRecords)} detail={`${filteredActivities.length} agrícolas · ${filteredLivestockExpenses.length} ganaderos`} />
            <StatCard helpText="Cuánto cuesta en promedio cada movimiento registrado. Un promedio alto suele venir de pocas compras grandes." icon={TrendingUp} label="Promedio por registro" tone="amber" value={formatClp(averageCost)} detail={totalRecords > 0 ? "Promedio de la selección" : "Aún sin datos"} />
          </section>

          <section className="mt-5 grid gap-5 xl:grid-cols-3">
            <Panel>
              <PanelHeader eyebrow="Distribución" help="costoOrigen" icon={ChartNoAxesColumnIncreasing} title="Gasto por origen" />
              {originBreakdown.length > 0 ? (
                <BreakdownList items={originBreakdown} total={totalCost} />
              ) : <EmptyState />}
            </Panel>

            <Panel>
              <PanelHeader eyebrow="Categorías" help="costoTipo" icon={ReceiptText} title="Gasto por tipo" />
              {typeBreakdown.length > 0 ? (
                <BreakdownList items={typeBreakdown.map((item) => ({ key: item.type, label: item.label, sublabel: item.sublabel, total: item.total }))} total={totalCost} />
              ) : <EmptyState />}
            </Panel>

            <Panel>
              <PanelHeader eyebrow="Territorio" help="costoPorPotrero" icon={MapPinned} title="Gasto agrícola por potrero" />
              {potreroBreakdown.length > 0 ? (
                <BreakdownList items={potreroBreakdown.map((item) => ({ key: item.potrero.id, label: item.potrero.name, sublabel: item.fundo?.name ?? "Fundo", total: item.total }))} total={agriculturalCost} />
              ) : <EmptyState />}
            </Panel>
          </section>

          <section className="mt-5 pb-8">
            <Panel>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <PanelHeader eyebrow="Detalle" helpText="Lista fila por fila de cada gasto: qué se hizo, cuándo, dónde y cuánto costó." icon={CalendarDays} title="Movimientos con costo" />
                <p className="text-[12px] font-bold text-ink-subtle">{costMovements.length} {costMovements.length === 1 ? "registro" : "registros"}</p>
              </div>
              {costMovements.length > 0 ? (
                <TableExplorer
                  className="mt-5"
                  description="Revisa cada movimiento que compone los totales de la selección actual. Puedes buscar por descripción, ubicación o tipo y separar rápidamente el origen agrícola del ganadero."
                  filter={{ label: "Filtrar movimientos por origen", allLabel: "Todos los orígenes", columnIndex: 1 }}
                  id="costos.movimientos"
                  maxHeight="34rem"
                  searchPlaceholder="Buscar descripción, ubicación, tipo o monto…"
                  title="Movimientos con costo"
                >
                  <table className="w-full min-w-[960px] border-separate border-spacing-0 text-left">
                    <thead>
                      <tr className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">
                        <TableHead>Fecha</TableHead><TableHead>Origen</TableHead><TableHead>Tipo</TableHead><TableHead>Descripción</TableHead><TableHead>Ubicación</TableHead><TableHead align="right">Costo</TableHead>
                      </tr>
                    </thead>
                    <tbody>
                      {costMovements.map((movement) => (
                        <tr className="text-xs text-ink-muted" key={movement.id}>
                          <TableCell>{movement.date ? formatDate(movement.date) : "Sin fecha"}</TableCell>
                          <TableCell><span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black ${movement.origin === "Ganado" ? "bg-warn-bg text-warn-ink" : "bg-surface-alt text-accent"}`}>{movement.origin}</span></TableCell>
                          <TableCell>{movement.type}</TableCell>
                          <TableCell><p className="max-w-xs truncate font-semibold text-ink">{movement.description}</p>{movement.quantity !== null && <p className="mt-1 text-[12px] text-ink-subtle">{formatNumber(movement.quantity, 2)} {movement.unit ?? ""}</p>}</TableCell>
                          <TableCell><p className="font-black text-ink">{movement.location}</p><p className="mt-1 text-[12px] text-ink-subtle">{movement.fundo}</p></TableCell>
                          <TableCell align="right"><span className="font-black text-ink">{formatClp(movement.costClp)}</span></TableCell>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableExplorer>
              ) : <EmptyState showAction />}
            </Panel>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function FilterSelect({ children, label, onChange, value }: { children: React.ReactNode; label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label>
      <span className="mb-1.5 block text-[12px] font-black uppercase tracking-wide text-ink-subtle">{label}</span>
      <select className="h-11 w-full rounded-xl border border-line-steel bg-surface-alt px-3 text-xs font-black text-ink outline-none focus:border-accent" onChange={(event) => onChange(event.target.value)} value={value}>{children}</select>
    </label>
  );
}

function StatCard({ help, helpText, icon: Icon, label, value, detail, tone = "default" }: { help?: HelpKey; helpText?: string; icon: typeof CircleDollarSign; label: string; value: string; detail: string; tone?: "default" | "dark" | "amber" }) {
  const tones = { default: "bg-white text-accent", dark: "bg-ink text-white", amber: "bg-surface-alt text-warn-ink" };
  return (
    <article className={`rounded-[18px] border border-line-steel p-4 shadow-[0_6px_24px_rgba(35,50,42,0.04)] ${tones[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] ${tone === "dark" ? "text-white/50" : "text-ink-subtle"}`}>
            {label}
            <HelpTip help={help} label={label} text={helpText} tone={tone === "dark" ? "inverse" : "muted"} />
          </p>
          <p className={`mt-2 truncate text-xl font-black tracking-[-0.045em] sm:text-2xl ${tone === "dark" ? "text-white" : "text-ink"}`}>{value}</p>
          <p className={`mt-1 text-[12px] font-semibold ${tone === "dark" ? "text-white/50" : "text-ink-subtle"}`}>{detail}</p>
        </div>
        <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${tone === "dark" ? "bg-white/10" : tone === "amber" ? "bg-warn-bg" : "bg-surface-alt"}`}><Icon size={17} /></span>
      </div>
    </article>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <article className="rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_38px_rgba(35,50,42,0.05)] sm:p-6">{children}</article>;
}

function PanelHeader({ eyebrow, help, helpText, icon: Icon, title }: { eyebrow: string; help?: HelpKey; helpText?: string; icon: typeof CircleDollarSign; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-surface-alt text-accent"><Icon size={18} /></span>
      <div><p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">{eyebrow}</p><h2 className="mt-1 flex items-center gap-1.5 text-base font-black tracking-[-0.035em] text-ink">{title}<HelpTip help={help} label={title} text={helpText} /></h2></div>
    </div>
  );
}

function BreakdownList({ items, total }: { items: { key: string; label: string; sublabel: string; total: number }[]; total: number }) {
  return (
    <div className="mt-5 space-y-4">
      {items.map((item) => {
        const share = total > 0 ? (item.total / total) * 100 : 0;
        return (
          <div key={item.key}>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0"><p className="truncate text-xs font-black text-ink">{item.label}</p><p className="mt-0.5 truncate text-[12px] font-bold uppercase tracking-wide text-ink-subtle">{item.sublabel}</p></div>
              <span className="shrink-0 text-xs font-black text-ink">{formatClp(item.total)}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-alt"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share)}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ showAction = false }: { showAction?: boolean }) {
  return (
    <div className="mt-5 grid min-h-44 place-items-center rounded-2xl border border-dashed border-line-steel bg-surface-alt p-5 text-center">
      <div><Sprout className="mx-auto text-accent" size={25} /><p className="mt-2 text-xs font-black text-ink">No hay costos registrados para esta selección.</p><p className="mt-1 text-[12px] text-ink-subtle">Los montos aparecerán aquí al agregarlos a un manejo.</p>{showAction && <Link className="mt-3 inline-flex items-center gap-1 text-[12px] font-black text-accent" href="/app/potreros">Registrar manejo <ArrowRight size={12} /></Link>}</div>
    </div>
  );
}

function TableHead({ align = "left", children }: { align?: "left" | "right"; children: React.ReactNode }) {
  return <th className={`border-b border-line-steel px-3 py-3 ${align === "right" ? "text-right" : "text-left"}`}>{children}</th>;
}

function TableCell({ align = "left", children }: { align?: "left" | "right"; children: React.ReactNode }) {
  return <td className={`border-b border-line-steel px-3 py-3.5 align-middle ${align === "right" ? "text-right" : "text-left"}`}>{children}</td>;
}

function getSeasonStart() {
  const now = new Date();
  const seasonYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${seasonYear}-07-01`;
}

function formatNumber(value: number, maximumFractionDigits: number) {
  return value.toLocaleString("es-CL", { maximumFractionDigits });
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}
