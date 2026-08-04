import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import { matchesRestorePreparationPhrase, restorePreparationPhrase } from "@/src/modules/integraciones/cooprinsem/domain/restore-challenge.mjs";
import { buildFieldBackup, recordRestorePreview } from "@/src/modules/integraciones/cooprinsem/server/backup-repository";
import { sha256Hex } from "@/src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import {
  prepareDurableRecoveryJob,
  RecoveryPreparationError,
} from "@/src/modules/integraciones/cooprinsem/server/recovery-job-preparation-repository";
import {
  buildPortableRestorePlan,
  portableRestoreOriginalInventory,
  PortableBackupValidationError,
  validatePortableBackup,
} from "@/src/modules/integraciones/cooprinsem/server/restore-rules.mjs";
import {
  isRestorePlanConfirmable,
  restorePlanSha256,
  restoreSnapshotSha256,
} from "@/src/modules/integraciones/cooprinsem/server/restore-confirmation-rules.mjs";
import {
  issueRestoreConfirmation,
  RestoreConfirmationScopeError,
} from "@/src/modules/integraciones/cooprinsem/server/restore-confirmation-repository";

export const dynamic = "force-dynamic";

const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  const intent = new URL(request.url).searchParams.get("intent") ?? "preview";
  if (intent !== "preview" && intent !== "prepare_confirmation" && intent !== "prepare_recovery") {
    return Response.json({ error: "La operacion de restauracion no esta soportada." }, { status: 400 });
  }
  const access = await authorizeApiAccess(intent === "preview" ? "manage_imports" : "restore_data");
  if (isAccessResponse(access)) return access;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "La solicitud no contiene un respaldo válido." }, { status: 400 });
  }
  const file = formData.get("backup");
  if (!(file instanceof File)) return Response.json({ error: "Selecciona un respaldo .fundosmart.json." }, { status: 400 });
  if (file.size <= 0 || file.size > MAX_BACKUP_BYTES) {
    return Response.json({ error: "El respaldo debe tener contenido y no superar 25 MB." }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    return Response.json({ error: "El archivo no es JSON UTF-8 válido." }, { status: 400 });
  }

  try {
    const backup = await validatePortableBackup(parsed);
    if (backup.manifest.scope.organizationId !== access.organizationId) {
      return Response.json({ error: "El respaldo pertenece a otra organización." }, { status: 403 });
    }
    const forbidden = requireContextField(access, backup.manifest.scope.fieldId);
    if (forbidden) return forbidden;

    const repositoryAccess = {
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      membershipId: access.membershipId,
      email: access.email,
    };
    const current = await buildFieldBackup({
      fieldId: backup.manifest.scope.fieldId,
      actor: access.email,
      ...repositoryAccess,
    });
    if (!current) return Response.json({ error: "El fundo de destino no existe." }, { status: 404 });
    const plan = buildPortableRestorePlan(backup, current.data);
    const uploadedSha256 = await sha256Hex(bytes);
    const audited = await recordRestorePreview({
      access: repositoryAccess,
      actor: access.email,
      scope: backup.manifest.scope,
      uploadedSha256,
      assessment: plan.assessment,
      totals: plan.totals,
    });
    if (!audited) {
      return Response.json({ error: "El alcance cambió durante el dry-run; vuelve a prepararlo." }, { status: 409 });
    }
    if (intent !== "preview") {
      if (!isRestorePlanConfirmable(plan)) {
        return Response.json({ error: "El dry-run debe estar listo, sin bloqueos y con filas insertables antes de preparar una confirmacion.", plan, uploadedSha256 }, { status: 409 });
      }
      const snapshotSha256 = await restoreSnapshotSha256(current.data);
      const planSha256 = await restorePlanSha256(plan);
      const binding = {
        actorEmail: access.email,
        organizationId: access.organizationId,
        fieldId: backup.manifest.scope.fieldId,
        backupSha256: uploadedSha256,
        snapshotSha256,
        planSha256,
      };
      const requiredPhrase = restorePreparationPhrase(backup.manifest.scope.fieldName);
      if (intent === "prepare_confirmation") {
        const confirmation = await issueRestoreConfirmation({ ...binding, ...repositoryAccess });
        return Response.json({
          plan,
          uploadedSha256,
          confirmation: { ...confirmation, requiredPhrase },
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const token = formText(formData, "token");
      const confirmationPhrase = formText(formData, "confirmationPhrase");
      if (!token || !matchesRestorePreparationPhrase(confirmationPhrase, backup.manifest.scope.fieldName)) {
        return Response.json({ error: `Escribe exactamente ${requiredPhrase} para preparar el ensayo.` }, { status: 400 });
      }
      const recovery = await prepareDurableRecoveryJob({
        ...binding,
        ...repositoryAccess,
        token,
        expectedRowCount: plan.totals.insertableRowCount,
        originalFiles: portableRestoreOriginalInventory(backup),
      });
      return Response.json({ plan, uploadedSha256, recovery }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ plan, uploadedSha256 }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof RestoreConfirmationScopeError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    if (cause instanceof PortableBackupValidationError) {
      return Response.json({ error: cause.message, code: cause.code, issues: cause.issues }, { status: 422 });
    }
    if (cause instanceof RecoveryPreparationError) {
      const status = cause.code === "PREPARATION_FAILED" ? 500 : 409;
      const error = status === 500 ? "No fue posible preparar el ensayo de recuperación." : cause.message;
      return Response.json({ error, code: cause.code }, { status });
    }
    return Response.json({ error: "No fue posible simular la restauración." }, { status: 500 });
  }
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}
