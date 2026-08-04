"use client";

import React, { useState, useEffect } from "react";

export interface AiConfigData {
  id?: string;
  provider: "gemini" | "openai" | "anthropic";
  maskedApiKey: string;
  defaultModel: string;
  isActive: boolean;
  updatedAt?: string;
}

export type OrganizationAiConfigPublic = AiConfigData;

const PROVIDERS = [
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "Recomendado",
    badgeColor: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    description: "Excelente ventana de contexto para procesar documentos agronómicos largos.",
    models: [
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash (Rápido y eficiente)" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro (Razonamiento profundo)" },
      { id: "gemini-2.0-flash-exp", name: "Gemini 2.0 Flash (Experimental)" },
    ],
    getKeyUrl: "https://aistudio.google.com/app/apikey",
    keyPrefixHint: "Empieza con AIzaSy...",
  },
  {
    id: "openai",
    name: "OpenAI (ChatGPT)",
    badge: "Popualar",
    badgeColor: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    description: "Modelos GPT-4o reconocidos mundialmente por análisis estructurado.",
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o mini (Económico y veloz)" },
      { id: "gpt-4o", name: "GPT-4o (Máxima precisión)" },
      { id: "o3-mini", name: "o3-mini (Razonamiento lógico)" },
    ],
    getKeyUrl: "https://platform.openai.com/api-keys",
    keyPrefixHint: "Empieza con sk-proj-... o sk-...",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    badge: "Avanzado",
    badgeColor: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    description: "Redacción natural, análisis de informes agronómicos y síntesis experta.",
    models: [
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet (Recomendado)" },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku (Rápido)" },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus (Capacidad máxima)" },
    ],
    getKeyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefixHint: "Empieza con sk-ant-...",
  },
];

