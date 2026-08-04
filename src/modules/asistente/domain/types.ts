export type AssistantContext = {
  activeSection?: string;
  fieldName?: string;
  isDemo?: boolean;
  pathname?: string;
};

export type AssistantLink = {
  href: string;
  label: string;
};

export type AssistantActionDetail = {
  label: string;
  value: string;
};

export type AssistantProposedAction = {
  confirmationId: string;
  kind: string;
  title: string;
  description?: string;
  details?: AssistantActionDetail[];
  confirmLabel?: string;
  cancelLabel?: string;
};

export type AssistantReply = {
  message: string;
  links?: AssistantLink[];
  proposedAction?: AssistantProposedAction;
  suggestions?: string[];
};

export type AssistantTurnRequest = {
  message: string;
  context: AssistantContext;
};

export type AssistantConfirmationAction = "confirm" | "cancel";

export type AssistantConfirmationRequest = {
  confirmationId: string;
};
