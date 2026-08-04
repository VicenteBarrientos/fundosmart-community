import assert from "node:assert/strict";
import test from "node:test";
import { isDownloadablePabcoEvidenceReference } from "../src/modules/leche/domain/pabco-evidence-reference.mjs";

test("PABCO links only durable v4 ids and well-formed audited legacy keys", () => {
  for (const reference of [
    "pabco-evidence-123e4567-e89b-42d3-a456-426614174000",
    "PABCO-EVIDENCE-123E4567-E89B-42D3-A456-426614174000",
    "pabco/org-a/field-pabco-evidence-lifecycle/legacy-certificado.pdf",
  ]) {
    assert.equal(isDownloadablePabcoEvidenceReference(reference), true, reference);
  }

  for (const reference of [
    null,
    "",
    "certificado-pabco-2019.pdf",
    "pabco-evidence-no-es-uuid",
    "pabco-evidence-123e4567-e89b-12d3-a456-426614174000",
    "pabco-evidence-123e4567-e89b-42d3-7456-426614174000",
    "pabco/",
    "pabco//legacy-certificado.pdf",
    "pabco/../legacy-certificado.pdf",
    "other/org-a/legacy-certificado.pdf",
  ]) {
    assert.equal(isDownloadablePabcoEvidenceReference(reference), false, String(reference));
  }
});
