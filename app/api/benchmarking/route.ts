import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { roleHasCapability } from "@/src/modules/access/domain/access-rules.mjs";
import type { AccessContext } from "@/src/modules/access/domain/types";
import { BenchmarkPrivacyError } from "@/src/modules/benchmarking/domain/benchmarking-rules.mjs";
import {
  BenchmarkRepositoryError,
  enqueueBenchmarkAggregation,
  getBenchmarkDashboard,
  saveBenchmarkProfile,
  setBenchmarkConsent,
} from "@/src/modules/benchmarking/server/benchmarking-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const fieldId = params.get("fieldId")?.trim() ?? "";
  const period = params.get("period")?.trim() ?? "";
  if (!fieldId || !period) return privateJson({ error: "Selecciona un fundo y período." }, 400);
  const access = await authorizeApiAccess("benchmarking:read", fieldId);
  if (isAccessResponse(access)) return access;
  try {
    const dashboard = await getBenchmarkDashboard({ actor: access, fieldId, period });
    const currentAccess = await reauthorizeApiAccess(access, "benchmarking:read", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ dashboard });
  } catch (cause) {
    return benchmarkError(cause, "benchmark.dashboard.read", "No fue posible cargar el benchmarking.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const payload = await readJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;
  const headerIdempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const bodyIdempotencyKey = text(payload.idempotencyKey);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(headerIdempotencyKey)) {
    return privateJson({
      error: "Envía una clave Idempotency-Key válida para esta operación.",
      code: "BENCHMARK_IDEMPOTENCY_KEY_INVALID",
    }, 400);
  }
  if (bodyIdempotencyKey && bodyIdempotencyKey !== headerIdempotencyKey) {
    return privateJson({
      error: "La clave de idempotencia del cuerpo no coincide con Idempotency-Key.",
      code: "BENCHMARK_IDEMPOTENCY_KEY_INVALID",
    }, 400);
  }
  const action = text(payload.action);
  const fieldId = text(payload.fieldId);
  const period = text(payload.period);
  if (!fieldId || !period) return privateJson({ error: "Selecciona un fundo y período." }, 400);
  const administrativeAccess = await authorizeApiAccess("manage_members", fieldId);
  if (isAccessResponse(administrativeAccess)) return administrativeAccess;
  const access = await authorizeApiAccess("benchmarking:write", fieldId);
  if (isAccessResponse(access)) return access;
  try {
    if (action === "set_consent") {
      await setBenchmarkConsent({
        actor: access,
        fieldId,
        idempotencyKey: headerIdempotencyKey,
        status: payload.status,
        termsRevision: payload.termsRevision,
        confirmed: payload.confirmed,
      });
      const dashboard = await getBenchmarkDashboard({ actor: access, fieldId, period });
      const forbidden = await reauthorizeBenchmarkWrite(access, fieldId);
      if (forbidden) return forbidden;
      return privateJson({ dashboard });
    }
    if (action === "save_profile") {
      await saveBenchmarkProfile({
        actor: access,
        fieldId,
        period,
        idempotencyKey: headerIdempotencyKey,
        profile: payload.profile,
      });
      const dashboard = await getBenchmarkDashboard({ actor: access, fieldId, period });
      const forbidden = await reauthorizeBenchmarkWrite(access, fieldId);
      if (forbidden) return forbidden;
      return privateJson({ dashboard });
    }
    if (action === "enqueue_recompute") {
      const job = await enqueueBenchmarkAggregation({
        actor: access,
        fieldId,
        period,
        idempotencyKey: headerIdempotencyKey,
        kThreshold: payload.kThreshold,
      });
      const forbidden = await reauthorizeBenchmarkWrite(access, fieldId);
      if (forbidden) return forbidden;
      return privateJson({ job }, 202);
    }
    return privateJson({ error: "La operación de benchmarking no está soportada." }, 400);
  } catch (cause) {
    return benchmarkError(cause, `benchmark.${action || "unknown"}`, "No fue posible actualizar el benchmarking.");
  }
}

async function reauthorizeBenchmarkWrite(
  access: AccessContext,
  fieldId: string,
): Promise<Response | null> {
  const currentAccess = await reauthorizeApiAccess(access, "benchmarking:write", fieldId);
  if (isAccessResponse(currentAccess)) return currentAccess;
  if (!roleHasCapability(currentAccess.role, "manage_members")) {
    return privateJson({ error: "Tu rol no permite administrar benchmarking.", code: "CAPABILITY_REQUIRED" }, 403);
  }
  return null;
}

function benchmarkError(cause: unknown, operation: string, fallback: string): Response {
  if (cause instanceof BenchmarkPrivacyError) return privateJson({ error: cause.message, code: cause.code }, 422);
  if (cause instanceof BenchmarkRepositoryError) {
    const status = cause.code === "BENCHMARK_SCOPE_INVALID" ? 404
      : cause.code === "BENCHMARK_IDEMPOTENCY_KEY_INVALID" ? 400
        : new Set([
          "BENCHMARK_IDEMPOTENCY_CONFLICT",
          "BENCHMARK_PROFILE_FROZEN",
          "BENCHMARK_PERIOD_CLOSED",
          "BENCHMARK_RECOMPUTE_COOLDOWN",
        ]).has(cause.code) || cause.code.endsWith("_CONFLICT") ? 409
          : 403;
    return privateJson({ error: cause.message, code: cause.code }, status);
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
