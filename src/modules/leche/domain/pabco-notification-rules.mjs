const REQUIREMENT_LABELS = {
  veterinary_advisory: "Asesoría veterinaria",
  medicine_prescriptions: "Recetas de medicamentos",
  withdrawal_management: "Control de resguardos",
  annual_water_analysis: "Análisis anual de agua",
  animal_traceability: "Trazabilidad animal",
};

/**
 * Builds stable reminder work items from PABCO compliance records.
 * An explicit reminder date takes precedence over the document expiry date.
 */
export function derivePabcoReminderWorkItems(items) {
  return items
    .filter((item) => item.status !== "not_applicable")
    .map((item) => {
      const dueDate = validDate(item.reminderAt) ?? validDate(item.validUntil);
      if (!dueDate) return null;
      const requirement =
        REQUIREMENT_LABELS[item.requirement] ?? item.requirement;
      const expiryDetail = validDate(item.validUntil)
        ? `La vigencia termina el ${item.validUntil}.`
        : `El seguimiento fue programado para el ${dueDate}.`;
      return {
        id: `pabco:${item.id}`,
        complianceItemId: item.id,
        fieldId: item.fieldId,
        title: `PABCO · ${requirement}`,
        detail: expiryDetail,
        dueDate,
        validUntil: validDate(item.validUntil),
        status: item.status,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.dueDate.localeCompare(right.dueDate) ||
        left.id.localeCompare(right.id),
    );
}

export function selectDuePabcoReminderWorkItems(items, today, reminderDays) {
  const horizon = addDays(today, clampReminderDays(reminderDays));
  return derivePabcoReminderWorkItems(items).filter(
    (item) => item.dueDate <= horizon,
  );
}

export function derivePabcoComplianceStatus(item, today) {
  if (item.status === "not_applicable") return "not_applicable";
  const validUntil = validDate(item.validUntil);
  if (validUntil && validUntil < today) return "expired";
  const reminderAt = validDate(item.reminderAt);
  if (
    reminderAt &&
    reminderAt <= today &&
    (!validUntil || today <= validUntil)
  ) {
    return "expiring";
  }
  return item.status;
}

export function clampReminderDays(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 14;
  return Math.max(0, Math.min(60, Math.round(numeric)));
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()))
    throw new TypeError("today must use YYYY-MM-DD format");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
