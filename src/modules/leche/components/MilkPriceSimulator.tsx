"use client";

import type { Fundo, MilkSettlement } from "@/src/core/domain/types";
import { Field } from "@/src/ui/form";
import { HelpTip } from "@/src/ui/Hint";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { Calculator, RotateCcw, TrendingUp, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { extractMilkSettlementQuality } from "../domain/milk-settlement-analysis.mjs";
import {
  backtestMilkPriceModel,
  calculateQualitySensitivityTable,
  extractMilkRateObservations,
  fitMilkPriceModel,
  projectMilkSettlement,
  projectionInputFromSettlement,
} from "../domain/milk-price-model.mjs";
import type { MilkProjectionInput, MilkQualityInput } from "../domain/milk-price-model.d.mts";

const ALL = "all";

const RATE_SOURCE_LABELS = {
  contractualAtMeasurement: "Contractual",
  observedAtMeasurement: "Observada",
  qualityFit: "Ajustada",
  stable: "Contractual",
  latestOfUnstable: "Última (inestable)",
  override: "Manual",
};

type Props = {
  fundos: Fundo[];
  settlements: MilkSettlement[];
  selectedFundoId: string;
};

type Inputs = {
  litersFirstHalf: string;
  litersSecondHalf: string;
  fatPct: string;
  proteinPct: string;
  totalSolidsPct: string;
};

export function MilkPriceSimulator({ fundos, settlements, selectedFundoId }: Props) {
  const scoped = useMemo(
    () =>
      settlements
        .filter((settlement) => selectedFundoId === ALL || settlement.fieldId === selectedFundoId)
        .slice()
        .sort((left, right) => right.period.localeCompare(left.period)),
    [settlements, selectedFundoId],
  );

  const buyers = useMemo(() => [...new Set(scoped.map((settlement) => settlement.buyerName))], [scoped]);
  const [buyer, setBuyer] = useState<string | null>(null);
  // A price schedule belongs to one buyer. Default to the most recent one instead of
  // silently blending two schedules that have nothing to do with each other.
  const activeBuyer = buyer && buyers.includes(buyer) ? buyer : (buyers[0] ?? null);
  const history = useMemo(
    () => scoped.filter((settlement) => settlement.buyerName === activeBuyer),
    [scoped, activeBuyer],
  );
  const latest = history[0] ?? null;

  const baseline = useMemo(() => (latest ? toInputs(latest) : null), [latest]);
  const [draft, setDraft] = useState<Inputs | null>(null);
  const inputs = draft ?? baseline;

  const fitted = useMemo(() => {
    if (history.length === 0) return null;
    try {
      return { model: fitMilkPriceModel(history), error: null };
    } catch (cause) {
      return { model: null, error: cause instanceof Error ? cause.message : "No fue posible ajustar el modelo." };
    }
  }, [history]);

  const result = useMemo(() => {
    const model = fitted?.model;
    if (!model || !inputs || !latest) return null;
    try {
      return {
        projection: projectMilkSettlement(model, toProjectionInput(inputs)),
        sensitivity: calculateQualitySensitivityTable(model, {
          totalLiters:
            (numberOrNull(inputs.litersFirstHalf) ?? 0) + (numberOrNull(inputs.litersSecondHalf) ?? 0),
        }),
        error: null,
      };
    } catch (cause) {
      return { projection: null, sensitivity: [], error: errorMessage(cause) };
    }
  }, [fitted, inputs, latest]);

  // The comparison is against what the buyer actually paid, not against a second
  // projection of the same period. "Contra jun 2026 real" has to mean the real
  // document, or the number on screen is the model talking to itself.
  const actual = useMemo(() => {
    if (!latest) return null;
    const byKey = new Map<string, number>();
    for (const observation of extractMilkRateObservations(latest)) {
      byKey.set(observation.componentKey, (byKey.get(observation.componentKey) ?? 0) + (observation.amountClp ?? 0));
    }
    return { byKey, netAmountClp: latest.netAmountClp };
  }, [latest]);

  const backtest = useMemo(() => {
    if (history.length === 0) return null;
    try {
      return backtestMilkPriceModel(history, { mode: "inSample", toleranceClp: 3 });
    } catch {
      return null;
    }
  }, [history]);

  if (scoped.length === 0 || !latest || !inputs) {
    return (
      <div className="flex flex-col gap-5">
        <Lead fundoLabel={fundoLabel(fundos, selectedFundoId)} />
        <Panel icon={Calculator} title="Sin liquidaciones para simular">
          <p className="text-[12px] leading-5 text-ink-muted">
            El simulador se construye con tus propias liquidaciones. Carga al menos una en{" "}
            <span className="font-black text-ink">Leche → Liquidaciones</span> y aquí aparecerá la
            descomposición de tu precio.
          </p>
        </Panel>
      </div>
    );
  }

  const model = fitted?.model ?? null;
  const projection = result?.projection ?? null;
  const deltaClp = projection && actual ? projection.netAmountClp - actual.netAmountClp : null;

  return (
    <div className="flex flex-col gap-5">
      <Lead fundoLabel={fundoLabel(fundos, selectedFundoId)} />

      {fitted?.error ? <ErrorBox text={fitted.error} /> : null}
      {result?.error ? <ErrorBox text={result.error} /> : null}

      {model ? (
        <Panel icon={TrendingUp} title="Base del modelo">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-0">
              <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">Comprador</p>
              {buyers.length > 1 ? (
                <select
                  aria-label="Comprador"
                  className="input-base mt-1"
                  onChange={(event) => {
                    setBuyer(event.target.value);
                    setDraft(null);
                  }}
                  value={activeBuyer ?? ""}
                >
                  {buyers.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-sm font-black text-ink">{activeBuyer}</p>
              )}
            </div>
            <p className="text-[12px] leading-5 text-ink-muted">
              Ajustado con <span className="font-black text-ink">{model.periodCount}</span>{" "}
              {model.periodCount === 1 ? "liquidación" : "liquidaciones"} ({model.periods.join(", ")}):{" "}
              <span className="font-black text-ink">{model.coverage.contractual}</span>{" "}
              {model.coverage.contractual === 1 ? "concepto" : "conceptos"} con precio unitario declarado y{" "}
              <span className="font-black text-ink">{model.coverage.derived}</span>{" "}
              {model.coverage.derived === 1 ? "recuperado" : "recuperados"} por división.
              {model.coverage.unstable > 0 ? (
                <>
                  {" "}
                  <span className="font-black text-amber-900">
                    {model.coverage.unstable} cambiaron de tasa entre períodos.
                  </span>
                </>
              ) : null}
            </p>
          </div>
          {backtest ? <BacktestNote backtest={backtest} /> : null}
        </Panel>
      ) : null}

      <Panel icon={Calculator} title="Supuestos de la estimación">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field help="lecheLiquidaciones" label="Litros 1.ª quincena">
            <input
              className="input-base"
              min={0}
              onChange={(event) => update(setDraft, inputs, { litersFirstHalf: event.target.value })}
              step={1}
              type="number"
              value={inputs.litersFirstHalf}
            />
          </Field>
          <Field label="Litros 2.ª quincena">
            <input
              className="input-base"
              min={0}
              onChange={(event) => update(setDraft, inputs, { litersSecondHalf: event.target.value })}
              step={1}
              type="number"
              value={inputs.litersSecondHalf}
            />
          </Field>
          <Field help="lecheGrasa" label="Grasa %">
            <input
              className="input-base"
              onChange={(event) => update(setDraft, inputs, { fatPct: event.target.value })}
              step={0.01}
              type="number"
              value={inputs.fatPct}
            />
          </Field>
          <Field help="lecheProteina" label="Proteína %">
            <input
              className="input-base"
              onChange={(event) => update(setDraft, inputs, { proteinPct: event.target.value })}
              step={0.01}
              type="number"
              value={inputs.proteinPct}
            />
          </Field>
          <Field label="Sólidos %">
            <input
              className="input-base"
              onChange={(event) => update(setDraft, inputs, { totalSolidsPct: event.target.value })}
              step={0.01}
              type="number"
              value={inputs.totalSolidsPct}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="flex h-11 items-center gap-2 rounded-xl bg-surface-alt px-3 text-[12px] font-black text-ink disabled:cursor-not-allowed disabled:opacity-50"
            disabled={draft === null}
            onClick={() => setDraft(null)}
            type="button"
          >
            <RotateCcw size={14} /> Volver a {formatPeriod(latest.period)}
          </button>
          <p className="text-[12px] leading-5 text-ink-subtle">
            Las células somáticas y la UFC se pagan por tramo, no por décimo de punto: no se simulan.
          </p>
        </div>
      </Panel>

      {projection ? (
        <>
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Metric
              detail={`${formatNumber(projection.totalLiters)} L estimados`}
              label="Neto estimado"
              value={formatClp(projection.netAmountClp)}
            />
            <Metric
              detail="Antes de IVA, según tus liquidaciones"
              label="Precio por litro"
              value={
                projection.netPricePerLiterClp === null
                  ? "—"
                  : `${formatDecimal(projection.netPricePerLiterClp, 2)} CLP`
              }
            />
            <Metric
              detail={`Contra ${formatPeriod(latest.period)} real (${formatClp(actual?.netAmountClp ?? 0)})`}
              label="Diferencia"
              value={deltaClp === null ? "—" : formatSignedClp(deltaClp)}
            />
            <Metric
              detail={
                projection.complete
                  ? "Todos los conceptos tienen tasa"
                  : `${projection.notProjectedComponentKeys.length} sin tasa proyectable`
              }
              label="Cobertura"
              value={projection.complete ? "Completa" : "Parcial"}
              warning={!projection.complete}
            />
          </section>

          {projection.warnings.length > 0 ? (
            <Panel icon={TriangleAlert} title="Lo que esta estimación no puede sostener">
              <ul className="flex flex-col gap-2">
                {projection.warnings.map((warning) => (
                  <li
                    className="rounded-[14px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold leading-5 text-amber-900"
                    key={`${warning.code}-${warning.componentKey}`}
                  >
                    {warning.message}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <TableExplorer
            description="Cada concepto con su tasa, de dónde sale y cuánto cambia respecto de la última liquidación real."
            filter={{ allLabel: "Todos los orígenes", columnIndex: 1, label: "Origen de la tasa" }}
            id="leche.simulador.componentes"
            searchPlaceholder="Buscar concepto"
            title="Descomposición del precio estimado"
          >
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr>
                  {["Concepto", "Origen de la tasa", "CLP/L", "Monto", `vs ${formatPeriod(latest.period)}`].map(
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
                {projection.components.map((component) => {
                  const paid = actual?.byKey.get(component.componentKey);
                  const delta =
                    component.amountClp !== null && paid !== undefined
                      ? component.amountClp - paid
                      : null;
                  return (
                    <tr key={component.componentKey}>
                      <Cell strong>{component.label}</Cell>
                      <Cell>
                        {component.projected ? (
                          <Badge tone={component.rateSource === "latestOfUnstable" ? "amber" : "green"}>
                            {RATE_SOURCE_LABELS[component.rateSource ?? "stable"] ?? "—"}
                          </Badge>
                        ) : (
                          <Badge tone="red">Sin tasa</Badge>
                        )}
                      </Cell>
                      <Cell right>
                        {component.amountPerLiterClp === null
                          ? "—"
                          : formatDecimal(component.amountPerLiterClp, 2)}
                      </Cell>
                      <Cell right strong>
                        {component.amountClp === null ? "—" : formatClp(component.amountClp)}
                      </Cell>
                      <Cell danger={delta !== null && delta < 0} right>
                        {delta === null ? "—" : formatSignedClp(delta)}
                      </Cell>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableExplorer>

          <SensitivityPanel rows={result?.sensitivity ?? []} />
        </>
      ) : null}
    </div>
  );
}

function SensitivityPanel({ rows }: { rows: ReturnType<typeof calculateQualitySensitivityTable> }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <TableExplorer
        description="Cuánto vale un décimo de punto de cada componente al volumen que estás simulando. Un componente por tramo no publica valor por décimo: plano dentro de un tramo no dice nada del siguiente."
        filter={{ allLabel: "Todas las confianzas", columnIndex: 1, label: "Confianza" }}
        id="leche.simulador.sensibilidad"
        searchPlaceholder="Buscar componente"
        title="Qué vale un décimo de punto"
      >
        <table className="w-full min-w-[560px] text-left">
          <thead>
            <tr>
              {["Componente", "Confianza", "CLP/L por 0,1 pto", "Por período"].map((header) => (
                <th
                  className="border-b border-line-steel px-2 py-2 text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle"
                  key={header}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.componentKey}>
                <Cell strong>{row.label}</Cell>
                <Cell>
                  {row.banded ? (
                    <Badge tone="blue">Por tramo</Badge>
                  ) : (
                    <Badge tone={row.confidence === "low" ? "amber" : "green"}>
                      {CONFIDENCE_LABELS[row.confidence]} · {row.distinctMeasurementCount} mediciones
                    </Badge>
                  )}
                </Cell>
                <Cell right>
                  {row.clpPerLiterPerStep === null ? "—" : formatDecimal(row.clpPerLiterPerStep, 2)}
                </Cell>
                <Cell right strong>
                  {row.clpPerPeriodPerStep === null ? "—" : formatClp(row.clpPerPeriodPerStep)}
                </Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </TableExplorer>
    </div>
  );
}

function BacktestNote({ backtest }: { backtest: ReturnType<typeof backtestMilkPriceModel> }) {
  const scored = backtest.results.filter((entry) => entry.matchedDifferenceClp !== null);
  if (scored.length === 0) return null;
  const worst = scored.reduce(
    (accumulator, entry) =>
      Math.abs(entry.matchedDifferenceClp ?? 0) > Math.abs(accumulator.matchedDifferenceClp ?? 0)
        ? entry
        : accumulator,
    scored[0],
  );
  return (
    <p className="mt-3 rounded-[14px] border border-line-steel bg-surface-alt px-3 py-2 text-[12px] leading-5 text-ink-muted">
      Control sobre tus propias liquidaciones: en los conceptos que cada período efectivamente pagó, el
      modelo reproduce el neto con una diferencia máxima de{" "}
      <span className="font-black text-ink">{formatClp(worst.matchedDifferenceClp ?? 0)}</span> en{" "}
      {formatPeriod(worst.period)}.
    </p>
  );
}

const CONFIDENCE_LABELS = {
  insufficient: "Insuficiente",
  low: "Baja",
  moderate: "Media",
  high: "Alta",
};

function Lead({ fundoLabel: label }: { fundoLabel: string }) {
  return (
    <section className="flex flex-col gap-4 rounded-[22px] border border-line-steel bg-ink p-5 text-white shadow-lg shadow-ink/10 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
          <Calculator size={20} />
        </span>
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.15em] text-white">Simulador de precio</p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.04em]">
            Qué pasa con tu cheque si cambia la calidad · {label}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-white/60">
            Es una <span className="font-black text-white">estimación</span> construida con tus propias
            liquidaciones, no una promesa de pago. Cada tasa declara si el documento la fijó o si hubo que
            deducirla, y cuando manda la liquidación real, manda ella.
          </p>
        </div>
      </div>
    </section>
  );
}

function Panel({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Calculator;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_38px_rgba(35,50,42,0.05)]">
      <div className="flex items-center gap-2">
        <Icon className="text-accent" size={16} />
        <h3 className="flex items-center gap-1.5 text-sm font-black text-ink">
          {title}
          <HelpTip help="lecheLiquidaciones" label={title} />
        </h3>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
  warning = false,
}: {
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <article
      className={`rounded-[18px] border p-4 shadow-sm ${warning ? "border-amber-200 bg-amber-50" : "border-line-steel bg-white"}`}
    >
      <p className="text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">{label}</p>
      <p
        className={`mt-2 text-xl font-black tracking-[-0.04em] ${warning ? "text-amber-900" : "text-ink"}`}
      >
        {value}
      </p>
      <p className="mt-1 text-[12px] font-semibold text-ink-subtle">{detail}</p>
    </article>
  );
}

function Cell({
  children,
  right = false,
  strong = false,
  danger = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <td
      className={`border-b border-line-steel px-2 py-2.5 text-[12px] ${right ? "text-right" : ""} ${strong ? "font-black text-ink" : "text-ink-muted"} ${danger ? "!font-black !text-red-700" : ""}`}
    >
      {children}
    </td>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "green" | "amber" | "red" | "blue" }) {
  const tones = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-800",
    blue: "border-sky-200 bg-sky-50 text-sky-900",
  };
  return (
    <span
      className={`inline-flex items-center rounded-lg border px-2 py-1 text-[12px] font-black ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <p className="rounded-[18px] border border-red-200 bg-red-50 px-4 py-3 text-[12px] font-bold text-red-800">
      {text}
    </p>
  );
}

function update(
  setDraft: (value: Inputs) => void,
  current: Inputs,
  patch: Partial<Inputs>,
) {
  setDraft({ ...current, ...patch });
}

function toInputs(settlement: MilkSettlement): Inputs {
  const input = projectionInputFromSettlement(settlement);
  // One quality figure stands for the whole period, so it must be the
  // volume-weighted result rather than the first fortnight's reading — otherwise the
  // untouched form would already disagree with the settlement it is based on.
  const quality = extractMilkSettlementQuality(settlement);
  return {
    litersFirstHalf: String(input.litersFirstHalf ?? input.totalLiters ?? ""),
    litersSecondHalf: String(input.litersSecondHalf ?? ""),
    fatPct: numberToInput(quality.fatPct),
    proteinPct: numberToInput(quality.proteinPct),
    totalSolidsPct: numberToInput(quality.totalSolidsPct),
  };
}

function toProjectionInput(inputs: Inputs): MilkProjectionInput {
  // A blank field means "no reading", not zero: it must be absent from the quality
  // object so the model falls back to a stated rate instead of pricing 0 %.
  const quality: MilkQualityInput = {};
  const fatPct = numberOrNull(inputs.fatPct);
  if (fatPct !== null) quality.fatPct = fatPct;
  const proteinPct = numberOrNull(inputs.proteinPct);
  if (proteinPct !== null) quality.proteinPct = proteinPct;
  const totalSolidsPct = numberOrNull(inputs.totalSolidsPct);
  if (totalSolidsPct !== null) quality.totalSolidsPct = totalSolidsPct;

  return {
    litersFirstHalf: numberOrNull(inputs.litersFirstHalf),
    litersSecondHalf: numberOrNull(inputs.litersSecondHalf),
    quality,
  };
}

function numberToInput(value: number | null | undefined) {
  return value === undefined || value === null ? "" : String(value);
}

function numberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "No fue posible calcular la estimación.";
}

function fundoLabel(fundos: Fundo[], selectedFundoId: string) {
  if (selectedFundoId === ALL) return "Todos los fundos";
  return fundos.find((fundo) => fundo.id === selectedFundoId)?.name ?? "Fundo";
}

function formatClp(value: number) {
  const rounded = Math.round(value);
  const magnitude = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(Math.abs(rounded));
  return `${rounded < 0 ? "-" : ""}$${magnitude}`;
}

/** Signed amount for a comparison column: "+$1.200", "-$800", "$0". */
function formatSignedClp(value: number) {
  const rounded = Math.round(value);
  if (rounded === 0) return "$0";
  return `${rounded > 0 ? "+" : ""}${formatClp(rounded)}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(value);
}

function formatDecimal(value: number, digits: number) {
  return new Intl.NumberFormat("es-CL", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatPeriod(value: string) {
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return new Intl.DateTimeFormat("es-CL", { month: "short", year: "numeric" }).format(date);
}
