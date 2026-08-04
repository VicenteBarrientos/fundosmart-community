import type { AiProviderKey } from "@/db/schema";
import type { AssistantEngineData } from "../domain/assistant-engine.mjs";

export interface LlmCompletionOptions {
  provider: AiProviderKey;
  apiKey: string;
  model?: string;
  userPrompt: string;
  contextData: AssistantEngineData;
}

export interface LlmVerificationResult {
  ok: boolean;
  message: string;
}

type ApiErrorJson = { error?: { message?: string } };
type GeminiResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
type OpenAiResponse = { choices?: Array<{ message?: { content?: string } }> };
type AnthropicResponse = { content?: Array<{ text?: string }> };

export async function verifyLlmApiKey(
  provider: AiProviderKey,
  apiKey: string,
  model?: string
): Promise<LlmVerificationResult> {
  if (!apiKey || apiKey.trim().length === 0) {
    return { ok: false, message: "La API Key no puede estar vacía." };
  }

  try {
    if (provider === "gemini") {
      const targetModel = model || "gemini-1.5-flash";
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey.trim()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Responde solo: OK" }] }],
          }),
        }
      );
      if (!res.ok) {
        const errorJson = (await res.json().catch(() => ({}))) as ApiErrorJson;
        const msg = errorJson?.error?.message || `Error ${res.status} en Google Gemini`;
        return { ok: false, message: msg };
      }
      return { ok: true, message: "Conexión exitosa con Google Gemini." };
    }

    if (provider === "openai") {
      const targetModel = model || "gpt-4o-mini";
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: "user", content: "Responde solo: OK" }],
          max_tokens: 5,
        }),
      });
      if (!res.ok) {
        const errorJson = (await res.json().catch(() => ({}))) as ApiErrorJson;
        const msg = errorJson?.error?.message || `Error ${res.status} en OpenAI`;
        return { ok: false, message: msg };
      }
      return { ok: true, message: "Conexión exitosa con OpenAI." };
    }

    if (provider === "anthropic") {
      const targetModel = model || "claude-3-5-sonnet-20241022";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: targetModel,
          max_tokens: 10,
          messages: [{ role: "user", content: "Responde solo: OK" }],
        }),
      });
      if (!res.ok) {
        const errorJson = (await res.json().catch(() => ({}))) as ApiErrorJson;
        const msg = errorJson?.error?.message || `Error ${res.status} en Anthropic`;
        return { ok: false, message: msg };
      }
      return { ok: true, message: "Conexión exitosa con Anthropic Claude." };
    }

    return { ok: false, message: "Proveedor no soportado." };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "No fue posible conectar con el proveedor.";
    return { ok: false, message: msg };
  }
}

export async function generateLlmAssistantResponse(
  options: LlmCompletionOptions
): Promise<string> {
  const { provider, apiKey, model, userPrompt, contextData } = options;

  const systemPrompt = `Eres el Asistente Experto Agrónomo y Ganadero de FundoSmart.
Respondes con precisión, tono profesional y empático para agricultores y ganaderos de Chile.
Contexto actual del Fundo:
- Fundos registrados: ${JSON.stringify(contextData.fields)}
- Potreros: ${JSON.stringify(contextData.paddocks)}
- Ganado total: ${contextData.livestock.total} (activos: ${contextData.livestock.active})
- Resumen leche/producción: ${JSON.stringify(contextData.milk || {})}

Instrucciones:
1. Responde de forma clara, directa y estructurada en formato Markdown.
2. Si se trata de un registro o recomendación agronómica, menciona los potreros o fundos específicos involucrados.
3. Sé breve y prioriza la utilidad práctica para la gestión diaria.`;

  if (provider === "gemini") {
    const targetModel = model || "gemini-1.5-flash";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey.trim()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`Google Gemini API retornó estado HTTP ${res.status}`);
    }
    const data = (await res.json()) as GeminiResponse;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "No se obtuvo respuesta del modelo.";
  }

  if (provider === "openai") {
    const targetModel = model || "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API retornó estado HTTP ${res.status}`);
    }
    const data = (await res.json()) as OpenAiResponse;
    return data?.choices?.[0]?.message?.content || "No se obtuvo respuesta del modelo.";
  }

  if (provider === "anthropic") {
    const targetModel = model || "claude-3-5-sonnet-20241022";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: targetModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic Claude API retornó estado HTTP ${res.status}`);
    }
    const data = (await res.json()) as AnthropicResponse;
    return data?.content?.[0]?.text || "No se obtuvo respuesta del modelo.";
  }

  throw new Error("Proveedor de IA no válido.");
}
