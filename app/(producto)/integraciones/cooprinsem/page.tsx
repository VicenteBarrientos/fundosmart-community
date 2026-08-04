import { reauthorizePageSnapshotAccess, requirePageAccess } from "@/app/access";
import { CooprinsemImportPage } from "@/src/modules/integraciones/cooprinsem/CooprinsemImportPage";
import { getImportDashboard } from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";

export const dynamic = "force-dynamic";

export default async function CooprinsemIntegrationRoute({
  searchParams,
}: {
  searchParams: Promise<{ fieldId?: string | string[] }>;
}) {
  const access = await requirePageAccess("/app/integraciones/cooprinsem", "manage_imports");
  const params = await searchParams;
  const requestedFieldId = Array.isArray(params.fieldId) ? params.fieldId[0] : params.fieldId;
  const importAccess = {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
  const [fundos, initialDashboard] = await Promise.all([
    listFundos(access),
    getImportDashboard(importAccess),
  ]);
  const scopedFundos = fundos.filter((fundo) => access.fieldIds.includes(fundo.id));
  const initialFieldId = scopedFundos.some((fundo) => fundo.id === requestedFieldId)
    ? requestedFieldId!
    : scopedFundos[0]?.id ?? "";
  const currentAccess = await reauthorizePageSnapshotAccess(
    access,
    "/app/integraciones/cooprinsem",
    {
      capability: "manage_imports",
      fieldIds: access.fieldIds,
    },
  );

  return (
    <CooprinsemImportPage
      fundos={scopedFundos}
      initialFieldId={initialFieldId}
      initialDashboard={initialDashboard}
      isDemo={currentAccess.email === DEMO_EMAIL}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      userName={currentAccess.displayName}
      canRestore={roleHasCapability(currentAccess.role, "restore_data")}
    />
  );
}
