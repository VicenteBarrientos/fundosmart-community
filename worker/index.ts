/** Cloudflare Worker entry point for FundoSmart. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runDueAnalyticsNotifications } from "../src/modules/analytics/server/analytics-notification-repository";
import { runAnalyticsRecomputeJob } from "../src/modules/analytics/server/analytics-repository";
import { executeBenchmarkAggregationJob } from "../src/modules/benchmarking/server/benchmarking-repository";
import { runDueLivestockNotifications } from "../src/modules/ganado/server/livestock-notification-repository";
import { runDueOriginalIntegritySweep } from "../src/modules/integraciones/cooprinsem/server/integrity-sweep-repository";
import { runDuePabcoNotifications } from "../src/modules/leche/server/pabco-notification-repository";
import { runDuePabcoEvidenceReconciliation } from "../src/modules/leche/server/pabco-evidence-repository";
import { runPastureNdviCollectionJob } from "../src/modules/praderas/server/ndvi-connector";
import { runDueScheduledJobs } from "../src/modules/sync/server/job-dispatcher";
import { runTraceabilityReconciliationJob } from "../src/modules/trazabilidad/server/traceability-repository";
import { processIncomingEmailMessage } from "../src/modules/importaciones/server/inbox-repository";
import { parseRawEmailMessage } from "../src/modules/importaciones/server/email-parser.mjs";
import type { ScheduledJobRecord } from "../src/modules/sync/domain/types";
import { productRoutePath } from "./product-routes.mjs";
import { rscNormalizationTarget } from "./rsc-redirect.mjs";
import { rejectCrossSiteMutation } from "./request-integrity.mjs";
import { enforceApiMutationSize } from "./request-size.mjs";
import {
  healthResponse,
  observeRequest,
  recordOperationObservation,
  safeErrorType,
} from "./observability.mjs";
import { withSecurityHeaders } from "./security-headers.mjs";

const LEGACY_PRODUCT_PREFIXES = [
  "/analitica",
  "/benchmarking",
  "/configuracion",
  "/costos",
  "/dashboard",
  "/espacios",
  "/ganado",
  "/importaciones",
  "/integraciones",
  "/leche",
  "/potreros",
  "/praderas",
  "/sin-acceso",
  "/trazabilidad",
];

function matchesProductPrefix(pathname: string): boolean {
  return LEGACY_PRODUCT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function supportedImageFormat(format: string) {
  switch (format) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
    case "image/avif":
    case "rgb":
    case "rgba":
      return format;
    default:
      return "image/jpeg";
  }
}

// SVG sources with .svg extension skip the optimizer and are served directly.
async function handleRequest(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return healthResponse(env);
  }

  if (matchesProductPrefix(url.pathname)) {
    const productPath = url.pathname === "/dashboard" ? "/app" : `/app${url.pathname}`;
    return Response.redirect(new URL(`${productPath}${url.search}`, url), 308);
  }

  const productRoute = productRoutePath(url.pathname);
  if (productRoute !== null) {
    url.pathname = productRoute;
    request = new Request(url, request);
  }

  if (url.pathname === "/_vinext/image") {
    const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
    return handleImageOptimization(request, {
      fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
      transformImage: async (body, { width, format, quality }) => {
        const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({
          format: supportedImageFormat(format),
          quality,
        });
        return result.response();
      },
    }, allowedWidths);
  }

  const response = await handler.fetch(request, env, ctx);
  const normalized = rscNormalizationTarget(request, response);
  // Un solo reintento: si la respuesta normalizada volviera a redirigir, esa sí
  // viaja al navegador en vez de encadenar saltos dentro del Worker.
  if (!normalized) return response;
  return handler.fetch(new Request(normalized, request), env, ctx);
}

export async function runObservedScheduledOperation(
  env: Cloudflare.Env,
  route: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const startedAt = performance.now();
  try {
    await operation();
    recordOperationObservation({
      env,
      route,
      method: "SCHEDULED",
      status: 200,
      outcome: "success",
      durationMs: performance.now() - startedAt,
    });
  } catch (cause) {
    console.error(JSON.stringify({
      event: "operation.failed",
      environment: env.FUNDOSMART_DEPLOY_ENVIRONMENT ?? "local",
      release: env.FUNDOSMART_RELEASE_SHA?.slice(0, 12) ?? "unknown",
      route,
      method: "SCHEDULED",
      errorType: safeErrorType(cause),
    }));
    recordOperationObservation({
      env,
      route,
      method: "SCHEDULED",
      status: 500,
      outcome: "failure",
      durationMs: performance.now() - startedAt,
    });
    throw cause;
  }
}

async function executeDispatchedJob(job: ScheduledJobRecord, env: Cloudflare.Env): Promise<void> {
  if (job.type === "system.probe") return;
  if (job.type === "analytics.recompute.v1") {
    await runAnalyticsRecomputeJob(job.payload);
    return;
  }
  if (job.type === "benchmark.aggregate.v1") {
    await executeBenchmarkAggregationJob({ id: job.id, type: job.type, payload: job.payload });
    return;
  }
  if (job.type === "traceability.reconcile.v1") {
    await runTraceabilityReconciliationJob(job);
    return;
  }
  if (job.type === "pasture.ndvi.collect.v1") {
    await runPastureNdviCollectionJob(job, {
      clientId: env.CDSE_CLIENT_ID,
      clientSecret: env.CDSE_CLIENT_SECRET,
    });
    return;
  }
  throw new Error("SCHEDULED_JOB_HANDLER_MISSING");
}

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    return observeRequest(request, env, async () => {
      let guardedRequest = request;
      let rejection = rejectCrossSiteMutation(request);
      if (rejection === null) {
        const sizeResult = await enforceApiMutationSize(request);
        guardedRequest = sizeResult.request;
        rejection = sizeResult.rejection;
      }

      const response = rejection ?? await handleRequest(guardedRequest, env, ctx);
      return withSecurityHeaders(response, request.url);
    });
  },
  scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runObservedScheduledOperation(
      env,
      "job.dispatcher",
      async () => {
        const result = await runDueScheduledJobs({
          execute: (job) => runObservedScheduledOperation(
            env,
            `job.dispatcher.${job.type.replace(/[^a-zA-Z0-9._/-]/g, "_").slice(0, 48)}`,
            () => executeDispatchedJob(job, env),
          ),
        });
        if (result.failures > 0) throw new Error("One or more dispatched jobs failed");
      },
    ));
    ctx.waitUntil(runObservedScheduledOperation(
      env,
      "job.integrity-sweep",
      () => runDueOriginalIntegritySweep({ trigger: "scheduled" }),
    ));
    if (env.EMAIL) {
      const notificationOptions = {
        appBaseUrl: env.FUNDOSMART_APP_BASE_URL,
        emailFrom: env.FUNDOSMART_EMAIL_FROM,
      };
      ctx.waitUntil(runObservedScheduledOperation(
        env,
        "job.livestock-notifications",
        async () => {
          const result = await runDueLivestockNotifications(env.EMAIL!, notificationOptions);
          if (result.failures > 0) {
            throw new Error("One or more livestock notification deliveries failed");
          }
        },
      ));
      ctx.waitUntil(runObservedScheduledOperation(
        env,
        "job.analytics-notifications",
        async () => {
          const result = await runDueAnalyticsNotifications(env.EMAIL!, notificationOptions);
          if (result.failures > 0) {
            throw new Error("One or more analytics notification deliveries failed");
          }
        },
      ));
      ctx.waitUntil(runObservedScheduledOperation(
        env,
        "job.pabco-notifications",
        async () => {
          const result = await runDuePabcoNotifications(env.EMAIL!, notificationOptions);
          if (result.failures > 0) {
            throw new Error("One or more PABCO notification deliveries failed");
          }
        },
      ));
    }
    ctx.waitUntil(runObservedScheduledOperation(
      env,
      "job.pabco-evidence-reconciliation",
      async () => {
        const result = await runDuePabcoEvidenceReconciliation();
        if (result.failures > 0) {
          throw new Error("One or more PABCO evidence reconciliations failed");
        }
      },
    ));
  },
  async email(message: ForwardableEmailMessage, env: Cloudflare.Env, ctx: ExecutionContext): Promise<void> {
    try {
      const rawText = await new Response(message.raw).text();
      const parsed = parseRawEmailMessage(rawText);

      await processIncomingEmailMessage({
        recipientAddress: message.to || parsed.to,
        senderEmail: message.from || parsed.from,
        subject: message.headers.get("Subject") || parsed.subject || undefined,
        messageId: message.headers.get("Message-ID") || parsed.messageId || undefined,
        attachments: parsed.attachments,
      });
    } catch (error) {
      console.error("Failed to process incoming email message:", error);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export default worker;
