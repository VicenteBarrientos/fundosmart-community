"use client";

import React, { useState, useEffect } from "react";
import { Navigation, AlertCircle } from "lucide-react";

export type GpsFix = Readonly<{
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  timestamp: string;
  speedMps: number | null;
}>;

export type MapGpsTrackerProps = {
  active: boolean;
  onFixUpdate?: (fix: GpsFix) => void;
  className?: string;
};

export function MapGpsTracker({
  active,
  onFixUpdate,
  className = "",
}: MapGpsTrackerProps) {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || typeof window === "undefined" || !("geolocation" in navigator)) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const newFix: GpsFix = Object.freeze({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
          timestamp: new Date(pos.timestamp).toISOString(),
          speedMps: pos.coords.speed,
        });
        setFix(newFix);
        setError(null);
        onFixUpdate?.(newFix);
      },
      (err) => {
        setError(err.message || "No se pudo obtener señal GPS.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [active, onFixUpdate]);

  if (!active) return null;

  return (
    <div
      className={`bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-lg p-2 text-slate-100 text-xs flex items-center gap-2 ${className}`}
      aria-label="Estado de rastreo GPS de terreno"
    >
      <Navigation className={`w-4 h-4 ${fix ? "text-emerald-400 animate-pulse" : "text-amber-400"}`} />
      {error ? (
        <span className="text-rose-400 text-[11px] flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{error}</span>
        </span>
      ) : fix ? (
        <div className="flex items-center gap-3 text-[11px]">
          <span className="font-mono text-emerald-300">
            ±{fix.accuracyMeters.toFixed(1)}m
          </span>
          <span className="text-slate-400">
            {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
          </span>
        </div>
      ) : (
        <span className="text-slate-400 text-[11px]">Buscando señal GPS...</span>
      )}
    </div>
  );
}
