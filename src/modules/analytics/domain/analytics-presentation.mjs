import { serializeCsv } from "../../../core/export/csv.mjs";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const PERIOD = /^(\d{4})-(\d{2})$/u;
const ANALYTICS_TIME_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const CSV_HEADERS = [
  "Tipo",
  "Fundo",
  "Período",
  "Ventana inicio",
  "Ventana fin",
  "Clave",
  "Estado",
  "Severidad",
  "Valor observado",
  "Unidad",
  "Numerador",
  "Denominador",
  "Muestra",
  "Método u operador",
  "Razón o explicación",
  "Referencias",
  "Revisión fuente",
  "Calculado",
];

export function formatAnalyticsDate(value) {
  const match = DATE.exec(String(value));
  if (!match) return String(value);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(match[1]), month)) return String(value);
  return `${match[3]} ${MONTHS[month - 1]} ${match[1]}`;
}

export function formatAnalyticsDateTime(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return String(value);
  const parts = Object.fromEntries(
    ANALYTICS_TIME_FORMAT.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}-${parts.month}-${parts.year}, ${parts.hour}:${parts.minute}`;
}

export function shiftAnalyticsPeriod(period, delta) {
  const match = PERIOD.exec(String(period));
  const amount = Number(delta);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12 || !Number.isSafeInteger(amount)) {
    throw new TypeError("El período debe usar YYYY-MM y el desplazamiento debe ser un entero.");
  }
  const absoluteMonth = Number(match[1]) * 12 + month - 1 + amount;
  const year = Math.floor(absoluteMonth / 12);
  const shiftedMonth = absoluteMonth - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
}

export function buildAnalyticsCsv(dashboard) {
  const projection = dashboard?.projection;
  if (!projection) return serializeCsv(CSV_HEADERS, []);
  const shared = {
    field: dashboard.field?.name ?? "",
    period: projection.window.period ?? "",
    start: projection.window.start,
    end: projection.window.end,
    revision: projection.reference.datasetRevision ?? "",
    computedAt: projection.computedAt ?? "",
  };
  const metricRows = projection.metrics.map((metric) => [
    "Indicador",
    shared.field,
    shared.period,
    shared.start,
    shared.end,
    metric.key,
    metric.status,
    "",
    metric.value,
    metric.unit,
    metric.numerator,
    metric.denominator,
    metric.sampleCount,
    metric.method,
    metric.statusReason ?? "",
    JSON.stringify(metric.references),
    shared.revision,
    shared.computedAt,
  ]);
  const alertRows = projection.alertEvaluations.map((alert) => [
    "Regla",
    shared.field,
    shared.period,
    alert.window?.start ?? shared.start,
    alert.window?.end ?? shared.end,
    alert.code,
    alert.status,
    alert.severity,
    alert.evidence.observed,
    alert.evidence.unit ?? "",
    alert.evidence.numerator,
    alert.evidence.denominator,
    alert.evidence.sampleCount,
    alert.evidence.operator,
    alert.explanation,
    JSON.stringify({
      metricKey: alert.evidence.metricKey,
      subject: alert.evidence.subject ?? null,
      observations: alert.evidence.observations ?? [],
      threshold: alert.evidence.threshold,
    }),
    shared.revision,
    shared.computedAt,
  ]);
  return serializeCsv(CSV_HEADERS, [...metricRows, ...alertRows]);
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const OWN_HISTORY_CSV_HEADERS = [
  "Fundo",
  "Período",
  "Indicador",
  "Unidad",
  "Valor del período",
  "Estado del período",
  "Base comparada",
  "Período base",
  "Tipo de comparación",
  "Diferencia",
  "Diferencia %",
  "Dirección",
  "Resultado",
  "Motivo",
  "Banda mínima",
  "Banda máxima",
  "Banda promedio",
  "Períodos de la banda",
  "Posición en la banda",
  "Advertencias",
];

/**
 * Serializes the own-history comparison as CSV.
 *
 * This is deliberately the *only* implementation of comparable series: improvement 70
 * asked for a monthly report with comparable windows, and building that separately
 * would have produced two answers to the same question. The report exports this.
 *
 * Every row carries the reason it says what it says — the basis period, whether the
 * comparison had to fall back to the previous period, and why a metric produced no
 * delta — so a spreadsheet reader is not left guessing at a blank cell.
 */
export function buildOwnHistoryCsv({ comparison, fieldName = "" } = {}) {
  if (!comparison?.comparisons?.length) return serializeCsv(OWN_HISTORY_CSV_HEADERS, []);

  const rows = comparison.comparisons.map((entry) => {
    const delta = entry.primary === "yearOverYear"
      ? entry.yearOverYear
      : entry.primary === "periodOverPeriod"
        ? entry.periodOverPeriod
        : null;
    const comparisonKind = entry.primary === "yearOverYear"
      ? "Interanual"
      : entry.primary === "periodOverPeriod"
        ? "Período previo"
        : "Sin base";

    return [
      fieldName,
      entry.target.period,
      entry.key,
      entry.unit ?? "",
      entry.target.value,
      entry.target.status,
      delta?.status === "available" ? delta.basisValue : "",
      delta?.basisPeriod ?? "",
      comparisonKind,
      delta?.status === "available" ? delta.deltaAbsolute : "",
      delta?.status === "available" ? delta.deltaPct : "",
      delta?.status === "available" ? delta.direction : "",
      entry.verdict,
      entry.reason ?? delta?.statusReason ?? "",
      entry.band.status === "available" ? entry.band.minimum : "",
      entry.band.status === "available" ? entry.band.maximum : "",
      entry.band.status === "available" ? entry.band.mean : "",
      entry.band.periodsUsed,
      entry.band.status === "available" ? (entry.band.position ?? "") : entry.band.statusReason ?? "",
      entry.notes.map((note) => note.code).join(" "),
    ];
  });

  return serializeCsv(OWN_HISTORY_CSV_HEADERS, rows);
}
