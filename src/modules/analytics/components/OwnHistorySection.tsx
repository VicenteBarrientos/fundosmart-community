"use client";

import { HelpTip } from "@/src/ui/Hint";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { CalendarClock, Download, TrendingDown, TrendingUp } from "lucide-react";

import { downloadCsvText } from "@/src/core/export/csv.mjs";
import { buildOwnHistoryCsv } from "../domain/analytics-presentation.mjs";

import type {
  OwnHistoryComparison,
  OwnHistoryComparisonResult,
} from "../domain/own-history-comparison.d.mts";

const EMPTY_REASONS = {
  no_projected_periods: "Todavía no hay períodos proyectados para este fundo. Recalcula la analítica para empezar a acumular historia.",
  single_period_history: "Hay un solo período proyectado. Una comparación necesita al menos dos: vuelve cuando exista el siguiente.",
  target_period_not_projected: "El período seleccionado no tiene proyección. Elige otro o recalcula la analítica.",
};

const VERDICT_LABELS = {
  changed: "Cambió",
  unchanged: "Sin cambio",
  insufficient_data: "Datos insuficientes",
};

type Props = {
  comparison: OwnHistoryComparisonResult | null;
  reason: string | null;
  periodsRead: number;
  fieldName: string;
};

/**
 * Shows a field against its own history.
 *
 * This is not benchmarking: nothing is compared against other farms, which is why it
 * carries none of the consent and cohort machinery. The default basis is the same
 * period a year earlier, because consecutive months in a southern-hemisphere dairy
 * compare different seasons.
 */
