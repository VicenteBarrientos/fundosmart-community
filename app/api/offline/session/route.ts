import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import { env } from "cloudflare:workers";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { issueOfflineSession } from "@/src/modules/offline/server/offline-session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const access = await authorizeApiAccess("operate");
  if (isAccessResponse(access)) return access;
  const secret = env.OFFLINE_SESSION_SECRET?.trim();
  if (!secret) return privateJson({ error: "La sesión offline no está configurada." }, 503);
  try {
    const session = await issueOfflineSession({
      actor: access,
      accountMode: access.email === DEMO_EMAIL ? "demo" : "personal",
      secret,
    });
    return privateJson({ session });
  } catch {
    return privateJson({ error: "No fue posible preparar la sesión offline." }, 503);
  }
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
