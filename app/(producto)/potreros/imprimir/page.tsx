import { reauthorizePageAccess, requirePageAccess } from "@/app/access";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrintPaddockSheet } from "./PrintPaddockSheet";
import styles from "./print.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: "Imprimir potreros · FundoSmart",
  robots: { index: false, follow: false },
};

type PrintPageProps = {
  searchParams: Promise<{
    fundoId?: string | string[];
  }>;
};

export default async function PrintPaddocksPage({ searchParams }: PrintPageProps) {
  const params = await searchParams;
  const rawFundoId = Array.isArray(params.fundoId) ? params.fundoId[0] : params.fundoId;
  const fundoId = rawFundoId?.trim() ?? "";
  const returnTo = fundoId
    ? `/app/potreros/imprimir?fundoId=${encodeURIComponent(fundoId)}`
    : "/app/potreros/imprimir";
  const access = await requirePageAccess(returnTo, "view", fundoId || undefined);

  if (!fundoId) {
    return (
      <main className={styles.missingSelection}>
        <div>
          <h1>Selecciona un fundo antes de imprimir</h1>
          <p>Abre la administración de un fundo y elige “Imprimir”.</p>
          <a href="/app/potreros">Volver a potreros</a>
        </div>
      </main>
    );
  }

  const [fundos, paddocks] = await Promise.all([
    listFundos(access),
    listPotreros(access, fundoId),
  ]);
  const fundo = fundos.find(({ id }) => id === fundoId);
  if (!fundo) notFound();
  const generatedLabel = new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(new Date());
  await reauthorizePageAccess(access, returnTo, "view", fundoId);

  return (
    <PrintPaddockSheet
      fundo={fundo}
      generatedLabel={generatedLabel}
      paddocks={paddocks}
    />
  );
}