export function OwnHistorySection({ comparison, reason, periodsRead, fieldName }: Props) {
  if (!comparison) {
    return (
      <Panel>
        <p className="text-[12px] leading-5 text-ink-muted">
          {EMPTY_REASONS[reason as keyof typeof EMPTY_REASONS]
            ?? "Todavía no se puede comparar este fundo contra su propia historia."}
        </p>
      </Panel>
    );
  }

  const seasonalFallback = comparison.summary.seasonalFallbackCount > 0;

  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-[12px] leading-5 text-ink-muted">
          <span className="font-black text-ink">{fieldName}</span> contra sí mismo en{" "}
          <span className="font-black text-ink">{comparison.targetPeriod}</span>. Base interanual:{" "}
          <span className="font-black text-ink">
            {comparison.yearOverYearBasisPeriod ?? "no disponible"}
          </span>
          . {periodsRead} períodos leídos.
        </p>
        <p className="text-[12px] font-semibold text-ink-subtle">
          {comparison.summary.changed} cambiaron · {comparison.summary.unchanged} sin cambio ·{" "}
          {comparison.summary.insufficientData} sin datos suficientes
        </p>
        <button
          className="flex h-11 items-center gap-2 rounded-xl bg-surface-alt px-3 text-[12px] font-black text-ink"
          onClick={() => exportComparison(comparison, fieldName)}
          type="button"
        >
          <Download aria-hidden="true" size={14} /> Exportar CSV
        </button>
      </div>

      {seasonalFallback ? (
        <p className="mt-3 rounded-[14px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold leading-5 text-amber-900">
          {comparison.summary.seasonalFallbackCount} métrica(s) no tienen el mismo período del año
          anterior y se compararon con el período previo. En una lechería del sur eso compara
          estaciones distintas: la caída puede ser calendario y no gestión.
        </p>
      ) : null}

      <div className="mt-4">
        <TableExplorer
          description="Cada indicador contra el mismo período del año anterior, y dónde queda respecto de la banda que ese indicador ha ocupado antes."
          filter={{ allLabel: "Todos los resultados", columnIndex: 4, label: "Resultado" }}
          id="analitica.historia-propia"
          searchPlaceholder="Buscar indicador"
          title="Comparación contra la propia historia"
        >
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr>
                {["Indicador", comparison.targetPeriod, "Base", "Diferencia", "Resultado", "Banda propia"].map(
                  (header) => (
                    <th
                      className="border-b border-line-steel px-2 py-2 text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle"
                      key={header}
                    >
                      {header}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {comparison.comparisons.map((entry) => (
                <Row entry={entry} key={entry.key} />
              ))}
            </tbody>
          </table>
        </TableExplorer>
      </div>

      <p className="mt-3 text-[12px] leading-5 text-ink-subtle">
        No es benchmarking: nada se compara contra otros fundos y ningún dato sale de la cuenta.
        La banda propia se publica sólo con {comparison.minimumBandPeriods} períodos o más, porque
        dos puntos son una recta y no un rango.
      </p>
    </Panel>
  );
}

/**
 * The monthly report's comparable series are this export, not a second calculation.
 * Improvement 70 asked for comparable windows; producing them separately would have
 * created two answers to the same question.
 */
function exportComparison(comparison: OwnHistoryComparisonResult, fieldName: string) {
  const csv = buildOwnHistoryCsv({ comparison, fieldName });
  const safeField = fieldName.normalize("NFD").replace(/[^w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  downloadCsvText(
    `fundosmart-historia-propia-${safeField || "fundo"}-${comparison.targetPeriod}.csv`,
    csv,
  );
}

function Row({ entry }: { entry: OwnHistoryComparison }) {
  const delta = entry.primary === "yearOverYear"
    ? entry.yearOverYear
    : entry.primary === "periodOverPeriod"
      ? entry.periodOverPeriod
      : null;
  const outsideBand = entry.band.position === "above" || entry.band.position === "below";

  return (
    <tr>
      <Cell strong>{entry.key}</Cell>
      <Cell right>{formatValue(entry.target.value, entry.unit)}</Cell>
      <Cell right>
        {delta?.status === "available"
          ? `${formatValue(delta.basisValue, entry.unit)} · ${delta.basisPeriod}`
          : "—"}
      </Cell>
      <Cell right>
        {delta?.status === "available" && delta.deltaAbsolute !== null ? (
          <span className="inline-flex items-center gap-1 font-black">
            {delta.direction === "up" ? (
              <TrendingUp aria-hidden="true" className="text-ink-muted" size={13} />
            ) : delta.direction === "down" ? (
              <TrendingDown aria-hidden="true" className="text-ink-muted" size={13} />
            ) : null}
            {formatSigned(delta.deltaAbsolute)}
            {delta.deltaPct === null ? "" : ` (${formatSigned(delta.deltaPct)}%)`}
          </span>
        ) : (
          "—"
        )}
      </Cell>
      <Cell>
        <Badge tone={entry.verdict === "changed" ? "blue" : entry.verdict === "unchanged" ? "green" : "amber"}>
          {VERDICT_LABELS[entry.verdict]}
        </Badge>
      </Cell>
      <Cell>
        {entry.band.status !== "available" ? (
          <span className="text-ink-subtle">
            {entry.band.periodsUsed} período(s), insuficiente
          </span>
        ) : (
          <span className={outsideBand ? "font-black text-amber-900" : ""}>
            {entry.band.position === "above"
              ? `Sobre su máximo (${formatValue(entry.band.maximum, entry.unit)})`
              : entry.band.position === "below"
                ? `Bajo su mínimo (${formatValue(entry.band.minimum, entry.unit)})`
                : `Dentro de ${formatValue(entry.band.minimum, entry.unit)}–${formatValue(entry.band.maximum, entry.unit)}`}
          </span>
        )}
      </Cell>
    </tr>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_38px_rgba(35,50,42,0.05)]">
      <div className="flex items-center gap-2">
        <CalendarClock className="text-accent" size={16} />
        <h3 className="flex items-center gap-1.5 text-sm font-black text-ink">
          Contra su propia historia
          <HelpTip help="analiticaHistoriaPropia" label="Contra su propia historia" />
        </h3>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Cell({
  children,
  right = false,
  strong = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={`border-b border-line-steel px-2 py-2.5 text-[12px] ${right ? "text-right" : ""} ${strong ? "font-black text-ink" : "text-ink-muted"}`}
    >
      {children}
    </td>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "green" | "amber" | "blue" }) {
  const tones = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    blue: "border-sky-200 bg-sky-50 text-sky-900",
  };
  return (
    <span className={`inline-flex items-center rounded-lg border px-2 py-1 text-[12px] font-black ${tones[tone]}`}>
      {children}
    </span>
  );
}

function formatValue(value: number | null, unit: string | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(value);
  return unit === "percent" ? `${formatted}%` : formatted;
}

function formatSigned(value: number) {
  const formatted = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(Math.abs(value));
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatted}`;
}
