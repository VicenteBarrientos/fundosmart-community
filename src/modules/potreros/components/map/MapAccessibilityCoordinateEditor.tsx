"use client";

import React, { useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, MapPin } from "lucide-react";
import type { Coordinate } from "../../types";

export type MapAccessibilityCoordinateEditorProps = {
  coordinates: Coordinate[];
  onCoordinatesChange: (newCoordinates: Coordinate[]) => void;
  paddockName?: string;
  className?: string;
};

export function MapAccessibilityCoordinateEditor({
  coordinates,
  onCoordinatesChange,
  paddockName = "Potrero",
  className = "",
}: MapAccessibilityCoordinateEditorProps) {
  const [latInput, setLatInput] = useState("");
  const [lngInput, setLngInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAddPoint = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(latInput);
    const lng = parseFloat(lngInput);

    if (isNaN(lat) || isNaN(lng)) {
      setError("Ingresa coordenadas válidas (números decimales).");
      return;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setError("Latitud (-90 a 90) o Longitud (-180 a 180) fuera de rango.");
      return;
    }

    setError(null);
    onCoordinatesChange([...coordinates, [lat, lng]]);
    setLatInput("");
    setLngInput("");
  };

  const handleRemovePoint = (index: number) => {
    onCoordinatesChange(coordinates.filter((_, i) => i !== index));
  };

  const handleMovePoint = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= coordinates.length) return;

    const newCoords = [...coordinates];
    const temp = newCoords[index];
    newCoords[index] = newCoords[targetIndex];
    newCoords[targetIndex] = temp;
    onCoordinatesChange(newCoords);
  };

  return (
    <div
      className={`bg-slate-900 border border-slate-800 rounded-xl p-4 text-slate-100 text-xs space-y-4 ${className}`}
      aria-label={`Tabla accesible de vértices para ${paddockName}`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-emerald-400" />
          <h4 className="font-bold text-sm text-white">
            Editor accesible de vértices ({coordinates.length} puntos)
          </h4>
        </div>
        <span className="text-[11px] text-slate-400">WCAG 2.2 AA Compatible</span>
      </div>

      {/* Point Addition Form */}
      <form onSubmit={handleAddPoint} className="space-y-2 bg-slate-950/60 p-3 rounded-lg border border-slate-800">
        <span className="font-semibold text-slate-300 block">Agregar Vértice por Coordenadas</span>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="vertex-lat" className="block text-slate-400 mb-1">
              Latitud
            </label>
            <input
              id="vertex-lat"
              type="text"
              value={latInput}
              onChange={(e) => setLatInput(e.target.value)}
              placeholder="-40.6123"
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="vertex-lng" className="block text-slate-400 mb-1">
              Longitud
            </label>
            <input
              id="vertex-lng"
              type="text"
              value={lngInput}
              onChange={(e) => setLngInput(e.target.value)}
              placeholder="-73.1245"
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        {error && <p className="text-rose-400 text-xs">{error}</p>}

        <button
          type="submit"
          className="flex items-center justify-center gap-1.5 w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-1.5 rounded transition-colors mt-2"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Agregar Punto</span>
        </button>
      </form>

      {/* Accessible Table of Vertices */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse" aria-label="Lista de vértices del potrero">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 font-semibold">
              <th className="py-1.5 px-2">#</th>
              <th className="py-1.5 px-2">Latitud</th>
              <th className="py-1.5 px-2">Longitud</th>
              <th className="py-1.5 px-2 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {coordinates.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-3 text-center text-slate-500">
                  No hay vértices definidos. Agrega el primer punto arriba.
                </td>
              </tr>
            ) : (
              coordinates.map(([lat, lng], idx) => (
                <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="py-1.5 px-2 font-mono text-slate-400">{idx + 1}</td>
                  <td className="py-1.5 px-2 font-mono text-slate-200">{lat.toFixed(6)}</td>
                  <td className="py-1.5 px-2 font-mono text-slate-200">{lng.toFixed(6)}</td>
                  <td className="py-1.5 px-2 text-right space-x-1">
                    <button
                      type="button"
                      onClick={() => handleMovePoint(idx, "up")}
                      disabled={idx === 0}
                      className="p-1 text-slate-400 hover:text-white disabled:opacity-30"
                      aria-label={`Mover punto ${idx + 1} arriba`}
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMovePoint(idx, "down")}
                      disabled={idx === coordinates.length - 1}
                      className="p-1 text-slate-400 hover:text-white disabled:opacity-30"
                      aria-label={`Mover punto ${idx + 1} abajo`}
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemovePoint(idx)}
                      className="p-1 text-rose-400 hover:text-rose-300"
                      aria-label={`Eliminar punto ${idx + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
