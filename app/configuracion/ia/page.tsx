import { reauthorizePageAccess, requirePageAccess } from "@/app/access";
import { ConfiguracionIAPage } from "@/src/modules/asistente/ui/ConfiguracionIAPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await requirePageAccess("/app/configuracion/ia");
  await reauthorizePageAccess(access, "/app/configuracion/ia");

  return <ConfiguracionIAPage />;
}
