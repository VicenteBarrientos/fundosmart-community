import { reauthorizePageSnapshotAccess, requirePageAccess } from "@/app/access";
import { AccessManagementPage } from "@/src/modules/access/AccessManagementPage";
import { getAccessDashboard } from "@/src/modules/access/server/access-repository";
import { authorizeStaffCapability } from "@/app/staff-access";

export const dynamic = "force-dynamic";

export default async function AccessConfigurationRoute() {
  const access = await requirePageAccess("/app/configuracion/accesos", "manage_members");
  const dashboard = await getAccessDashboard(access);
  const currentAccess = await reauthorizePageSnapshotAccess(
    access,
    "/app/configuracion/accesos",
    {
      capability: "manage_members",
      fieldIds: access.fieldIds,
    },
  );
  const staffAccess = await authorizeStaffCapability("support:read");
  const isStaff = staffAccess?.resolution.granted === true;
  return (
    <AccessManagementPage
      initialDashboard={dashboard}
      userName={currentAccess.displayName}
      isStaff={isStaff}
    />
  );
}
