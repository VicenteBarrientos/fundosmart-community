const DEFAULT_REMINDER_DAYS = 14;

export function resolvePabcoNotificationPreferenceEditor(
  preferences,
  selectedFieldId,
) {
  if (selectedFieldId === "all") {
    return {
      editable: false,
      emailEnabled: false,
      browserEnabled: false,
      reminderDays: DEFAULT_REMINDER_DAYS,
    };
  }

  const preference = Array.isArray(preferences)
    ? preferences.find((candidate) => candidate?.fieldId === selectedFieldId)
    : undefined;
  const reminderDays = Number(preference?.reminderDays);

  return {
    editable: true,
    emailEnabled: Boolean(preference?.emailEnabled),
    browserEnabled: Boolean(preference?.browserEnabled),
    reminderDays:
      Number.isInteger(reminderDays) && reminderDays >= 0 && reminderDays <= 60
        ? reminderDays
        : DEFAULT_REMINDER_DAYS,
  };
}
