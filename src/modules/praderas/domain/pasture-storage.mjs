import { PastureDomainError } from "./pasture-planning.mjs";

export function buildPastureRawObjectKey(input) {
  return `praderas/${objectSegment(input.organizationId)}/${objectSegment(input.fieldId)}/raw/${objectSegment(input.observationId)}.json`;
}

export async function buildPastureObservationId(input) {
  const organizationId = objectSegment(input.organizationId);
  const fieldId = objectSegment(input.fieldId);
  const operationId = objectSegment(input.operationId);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${organizationId}\u0000${fieldId}\u0000${operationId}`),
  );
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pasture-observation-${hash.slice(0, 32)}`;
}

function objectSegment(value) {
  const segment = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(segment) || segment.includes("..")) {
    throw new PastureDomainError("El alcance contiene un identificador no válido.", "PASTURE_SCOPE_INVALID");
  }
  return segment;
}
