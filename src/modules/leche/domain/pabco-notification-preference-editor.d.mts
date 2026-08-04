export type PabcoNotificationPreferenceEditorState = {
  editable: boolean;
  emailEnabled: boolean;
  browserEnabled: boolean;
  reminderDays: number;
};

export function resolvePabcoNotificationPreferenceEditor(
  preferences: ReadonlyArray<{
    fieldId: string;
    emailEnabled: boolean;
    browserEnabled: boolean;
    reminderDays: number;
  }>,
  selectedFieldId: string,
): PabcoNotificationPreferenceEditorState;
