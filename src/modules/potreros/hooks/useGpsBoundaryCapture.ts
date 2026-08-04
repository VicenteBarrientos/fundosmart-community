"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Coordinate } from "../types";
import type {
  GpsBoundaryContext,
  GpsBoundaryFinalization,
  GpsFixDecision,
  GpsLocationFix,
  GpsPositionSample,
} from "../utils/gps-capture";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { finalizeGpsBoundary, processGpsSample } from "../utils/gps-capture.ts";

export type GpsTrackingMode = "location" | "boundary";
export type GpsCaptureStatus = "idle" | "starting" | "tracking" | "complete" | "error";
export type GpsAvailability = "checking" | "available" | "unsupported" | "insecure_context";
export type GpsPermissionState = "unknown" | "prompt" | "granted" | "denied";
export type GpsWakeLockStatus = "inactive" | "requesting" | "active" | "unsupported" | "unavailable";

export type GpsCaptureErrorCode =
  | "unsupported"
  | "insecure_context"
  | "permission_denied"
  | "position_unavailable"
  | "timeout"
  | "invalid_position"
  | "watch_failed";

export type GpsCaptureError = {
  code: GpsCaptureErrorCode;
  message: string;
  recoverable: boolean;
};

export type GpsRuntimePositionError = {
  code: number;
};

export type GpsWakeLockLease = {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
};

export type GpsCaptureRuntimeDependencies = {
  watchPosition(
    onPosition: (sample: GpsPositionSample) => void,
    onError: (error: GpsRuntimePositionError) => void,
  ): number;
  clearWatch(watchId: number): void;
  requestWakeLock?: () => Promise<GpsWakeLockLease>;
};

export type GpsCaptureRuntimeCallbacks = {
  onPosition(sample: GpsPositionSample): void;
  onError(error: GpsRuntimePositionError): void;
  onWakeLockStatus(status: GpsWakeLockStatus): void;
};

export type GpsCaptureRuntime = {
  start(callbacks: GpsCaptureRuntimeCallbacks): boolean;
  stop(): void;
  refreshWakeLock(): void;
  dispose(): void;
};

type WakeLockRecord = {
  generation: number;
  lease: GpsWakeLockLease;
  onRelease: () => void;
};

