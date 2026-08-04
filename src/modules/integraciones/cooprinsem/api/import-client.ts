import type {
  CooprinsemConfigurationDashboard,
  CooprinsemGenealogyConfirmation,
  CooprinsemGenealogyPlan,
  CooprinsemGroupMappingConfirmation,
  CooprinsemGroupMappingPlan,
  CooprinsemHistoryServiceConfirmation,
  CooprinsemHistoryServicePlan,
  CooprinsemImportDashboard,
  CooprinsemImportErrorStatus,
  CooprinsemImportConfirmation,
  CooprinsemImportProjectionPlan,
  CooprinsemImportPreview,
  CooprinsemMilkUnitContractConfirmation,
  CooprinsemMilkUnitContractPlan,
  CooprinsemQuarantineReassignmentConfirmation,
  CooprinsemQuarantineReassignmentPlan,
  CooprinsemSourceTable,
  CooprinsemOriginalIntegrityDashboard,
  CooprinsemOriginalDeepVerification,
  CooprinsemIntegritySweepBatchResult,
  CooprinsemIntegritySweepDashboard,
  CooprinsemRetentionDashboard,
  FundoSmartPortableRestorePlan,
  FundoSmartRecoveryPreparationReceipt,
  FundoSmartRestoreConfirmation,
} from "../domain/types";

export async function uploadCooprinsemPreview(input: {
  effectiveAt: string;
  fieldId: string;
  file: File;
  sourceTable: CooprinsemSourceTable;
}): Promise<CooprinsemImportPreview> {
  const formData = new FormData();
  formData.set("file", input.file);
  formData.set("fieldId", input.fieldId);
  formData.set("sourceTable", input.sourceTable);
  if (input.effectiveAt) formData.set("effectiveAt", input.effectiveAt);

  const response = await fetch("/api/integraciones/cooprinsem/importaciones", {
    method: "POST",
    body: formData,
  });
  const body = await response.json() as { error?: string; preview?: CooprinsemImportPreview };
  if (!response.ok || !body.preview) throw new Error(body.error ?? "No fue posible preparar la vista previa.");
  return body.preview;
}

export async function fetchCooprinsemDashboard(): Promise<CooprinsemImportDashboard> {
  const response = await fetch("/api/integraciones/cooprinsem/importaciones", { cache: "no-store" });
  const body = await response.json() as { dashboard?: CooprinsemImportDashboard; error?: string };
  if (!response.ok || !body.dashboard) throw new Error(body.error ?? "No fue posible actualizar el centro de migración.");
  return body.dashboard;
}

export async function fetchCooprinsemPreview(id: string): Promise<CooprinsemImportPreview> {
  const response = await fetch(`/api/integraciones/cooprinsem/importaciones?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  const body = await response.json() as { preview?: CooprinsemImportPreview; error?: string };
  if (!response.ok || !body.preview) throw new Error(body.error ?? "No fue posible abrir la vista previa.");
  return body.preview;
}

export async function previewPortableRestore(file: File): Promise<{ plan: FundoSmartPortableRestorePlan; uploadedSha256: string }> {
  const formData = new FormData();
  formData.set("backup", file);
  const response = await fetch("/api/integraciones/cooprinsem/restauracion", { method: "POST", body: formData });
  const body = await response.json() as {
    plan?: FundoSmartPortableRestorePlan;
    uploadedSha256?: string;
    error?: string;
    issues?: string[];
  };
  if (!response.ok || !body.plan || !body.uploadedSha256) {
    const detail = body.issues?.length ? ` ${body.issues.slice(0, 3).join(" ")}` : "";
    throw new Error(`${body.error ?? "No fue posible verificar el respaldo."}${detail}`);
  }
  return { plan: body.plan, uploadedSha256: body.uploadedSha256 };
}

export async function preparePortableRestore(file: File): Promise<{
  plan: FundoSmartPortableRestorePlan;
  uploadedSha256: string;
  confirmation: FundoSmartRestoreConfirmation;
}> {
  const formData = new FormData();
  formData.set("backup", file);
  const response = await fetch("/api/integraciones/cooprinsem/restauracion?intent=prepare_confirmation", { method: "POST", body: formData });
  const body = await response.json() as {
    plan?: FundoSmartPortableRestorePlan;
    uploadedSha256?: string;
    confirmation?: FundoSmartRestoreConfirmation;
    error?: string;
  };
  if (!response.ok || !body.plan || !body.uploadedSha256 || !body.confirmation) {
    throw new Error(body.error ?? "No fue posible preparar la confirmacion segura.");
  }
  return { plan: body.plan, uploadedSha256: body.uploadedSha256, confirmation: body.confirmation };
}

export async function preparePortableRecovery(
  file: File,
  confirmation: FundoSmartRestoreConfirmation,
  confirmationPhrase: string,
): Promise<{
  plan: FundoSmartPortableRestorePlan;
  uploadedSha256: string;
  recovery: FundoSmartRecoveryPreparationReceipt;
}> {
  const formData = new FormData();
  formData.set("backup", file);
  formData.set("token", confirmation.token);
  formData.set("confirmationPhrase", confirmationPhrase);
  const response = await fetch("/api/integraciones/cooprinsem/restauracion?intent=prepare_recovery", { method: "POST", body: formData });
  const body = await response.json() as {
    plan?: FundoSmartPortableRestorePlan;
    uploadedSha256?: string;
    recovery?: FundoSmartRecoveryPreparationReceipt;
    error?: string;
  };
  if (!response.ok || !body.plan || !body.uploadedSha256 || !body.recovery) {
    throw new Error(body.error ?? "No fue posible preparar el ensayo de recuperación.");
  }
  return { plan: body.plan, uploadedSha256: body.uploadedSha256, recovery: body.recovery };
}

export async function fetchOriginalIntegrity(fieldId: string): Promise<CooprinsemOriginalIntegrityDashboard> {
  const response = await fetch(`/api/integraciones/cooprinsem/conservacion?fieldId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  const body = await response.json() as { integrity?: CooprinsemOriginalIntegrityDashboard; error?: string };
  if (!response.ok || !body.integrity) throw new Error(body.error ?? "No fue posible verificar los originales R2.");
  return body.integrity;
}

export async function deepVerifyOriginal(importJobId: string): Promise<CooprinsemOriginalDeepVerification> {
  const response = await fetch("/api/integraciones/cooprinsem/conservacion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ importJobId }),
  });
  const body = await response.json() as { verification?: CooprinsemOriginalDeepVerification; error?: string };
  if (!response.ok || !body.verification) throw new Error(body.error ?? "No fue posible recalcular la huella del original.");
  return body.verification;
}

