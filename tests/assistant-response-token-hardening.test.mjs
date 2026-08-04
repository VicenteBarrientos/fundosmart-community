import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  AssistantConfirmationTokenError,
  openAssistantConfirmation,
  sealAssistantConfirmation,
} from "../src/modules/asistente/server/assistant-confirmation-token.ts";

const routeUrl = new URL("../app/api/asistente/route.ts", import.meta.url);
const stateKey = "__FUNDOSMART_ASSISTANT_RESPONSE_HARDENING_TEST__";
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const dataSecret = "Fundo Respuesta Secreta";
const expectedAccess = {
  displayName: "Operador",
  email: "persona@example.com",
  fieldIds: ["field-a", "field-b"],
  membershipId: "membership-original",
  organizationId: "org-a",
  role: "operator",
};
const action = {
  kind: "create_activity",
  id: "assistant-activity-11111111-1111-4111-8111-111111111111",
  fieldId: "field-a",
  fieldName: dataSecret,
  paddockId: "paddock-a",
  paddockName: "Potrero Secreto",
  activityType: "grazing",
  activityLabel: "Pastoreo",
  occurredAt: "2026-07-21",
  description: "Registrado por Asistente FundoSmart: pastoreo hoy",
  quantity: null,
  unit: null,
  costClp: null,
  createdAt: "2026-07-21T12:00:00.000Z",
};

test("GET reauthorizes the complete snapshot with the capability implied by the reply", async () => {
  const route = await loadRoute();

  const reader = resetState({ action: null, mode: "allowed" });
  const readerResponse = await route.GET(assistantRequest("resumen"));
  assert.equal(readerResponse.status, 200);
  assert.equal((await readerResponse.json()).reply.message, dataSecret);
  assert.deepEqual(reader.snapshotRequirement, {
    capability: "view",
    fieldIds: expectedAccess.fieldIds,
  });

  const operator = resetState({ action, mode: "allowed" });
  const operatorResponse = await route.GET(assistantRequest("registrar pastoreo"));
  const operatorBody = await operatorResponse.json();
  assert.equal(operatorResponse.status, 200);
  assert.match(operatorBody.reply.proposedAction.confirmationId, /^v2\./);
  assert.deepEqual(operator.snapshotRequirement, {
    capability: "operate",
    fieldIds: expectedAccess.fieldIds,
  });
  assert.deepEqual(operator.sealSubject, {
    membershipId: expectedAccess.membershipId,
    organizationId: expectedAccess.organizationId,
    actor: expectedAccess.email,
  });
  assert.deepEqual(operator.calls, ["authorize:view", "load", "build", "seal", "snapshot"]);
});

