export function resolvePabcoComplianceEditor(
  items,
  fieldId,
  requirement,
  defaultValidFrom,
) {
  const current = Array.isArray(items)
    ? items.find(
        (item) =>
          item?.fieldId === fieldId && item?.requirement === requirement,
      )
    : undefined;

  return {
    fieldId,
    requirement,
    status: current?.status ?? "compliant",
    validFrom: current?.validFrom ?? defaultValidFrom,
    validUntil: current?.validUntil ?? "",
    reminderAt: current?.reminderAt ?? "",
    evidence: current?.evidenceDocumentId ?? "",
    notes: current?.notes ?? "",
  };
}
