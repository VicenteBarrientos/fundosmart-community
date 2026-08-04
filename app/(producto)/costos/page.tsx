import { CostosPage } from "@/src/modules/costos/CostosPage";
import { requirePageAccess, reauthorizePageSnapshotAccess } from "@/app/access";
import { roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { listLivestockFinance } from "@/src/modules/ganado/server/livestock-finance-repository";
import { listActivities } from "@/src/modules/potreros/server/activity-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";

export const dynamic = "force-dynamic";

export default async function CostsRoute() {
  const access = await requirePageAccess("/app/costos", "manage_finance");
  const canViewOrganizationFinance = roleHasGlobalFieldAccess(access.role);
  const [fundos, potreros, activities, livestockFinance] = await Promise.all([
    listFundos(access),
    listPotreros(access),
    listActivities(access),
    listLivestockFinance({
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      allowOrganizationWide: canViewOrganizationFinance,
    }),
  ]);
  const allowedFields = new Set(access.fieldIds);
  const visibleFundos = fundos.filter((fundo) => allowedFields.has(fundo.id));
  const visiblePotreros = potreros.filter((potrero) => allowedFields.has(potrero.fieldId));
  const visiblePaddockIds = new Set(visiblePotreros.map((potrero) => potrero.id));
  const visibleActivities = activities.filter((activity) => visiblePaddockIds.has(activity.potreroId));
  await reauthorizePageSnapshotAccess(access, "/app/costos", {
    capability: "manage_finance",
    fieldIds: access.fieldIds,
  });
  return <CostosPage activities={visibleActivities} fundos={visibleFundos} isDemo={access.email === DEMO_EMAIL} livestockExpenses={livestockFinance.expenses} organizationId={access.organizationId} organizationName={access.organizationName} potreros={visiblePotreros} userName={access.displayName} />;
}
