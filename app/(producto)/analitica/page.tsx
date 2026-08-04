import { reauthorizePageAccess, requirePageAccess } from "@/app/access";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { isFeatureEnabled } from "@/src/modules/access/server/feature-flag-repository";
import { normalizeAnalyticsWindow } from "@/src/modules/analytics/domain/analytics-projection.mjs";
import { AnalyticsPage } from "@/src/modules/analytics/server/AnalyticsPage";
import { getAnalyticsDashboard, getOwnHistoryComparison } from "@/src/modules/analytics/server/analytics-repository";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";

export const dynamic = "force-dynamic";

export default async function AnalyticsRoute({
  searchParams,
}: {
  searchParams: Promise<{ fieldId?: string | string[]; period?: string | string[] }>;
}) {
  const baseAccess = await requirePageAccess("/app/analitica");
  const params = await searchParams;
  const requestedFieldId = first(params.fieldId);
  const period = validPeriod(first(params.period)) ?? currentChilePeriod();
  const fundos = await listFundos(baseAccess);
  const enabled = await Promise.all(fundos.map(async (fundo) => ({
    id: fundo.id,
    name: fundo.name,
    enabled: await isFeatureEnabled(baseAccess, "analitica", fundo.id),
  })));
  const fields = enabled.filter((field) => field.enabled).map(({ id, name }) => ({ id, name }));
  const fieldId = fields.some((field) => field.id === requestedFieldId) ? requestedFieldId! : fields[0]?.id ?? null;
  if (!fieldId) {
    const currentAccess = await reauthorizePageAccess(baseAccess, "/app/analitica");
    return (
      <AnalyticsPage
        canConfigureThresholds={false}
        canRecompute={false}
        fields={[]}
        initialAnalytics={null}
        initialFieldId=""
        ownHistory={null}
        initialPeriod={period}
        isDemo={currentAccess.email === DEMO_EMAIL}
        organizationId={currentAccess.organizationId}
        organizationName={currentAccess.organizationName}
        userName={currentAccess.displayName}
      />
    );
  }

  const returnTo = `/app/analitica?fieldId=${encodeURIComponent(fieldId)}&period=${encodeURIComponent(period)}`;
  const access = await requirePageAccess(
    returnTo,
    "analitica:read",
    fieldId,
  );
  const analytics = await getAnalyticsDashboard({ actor: access, fieldId, period });
  // A new read must not be able to take the dashboard down with it: if the own-history
  // comparison fails, the page still renders and the section explains itself.
  const ownHistory = await getOwnHistoryComparison({ actor: access, fieldId, targetPeriod: period })
    .catch(() => ({ comparison: null, periodsRead: 0, reason: "no_projected_periods" as const }));
  const currentAccess = await reauthorizePageAccess(access, returnTo, "analitica:read", fieldId);
  const currentFields = fields.filter((field) => currentAccess.fieldIds.includes(field.id));
  const isDemo = currentAccess.email === DEMO_EMAIL || analytics.field.isDemo;
  return (
    <AnalyticsPage
      canConfigureThresholds={!isDemo && roleHasCapability(currentAccess.role, "manage_imports")}
      canRecompute={!isDemo && roleHasCapability(currentAccess.role, "manage_imports")}
      fields={currentFields}
      initialAnalytics={analytics}
      initialFieldId={fieldId}
      ownHistory={ownHistory}
      initialPeriod={period}
      isDemo={isDemo}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      userName={currentAccess.displayName}
    />
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validPeriod(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeAnalyticsWindow(value).period;
  } catch {
    return null;
  }
}

function currentChilePeriod(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : new Date().toISOString().slice(0, 7);
}
