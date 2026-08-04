"use client";

import { downloadCsv, type CsvCell } from "@/src/core/export/csv.mjs";
import { AppShell } from "@/src/core/layout/AppShell";
import { HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import {
  BarChart3,
  Beef,
  CalendarDays,
  CheckCircle2,
  Download,
  Droplets,
  Gauge,
  MapPinned,
  ShieldCheck,
  Sprout,
  WalletCards,
  Weight,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { OperationalReport, OperationalReportRow } from "./operational-report.mjs";

const ALL_FIELDS = "all";

export function ReportesPage({ isDemo, organizationId, organizationName, report, userName }: { isDemo: boolean; organizationId: string; organizationName: string; report: OperationalReport; userName: string }) {
  const [selectedFieldId, setSelectedFieldId] = useState(ALL_FIELDS);
  const selectedRow = selectedFieldId === ALL_FIELDS
    ? report.total
    : report.fields.find((row) => row.fieldId === selectedFieldId) ?? report.total;
  const exportRows = useMemo(
    () => selectedFieldId === ALL_FIELDS ? report.fields : report.fields.filter((row) => row.fieldId === selectedFieldId),
    [report.fields, selectedFieldId],
  );

  function exportCsv() {
    if (exportRows.length === 0) return;
    const headers: CsvCell[] = [
      "Fundo",
      "Superficie ha",
      "Superficie delimitada ha",
      "Cobertura %",
      "Potreros",
      "Disponibles",
      "En pastoreo",
      "En descanso",
      "Animales activos",
      "Lotes activos",
      "Vacas en leche",
      "Período leche",
      "Litros",
      "Variación leche %",
      "Litros por vaca/día",
      "Cobertura pesaje %",
      "Último pesaje",
      "Manejos últimos 30 días",
      "Último manejo",
    ];
    if (report.canViewFinance) {
      headers.push("Ingreso neto CLP", "Precio neto por litro CLP", "Costos del período CLP", "Resultado operativo CLP");
    }
    const rows: CsvCell[][] = exportRows.map((row) => {
      const operational: CsvCell[] = [
        row.fieldName,
        row.fieldAreaHectares,
        row.delimitedAreaHectares,
        round(row.coveragePercent, 2),
        row.paddockCount,
        row.availablePaddocks,
        row.grazingPaddocks,
        row.restingPaddocks,
        row.activeAnimals,
        row.activeLots,
        row.milkingCows,
        row.latestMilkPeriod,
        row.latestMilkTotalLiters,
        roundNullable(row.milkChangePercent, 2),
        roundNullable(row.litersPerMilkingCowDay, 2),
        roundNullable(row.weightCoveragePercent, 2),
        row.latestWeightDate,
        row.activities30Days,
        row.lastActivityDate,
      ];
      if (report.canViewFinance) {
        operational.push(
          row.finance?.latestMilkNetAmountClp,
          roundNullable(row.finance?.latestMilkNetPricePerLiterClp, 4),
          row.finance?.periodCostsClp,
          row.finance?.operatingResultClp,
        );
      }
      return operational;
    });
    downloadCsv(`fundosmart-reporte-operativo-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  }

  return (
    <AppShell activeSection="reportes" fieldName={selectedRow.fieldName} isDemo={isDemo} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent"><span className="size-1.5 rounded-full bg-accent" /> Reportes operativos</div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Decisiones que puedes llevar contigo</h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">Compara superficie, rebaño, leche, pesajes y trazabilidad con el mismo alcance de datos que tiene tu membresía.</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="relative">
                <span className="sr-only">Filtrar reporte por fundo</span>
                <select className="h-11 min-w-56 appearance-none rounded-xl border border-line-steel bg-white pl-4 pr-10 text-xs font-black text-ink shadow-sm outline-none focus:border-accent" onChange={(event) => setSelectedFieldId(event.target.value)} value={selectedFieldId}>
                  <option value={ALL_FIELDS}>Todos los fundos</option>
                  {report.fields.map((row) => <option key={row.fieldId} value={row.fieldId}>{row.fieldName}</option>)}
                </select>
                <MapPinned className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-accent" size={16} />
              </label>
              <button className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white shadow-lg shadow-ink/10 disabled:cursor-not-allowed disabled:opacity-45" disabled={exportRows.length === 0} onClick={exportCsv} type="button"><Download size={15} /> Exportar CSV</button>
            </div>
          </header>

          {isDemo && <DemoNotice />}

          <section className="mt-6 flex flex-col gap-3 rounded-[18px] border border-line-steel bg-surface-alt p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-accent"><ShieldCheck size={17} /></span><div><p className="text-xs font-black text-ink">Alcance verificado en el servidor</p><p className="mt-1 text-[12px] leading-4 text-ink-subtle">El archivo exportado contiene solo los fundos autorizados para tu membresía. No se descarga información cruda ni de otras organizaciones.</p></div></div>
            <span className="self-start rounded-full bg-white px-3 py-1.5 text-[12px] font-black uppercase tracking-wide text-accent shadow-sm sm:self-center">{report.canViewFinance ? "Operación + finanzas" : "Solo operación"}</span>
          </section>

          <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard detail={`${formatNumber(selectedRow.delimitedAreaHectares, 1)} ha delimitadas · ${formatNumber(selectedRow.coveragePercent, 0)}%`} help="dashSuperficie" icon={MapPinned} label="Superficie" tone="dark" value={`${formatNumber(selectedRow.fieldAreaHectares, 1)} ha`} />
            <MetricCard detail={`${selectedRow.milkingCows} vacas en leche · ${selectedRow.activeLots} lotes`} help="dashAnimalesActivos" icon={Beef} label="Animales activos" value={formatNumber(selectedRow.activeAnimals, 0)} />
            <MetricCard detail={selectedRow.milkChangePercent === null ? "Sin período anterior" : `${signedNumber(selectedRow.milkChangePercent, 1)}% vs. período anterior`} help="dashLeche" icon={Droplets} label={selectedRow.latestMilkPeriod ? `Leche · ${formatPeriod(selectedRow.latestMilkPeriod)}` : "Leche"} value={selectedRow.latestMilkTotalLiters === null ? "Sin datos" : `${formatNumber(selectedRow.latestMilkTotalLiters, 0)} L`} />
            {report.canViewFinance && selectedRow.finance
              ? <MetricCard detail={selectedRow.finance.periodCostsClp === null ? "Sin período comparable" : `${formatClp(selectedRow.finance.periodCostsClp)} en costos`} help="dashResultadoOperativo" icon={WalletCards} label="Resultado operativo" tone={(selectedRow.finance.operatingResultClp ?? 0) < 0 ? "warning" : "positive"} value={selectedRow.finance.operatingResultClp === null ? "Sin datos" : formatClp(selectedRow.finance.operatingResultClp)} />
              : <MetricCard detail={selectedRow.latestWeightDate ? `Último control: ${formatDate(selectedRow.latestWeightDate)}` : "Sin pesajes registrados"} help="dashCoberturaPesaje" icon={Weight} label="Cobertura de pesaje" tone="positive" value={selectedRow.weightCoveragePercent === null ? "Sin datos" : `${formatNumber(selectedRow.weightCoveragePercent, 0)}%`} />}
          </section>

          <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
            <Panel title="Comparación por fundo" eyebrow="Vista consolidada" help="reporteComparacion" icon={BarChart3}>
              {report.fields.length > 0 ? (
                <TableExplorer
                  className="mt-5"
                  description="Compara cobertura, dotación, producción y actividad reciente; selecciona una fila para actualizar el resto del reporte."
                  filter={{ label: "Filtrar fundos por cobertura", allLabel: "Todas las coberturas", columnIndex: 1 }}
                  id="reportes.comparacion"
                  maxHeight="30rem"
                  searchPlaceholder="Buscar fundo, cobertura, leche o manejo…"
                  title="Comparación por fundo"
                >
                  <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left">
                    <thead><tr>{["Fundo", "Cobertura", "Animales", "Leche", "Pesaje", "Manejos 30 d"].map((label) => <th className="border-b border-line-steel bg-surface-alt px-3 py-3 text-[12px] font-black uppercase tracking-wide text-ink-subtle" key={label}>{label}</th>)}</tr></thead>
                    <tbody>{report.fields.map((row) => <ReportRow active={selectedFieldId === row.fieldId} key={row.fieldId} onSelect={() => setSelectedFieldId(row.fieldId)} row={row} />)}</tbody>
                  </table>
                </TableExplorer>
              ) : <EmptyState text="Todavía no hay fundos disponibles para esta membresía." />}
            </Panel>

            <div className="grid gap-5">
              <Panel title="Estado de potreros" eyebrow="Disponibilidad" help="potreroEstado" icon={Sprout}>
                <div className="mt-5 grid grid-cols-3 gap-2"><StatusCard label="Disponibles" tone="lime" value={selectedRow.availablePaddocks} /><StatusCard label="Pastoreo" tone="green" value={selectedRow.grazingPaddocks} /><StatusCard label="Descanso" tone="amber" value={selectedRow.restingPaddocks} /></div>
                <p className="mt-4 text-[12px] leading-4 text-ink-subtle">{selectedRow.paddockCount} potreros considerados en la selección actual.</p>
              </Panel>
              <Panel title="Trazabilidad reciente" eyebrow="Últimos 30 días" help="navTrazabilidad" icon={CalendarDays}>
                <div className="mt-5 rounded-2xl bg-surface-alt p-4"><p className="text-3xl font-black tracking-[-0.05em] text-ink">{selectedRow.activities30Days}</p><p className="mt-1 text-[12px] font-bold text-ink-subtle">manejos registrados</p></div>
                <DetailLine label="Último manejo" value={selectedRow.lastActivityDate ? formatDate(selectedRow.lastActivityDate) : "Sin registros"} />
                <DetailLine label="Litros por vaca/día" value={selectedRow.litersPerMilkingCowDay === null ? "Sin datos" : `${formatNumber(selectedRow.litersPerMilkingCowDay, 1)} L`} />
                {report.canViewFinance && selectedRow.finance && <DetailLine label="Precio neto por litro" value={selectedRow.finance.latestMilkNetPricePerLiterClp === null ? "Sin datos" : formatClpDecimal(selectedRow.finance.latestMilkNetPricePerLiterClp)} />}
              </Panel>
            </div>
          </section>

          <p className="pb-8 pt-5 text-right text-[12px] font-bold text-ink-subtle">Calculado {formatDateTime(report.generatedAt)}</p>
        </div>
      </div>
    </AppShell>
  );
}

function DemoNotice() {
  return <section className="mt-6 flex items-start gap-3 rounded-[18px] border border-accent bg-ink p-4 text-white"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-ink"><CheckCircle2 size={17} /></span><div><p className="text-xs font-black">Reporte de demostración</p><p className="mt-1 text-[12px] leading-4 text-white/60">Los resultados y el CSV usan únicamente registros ficticios de Fundo El Ejemplo.</p></div></section>;
}

function MetricCard({ detail, help, icon: Icon, label, tone = "default", value }: { detail: string; help?: HelpKey; icon: LucideIcon; label: string; tone?: "default" | "dark" | "positive" | "warning"; value: string }) {
  const cardTone = { default: "bg-white", dark: "bg-ink", positive: "bg-surface-alt", warning: "bg-surface-alt" }[tone];
  const iconTone = { default: "bg-surface-alt text-accent", dark: "bg-white/10 text-white", positive: "bg-accent text-accent", warning: "bg-warn-bg text-warn-ink" }[tone];
  return <article className={`relative overflow-hidden rounded-[18px] border border-line-steel p-4 shadow-[0_6px_24px_rgba(35,50,42,0.04)] ${cardTone}`}><span className={`absolute right-4 top-4 grid size-9 place-items-center rounded-xl ${iconTone}`}><Icon size={17} /></span><p className={`flex min-h-9 items-center gap-1 pr-11 text-[12px] font-black uppercase tracking-[0.12em] sm:min-h-0 ${tone === "dark" ? "text-white/50" : "text-ink-subtle"}`}>{label}<HelpTip help={help} label={label} tone={tone === "dark" ? "inverse" : "muted"} /></p><p className={`mt-2 whitespace-nowrap text-xl font-black tracking-[-0.045em] sm:text-2xl ${tone === "dark" ? "text-white" : "text-ink"}`}>{value}</p><p className={`mt-1 text-[12px] font-semibold ${tone === "dark" ? "text-white/50" : "text-ink-subtle"}`}>{detail}</p></article>;
}

function Panel({ children, eyebrow, help, helpText, icon: Icon, title }: { children: React.ReactNode; eyebrow: string; help?: HelpKey; helpText?: string; icon: LucideIcon; title: string }) {
  return <section className="min-w-0 rounded-[20px] border border-line-steel bg-white p-5 shadow-[0_8px_28px_rgba(35,50,42,0.04)]"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-surface-alt text-accent"><Icon size={18} /></span><div><p className="text-[12px] font-black uppercase tracking-[0.13em] text-ink-subtle">{eyebrow}</p><h2 className="mt-0.5 flex items-center gap-1.5 text-base font-black text-ink">{title}<HelpTip help={help} label={title} text={helpText} /></h2></div></div>{children}</section>;
}

function ReportRow({ active, onSelect, row }: { active: boolean; onSelect: () => void; row: OperationalReportRow }) {
  return <tr className={active ? "bg-surface-alt" : "hover:bg-surface-alt"} onClick={onSelect}><td className="border-b border-line-steel px-3 py-3.5"><button className="text-left text-xs font-black text-ink" type="button">{row.fieldName}</button></td><TableCell filterLabel={coverageFilterLabel(row.coveragePercent)} value={`${formatNumber(row.coveragePercent, 0)}%`} /><TableCell value={formatNumber(row.activeAnimals, 0)} /><TableCell value={row.latestMilkTotalLiters === null ? "—" : `${formatNumber(row.latestMilkTotalLiters, 0)} L`} /><TableCell value={row.weightCoveragePercent === null ? "—" : `${formatNumber(row.weightCoveragePercent, 0)}%`} /><TableCell value={formatNumber(row.activities30Days, 0)} /></tr>;
}

function TableCell({ filterLabel, value }: { filterLabel?: string; value: string }) {
  return <td className="border-b border-line-steel px-3 py-3.5 text-xs font-bold text-ink-muted" data-table-filter-label={filterLabel}>{value}</td>;
}

function coverageFilterLabel(value: number): string {
  if (value >= 90) return "Cobertura alta";
  if (value >= 60) return "Cobertura media";
  return "Cobertura baja";
}

function StatusCard({ label, tone, value }: { label: string; tone: "lime" | "green" | "amber"; value: number }) {
  const color = { lime: "bg-accent text-accent", green: "bg-band text-accent", amber: "bg-warn-bg text-warn-ink" }[tone];
  return <div className={`rounded-xl p-3 ${color}`}><p className="text-xl font-black">{value}</p><p className="mt-1 text-[12px] font-black uppercase tracking-wide">{label}</p></div>;
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 flex items-center justify-between gap-4 border-t border-line-steel pt-3 text-[12px]"><span className="font-bold text-ink-subtle">{label}</span><span className="text-right font-black text-ink">{value}</span></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="mt-5 rounded-2xl border border-dashed border-line-steel bg-surface-alt p-6 text-center"><Gauge className="mx-auto text-ink-subtle" size={22} /><p className="mt-2 text-xs font-bold text-ink-subtle">{text}</p></div>;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundNullable(value: number | null | undefined, digits: number) {
  return value === null || value === undefined ? null : round(value, digits);
}

function signedNumber(value: number, maximumFractionDigits: number) {
  return `${value >= 0 ? "+" : ""}${formatNumber(value, maximumFractionDigits)}`;
}

function formatNumber(value: number, maximumFractionDigits: number) {
  return value.toLocaleString("es-CL", { maximumFractionDigits });
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function formatClpDecimal(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 4 }).format(value);
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day}-${month}-${date.getUTCFullYear()} ${hours}:${minutes} UTC`;
}

function formatPeriod(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("es-CL", { month: "short", year: "numeric", timeZone: "UTC" });
}
