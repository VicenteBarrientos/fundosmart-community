/**
 * Decode Base64 string into Uint8Array.
 */
function decodeBase64(str) {
  const clean = str.replace(/[^A-Za-z0-9+/=]/g, "");
  const binaryStr = atob(clean);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode Quoted-Printable string into Uint8Array.
 */
function decodeQuotedPrintable(str) {
  const unescaped = str.replace(/=\r?\n/g, "");
  const bytes = [];
  let i = 0;
  while (i < unescaped.length) {
    if (unescaped[i] === "=" && i + 2 < unescaped.length) {
      const hex = unescaped.substring(i + 1, i + 3);
      const val = parseInt(hex, 16);
      if (!isNaN(val)) {
        bytes.push(val);
        i += 3;
        continue;
      }
    }
    bytes.push(unescaped.charCodeAt(i));
    i++;
  }
  return new Uint8Array(bytes);
}

/**
 * Parse a raw MIME email (Uint8Array or string) into headers and attachments.
 */
export function parseRawEmailMessage(raw) {
  const rawText = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: false }).decode(raw);

  // Separate header block from body
  const headerEnd = rawText.indexOf("\r\n\r\n") !== -1 ? rawText.indexOf("\r\n\r\n") : rawText.indexOf("\n\n");
  const headerBlock = headerEnd !== -1 ? rawText.slice(0, headerEnd) : rawText;

  // Unfold folded header lines
  const unfoldedHeaders = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const headerLines = unfoldedHeaders.split(/\r?\n/);

  const headers = {};
  for (const line of headerLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const name = line.slice(0, colonIndex).trim().toLowerCase();
      const val = line.slice(colonIndex + 1).trim();
      headers[name] = val;
    }
  }

  const from = headers["from"] || "";
  const to = headers["to"] || "";
  const subject = headers["subject"] || "";
  const messageId = headers["message-id"] || "";
  const contentTypeHeader = headers["content-type"] || "";

  const attachments = [];

  // Check if multipart
  const boundaryMatch = contentTypeHeader.match(/boundary=["']?([^"';\s]+)["']?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawText.split(new RegExp(`--${boundary.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));

    for (const part of parts) {
      if (part.trim() === "" || part.trim() === "--") continue;

      const partHeaderEnd = part.indexOf("\r\n\r\n") !== -1 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
      if (partHeaderEnd === -1) continue;

      const partHeaderBlock = part.slice(0, partHeaderEnd);
      const partBody = part.slice(partHeaderEnd).trim();

      const partUnfolded = partHeaderBlock.replace(/\r?\n[ \t]+/g, " ");
      const partHeaders = {};
      for (const line of partUnfolded.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          const n = line.slice(0, colon).trim().toLowerCase();
          const v = line.slice(colon + 1).trim();
          partHeaders[n] = v;
        }
      }

      const partDisposition = partHeaders["content-disposition"] || "";
      const partContentType = partHeaders["content-type"] || "";
      const encoding = (partHeaders["content-transfer-encoding"] || "").toLowerCase();

      // Extract filename
      const filenameMatch = partDisposition.match(/filename=["']?([^"';\s]+)["']?/i) ||
                            partContentType.match(/name=["']?([^"';\s]+)["']?/i);

      if (filenameMatch || partDisposition.includes("attachment")) {
        const filename = filenameMatch ? filenameMatch[1] : "attachment.bin";
        const contentType = partContentType.split(";")[0].trim() || "application/octet-stream";

        let data;
        if (encoding === "base64") {
          data = decodeBase64(partBody);
        } else if (encoding === "quoted-printable") {
          data = decodeQuotedPrintable(partBody);
        } else {
          data = new TextEncoder().encode(partBody);
        }

        attachments.push({ filename, contentType, data });
      }
    }
  }

  return { from, to, subject, messageId, attachments };
}
