const ALLOWED_STATUSES = new Set(["open", "resolved", "ignored"]);
const MAX_NOTES_LENGTH = 500;

export class IssueResolutionError extends Error {
  constructor(message, code = "ISSUE_RESOLUTION_INVALID") {
    super(message);
    this.name = "IssueResolutionError";
    this.code = code;
  }
}

export function normalizeIssueResolution(input) {
  const status = typeof input?.status === "string" ? input.status.trim() : "";
  if (!ALLOWED_STATUSES.has(status)) {
    throw new IssueResolutionError("Selecciona un estado de resolución válido.", "ISSUE_STATUS_INVALID");
  }

  const notes = typeof input?.resolutionNotes === "string"
    ? input.resolutionNotes.trim().slice(0, MAX_NOTES_LENGTH)
    : "";
  if (status === "ignored" && notes.length < 5) {
    throw new IssueResolutionError(
      "Para ignorar una observación debes registrar una justificación de al menos 5 caracteres.",
      "ISSUE_IGNORE_REASON_REQUIRED",
    );
  }

  return {
    status,
    resolutionNotes: status === "open" ? null : notes || null,
  };
}
