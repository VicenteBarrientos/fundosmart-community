import test from "node:test";
import assert from "node:assert/strict";
import {
  clampReminderDays,
  derivePabcoComplianceStatus,
  derivePabcoReminderWorkItems,
  selectDuePabcoReminderWorkItems,
} from "../src/modules/leche/domain/pabco-notification-rules.mjs";

const base = {
  fieldId: "field-1",
  requirement: "annual_water_analysis",
  status: "compliant",
  validUntil: "2026-08-30",
  reminderAt: null,
};

test("derives PABCO work items and prioritizes explicit reminderAt", () => {
  const [item] = derivePabcoReminderWorkItems([
    { ...base, id: "water", reminderAt: "2026-08-10" },
  ]);
  assert.equal(item.id, "pabco:water");
  assert.equal(item.dueDate, "2026-08-10");
  assert.equal(item.validUntil, "2026-08-30");
  assert.match(item.title, /Análisis anual de agua/);
});

test("ignores not applicable or undated PABCO records", () => {
  const items = derivePabcoReminderWorkItems([
    { ...base, id: "na", status: "not_applicable" },
    { ...base, id: "undated", validUntil: null },
  ]);
  assert.deepEqual(items, []);
});

test("selects reminders within the configured horizon including overdue items", () => {
  const due = selectDuePabcoReminderWorkItems(
    [
      { ...base, id: "overdue", validUntil: "2026-07-15" },
      { ...base, id: "near", validUntil: "2026-07-30" },
      { ...base, id: "later", validUntil: "2026-08-10" },
    ],
    "2026-07-21",
    14,
  );
  assert.deepEqual(
    due.map((item) => item.complianceItemId),
    ["overdue", "near"],
  );
});

test("clamps reminder lead time to the supported range", () => {
  assert.equal(clampReminderDays(-2), 0);
  assert.equal(clampReminderDays(21.6), 22);
  assert.equal(clampReminderDays(100), 60);
  assert.equal(clampReminderDays("invalid"), 14);
});

test("derives visible expiring and expired states from PABCO dates", () => {
  assert.equal(
    derivePabcoComplianceStatus(
      {
        status: "compliant",
        reminderAt: "2026-07-20",
        validUntil: "2026-08-01",
      },
      "2026-07-21",
    ),
    "expiring",
  );
  assert.equal(
    derivePabcoComplianceStatus(
      {
        status: "compliant",
        reminderAt: "2026-07-01",
        validUntil: "2026-07-20",
      },
      "2026-07-21",
    ),
    "expired",
  );
  assert.equal(
    derivePabcoComplianceStatus(
      {
        status: "not_applicable",
        reminderAt: "2026-07-01",
        validUntil: "2026-07-20",
      },
      "2026-07-21",
    ),
    "not_applicable",
  );
});
