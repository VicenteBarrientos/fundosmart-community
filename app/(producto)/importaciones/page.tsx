import { reauthorizePageSnapshotAccess, requirePageAccess } from "@/app/access";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { ImportacionesPage } from "@/src/modules/importaciones/ImportacionesPage";
import {
  IMPORT_PROFILE_KEYS,
  type ImportProfileKey,
} from "@/src/modules/importaciones/domain/types";
import { getImportCenterDashboard } from "@/src/modules/importaciones/server/import-center-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";

export const dynamic = "force-dynamic";

export default async function ImportacionesRoute({
  searchParams,
}: {
  searchParams: Promise<{
    fieldId?: string | string[];
    profile?: string | string[];
  }>;
}) {
  const access = await requirePageAccess("/app/importaciones", "manage_imports");
  const params = await searchParams;
  const requestedFieldId = Array.isArray(params.fieldId) ? params.fieldId[0] : params.fieldId;
  const requestedProfile = Array.isArray(params.profile) ? params.profile[0] : params.profile;
  const initialProfileKey: ImportProfileKey = IMPORT_PROFILE_KEYS.includes(
    requestedProfile as ImportProfileKey,
  )
    ? requestedProfile as ImportProfileKey
    : "watts.visit_report.pdf.v1";
  const importAccess = {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
  const [allFundos, potreros, initialDashboard] = await Promise.all([
    listFundos(access),
    listPotreros(access),
    getImportCenterDashboard(importAccess),
  ]);
  const fundos = allFundos.filter((fundo) => access.fieldIds.includes(fundo.id));
  const initialFieldId = fundos.some((fundo) => fundo.id === requestedFieldId)
    ? requestedFieldId!
    : fundos[0]?.id ?? "";
  const currentAccess = await reauthorizePageSnapshotAccess(access, "/app/importaciones", {
    capability: "manage_imports",
    fieldIds: access.fieldIds,
  });

  return (
    <ImportacionesPage
      fundos={fundos}
      initialDashboard={initialDashboard}
      initialFieldId={initialFieldId}
      initialProfileKey={initialProfileKey}
      isDemo={currentAccess.email === DEMO_EMAIL}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      potreros={potreros}
      userName={currentAccess.displayName}
    />
  );
}