export async function fetchIntegritySweepDashboard(fieldId: string): Promise<CooprinsemIntegritySweepDashboard> {
  const response = await fetch(`/api/integraciones/cooprinsem/conservacion-programada?fieldId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  const body = await response.json() as { sweep?: CooprinsemIntegritySweepDashboard; error?: string };
  if (!response.ok || !body.sweep) throw new Error(body.error ?? "No fue posible cargar la cobertura programada.");
  return body.sweep;
}

export async function runIntegritySweepBatch(fieldId: string): Promise<{
  result: CooprinsemIntegritySweepBatchResult;
  sweep: CooprinsemIntegritySweepDashboard;
}> {
  const response = await fetch("/api/integraciones/cooprinsem/conservacion-programada", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "run_next_batch", fieldId }),
  });
  const body = await response.json() as {
    result?: CooprinsemIntegritySweepBatchResult;
    sweep?: CooprinsemIntegritySweepDashboard;
    error?: string;
  };
  if (!response.ok || !body.result || !body.sweep) throw new Error(body.error ?? "No fue posible procesar el siguiente lote.");
  return { result: body.result, sweep: body.sweep };
}

export async function fetchRetentionDashboard(fieldId: string): Promise<CooprinsemRetentionDashboard> {
  const response = await fetch(`/api/integraciones/cooprinsem/retencion?fieldId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  const body = await response.json() as { retention?: CooprinsemRetentionDashboard; error?: string };
  if (!response.ok || !body.retention) throw new Error(body.error ?? "No fue posible simular la política de retención.");
  return body.retention;
}

export async function updateCooprinsemIssue(input: {
  id: string;
  status: CooprinsemImportErrorStatus;
  resolutionNotes: string;
}): Promise<CooprinsemImportDashboard> {
  const response = await fetch("/api/integraciones/cooprinsem/inconsistencias", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json() as { dashboard?: CooprinsemImportDashboard; error?: string };
  if (!response.ok || !body.dashboard) throw new Error(body.error ?? "No fue posible registrar la resolución.");
  return body.dashboard;
}

export async function simulateCooprinsemProjection(id: string): Promise<CooprinsemImportProjectionPlan> {
  const response = await fetch(`/api/integraciones/cooprinsem/proyeccion?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  const body = await response.json() as { projection?: CooprinsemImportProjectionPlan; error?: string };
  if (!response.ok || !body.projection) throw new Error(body.error ?? "No fue posible simular la integración.");
  return body.projection;
}

export async function confirmCooprinsemProjection(importJobId: string): Promise<{
  result: CooprinsemImportConfirmation;
  dashboard: CooprinsemImportDashboard;
  preview: CooprinsemImportPreview | null;
  projection: CooprinsemImportProjectionPlan | null;
}> {
  const response = await fetch("/api/integraciones/cooprinsem/proyeccion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ importJobId, confirmation: importJobId }),
  });
  const body = await response.json() as {
    result?: CooprinsemImportConfirmation;
    dashboard?: CooprinsemImportDashboard;
    preview?: CooprinsemImportPreview | null;
    projection?: CooprinsemImportProjectionPlan | null;
    error?: string;
  };
  if (!response.ok || !body.result || !body.dashboard) throw new Error(body.error ?? "No fue posible confirmar la integración.");
  return { result: body.result, dashboard: body.dashboard, preview: body.preview ?? null, projection: body.projection ?? null };
}

export async function fetchCooprinsemConfiguration(fieldId: string): Promise<CooprinsemConfigurationDashboard> {
  const response = await fetch(`/api/integraciones/cooprinsem/configuracion?fieldId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  const body = await response.json() as { configuration?: CooprinsemConfigurationDashboard; error?: string };
  if (!response.ok || !body.configuration) throw new Error(body.error ?? "No fue posible cargar la configuración Cooprinsem.");
  return body.configuration;
}

export async function simulateCooprinsemGroupMapping(input: {
  fieldId: string;
  groupCode: string;
  lotId: string;
}): Promise<CooprinsemGroupMappingPlan> {
  return configurationPlan<CooprinsemGroupMappingPlan>({ action: "simulate_group_mapping", ...input });
}

export async function simulateCooprinsemGroupDeactivation(input: {
  fieldId: string;
  groupCode: string;
}): Promise<CooprinsemGroupMappingPlan> {
  return configurationPlan<CooprinsemGroupMappingPlan>({ action: "simulate_group_deactivation", ...input });
}

export async function confirmCooprinsemGroupPlan(plan: CooprinsemGroupMappingPlan): Promise<{
  result: CooprinsemGroupMappingConfirmation;
  configuration: CooprinsemConfigurationDashboard;
}> {
  return configurationMutation({
    action: plan.action === "deactivate" ? "confirm_group_deactivation" : "confirm_group_mapping",
    fieldId: plan.fieldId,
    groupCode: plan.groupCode,
    lotId: plan.targetLot?.id ?? "",
    confirmation: plan.confirmationToken,
  });
}

export async function simulateCooprinsemQuarantineReassignment(input: {
  fieldId: string;
  groupCode: string;
}): Promise<CooprinsemQuarantineReassignmentPlan> {
  return configurationPlan<CooprinsemQuarantineReassignmentPlan>({ action: "simulate_quarantine_reassignment", ...input });
}

export async function confirmCooprinsemQuarantineReassignment(plan: CooprinsemQuarantineReassignmentPlan): Promise<{
  result: CooprinsemQuarantineReassignmentConfirmation;
  configuration: CooprinsemConfigurationDashboard;
}> {
  return configurationMutation({
    action: "confirm_quarantine_reassignment",
    fieldId: plan.fieldId,
    groupCode: plan.groupCode,
    confirmation: plan.confirmationToken,
  });
}

export async function confirmCooprinsemGenealogy(plan: CooprinsemGenealogyPlan): Promise<{
  result: CooprinsemGenealogyConfirmation;
  configuration: CooprinsemConfigurationDashboard;
}> {
  return configurationMutation({
    action: "confirm_genealogy_reconciliation",
    fieldId: plan.fieldId,
    confirmation: plan.confirmationToken,
  });
}

export async function confirmCooprinsemMilkUnit(
  plan: CooprinsemMilkUnitContractPlan,
  phrase: string,
): Promise<{
  result: CooprinsemMilkUnitContractConfirmation;
  configuration: CooprinsemConfigurationDashboard;
}> {
  return configurationMutation({
    action: "confirm_history_milk_unit_contract",
    fieldId: plan.fieldId,
    confirmation: plan.confirmationToken,
    phrase,
  });
}

export async function confirmCooprinsemHistoricalServices(
  plan: CooprinsemHistoryServicePlan,
  phrase: string,
): Promise<{
  result: CooprinsemHistoryServiceConfirmation;
  configuration: CooprinsemConfigurationDashboard;
}> {
  return configurationMutation({
    action: "confirm_history_services",
    fieldId: plan.fieldId,
    confirmation: plan.confirmationToken,
    phrase,
  });
}

async function configurationPlan<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/integraciones/cooprinsem/configuracion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as { plan?: T; error?: string };
  if (!response.ok || !body.plan) throw new Error(body.error ?? "No fue posible simular la configuración.");
  return body.plan;
}

async function configurationMutation<T extends { result: unknown; configuration: CooprinsemConfigurationDashboard }>(payload: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/integraciones/cooprinsem/configuracion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok || !body.result || !body.configuration) throw new Error(body.error ?? "No fue posible confirmar la configuración.");
  return body;
}
