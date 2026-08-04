import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/asistente/route.ts", import.meta.url), "utf8");
const service = await readFile(new URL("../src/modules/asistente/server/assistant-service.ts", import.meta.url), "utf8");
const shell = await readFile(new URL("../src/core/layout/AppShell.tsx", import.meta.url), "utf8");
const vite = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
const workersAi = await readFile(new URL("../src/modules/asistente/server/workers-ai-provider.ts", import.meta.url), "utf8");

test("consultas y tareas separan lectura de confirmación operativa", () => {
  assert.match(route, /export async function GET[\s\S]+authorizeApiAccess\(\)/);
  assert.match(route, /export async function POST[\s\S]+authorizeApiAccess\("operate"\)/);
  assert.match(route, /validateConfirmedActivity/);
  assert.match(route, /openAssistantConfirmation/);
  assert.match(route, /sealAssistantConfirmation/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /requiredConfirmationSecret/);
  assert.match(
    route,
    /const reply = toClientReply[\s\S]+reauthorizeApiSnapshotAccess\(access,[\s\S]+capability: engineReply\.action \? "operate" : "view"[\s\S]+fieldIds: access\.fieldIds[\s\S]+return privateJson\(\{ reply \}\)/,
  );
  assert.match(route, /requireResourceField\(access, "paddock", action\.paddockId\)/);
  assert.match(
    route,
    /reauthorizeApiAccess\(access, "operate", paddock\.fieldId\)[\s\S]+upsertActivity[\s\S]+currentAccess, currentAccess\.email[\s\S]+reauthorizeApiAccess\(access, "operate", paddock\.fieldId\)/,
  );
  assert.match(route, /upsertActivity/);
  assert.match(route, /"assistant\.activity"/);
  assert.match(route, /costClp: null/);
  assert.match(route, /Cache-Control": "private, no-store"/);
});

test("las confirmaciones no confían el payload operativo al navegador", async () => {
  const types = await readFile(new URL("../src/modules/asistente/domain/types.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/modules/asistente/api/assistant-client.ts", import.meta.url), "utf8");
  assert.match(types, /AssistantConfirmationRequest = \{\s*confirmationId: string;\s*\}/);
  assert.doesNotMatch(types, /AssistantConfirmationRequest = \{[\s\S]*?payload/);
  assert.match(client, /JSON\.stringify\(request\)/);
});

test("el contexto del asistente se construye solo con repositorios acotados por la membresía", () => {
  assert.match(service, /listFundos\(access\)/);
  assert.match(service, /listPotreros\(access\)/);
  assert.match(service, /getMilkModuleSnapshot\(access, asOf\)/);
  assert.match(service, /listLivestockLots\(access\)/);
  assert.match(service, /listLivestockAnimals\(access\)/);
  assert.match(service, /roleHasCapability\(access\.role, "operate"\)/);
});

test("Workers AI responde el chat sin cuotas de producto y conserva el fallback determinístico", () => {
  assert.match(vite, /\.\.\.aiBindingConfig\(command\)/);
  assert.match(vite, /FUNDOSMART_ENABLE_AI !== "true"/);
  assert.match(vite, /command === "build" \|\| process\.env\.CI === "true"/);
  assert.match(vite, /FUNDOSMART_ENABLE_REMOTE_AI === "true"/);
  assert.match(vite, /\? \{ ai: \{ binding: "AI", remote: true \} \}/);
  assert.match(route, /generateWorkersAiAssistantResponse\(\{[\s\S]+ai: env\.AI/);
  assert.match(route, /verifiedReply: engineReply\.message/);
  assert.match(route, /if \(llmMessage\) engineReply\.message = llmMessage/);
  assert.match(workersAi, /@cf\/openai\/gpt-oss-20b/);
  assert.doesNotMatch(workersAi, /quota|rate.?limit|daily.?limit|usage.?limit/i);
});

test("AppShell ofrece el asistente solo dentro del producto", () => {
  assert.match(shell, /import \{ AsistenteFundoSmart \}/);
  assert.match(shell, /<AsistenteFundoSmart/);
  assert.match(shell, /context=\{\{ activeSection, fieldName, isDemo, pathname \}\}/);
});
