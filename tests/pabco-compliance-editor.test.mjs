import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePabcoComplianceEditor,
} from "../src/modules/leche/domain/pabco-compliance-editor.mjs";

const existing = {
  id: "pabco-water",
  organizationId: "org-a",
  fieldId: "field-a",
  requirement: "annual_water_analysis",
  status: "expiring",
  evidenceDocumentId: "document-123",
  validFrom: "2025-08-01",
  validUntil: "2026-08-01",
  reminderAt: "2026-07-20",
  source: "manual",
  sourceRecordId: null,
  notes: "Renovar con laboratorio",
  createdBy: "member-a",
  createdAt: "2025-08-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

test("the PABCO editor hydrates every persisted field before an update", () => {
  assert.deepEqual(
    resolvePabcoComplianceEditor(
      [existing],
      "field-a",
      "annual_water_analysis",
      "2026-07-21",
    ),
    {
      fieldId: "field-a",
      requirement: "annual_water_analysis",
      status: "expiring",
      validFrom: "2025-08-01",
      validUntil: "2026-08-01",
      reminderAt: "2026-07-20",
      evidence: "document-123",
      notes: "Renovar con laboratorio",
    },
  );
});

test("the PABCO editor uses safe defaults only for a new requirement", () => {
  assert.deepEqual(
    resolvePabcoComplianceEditor(
      [existing],
      "field-a",
      "animal_traceability",
      "2026-07-21",
    ),
    {
      fieldId: "field-a",
      requirement: "animal_traceability",
      status: "compliant",
      validFrom: "2026-07-21",
      validUntil: "",
      reminderAt: "",
      evidence: "",
      notes: "",
    },
  );
});
