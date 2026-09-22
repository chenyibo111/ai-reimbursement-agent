export const fieldSources = ["EXTRACTED", "USER_ENTERED", "SYSTEM_CALCULATED"] as const;

export type FieldSource = (typeof fieldSources)[number];
