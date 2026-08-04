import { reauthorizePageSnapshotAccess, requirePageAccess } from "@/app/access";
import { getOrganizationPlanUsage } from "@/src/modules/access/server/organization-plan-repository";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { PotrerosPage } from "@/src/modules/potreros/PotrerosPage";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";

export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await requirePageAccess("/app/potreros");
  const offlineScope = [access.membershipId, access.role, ...[...access.fieldIds].sort()].join(".");
  /* El fundo activo gobierna todo lo que viene después —carga, rotación, celdas,
     NDVI e hitos—, y salía de un fetch que recién arrancaba al hidratar: esa
     cadena entera esperaba un viaje que la página ya podía resolver. Los
     potreros y las actividades siguen llegando por la cola offline, que además
     reconcilia lo que quedó pendiente en el dispositivo. */
  const [fundos, plan] = await Promise.all([
    listFundos(access),
    getOrganizationPlanUsage(access.organizationId),
  ]);
  const currentAccess = await reauthorizePageSnapshotAccess(access, "/app/potreros", {
    fieldIds: access.fieldIds,
  });
  return (
    <PotrerosPage
      initialFundos={fundos}
      initialPlan={plan}
      isDemo={currentAccess.email === DEMO_EMAIL}
      offlineScope={offlineScope}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      userName={currentAccess.displayName}
    />
  );
}
