import assert from "node:assert/strict";
import test from "node:test";
import { parseRawEmailMessage } from "../src/modules/importaciones/server/email-parser.mjs";

test("parseRawEmailMessage parses headers and base64 attachments", () => {
  const rawEmail = [
    "From: Laboratorio Central <lab@example.com>",
    "To: inbox-xyz123@fundosmart.com",
    "Subject: Reporte de Leche Julio 2026",
    "Message-ID: <msg-999@example.com>",
    "Content-Type: multipart/mixed; boundary=\"boundary_123\"",
    "",
    "--boundary_123",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Adjunto reporte de control lechero en XLSX.",
    "",
    "--boundary_123",
    "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition: attachment; filename=\"control_lechero.xlsx\"",
    "Content-Transfer-Encoding: base64",
    "",
    "UEtDMDRDQ1NW...",
    "--boundary_123--",
  ].join("\r\n");

  const parsed = parseRawEmailMessage(rawEmail);

  assert.equal(parsed.from, "Laboratorio Central <lab@example.com>");
  assert.equal(parsed.to, "inbox-xyz123@fundosmart.com");
  assert.equal(parsed.subject, "Reporte de Leche Julio 2026");
  assert.equal(parsed.messageId, "<msg-999@example.com>");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, "control_lechero.xlsx");
});