export function ConfiguracionIAPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [selectedProvider, setSelectedProvider] = useState<"gemini" | "openai" | "anthropic">("gemini");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("gemini-1.5-flash");
  const [existingConfig, setExistingConfig] = useState<AiConfigData | null>(null);

  const [feedback, setFeedback] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadConfig() {
      setLoading(true);
      try {
        const res = await fetch("/api/configuracion/ia");
        if (res.ok && isMounted) {
          const data = (await res.json()) as { config?: OrganizationAiConfigPublic };
          if (data.config) {
            setExistingConfig(data.config);
            setSelectedProvider(data.config.provider);
            setSelectedModel(data.config.defaultModel);
          }
        }
      } catch {
        if (isMounted) {
          setFeedback({ type: "error", message: "No se pudo cargar la configuración actual." });
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }
    void loadConfig();
    return () => {
      isMounted = false;
    };
  }, []);

  const currentProviderInfo = PROVIDERS.find((p) => p.id === selectedProvider)!;

  function handleProviderChange(providerId: "gemini" | "openai" | "anthropic") {
    setSelectedProvider(providerId);
    const info = PROVIDERS.find((p) => p.id === providerId)!;
    setSelectedModel(info.models[0].id);
    setFeedback(null);
  }

  async function handleTestConnection() {
    if (!apiKeyInput && !existingConfig) {
      setFeedback({ type: "error", message: "Ingresa una API Key para realizar la prueba de conexión." });
      return;
    }

    setTesting(true);
    setFeedback({ type: "info", message: "Probando conexión con el proveedor de IA..." });
    try {
      const res = await fetch("/api/configuracion/ia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          provider: selectedProvider,
          apiKey: apiKeyInput || (existingConfig?.provider === selectedProvider ? "EXISTING" : ""),
          defaultModel: selectedModel,
        }),
      });

      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && data.ok) {
        setFeedback({ type: "success", message: data.message || "¡Conexión verificada con éxito!" });
      } else {
        setFeedback({ type: "error", message: data.message || data.error || "Falló la verificación." });
      }
    } catch {
      setFeedback({ type: "error", message: "Error al intentar conectar." });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!apiKeyInput && !existingConfig) {
      setFeedback({ type: "error", message: "Debes ingresar tu API Key." });
      return;
    }

    setSaving(true);
    setFeedback({ type: "info", message: "Verificando y guardando la configuración de IA..." });
    try {
      const res = await fetch("/api/configuracion/ia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          provider: selectedProvider,
          apiKey: apiKeyInput,
          defaultModel: selectedModel,
        }),
      });

      const data = (await res.json()) as { config?: OrganizationAiConfigPublic; error?: string };
      if (res.ok && data.config) {
        setExistingConfig(data.config);
        setApiKeyInput("");
        setFeedback({ type: "success", message: "¡Configuración de IA guardada y activada exitosamente!" });
      } else {
        setFeedback({ type: "error", message: data.error || "No se pudo guardar la configuración." });
      }
    } catch {
      setFeedback({ type: "error", message: "Error de red al guardar la configuración." });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("¿Deseas desvincular tu API Key de IA? FundoSmart volverá al asistente estándar.")) return;

    setDeleting(true);
    try {
      const res = await fetch("/api/configuracion/ia", { method: "DELETE" });
      if (res.ok) {
        setExistingConfig(null);
        setApiKeyInput("");
        setFeedback({ type: "info", message: "Se ha desvinculado la API Key. Se utilizará el asistente estándar." });
      }
    } catch {
      setFeedback({ type: "error", message: "No fue posible desvincular la API Key." });
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-400">
        <div className="animate-spin inline-block w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mb-3"></div>
        <p>Cargando configuración de Inteligencia Artificial...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="border-b border-slate-700/60 pb-6">
        <div className="flex items-center gap-3">
          <span className="text-3xl">🤖</span>
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Conexión de IA Propia (BYOK)</h1>
            <p className="text-sm text-slate-400">
              Conecta tu propia cuenta de Google Gemini, OpenAI ChatGPT o Anthropic Claude para usar tus propios tokens en FundoSmart.
            </p>
          </div>
        </div>
      </div>

      {/* Status Banner if configured */}
      {existingConfig && (
        <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"></span>
            <div>
              <p className="text-sm font-semibold text-emerald-200">
                IA Activa: {PROVIDERS.find((p) => p.id === existingConfig.provider)?.name} ({existingConfig.defaultModel})
              </p>
              <p className="text-xs text-slate-400">
                Llave en uso: <code className="bg-slate-800 px-1.5 py-0.5 rounded text-emerald-300">{existingConfig.maskedApiKey}</code> (Cifrada con AES-256-GCM)
              </p>
            </div>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-xs text-rose-400 hover:text-rose-300 underline disabled:opacity-50"
          >
            {deleting ? "Desvinculando..." : "Desvincular llave"}
          </button>
        </div>
      )}

      {/* Provider Selector Cards */}
      <div className="space-y-4">
        <label className="block text-sm font-medium text-slate-300">1. Selecciona tu proveedor de IA</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PROVIDERS.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            return (
              <div
                key={provider.id}
                onClick={() => handleProviderChange(provider.id as "gemini" | "openai" | "anthropic")}
                className={`cursor-pointer rounded-xl p-5 border transition-all ${
                  isSelected
                    ? "bg-slate-800/90 border-emerald-500 shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-500/50"
                    : "bg-slate-900/60 border-slate-750 hover:border-slate-600 hover:bg-slate-800/50"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-slate-100">{provider.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${provider.badgeColor}`}>
                    {provider.badge}
                  </span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{provider.description}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Configuration Form */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 space-y-6">
        <h3 className="text-base font-semibold text-slate-200 border-b border-slate-800 pb-3">
          2. Credenciales y Modelo de {currentProviderInfo.name}
        </h3>

        {/* API Key Input */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium text-slate-300">API Key del Proveedor</label>
            <a
              href={currentProviderInfo.getKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-emerald-400 hover:underline flex items-center gap-1"
            >
              Obtener API Key en {currentProviderInfo.name} ↗
            </a>
          </div>
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={
              existingConfig?.provider === selectedProvider
                ? `Mantener actual (${existingConfig.maskedApiKey})`
                : currentProviderInfo.keyPrefixHint
            }
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono"
          />
          <p className="text-xs text-slate-500">
            🔒 Tu llave se almacena cifrada en reposo. Nunca se muestra a otros usuarios ni se envía al navegador.
          </p>
        </div>

        {/* Model Selection */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-300">Modelo por Defecto</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
          >
            {currentProviderInfo.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </select>
        </div>

        {/* Feedback alert */}
        {feedback && (
          <div
            className={`p-4 rounded-lg text-sm flex items-center gap-2 ${
              feedback.type === "success"
                ? "bg-emerald-950/60 border border-emerald-500/40 text-emerald-200"
                : feedback.type === "error"
                ? "bg-rose-950/60 border border-rose-500/40 text-rose-200"
                : "bg-blue-950/60 border border-blue-500/40 text-blue-200"
            }`}
          >
            <span>{feedback.type === "success" ? "✅" : feedback.type === "error" ? "⚠️" : "ℹ️"}</span>
            <span>{feedback.message}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving || testing}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <>
                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
                Guardando...
              </>
            ) : (
              "Guardar y Activar"
            )}
          </button>

          <button
            onClick={handleTestConnection}
            disabled={saving || testing}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium px-5 py-2.5 rounded-lg border border-slate-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {testing ? "Probando..." : "⚡ Probar Conexión"}
          </button>
        </div>
      </div>
    </div>
  );
}
