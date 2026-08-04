import type { OfficialDocumentProjection } from "../domain/types";

export function renderTraceabilityDocumentPdf(projection: OfficialDocumentProjection): Uint8Array;
export function traceabilityDocumentObjectKey(projection: OfficialDocumentProjection): string;
export function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string>;
