const DAY_MS = 86_400_000;

export function buildAnimalInsights(input, nowValue = new Date().toISOString()) {
  const now = new Date(nowValue);
  const insights = [];
  const lactations = [...(input?.lactations ?? [])].sort(byDateDesc("startedAt"));
  const milkControls = [...(input?.milkControls ?? [])].sort(byDateDesc("controlDate"));
  const events = [...(input?.reproductiveEvents ?? [])].sort(byDateDesc("occurredAt"));
  const births = [...(input?.births ?? [])].sort(byDateDesc("occurredAt"));
  const healthEvents = [...(input?.healthEvents ?? [])].sort(byDateDesc("occurredAt"));
  const weighings = [...(input?.weighings ?? [])].sort(byDateDesc("recordedAt"));
  const activeLactation = lactations.find((entry) => entry.status === "active") ?? null;

  if (activeLactation) {
    const daysInMilk = daysBetween(activeLactation.startedAt, now);
    if (daysInMilk > 305) {
      insights.push({
        code: "LONG_LACTATION",
        level: "attention",
        title: "Lactancia prolongada",
        detail: `La lactancia activa lleva ${daysInMilk} días; conviene revisar secado y estado reproductivo.`,
      });
    } else {
      insights.push({
        code: "ACTIVE_LACTATION",
        level: "info",
        title: `Día ${Math.max(1, daysInMilk)} de lactancia`,
        detail: "Seguimiento productivo activo desde el último parto registrado.",
      });
    }
  }

  if (milkControls.length > 0) {
    const latest = milkControls[0];
    const age = daysBetween(latest.controlDate, now);
    if (activeLactation && age > 35) {
      insights.push({
        code: "MILK_CONTROL_OVERDUE",
        level: "attention",
        title: "Control lechero atrasado",
        detail: `Han pasado ${age} días desde el último control individual.`,
      });
    }
    const previous = milkControls.slice(1, 4);
    if (previous.length > 0) {
      const baseline = previous.reduce((total, entry) => total + entry.totalLiters, 0) / previous.length;
      const change = baseline > 0 ? ((latest.totalLiters - baseline) / baseline) * 100 : 0;
      if (change <= -15) {
        insights.push({
          code: "MILK_DROP",
          level: "attention",
          title: "Caída de producción",
          detail: `El último control está ${Math.abs(Math.round(change))}% bajo el promedio de los controles previos.`,
        });
      } else if (change >= 10) {
        insights.push({
          code: "MILK_IMPROVEMENT",
          level: "positive",
          title: "Producción en mejora",
          detail: `El último control está ${Math.round(change)}% sobre el promedio reciente.`,
        });
      }
    }
  } else if (activeLactation) {
    insights.push({
      code: "MILK_CONTROL_MISSING",
      level: "attention",
      title: "Lactancia sin controles",
      detail: "La lactancia está activa, pero todavía no tiene producción individual registrada.",
    });
  }

  const lastService = events.find((entry) => entry.eventType === "service" || entry.eventType === "insemination");
  if (lastService) {
    const laterOutcome = events.some((entry) =>
      entry.occurredAt > lastService.occurredAt
      && (entry.eventType === "pregnancy_diagnosis" || entry.eventType === "calving" || entry.eventType === "abortion"));
    const daysSinceService = daysBetween(lastService.occurredAt, now);
    if (!laterOutcome && daysSinceService >= 35) {
      insights.push({
        code: "PREGNANCY_CHECK_DUE",
        level: "attention",
        title: "Diagnóstico de gestación pendiente",
        detail: `Han pasado ${daysSinceService} días desde la última cubierta o inseminación sin resultado posterior.`,
      });
    }
  }

  if (weighings.length > 0) {
    const age = daysBetween(weighings[0].recordedAt, now);
    if (age > 120) {
      insights.push({
        code: "WEIGHING_OLD",
        level: "info",
        title: "Pesaje desactualizado",
        detail: `El último peso tiene ${age} días de antigüedad.`,
      });
    }
  }

  const today = now.toISOString().slice(0, 10);
  const activeWithdrawals = healthEvents.filter((entry) => entry.status !== "cancelled" && (
    (entry.withdrawalMilkUntil && entry.withdrawalMilkUntil >= today)
    || (entry.withdrawalMeatUntil && entry.withdrawalMeatUntil >= today)
  ));
  if (activeWithdrawals.length > 0) {
    const milkUntil = maximumDate(activeWithdrawals.map((entry) => entry.withdrawalMilkUntil));
    const meatUntil = maximumDate(activeWithdrawals.map((entry) => entry.withdrawalMeatUntil));
    const restrictions = [milkUntil ? `leche hasta ${formatShortDate(milkUntil)}` : null, meatUntil ? `carne hasta ${formatShortDate(meatUntil)}` : null].filter(Boolean).join(" y ");
    insights.push({
      code: "ACTIVE_WITHDRAWAL",
      level: "attention",
      title: "Período de retiro activo",
      detail: `Mantener segregación de ${restrictions}. Verifica siempre el registro del producto y la indicación profesional.`,
    });
  }

  const overdueHealth = healthEvents.find((entry) => entry.status === "open" && daysBetween(entry.occurredAt, now) > 7);
  if (overdueHealth) {
    insights.push({
      code: "HEALTH_FOLLOW_UP_DUE",
      level: "attention",
      title: "Seguimiento sanitario pendiente",
      detail: `El evento abierto “${overdueHealth.condition || overdueHealth.eventType}” lleva ${daysBetween(overdueHealth.occurredAt, now)} días sin cierre.`,
    });
  }

  const recentBirth = births.find((entry) => daysBetween(entry.occurredAt, now) <= 30);
  if (recentBirth) {
    insights.push({
      code: "RECENT_BIRTH",
      level: "info",
      title: "Parto reciente trazado",
      detail: `${recentBirth.offspring?.length ?? 0} cría${recentBirth.offspring?.length === 1 ? "" : "s"} vinculada${recentBirth.offspring?.length === 1 ? "" : "s"} a la genealogía del animal.`,
    });
  }

  if (insights.length === 0) {
    insights.push({
      code: "NO_HISTORY",
      level: "info",
      title: "Ficha lista para crecer",
      detail: "Registra el primer evento productivo o reproductivo para activar alertas inteligentes.",
    });
  }
  if (!insights.some((entry) => entry.level === "attention") && (milkControls.length > 0 || events.length > 0 || births.length > 0 || healthEvents.length > 0)) {
    insights.push({
      code: "FOLLOW_UP_HEALTHY",
      level: "positive",
      title: "Seguimiento al día",
      detail: "No se detectan alertas críticas en la información registrada.",
    });
  }
  return insights;
}

function maximumDate(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function formatShortDate(value) {
  const [year, month, day] = value.split("-");
  return `${day}-${month}-${year}`;
}

function byDateDesc(field) {
  return (left, right) => String(right[field]).localeCompare(String(left[field]));
}

function daysBetween(value, now) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}