test("GET reemplaza la ayuda cerrada si Workers AI no entrega texto o la repite", async () => {
  const route = await loadRoute();
  const closedReply = "Todavía no puedo interpretar esa solicitud con seguridad. Prueba con otros ejemplos.";
  const openReply = "Puedo ayudarte a elegir qué plantar y comparar alternativas.";
  for (const workersReply of [null, closedReply]) {
    const state = resetState({
      action: null,
      engineMessage: closedReply,
      mode: "allowed",
      openFallback: openReply,
      workersReply,
    });

    const response = await route.GET(assistantRequest("que recomiendas plantar?"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply.message, openReply);
    assert.deepEqual(state.openFallbackInput, {
      userPrompt: "que recomiendas plantar?",
      verifiedReply: closedReply,
    });
  }
});

test("suspension, field withdrawal, and same-email replacement return neither derived data nor token", async () => {
  const route = await loadRoute();
  for (const [mode, status] of [
    ["suspended", 403],
    ["field-withdrawn", 409],
    ["same-email-replacement", 409],
  ]) {
    const state = resetState({ action, mode });
    const response = await route.GET(assistantRequest("registrar pastoreo"));
    const body = await response.text();
    assert.equal(response.status, status, mode);
    assert.doesNotMatch(body, new RegExp(dataSecret), mode);
    assert.doesNotMatch(body, /v[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u, mode);
    assert.deepEqual(state.calls, ["authorize:view", "load", "build", "seal", "snapshot"], mode);
  }
});

test("confirmation rejects legacy and same-email replacement tokens before any effect", async () => {
  const route = await loadRoute();
  const originalToken = await sealAssistantConfirmation(
    action,
    {
      membershipId: expectedAccess.membershipId,
      organizationId: expectedAccess.organizationId,
      actor: expectedAccess.email,
    },
    secret,
  );

  const replacement = resetState({
    access: { ...expectedAccess, membershipId: "membership-replacement" },
    confirmationId: originalToken,
    mode: "allowed",
  });
  const replacementResponse = await route.POST(confirmRequest());
  assert.equal(replacementResponse.status, 404);
  assert.equal(replacement.effects, 0);
  assert.deepEqual(replacement.openSubject, {
    membershipId: "membership-replacement",
    organizationId: expectedAccess.organizationId,
    actor: expectedAccess.email,
  });

  const legacy = resetState({ confirmationId: "v1.legacy.iv", mode: "allowed" });
  const legacyResponse = await route.POST(confirmRequest());
  assert.equal(legacyResponse.status, 400);
  assert.equal(legacy.effects, 0);
});

test("confirmation reauthorizes immediately before the writer and keeps revoked requests effect-free", async () => {
  const route = await loadRoute();
  const confirmationId = await sealAssistantConfirmation(
    action,
    {
      membershipId: expectedAccess.membershipId,
      organizationId: expectedAccess.organizationId,
      actor: expectedAccess.email,
    },
    secret,
  );

  for (const [mode, status] of [
    ["suspended", 403],
    ["field-withdrawn", 409],
  ]) {
    const denied = resetState({ confirmationId, mode });
    const response = await route.POST(confirmRequest());
    assert.equal(response.status, status, mode);
    assert.equal(denied.effects, 0, mode);
    assert.deepEqual(denied.reauthorizeCalls, [{ capability: "operate", fieldId: action.fieldId }], mode);
  }

  const allowed = resetState({ confirmationId, mode: "allowed" });
  const response = await route.POST(confirmRequest());
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.result.activityId, action.id);
  assert.equal(allowed.effects, 1);
  assert.deepEqual(allowed.reauthorizeCalls, [
    { capability: "operate", fieldId: action.fieldId },
    { capability: "operate", fieldId: action.fieldId },
  ]);
});

async function loadRoute() {
  const source = await readFile(routeUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const stubs = {
    "@/app/access": {
      authorizeApiAccess: async (capability = "view") => {
        const state = currentState();
        state.calls.push(`authorize:${capability}`);
        return state.access;
      },
      isAccessResponse: (value) => value instanceof Response,
      reauthorizeApiAccess: async (_access, capability, fieldId) => {
        const state = currentState();
        state.calls.push("reauthorize");
        state.reauthorizeCalls.push({ capability, fieldId });
        return accessResult(state);
      },
      reauthorizeApiSnapshotAccess: async (_access, requirement) => {
        const state = currentState();
        state.calls.push("snapshot");
        state.snapshotRequirement = requirement;
        return accessResult(state);
      },
      requireResourceField: async () => {
        currentState().calls.push("resource");
        return null;
      },
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure: (_operation, message) => Response.json({ error: message }, { status: 500 }),
    },
    "@/app/json-body.mjs": {
      readJsonObject: async () => ({ confirmationId: currentState().confirmationId }),
    },
    "@/src/modules/asistente/domain/assistant-engine.mjs": {
      buildAssistantReply: () => {
        const state = currentState();
        state.calls.push("build");
        return {
          action: state.action,
          links: [],
          message: state.engineMessage,
          suggestions: [],
        };
      },
      validateConfirmedActivity: () => null,
    },
    "@/src/modules/asistente/server/assistant-confirmation-token": {
      AssistantConfirmationTokenError,
      openAssistantConfirmation: async (token, subject, confirmationSecret) => {
        const state = currentState();
        state.calls.push("open");
        state.openSubject = subject;
        return openAssistantConfirmation(token, subject, confirmationSecret);
      },
      sealAssistantConfirmation: async (value, subject, confirmationSecret) => {
        const state = currentState();
        state.calls.push("seal");
        state.sealSubject = subject;
        return sealAssistantConfirmation(value, subject, confirmationSecret);
      },
    },
    "@/src/modules/asistente/server/ai-config-repository": {
      getActiveOrganizationAiConfig: async () => null,
    },
    "@/src/modules/asistente/server/llm-provider": {
      generateLlmAssistantResponse: async () => null,
    },
    "@/src/modules/asistente/server/workers-ai-provider": {
      buildOpenQuestionFallback: (userPrompt, verifiedReply) => {
        const state = currentState();
        state.openFallbackInput = { userPrompt, verifiedReply };
        return state.openFallback;
      },
      generateWorkersAiAssistantResponse: async () => currentState().workersReply,
    },
    "@/src/modules/asistente/server/assistant-service": {
      loadAssistantData: async () => {
        currentState().calls.push("load");
        return { secret: dataSecret };
      },
      todayInChile: () => "2026-07-22",
    },
    "@/src/modules/potreros/server/activity-repository": {
      upsertActivity: async (value) => {
        const state = currentState();
        state.calls.push("write");
        state.effects += 1;
        return { ...value, updatedAt: "2026-07-22T00:00:00.000Z" };
      },
    },
    "@/src/modules/potreros/server/fundo-repository": {
      listFundos: async () => {
        currentState().calls.push("fields");
        return [{ id: action.fieldId, name: dataSecret }];
      },
    },
    "@/src/modules/potreros/server/potrero-repository": {
      listPotreros: async () => {
        currentState().calls.push("paddocks");
        return [{ fieldId: action.fieldId, id: action.paddockId, name: action.paddockName }];
      },
    },
    "cloudflare:workers": { env: { ASSISTANT_CONFIRMATION_SECRET: secret } },
  };
  const loadedModule = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      assert.ok(specifier in stubs, `Unexpected import: ${specifier}`);
      return stubs[specifier];
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function accessResult(state) {
  if (state.mode === "suspended") {
    return Response.json({ error: "suspended", code: "MEMBERSHIP_SUSPENDED" }, { status: 403 });
  }
  if (state.mode === "field-withdrawn") {
    return Response.json({ error: "scope changed", code: "ACCESS_SCOPE_CHANGED" }, { status: 409 });
  }
  if (state.mode === "same-email-replacement") {
    return Response.json({ error: "membership changed", code: "ACCESS_CONTEXT_CHANGED" }, { status: 409 });
  }
  return state.access;
}

function resetState({
  access = expectedAccess,
  action: proposedAction = action,
  confirmationId = "",
  engineMessage = dataSecret,
  mode,
  openFallback = null,
  workersReply = null,
}) {
  const state = {
    access,
    action: proposedAction,
    calls: [],
    confirmationId,
    effects: 0,
    engineMessage,
    mode,
    openFallback,
    openFallbackInput: null,
    openSubject: null,
    reauthorizeCalls: [],
    sealSubject: null,
    snapshotRequirement: null,
    workersReply,
  };
  globalThis[stateKey] = state;
  return state;
}

function currentState() {
  return globalThis[stateKey];
}

function assistantRequest(message) {
  return new Request("https://example.com/api/asistente", {
    headers: { "x-fundosmart-assistant-message": encodeURIComponent(message) },
  });
}

function confirmRequest() {
  return new Request("https://example.com/api/asistente", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}
