import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenQuestionFallback,
  generateWorkersAiAssistantResponse,
  WORKERS_AI_ASSISTANT_MODEL,
} from "../src/modules/asistente/server/workers-ai-provider.ts";

const contextData = {
  canOperate: true,
  fields: [{ id: "field-a", name: "Fundo Los Robles" }],
  paddocks: [{ id: "paddock-a", fieldId: "field-a", name: "Potrero Norte" }],
  livestock: { total: 12, active: 11 },
  livestockByField: { "field-a": { total: 12, active: 11 } },
  milk: { bulkProduction: [] },
};

test("env.AI recibe el contexto autorizado y devuelve la respuesta del modelo", async () => {
  let invocation;
  const ai = {
    run: async (model, input) => {
      invocation = { model, input };
      return {
        choices: [{ message: { content: "  Hay 11 animales activos en Fundo Los Robles.  " } }],
      };
    },
  };

  const response = await generateWorkersAiAssistantResponse({
    ai,
    userPrompt: "¿Cuántos animales activos tengo?",
    verifiedReply: "Tienes 11 animales activos.",
    contextData,
  });

  assert.equal(response, "Hay 11 animales activos en Fundo Los Robles.");
  assert.equal(invocation.model, WORKERS_AI_ASSISTANT_MODEL);
  assert.equal(invocation.input.messages[1].content, "¿Cuántos animales activos tengo?");
  assert.match(invocation.input.messages[0].content, /Tienes 11 animales activos/);
  assert.match(invocation.input.messages[0].content, /Fundo Los Robles/);
  assert.equal(invocation.input.store, false);
  assert.equal(invocation.input.max_tokens, undefined);
});

test("una respuesta vacía deja disponible el fallback determinístico", async () => {
  const response = await generateWorkersAiAssistantResponse({
    ai: { run: async () => ({ choices: [{ message: { content: "   " } }] }) },
    userPrompt: "Resumen",
    verifiedReply: "Respuesta verificada",
    contextData,
  });

  assert.equal(response, null);
});

test("una pregunta abierta conserva una orientación útil si Workers AI no devuelve texto", () => {
  const response = buildOpenQuestionFallback(
    "que recomiendas plantar?",
    "Todavía no puedo interpretar esa solicitud con seguridad. Prueba con otros ejemplos.",
  );

  assert.match(response, /Puedo ayudarte a elegir qué plantar/);
  assert.match(response, /praderas, cereales forrajeros, leguminosas o cultivos comerciales/);
  assert.match(response, /comuna/);
  assert.doesNotMatch(response, /Todavía no puedo interpretar/);
  assert.equal(buildOpenQuestionFallback("Resumen", "Respuesta verificada"), null);
});

test("una pregunta abierta habilita orientación agronómica sin inventar datos del fundo", async () => {
  let invocation;
  const response = await generateWorkersAiAssistantResponse({
    ai: {
      run: async (model, input) => {
        invocation = { model, input };
        return {
          choices: [{
            message: {
              content: "Como orientación general, primero define el objetivo y revisa suelo, drenaje y disponibilidad de agua.",
            },
          }],
        };
      },
    },
    userPrompt: "¿Qué recomiendas plantar?",
    verifiedReply: "Todavía no puedo interpretar esa solicitud con seguridad. Prueba con otros ejemplos.",
    contextData,
  });

  assert.match(response, /orientación general/);
  const systemPrompt = invocation.input.messages[0].content;
  assert.match(systemPrompt, /conocimiento agronómico y ganadero general/);
  assert.match(systemPrompt, /preguntas abiertas como “qué plantar”/);
  assert.match(systemPrompt, /no produjo una respuesta operativa específica/);
  assert.match(systemPrompt, /Es una pregunta abierta: respóndela directamente/);
  assert.doesNotMatch(systemPrompt, /Todavía no puedo interpretar esa solicitud con seguridad/);
  assert.match(systemPrompt, /ubicación, objetivo productivo, época/);
  assert.match(systemPrompt, /Nunca insinúes que viste análisis, clima, suelo, agua o historial/);
  assert.equal(invocation.input.max_tokens, undefined);
});
