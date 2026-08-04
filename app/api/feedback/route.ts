import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { FeedbackRequestError, validateFeedbackSubmission } from "@/src/modules/feedback/domain/types";
import {
  isSameOriginFeedbackMutation,
  privateFeedbackJson,
  readBoundedJsonObject,
} from "@/src/modules/feedback/server/feedback-http";
import { submitProductFeedback } from "@/src/modules/feedback/server/feedback-repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginFeedbackMutation(request)) {
    return privateFeedbackJson({
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }

  try {
    const payload = await readBoundedJsonObject(request);
    if (payload instanceof Response) return payload;
    const submission = validateFeedbackSubmission(payload);
    const access = await authorizeApiAccess("view", submission.fieldId ?? undefined);
    if (isAccessResponse(access)) return access;
    if (access.email === DEMO_EMAIL) {
      return privateFeedbackJson({
        error: "Cambia a tu cuenta personal para enviarnos un comentario.",
        code: "FEEDBACK_PERSONAL_ACCOUNT_REQUIRED",
      }, 403);
    }

    const result = await submitProductFeedback({
      actor: access,
      submission,
      releaseSha: env.FUNDOSMART_RELEASE_SHA ?? "unknown",
      userAgent: request.headers.get("User-Agent") ?? "",
    });

    const currentAccess = await reauthorizeApiAccess(access, "view", submission.fieldId ?? undefined);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateFeedbackJson({
      feedback: {
        id: result.feedback.id,
        createdAt: result.feedback.createdAt,
      },
      replay: result.replay,
    }, result.replay ? 200 : 201);
  } catch (cause) {
    if (cause instanceof FeedbackRequestError) {
      return privateFeedbackJson({
        error: cause.message,
        code: cause.code,
      }, cause.status, cause.status === 429 ? { "Retry-After": "600" } : {});
    }
    return unexpectedApiFailure(
      "product_feedback.submit",
      "No fue posible enviar el comentario.",
      cause,
    );
  }
}
