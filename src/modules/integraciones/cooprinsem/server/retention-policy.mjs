export const ORIGINAL_RETENTION_POLICY = Object.freeze({
  id: "cooprinsem-originals-retain-only",
  version: 1,
  mode: "retain_only",
  deletionEnabled: false,
  approvedRetentionDays: null,
  lifecycleExpirationEnabled: false,
});

const BLOCKED_GATES = Object.freeze([
  Object.freeze({
    code: "retention_period_approved",
    label: "Período formal aprobado",
    satisfied: false,
    detail: "No existe una duración legal o contractual aprobada y versionada.",
  }),
  Object.freeze({
    code: "separate_delete_capability",
    label: "Capacidad separada de eliminación",
    satisfied: false,
    detail: "La aplicación no dispone de un escritor R2 que elimine originales.",
  }),
  Object.freeze({
    code: "portable_backup_attested",
    label: "Respaldo portable atestiguado",
    satisfied: false,
    detail: "No se persiste todavía una atestación de respaldo portable por original.",
  }),
  Object.freeze({
    code: "restore_rehearsal_attested",
    label: "Restauración probada",
    satisfied: false,
    detail: "No existe una atestación productiva de restauración completa ligada al original.",
  }),
  Object.freeze({
    code: "human_confirmation_bound",
    label: "Confirmación humana ligada al objeto",
    satisfied: false,
    detail: "No existe una confirmación temporal y de un solo uso para eliminar originales.",
  }),
  Object.freeze({
    code: "before_after_audit_ready",
    label: "Auditoría antes y después",
    satisfied: false,
    detail: "No se ha implementado el registro atómico requerido para una eliminación.",
  }),
  Object.freeze({
    code: "recovery_window_approved",
    label: "Ventana de recuperación aprobada",
    satisfied: false,
    detail: "No existe una ventana de recuperación contractual ni un mecanismo de cuarentena.",
  }),
]);

export function simulateOriginalRetention(input) {
  const originalCount = nonNegativeInteger(input.originalCount);
  const totalSizeBytes = nonNegativeInteger(input.totalSizeBytes);
  const openIntegrityIncidentCount = nonNegativeInteger(input.openIntegrityIncidentCount);
  const gates = [
    ...BLOCKED_GATES.map((gate) => ({ ...gate })),
    {
      code: "integrity_clear",
      label: "Integridad sin incidentes abiertos",
      satisfied: openIntegrityIncidentCount === 0,
      detail: openIntegrityIncidentCount === 0
        ? "D1 no registra incidentes de integridad abiertos para este fundo."
        : `${openIntegrityIncidentCount} ${openIntegrityIncidentCount === 1 ? "incidente abierto bloquea" : "incidentes abiertos bloquean"} cualquier eliminación.`,
    },
  ];

  return {
    fieldId: input.fieldId,
    fieldName: input.fieldName,
    organizationId: input.organizationId,
    evaluatedAt: input.evaluatedAt,
    status: originalCount === 0 ? "empty" : "retain_all",
    policy: { ...ORIGINAL_RETENTION_POLICY },
    inventory: {
      oldestImportedAt: input.oldestImportedAt ?? null,
      newestImportedAt: input.newestImportedAt ?? null,
    },
    totals: {
      originalCount,
      totalSizeBytes,
      retainCount: originalCount,
      eligibleForDeletionCount: 0,
      openIntegrityIncidentCount,
    },
    gates,
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
