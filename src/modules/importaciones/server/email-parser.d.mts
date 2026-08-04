export type ExtractedEmailAttachment = {
  filename: string;
  contentType: string;
  data: Uint8Array;
};

export type ParsedEmailMessage = {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  attachments: ExtractedEmailAttachment[];
};

export declare function parseRawEmailMessage(raw: Uint8Array | string): ParsedEmailMessage;
