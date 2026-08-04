import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePabcoNotificationPreferenceEditor,
} from "../src/modules/leche/domain/pabco-notification-preference-editor.mjs";

const mixedPreferences = [
  {
    fieldId: "field-a",
    emailEnabled: true,
    browserEnabled: false,
    reminderDays: 7,
  },
  {
    fieldId: "field-b",
    emailEnabled: false,
    browserEnabled: true,
    reminderDays: 30,
  },
];

test("the all-fields PABCO notification view cannot overwrite mixed preferences", () => {
  const editor = resolvePabcoNotificationPreferenceEditor(
    mixedPreferences,
    "all",
  );

  assert.equal(editor.editable, false);
});

test("the PABCO notification editor preserves each selected field preference", () => {
  assert.deepEqual(
    resolvePabcoNotificationPreferenceEditor(mixedPreferences, "field-a"),
    {
      editable: true,
      emailEnabled: true,
      browserEnabled: false,
      reminderDays: 7,
    },
  );
  assert.deepEqual(
    resolvePabcoNotificationPreferenceEditor(mixedPreferences, "field-b"),
    {
      editable: true,
      emailEnabled: false,
      browserEnabled: true,
      reminderDays: 30,
    },
  );
});
