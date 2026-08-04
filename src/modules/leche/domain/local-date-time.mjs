export function isoInstantToLocalDateTimeInput(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return "";

  const local = new Date(
    instant.getTime() - instant.getTimezoneOffset() * 60_000,
  );
  const localIso = local.toISOString();
  if (localIso.slice(20, 23) !== "000") return localIso.slice(0, 23);
  if (localIso.slice(17, 19) !== "00") return localIso.slice(0, 19);
  return localIso.slice(0, 16);
}

export function localDateTimeInputToIso(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) {
    throw new RangeError("La fecha de generación no es válida.");
  }
  return instant.toISOString();
}
