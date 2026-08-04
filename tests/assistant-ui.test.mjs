import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("el asistente conserva un contrato explícito para preguntas y confirmaciones", async () => {
  const [client, types] = await Promise.all([
    source("src/modules/asistente/api/assistant-client.ts"),
    source("src/modules/asistente/domain/types.ts"),
  ]);

  assert.match(client, /const ASSISTANT_ENDPOINT = "\/api\/asistente"/);
  assert.match(client, /X-FundoSmart-Assistant-Message/);
  assert.match(client, /method: "GET"/);
  assert.match(client, /method: "POST"/);
  assert.match(client, /JSON\.stringify\(request\)/);
  assert.match(types, /message: string;\s*context: AssistantContext;/);
  assert.match(types, /AssistantConfirmationRequest = \{\s*confirmationId: string;\s*\}/);
  assert.match(types, /"confirm" \| "cancel"/);
});

test("el panel global expone diálogo, log vivo y control de foco", async () => {
  const [component, dialogHook] = await Promise.all([
    source("src/modules/asistente/AsistenteFundoSmart.tsx"),
    source("src/ui/useDialogA11y.ts"),
  ]);

  assert.match(component, /aria-label="Abrir asistente"/);
  assert.match(component, /aria-controls="fundosmart-assistant-panel"/);
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /role="dialog"/);
  assert.match(component, /role="log"/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /useDialogA11y\(panelRef, closePanel, open\)/);
  assert.match(dialogHook, /event\.key === "Escape"/);
  assert.match(dialogHook, /event\.key !== "Tab"/);
  assert.match(dialogHook, /previouslyFocused\?\.focus\?\.\(\)/);
});

test("las tareas siempre pasan por confirmación o cancelación explícitas", async () => {
  const component = await source(
    "src/modules/asistente/AsistenteFundoSmart.tsx",
  );

  assert.match(component, /resolveAssistantConfirmation/);
  assert.match(component, /onDecision\(proposedAction, "confirm"\)/);
  assert.match(component, /onDecision\(proposedAction, "cancel"\)/);
  assert.match(component, /Confirmación requerida/);
  assert.match(component, /confirmationId: proposedAction\.confirmationId/);
});

test("los enlaces devueltos por el servidor se limitan al producto", async () => {
  const component = await source(
    "src/modules/asistente/AsistenteFundoSmart.tsx",
  );

  assert.match(component, /message\.links\.filter\(isProductLink\)/);
  assert.match(component, /link\.href === "\/app"/);
  assert.match(component, /link\.href\.startsWith\("\/app\/"\)/);
});
