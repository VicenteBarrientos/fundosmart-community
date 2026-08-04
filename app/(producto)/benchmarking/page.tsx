import { reauthorizePageAccess, requirePageAccess } from "@/app/access";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import { isFeatureEnabled } from "@/src/modules/access/server/feature-flag-repository";
import { BenchmarkingPage } from "@/src/modules/benchmarking/BenchmarkingPage";
import { getBenchmarkDashboard } from "@/src/modules/benchmarking/server/benchmarking-repository";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";

export const dynamic = "force-dynamic";

export default async function BenchmarkingRoute({
  searchParams,
}: {
  searchParams: Promise<{ fieldId?: string; period?: string }>;
}) {
  const params = await searchParams;
  const baseAccess = await requirePageAccess("/app/benchmarking");
  const scopedFundos = (await listFundos(baseAccess))
    .filter((fundo) => baseAccess.fieldIds.includes(fundo.id));
  const enabled = await Promise.all(scopedFundos.map(async (fundo) => ({
    fundo,
    enabled: await isFeatureEnabled(baseAccess, "benchmarking", fundo.id),
  })));
  const fundos = enabled.filter((entry) => entry.enabled).map(({ fundo }) => ({ id: fundo.id, name: fundo.name }));
  const fieldId = fundos.some((fundo) => fundo.id === params.fieldId)
    ? params.fieldId!
    : fundos[0]?.id ?? "";
  const period = validPeriod(params.period) ? params.period! : chileMonth();
  if (!fieldId) {
    const currentAccess = await reauthorizePageAccess(baseAccess, "/app/benchmarking");
    return (
      <BenchmarkingPage
        canManage={false}
        fundos={[]}
        initialDashboard={null}
        isDemo={currentAccess.email === DEMO_EMAIL}
        organizationId={currentAccess.organizationId}
        organizationName={currentAccess.organizationName}
        period={period}
        selectedFieldId=""
        userName={currentAccess.displayName}
      />
    );
  }
  const returnTo = `/app/benchmarking?fieldId=${encodeURIComponent(fieldId)}&period=${encodeURIComponent(period)}`;
  const access = await requirePageAccess(
    returnTo,
    "benchmarking:read",
    fieldId,
  );
  const dashboard = await getBenchmarkDashboard({ actor: access, fieldId, period });
  const currentAccess = await reauthorizePageAccess(access, returnTo, "benchmarking:read", fieldId);
  const currentFundos = fundos.filter((fundo) => currentAccess.fieldIds.includes(fundo.id));
  return (
    <BenchmarkingPage
      canManage={currentAccess.email !== DEMO_EMAIL && roleHasCapability(currentAccess.role, "benchmarking:write")}
      fundos={currentFundos}
      initialDashboard={dashboard}
      isDemo={currentAccess.email === DEMO_EMAIL}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      period={period}
      selectedFieldId={fieldId}
      userName={currentAccess.displayName}
    />
  );
}

function chileMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);
}

function validPeriod(value: string | undefined): value is string {
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(value ?? "");
}
