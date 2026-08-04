export function restorePreparationPhrase(fieldName) {
  const normalizedFieldName = String(fieldName ?? "").trim().replace(/\s+/g, " ");
  if (!normalizedFieldName) throw new Error("La confirmación requiere el nombre del fundo.");
  return `PREPARAR ${normalizedFieldName}`;
}

export function matchesRestorePreparationPhrase(value, fieldName) {
  return String(value ?? "").trim() === restorePreparationPhrase(fieldName);
}
