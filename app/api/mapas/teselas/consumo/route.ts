import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import {
  isSameOriginFeedbackMutation,
  privateFeedbackJson,
  readBoundedJsonObject,
} from "@/src/modules/feedback/server/feedback-http";
import { isValidTileUsageReport } from "@/src/core/maps/tile-policy.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

const MAXIMUM_REPORT_BYTES = 512;
const KNOWN_ENVIRONMENTS = new Set(["production", "staging", "local"]);

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginFeedbackMutation(request)) {
    return privateFeedbackJson({
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }

  const payload = await readBoundedJsonObject(request, MAXIMUM_REPORT_BYTES);
  if (payload instanceof Response) return payload;
  if (!isValidTileUsageReport(payload)) {
    return privateFeedbackJson({
      error: "El agregado de teselas no cumple el contrato.",
      code: "MAP_TILE_USAGE_INVALID",
    }, 400);
  }
  const report = payload as {
    basemapId: string;
    surface: string;
    tileCount: number;
    degraded: boolean;
    sessionSeq: number;
  };

  const access = await authorizeApiAccess("view");
  if (isAccessResponse(access)) return privateResponse(access);
  if (access.email === DEMO_EMAIL) {
    return privateFeedbackJson({
      error: "La cuenta demo no registra consumo de mapas base.",
      code: "MAP_TILE_USAGE_DEMO_DISABLED",
    }, 403);
  }
  void access;

  try {
    env.MAP_USAGE?.writeDataPoint({
      indexes: [environmentLabel()],
      blobs: [
        "map.tile_usage",
        report.basemapId,
        report.surface,
        report.degraded ? "degraded" : "served",
        releaseLabel(),
      ],
      doubles: [report.tileCount, report.sessionSeq],
    });
  } catch {
    console.warn(JSON.stringify({ event: "map.tile_usage_write_failed" }));
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function environmentLabel(): string {
  const value = String(env.FUNDOSMART_DEPLOY_ENVIRONMENT ?? "local").toLowerCase();
  return KNOWN_ENVIRONMENTS.has(value) ? value : "unknown";
}

function releaseLabel(): string {
  const value = String(env.FUNDOSMART_RELEASE_SHA ?? "").toLowerCase();
  return /^[a-f0-9]{7,64}$/u.test(value) ? value.slice(0, 12) : "unknown";
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}
