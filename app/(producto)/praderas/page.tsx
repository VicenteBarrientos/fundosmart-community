import { reauthorizePageAccess, requirePageAccess } from "@/app/access";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { isFeatureEnabled } from "@/src/modules/access/server/feature-flag-repository";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { PraderasPage } from "@/src/modules/praderas/PraderasPage";

export default async function Page() {
  const access = await requirePageAccess("/app/praderas");
  const enabled = await Promise.all(access.fieldIds.map(async (fieldId) => ({
    fieldId,
    enabled: await isFeatureEnabled(access, "pastoreo", fieldId),
  })));
  const allowedFieldIds = enabled.filter((entry) => entry.enabled).map((entry) => entry.fieldId);
  const currentAccesses = await Promise.all(allowedFieldIds.map((fieldId) => reauthorizePageAccess(
    access,
    "/app/praderas",
    "pastoreo:read",
    fieldId,
  )));
  const currentAccess = currentAccesses[0] ?? await reauthorizePageAccess(access, "/app/praderas");
  return (
    <PraderasPage
      allowedFieldIds={allowedFieldIds}
      canWrite={roleHasCapability(currentAccess.role, "pastoreo:write") && currentAccess.email !== DEMO_EMAIL}
      isDemo={currentAccess.email === DEMO_EMAIL}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      userName={currentAccess.displayName}
    />
  );
}
