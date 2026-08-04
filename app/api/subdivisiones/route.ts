import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  deleteSubdivisionDraft,
  deleteScopedSubdivisionDraft,
  getSubdivisionDraft,
  getScopedSubdivisionDraft,
  subdivisionBaseSnapshotToken,
  upsertScopedSubdivisionDraft,
  upsertSubdivisionDraft,
} from "@/src/modules/potreros/server/subdivision-draft-repository";
import type { ScopedSubdivisionDraft, SubdivisionScopeKind } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const searchParams = new URL(request.url).searchParams;
    const fieldId = searchParams.get("fundoId")?.trim();
    if (!fieldId) return Response.json({ error: "Selecciona un fundo." }, { status: 400 });
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const scopeKind = parseScopeKind(searchParams.get("scopeKind"));
    const scopeId = searchParams.get("scopeId")?.trim();
    if (searchParams.has("scopeKind") && !scopeKind) return Response.json({ error: "El alcance del borrador no es válido." }, { status: 400 });
    if (scopeKind && !scopeId) return Response.json({ error: "Falta el recurso del borrador." }, { status: 400 });
    if (!scopeKind) {
      const draft = await getSubdivisionDraft(fieldId, access);
      const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return Response.json({ draft }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const draft = await getScopedSubdivisionDraft(fieldId, scopeKind, scopeId!, access);
    const baseSnapshotToken = draft?.baseSnapshotToken ?? await subdivisionBaseSnapshotToken(fieldId, scopeKind, scopeId!, access);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ draft, baseSnapshotToken }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (cause) {
    return draftError(cause, "No fue posible recuperar el borrador.");
  }
}

export async function PUT(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<ScopedSubdivisionDraft> & { expectedUpdatedAt?: string | null }>(request);
    if (payload instanceof Response) return payload;
    if (!payload.fieldId?.trim()) return Response.json({ error: "Selecciona un fundo." }, { status: 400 });
    if (!Array.isArray(payload.history) || payload.history.length === 0) return Response.json({ error: "El borrador está vacío." }, { status: 400 });
    if (!Array.isArray(payload.line)) return Response.json({ error: "La línea del borrador no es válida." }, { status: 400 });
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;

    const saved = payload.scopeKind && payload.scopeId && payload.baseSnapshotToken
      ? await upsertScopedSubdivisionDraft({
        id: payload.id?.trim() || `subdivision-draft:${payload.fieldId}:${payload.scopeKind}:${payload.scopeId}`,
        fieldId: payload.fieldId,
        scopeKind: payload.scopeKind,
        scopeId: payload.scopeId,
        history: payload.history,
        line: payload.line,
        baseSnapshotToken: payload.baseSnapshotToken,
        updatedAt: payload.updatedAt ?? "",
      }, payload.expectedUpdatedAt ?? payload.updatedAt ?? null, access)
      : await upsertSubdivisionDraft({
      fieldId: payload.fieldId,
      history: payload.history,
      line: payload.line,
      updatedAt: payload.updatedAt ?? new Date().toISOString(),
      }, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ draft: saved });
  } catch (cause) {
    return draftError(cause, "No fue posible guardar el borrador.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const searchParams = new URL(request.url).searchParams;
    const fieldId = searchParams.get("fundoId")?.trim();
    if (!fieldId) return Response.json({ error: "Selecciona un fundo." }, { status: 400 });
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const scopeKind = parseScopeKind(searchParams.get("scopeKind"));
    const scopeId = searchParams.get("scopeId")?.trim();
    if (searchParams.has("scopeKind") && !scopeKind) return Response.json({ error: "El alcance del borrador no es válido." }, { status: 400 });
    if (scopeKind) {
      const expectedUpdatedAt = searchParams.get("updatedAt")?.trim();
      if (!scopeId || !expectedUpdatedAt) return Response.json({ error: "Actualiza el borrador antes de eliminarlo." }, { status: 409 });
      await deleteScopedSubdivisionDraft(fieldId, scopeKind, scopeId, expectedUpdatedAt, access);
    } else {
      await deleteSubdivisionDraft(fieldId, access);
    }
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true });
  } catch (cause) {
    return draftError(cause, "No fue posible eliminar el borrador.");
  }
}

function parseScopeKind(value: string | null): SubdivisionScopeKind | null {
  return value === "field" || value === "paddock" ? value : null;
}

function draftError(cause: unknown, fallback: string) {
  if (cause instanceof Error && "code" in cause && cause.code === "FIELD_SCOPE_CONFLICT") {
    return Response.json({ error: cause.message, code: cause.code }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
  }
  return Response.json({ error: fallback }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
}