export function createGpsCaptureRuntime(
  dependencies: GpsCaptureRuntimeDependencies,
): GpsCaptureRuntime {
  let generation = 0;
  let activeGeneration: number | null = null;
  let watchId: number | null = null;
  let callbacks: GpsCaptureRuntimeCallbacks | null = null;
  let wakeLock: WakeLockRecord | null = null;
  let wakeRequestId = 0;
  let pendingWakeRequest: { generation: number; requestId: number } | null = null;
  let disposed = false;

  const releaseWakeLock = (nextStatus: GpsWakeLockStatus, target = callbacks): void => {
    pendingWakeRequest = null;
    const current = wakeLock;
    wakeLock = null;
    if (current) {
      current.lease.removeEventListener("release", current.onRelease);
      void current.lease.release().catch(() => undefined);
    }
    target?.onWakeLockStatus(nextStatus);
  };

  const stopActiveSession = (nextWakeStatus: GpsWakeLockStatus): void => {
    const previousCallbacks = callbacks;
    generation += 1;
    activeGeneration = null;
    callbacks = null;
    if (watchId !== null) dependencies.clearWatch(watchId);
    watchId = null;
    releaseWakeLock(nextWakeStatus, previousCallbacks);
  };

  const requestWakeLock = (): void => {
    const currentGeneration = activeGeneration;
    const currentCallbacks = callbacks;
    if (currentGeneration === null || !currentCallbacks || wakeLock || pendingWakeRequest) return;
    if (!dependencies.requestWakeLock) {
      currentCallbacks.onWakeLockStatus("unsupported");
      return;
    }

    const requestId = ++wakeRequestId;
    pendingWakeRequest = { generation: currentGeneration, requestId };
    currentCallbacks.onWakeLockStatus("requesting");
    let request: Promise<GpsWakeLockLease>;
    try {
      request = dependencies.requestWakeLock();
    } catch {
      pendingWakeRequest = null;
      currentCallbacks.onWakeLockStatus("unavailable");
      return;
    }
    void request
      .then((lease) => {
        const isCurrent = !disposed
          && activeGeneration === currentGeneration
          && callbacks === currentCallbacks
          && pendingWakeRequest?.generation === currentGeneration
          && pendingWakeRequest.requestId === requestId;
        if (!isCurrent || lease.released) {
          void lease.release().catch(() => undefined);
          return;
        }

        pendingWakeRequest = null;
        const onRelease = () => {
          if (wakeLock?.lease !== lease || activeGeneration !== currentGeneration) return;
          lease.removeEventListener("release", onRelease);
          wakeLock = null;
          currentCallbacks.onWakeLockStatus("inactive");
        };
        wakeLock = { generation: currentGeneration, lease, onRelease };
        lease.addEventListener("release", onRelease);
        currentCallbacks.onWakeLockStatus("active");
      })
      .catch(() => {
        const isCurrent = !disposed
          && activeGeneration === currentGeneration
          && callbacks === currentCallbacks
          && pendingWakeRequest?.generation === currentGeneration
          && pendingWakeRequest.requestId === requestId;
        if (!isCurrent) return;
        pendingWakeRequest = null;
        currentCallbacks.onWakeLockStatus("unavailable");
      });
  };

  return {
    start(nextCallbacks) {
      if (disposed) return false;
      stopActiveSession("inactive");
      const currentGeneration = ++generation;
      activeGeneration = currentGeneration;
      callbacks = nextCallbacks;

      let nextWatchId: number;
      try {
        nextWatchId = dependencies.watchPosition(
          (sample) => {
            if (activeGeneration === currentGeneration && callbacks === nextCallbacks) {
              nextCallbacks.onPosition(sample);
            }
          },
          (error) => {
            if (activeGeneration === currentGeneration && callbacks === nextCallbacks) {
              nextCallbacks.onError(error);
            }
          },
        );
      } catch {
        nextCallbacks.onError({ code: 0 });
        stopActiveSession("inactive");
        return false;
      }

      if (activeGeneration !== currentGeneration || callbacks !== nextCallbacks) {
        dependencies.clearWatch(nextWatchId);
        return false;
      }
      watchId = nextWatchId;
      requestWakeLock();
      return true;
    },
    stop() {
      stopActiveSession("inactive");
    },
    refreshWakeLock() {
      requestWakeLock();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopActiveSession("inactive");
    },
  };
}

export type UseGpsBoundaryCaptureOptions = GpsBoundaryContext;

export type UseGpsBoundaryCaptureResult = {
  availability: GpsAvailability;
  permission: GpsPermissionState;
  status: GpsCaptureStatus;
  mode: GpsTrackingMode | null;
  error: GpsCaptureError | null;
  currentFix: GpsLocationFix | null;
  accuracyMeters: number | null;
  acceptedFixes: GpsLocationFix[];
  trace: Coordinate[];
  lastDecision: GpsFixDecision | null;
  wakeLockStatus: GpsWakeLockStatus;
  result: GpsBoundaryFinalization | null;
  start(mode?: GpsTrackingMode): void;
  stop(): GpsBoundaryFinalization | null;
  cancel(): void;
};

