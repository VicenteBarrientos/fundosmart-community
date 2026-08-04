import { requirePageAccess, reauthorizePageAccess } from "@/app/access";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { isFeatureEnabled } from "@/src/modules/access/server/feature-flag-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { getTraceabilityDashboard } from "@/src/modules/trazabilidad/server/traceability-repository";
import { redirect } from "next/navigation";
import { TraceabilityClient } from "./TraceabilityClient";

export const dynamic = "force-dynamic";

export default async function TraceabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ fieldId?: string | string[] }>;
}) {
  const baseAccess = await requirePageAccess("/app/trazabilidad");
  const fundos = await listFundos(baseAccess);
  const enabledFundos = [];
  for (const fundo of fundos) {
    if (await isFeatureEnabled(baseAccess, "trazabilidad", fundo.id)) enabledFundos.push(fundo);
  }
  const requested = (await searchParams).fieldId;
  const requestedId = typeof requested === "string" ? requested : "";
  const selected = enabledFundos.find((fundo) => fundo.id === requestedId) ?? enabledFundos[0] ?? fundos[0];
  if (!selected) await requirePageAccess("/app/trazabilidad", "trazabilidad:read", "missing-field");
  const returnTo = `/app/trazabilidad?fieldId=${encodeURIComponent(selected.id)}`;
  const access = await requirePageAccess(returnTo, "trazabilidad:read", selected.id);
  const dashboard = await getTraceabilityDashboard(access, selected.id);
  const currentAccess = await reauthorizePageAccess(
    access,
    returnTo,
    "trazabilidad:read",
    dashboard.field.id,
  );
  const currentFieldIds = new Set(currentAccess.fieldIds);
  if (enabledFundos.some((fundo) => !currentFieldIds.has(fundo.id))) {
    redirect("/app/sin-acceso?code=ACCESS_SCOPE_CHANGED");
  }
  return (
    <TraceabilityClient
      fields={enabledFundos.map((fundo) => ({ id: fundo.id, name: fundo.name }))}
      initialDashboard={dashboard}
      isDemo={currentAccess.email === DEMO_EMAIL}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      userName={currentAccess.displayName}
    />
  );
}
