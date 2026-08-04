// Formateo consistente para el módulo de ganado. El dinero es SIEMPRE CLP entero.

const clp = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

export function formatClp(amount: number): string {
  return clp.format(amount);
}

export function formatInteger(value: number): string {
  return value.toLocaleString("es-CL", { maximumFractionDigits: 0 });
}

export function formatNumber(value: number, maximumFractionDigits: number): string {
  return value.toLocaleString("es-CL", { maximumFractionDigits });
}

export function formatKg(value: number, maximumFractionDigits = 1): string {
  return `${formatNumber(value, maximumFractionDigits)} kg`;
}

/** "2026-07-16" → "16 jul 2026" sin corrimiento de día. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(`${value}T12:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("es-CL", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha local de hoy en formato "2026-07-17" para inputs type=date. */
export function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
