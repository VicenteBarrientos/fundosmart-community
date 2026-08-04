import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import {
  addWhitelistedSender,
  createOrGetActiveInboxAddress,
  getActiveInboxAddress,
  listQuarantineMessages,
  listWhitelistedSenders,
  removeWhitelistedSender,
  rotateInboxAddress,
} from "@/src/modules/importaciones/server/inbox-repository";

function actorAccess(access: {
  membershipId: string;
  email: string;
  organizationId: string;
  fieldIds: string[];
}) {
  return {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
}

export async function GET(request: Request) {
  try {
    const accessContext = await authorizeApiAccess("manage_imports");
    if (isAccessResponse(accessContext)) return accessContext;
    const access = actorAccess(accessContext);

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "address";
    const fieldId = url.searchParams.get("fieldId") || accessContext.fieldIds[0];

    if (action === "address") {
      const fieldError = requireContextField(accessContext, fieldId);
      if (fieldError) return fieldError;

      const address = await getActiveInboxAddress({ access, fieldId: fieldId! });
      return NextResponse.json({ address });
    }

    if (action === "whitelists") {
      const whitelists = await listWhitelistedSenders({ access });
      return NextResponse.json({ whitelists });
    }

    if (action === "quarantine") {
      const fieldError = requireContextField(accessContext, fieldId);
      if (fieldError) return fieldError;

      const quarantine = await listQuarantineMessages({ access, fieldId: fieldId! });
      return NextResponse.json({ quarantine });
    }

    return NextResponse.json({ error: "Acción no reconocida." }, { status: 400 });
  } catch (error) {
    return unexpectedApiFailure("inbox.get", "Fallo al consultar la bandeja de entrada.", error);
  }
}

export async function POST(request: Request) {
  try {
    const accessContext = await authorizeApiAccess("manage_imports");
    if (isAccessResponse(accessContext)) return accessContext;
    const access = actorAccess(accessContext);

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      fieldId?: string;
      senderEmail?: string;
      label?: string;
    };
    const { action, fieldId: inputFieldId, senderEmail, label } = body;
    const fieldId = inputFieldId || accessContext.fieldIds[0];

    if (action === "create_or_get_address") {
      const fieldError = requireContextField(accessContext, fieldId);
      if (fieldError) return fieldError;

      const address = await createOrGetActiveInboxAddress({
        access,
        fieldId: fieldId!,
        domain: env.FUNDOSMART_INBOX_DOMAIN,
      });
      return NextResponse.json({ address });
    }

    if (action === "rotate_address") {
      const fieldError = requireContextField(accessContext, fieldId);
      if (fieldError) return fieldError;

      const address = await rotateInboxAddress({
        access,
        fieldId: fieldId!,
        domain: env.FUNDOSMART_INBOX_DOMAIN,
      });
      return NextResponse.json({ address });
    }

    if (action === "add_whitelist") {
      if (!senderEmail || typeof senderEmail !== "string" || !senderEmail.includes("@")) {
        return NextResponse.json({ error: "Se requiere un correo de remitente válido." }, { status: 400 });
      }

      const record = await addWhitelistedSender({
        access,
        senderEmail,
        label: typeof label === "string" ? label : undefined,
      });
      return NextResponse.json({ record });
    }

    return NextResponse.json({ error: "Acción POST no reconocida." }, { status: 400 });
  } catch (error) {
    return unexpectedApiFailure("inbox.post", "Fallo al procesar acción de la bandeja de entrada.", error);
  }
}

export async function DELETE(request: Request) {
  try {
    const accessContext = await authorizeApiAccess("manage_imports");
    if (isAccessResponse(accessContext)) return accessContext;
    const access = actorAccess(accessContext);

    const url = new URL(request.url);
    const senderId = url.searchParams.get("senderId");

    if (!senderId) {
      return NextResponse.json({ error: "Se requiere senderId." }, { status: 400 });
    }

    await removeWhitelistedSender({ access, senderId });
    return NextResponse.json({ success: true });
  } catch (error) {
    return unexpectedApiFailure("inbox.delete", "Fallo al eliminar remitente de la lista blanca.", error);
  }
}
