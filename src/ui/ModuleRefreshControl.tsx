"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

type ModuleRefreshControlProps = {
  generatedAt?: string;
  label: string;
  moduleKey: string;
  onRefresh?: () => Promise<void> | void;
};

const MODULE_MUTATION_PREFIXES: Record<string, readonly string[]> = {
  analitica: ["/api/analitica"],
  benchmarking: ["/api/benchmarking"],
  costos: ["/api/ganado/plata"],
  ganado: ["/api/ganado"],
  integraciones: ["/api/importaciones", "/api/integraciones"],
  leche: ["/api/leche"],
  potreros: ["/api/actividades", "/api/fundos", "/api/offline", "/api/potreros", "/api/subdivisiones", "/api/sync"],
  praderas: ["/api/praderas", "/api/potreros/ndvi"],
  settings: ["/api/configuracion", "/api/cuenta", "/api/staff"],
  summary: ["/api/agenda"],
  trazabilidad: ["/api/trazabilidad"],
};

export function ModuleRefreshControl({ generatedAt, label, moduleKey, onRefresh }: ModuleRefreshControlProps) {
  const router = useRouter();
  const [manualPending, setManualPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [routePending, startRouteRefresh] = useTransition();
  const [updatedAt, setUpdatedAt] = useState(() => generatedAt ?? new Date().toISOString());
  const visibleUpdatedAt = generatedAt && generatedAt > updatedAt ? generatedAt : updatedAt;
  const pending = manualPending || routePending;

  useEffect(() => {
    const originalFetch = window.fetch;
    const observedFetch: typeof window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.ok && isModuleMutation(moduleKey, args[0], args[1])) {
        setFailed(false);
        setUpdatedAt(new Date().toISOString());
      }
      return response;
    };
    window.fetch = observedFetch;
    return () => {
      if (window.fetch === observedFetch) window.fetch = originalFetch;
    };
  }, [moduleKey]);

  async function refresh() {
    if (pending) return;
    setFailed(false);
    if (!onRefresh) {
      startRouteRefresh(() => {
        router.refresh();
        setUpdatedAt(new Date().toISOString());
      });
      return;
    }

    setManualPending(true);
    try {
      await onRefresh();
      setUpdatedAt(new Date().toISOString());
    } catch {
      setFailed(true);
    } finally {
      setManualPending(false);
    }
  }

  return (
    <div className={`flex h-9 items-center overflow-hidden rounded-lg border bg-white/[0.06] text-white shadow-sm ${failed ? "border-hivis" : "border-white/15"}`}>
      {visibleUpdatedAt && (
        <time
          className="hidden whitespace-nowrap pl-2.5 pr-1 text-[10px] font-bold text-white/60 xl:inline"
          dateTime={visibleUpdatedAt}
          suppressHydrationWarning
        >
          Actualizado {formatModuleUpdatedAt(visibleUpdatedAt)}
        </time>
      )}
      <button
        aria-label={`Actualizar ${label}`}
        className="inline-flex h-full items-center justify-center gap-1.5 px-2.5 text-[11px] font-black transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        onClick={() => { void refresh(); }}
        title={failed ? `No fue posible actualizar ${label}` : `Actualizar ${label}`}
        type="button"
      >
        <RefreshCw className={pending ? "animate-spin" : ""} size={14} />
        <span className="hidden sm:inline">{pending ? "Actualizando..." : "Actualizar"}</span>
      </button>
    </div>
  );
}

function isModuleMutation(moduleKey: string, input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return false;
  const prefixes = MODULE_MUTATION_PREFIXES[moduleKey] ?? [];
  if (prefixes.length === 0) return false;
  const requestUrl = input instanceof Request ? input.url : input.toString();
  const url = new URL(requestUrl, window.location.href);
  if (url.origin !== window.location.origin) return false;
  return prefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

export function formatModuleUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "America/Santiago",
  }).format(new Date(value));
}