export function useGpsBoundaryCapture(
  options: UseGpsBoundaryCaptureOptions = {},
): UseGpsBoundaryCaptureResult {
  const [availability, setAvailability] = useState<GpsAvailability>("checking");
  const [permission, setPermission] = useState<GpsPermissionState>("unknown");
  const [status, setStatus] = useState<GpsCaptureStatus>("idle");
  const [mode, setMode] = useState<GpsTrackingMode | null>(null);
  const [error, setError] = useState<GpsCaptureError | null>(null);
  const [currentFix, setCurrentFix] = useState<GpsLocationFix | null>(null);
  const [acceptedFixes, setAcceptedFixes] = useState<GpsLocationFix[]>([]);
  const [lastDecision, setLastDecision] = useState<GpsFixDecision | null>(null);
  const [wakeLockStatus, setWakeLockStatus] = useState<GpsWakeLockStatus>("inactive");
  const [result, setResult] = useState<GpsBoundaryFinalization | null>(null);
  const runtimeRef = useRef<GpsCaptureRuntime | null>(null);
  const fixesRef = useRef<GpsLocationFix[]>([]);
  const modeRef = useRef<GpsTrackingMode | null>(null);
  const contextRef = useRef<GpsBoundaryContext>(options);

  useEffect(() => {
    contextRef.current = { fundo: options.fundo, siblings: options.siblings };
  }, [options.fundo, options.siblings]);

  useEffect(() => {
    let runtime: GpsCaptureRuntime | null = null;
    let permissionStatus: PermissionStatus | null = null;
    let permissionChangeListener: (() => void) | null = null;
    let handleVisibilityChange: (() => void) | null = null;
    let effectActive = true;
    void Promise.resolve().then(() => {
      if (!effectActive || typeof window === "undefined" || typeof navigator === "undefined") return;
      if (!window.isSecureContext) {
        setAvailability("insecure_context");
        return;
      }
      if (!navigator.geolocation) {
        setAvailability("unsupported");
        return;
      }

      setAvailability("available");
      runtime = createGpsCaptureRuntime(createBrowserRuntimeDependencies());
      runtimeRef.current = runtime;

      // Permissions is deliberately optional: watchPosition remains the source of
      // truth on browsers that omit the Permissions API (notably older Safari).
      const optionalNavigator: { permissions?: Permissions } = navigator;
      const permissions = optionalNavigator.permissions;
      if (permissions) {
        try {
          void permissions.query({ name: "geolocation" })
            .then((nextPermissionStatus) => {
              if (!effectActive) return;
              permissionStatus = nextPermissionStatus;
              permissionChangeListener = () => setPermission(permissionStatus?.state ?? "unknown");
              permissionChangeListener();
              permissionStatus.addEventListener("change", permissionChangeListener);
            })
            .catch(() => {
              if (effectActive) setPermission("unknown");
            });
        } catch {
          setPermission("unknown");
        }
      }

      handleVisibilityChange = () => {
        if (document.visibilityState === "visible") runtime?.refreshWakeLock();
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }).catch(() => {
      if (!effectActive) return;
      runtime?.dispose();
      runtime = null;
      runtimeRef.current = null;
      setAvailability("unsupported");
    });

    return () => {
      effectActive = false;
      if (permissionStatus && permissionChangeListener) {
        permissionStatus.removeEventListener("change", permissionChangeListener);
      }
      if (handleVisibilityChange) document.removeEventListener("visibilitychange", handleVisibilityChange);
      runtime?.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, []);

  const start = useCallback((nextMode: GpsTrackingMode = "boundary") => {
    const runtime = runtimeRef.current;
    if (!runtime || availability !== "available") {
      runtime?.stop();
      modeRef.current = null;
      setMode(null);
      const unavailableError = availability === "insecure_context"
        ? gpsCaptureError("insecure_context")
        : gpsCaptureError("unsupported");
      setError(unavailableError);
      setStatus("error");
      return;
    }
    if (permission === "denied") {
      runtime.stop();
      modeRef.current = null;
      setMode(null);
      setError(gpsCaptureError("permission_denied"));
      setStatus("error");
      return;
    }

    fixesRef.current = [];
    modeRef.current = nextMode;
    setAcceptedFixes([]);
    setCurrentFix(null);
    setLastDecision(null);
    setResult(null);
    setError(null);
    setMode(nextMode);
    setStatus("starting");

    const started = runtime.start({
      onPosition(sample) {
        const sampleResult = processGpsSample(fixesRef.current, sample);
        if (!sampleResult.fix) {
          setError(gpsCaptureError("invalid_position"));
          return;
        }

        setCurrentFix(sampleResult.fix);
        setPermission("granted");
        setError(null);
        setStatus("tracking");
        if (nextMode === "boundary") {
          fixesRef.current = sampleResult.acceptedFixes;
          setAcceptedFixes(sampleResult.acceptedFixes);
          setLastDecision(sampleResult.decision);
        }
      },
      onError(positionError) {
        const mapped = gpsPositionError(positionError.code);
        setError(mapped);
        if (positionError.code === 0 || positionError.code === 1) {
          if (positionError.code === 1) setPermission("denied");
          runtime.stop();
          modeRef.current = null;
          setMode(null);
          setStatus("error");
        }
      },
      onWakeLockStatus: setWakeLockStatus,
    });
    if (started) setStatus("tracking");
  }, [availability, permission]);

  const stop = useCallback((): GpsBoundaryFinalization | null => {
    runtimeRef.current?.stop();
    const completed = modeRef.current === "boundary"
      ? finalizeGpsBoundary(fixesRef.current, contextRef.current)
      : null;
    modeRef.current = null;
    setMode(null);
    setResult(completed);
    setStatus(completed ? "complete" : "idle");
    return completed;
  }, []);

  const cancel = useCallback(() => {
    runtimeRef.current?.stop();
    fixesRef.current = [];
    modeRef.current = null;
    setAcceptedFixes([]);
    setCurrentFix(null);
    setLastDecision(null);
    setResult(null);
    setError(null);
    setMode(null);
    setStatus("idle");
  }, []);

  const trace = useMemo(
    () => acceptedFixes.map(({ coordinate }) => [...coordinate] as Coordinate),
    [acceptedFixes],
  );

  return {
    availability,
    permission,
    status,
    mode,
    error,
    currentFix,
    accuracyMeters: currentFix?.accuracyMeters ?? null,
    acceptedFixes,
    trace,
    lastDecision,
    wakeLockStatus,
    result,
    start,
    stop,
    cancel,
  };
}

export function gpsPositionError(code: number): GpsCaptureError {
  if (code === 1) return gpsCaptureError("permission_denied");
  if (code === 2) return gpsCaptureError("position_unavailable");
  if (code === 3) return gpsCaptureError("timeout");
  return gpsCaptureError("watch_failed");
}

function gpsCaptureError(code: GpsCaptureErrorCode): GpsCaptureError {
  const errors: Record<GpsCaptureErrorCode, Omit<GpsCaptureError, "code">> = {
    unsupported: {
      message: "Este navegador no ofrece geolocalización para capturar el límite.",
      recoverable: false,
    },
    insecure_context: {
      message: "La ubicación sólo funciona en una conexión segura (HTTPS).",
      recoverable: false,
    },
    permission_denied: {
      message: "Activa el permiso de ubicación del navegador para usar el GPS.",
      recoverable: true,
    },
    position_unavailable: {
      message: "No fue posible obtener una posición GPS. Revisa la señal e inténtalo nuevamente.",
      recoverable: true,
    },
    timeout: {
      message: "El GPS tardó demasiado en responder; la captura seguirá esperando una nueva posición.",
      recoverable: true,
    },
    invalid_position: {
      message: "El GPS entregó una posición inválida y se omitió.",
      recoverable: true,
    },
    watch_failed: {
      message: "No fue posible iniciar el seguimiento GPS.",
      recoverable: true,
    },
  };
  return { code, ...errors[code] };
}

function createBrowserRuntimeDependencies(): GpsCaptureRuntimeDependencies {
  const geolocation = navigator.geolocation;
  const optionalNavigator: { wakeLock?: WakeLock } = navigator;
  const wakeLock = optionalNavigator.wakeLock;
  return {
    watchPosition(onPosition, onError) {
      return geolocation.watchPosition(
        (position) => onPosition({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          timestamp: position.timestamp,
          altitudeMeters: position.coords.altitude,
          headingDegrees: position.coords.heading,
          speedMetersPerSecond: position.coords.speed,
        }),
        (positionError) => onError({ code: positionError.code }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
    },
    clearWatch(watchId) {
      geolocation.clearWatch(watchId);
    },
    ...(wakeLock ? {
      requestWakeLock: () => wakeLock.request("screen"),
    } : {}),
  };
}
