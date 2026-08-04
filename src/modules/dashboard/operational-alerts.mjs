const TONE_ORDER = { attention: 0, warning: 1, info: 2 };

export function buildOperationalAlerts({
  availablePaddockCount,
  canViewFinance,
  lastActivityDate,
  metrics,
  paddockCount,
  referenceDate,
}) {
  const alerts = [];

  if (metrics.milkChangePercent !== null && metrics.milkChangePercent <= -5) {
    alerts.push({
      detail: `La producción bajó ${formatPercent(Math.abs(metrics.milkChangePercent))} frente al período anterior. Revisa alimentación, salud y composición del rebaño.`,
      href: "/app/leche",
      id: "milk-drop",
      title: "Caída de producción de leche",
      tone: "attention",
    });
  }

  if (canViewFinance && metrics.operatingResultClp !== null && metrics.operatingResultClp < 0) {
    alerts.push({
      detail: "Los costos registrados superan el ingreso neto del último período lechero.",
      href: "/app/costos",
      id: "negative-operating-result",
      title: "Resultado operativo negativo",
      tone: "attention",
    });
  }

  if (metrics.weightCoveragePercent !== null && metrics.weightCoveragePercent < 80) {
    alerts.push({
      detail: `Solo ${formatPercent(metrics.weightCoveragePercent)} de los animales individuales tiene un pesaje registrado.`,
      href: "/app/ganado",
      id: "weight-coverage",
      title: "Cobertura de pesaje baja",
      tone: "warning",
    });
  }

  if (paddockCount > 0 && availablePaddockCount === 0) {
    alerts.push({
      detail: "No hay potreros marcados como disponibles en la selección actual.",
      href: "/app/potreros",
      id: "no-available-paddocks",
      title: "Sin potreros disponibles",
      tone: "warning",
    });
  }

  const activityAgeDays = daysSince(lastActivityDate, referenceDate);
  if (activityAgeDays === null || activityAgeDays >= 7) {
    alerts.push({
      detail: activityAgeDays === null
        ? "Todavía no hay manejos registrados para esta selección."
        : `Han pasado ${activityAgeDays} días desde el último manejo registrado.`,
      href: "/app/potreros",
      id: "activity-gap",
      title: "Trazabilidad por actualizar",
      tone: "info",
    });
  }

  return alerts
    .sort((first, second) => TONE_ORDER[first.tone] - TONE_ORDER[second.tone] || first.id.localeCompare(second.id))
    .slice(0, 4);
}

function daysSince(value, referenceDate) {
  if (!value) return null;
  const occurredAt = new Date(`${value}T12:00:00.000Z`);
  const reference = new Date(referenceDate);
  if (!Number.isFinite(occurredAt.getTime()) || !Number.isFinite(reference.getTime())) return null;
  return Math.max(0, Math.floor((reference.getTime() - occurredAt.getTime()) / 86_400_000));
}

function formatPercent(value) {
  return `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`;
}
