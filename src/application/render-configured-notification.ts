export const connectedNotificationEvents = ["ReceiptExtractionCompleted", "ReceiptReviewRequired", "ReceiptReviewResolved", "ClaimSubmitted"] as const;
export type NotificationEventCode = typeof connectedNotificationEvents[number];
export type NotificationTemplateConfig = { events: Array<{ eventCode: NotificationEventCode; channel: "FEISHU"; enabled: boolean; template: string }> };
export type NotificationConfigSnapshot = { version: number; payload: NotificationTemplateConfig };

const externalLink = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|\[[^\]]+\]\([^)]*\)|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b)/i;

export function assertSafeNotificationTemplate(template: string): void {
  if (Array.from(template).length > 400 || (template.match(/\{\{body\}\}/g) ?? []).length !== 1 || externalLink.test(template) || /[{}]/.test(template.replace("{{body}}", "")) || /[\x00-\x09\x0b-\x1f\x7f]/.test(template)) {
    throw new Error("unsafe notification template");
  }
}

export function renderConfiguredNotification(template: string, variables: { body: string }): string {
  assertSafeNotificationTemplate(template);
  const result = template.replace("{{body}}", variables.body);
  if (result.length > 4000) throw new Error("notification is too long");
  return result;
}

export function selectNotificationTemplate(snapshot: NotificationConfigSnapshot | null, eventCode: string): { enabled: boolean; version: number; template: string } {
  if (!connectedNotificationEvents.includes(eventCode as NotificationEventCode)) throw new Error("unknown notification event");
  const entry = snapshot?.payload.events.find((item) => item.eventCode === eventCode && item.channel === "FEISHU");
  return { enabled: entry?.enabled ?? true, version: snapshot?.version ?? 0, template: entry?.template ?? "{{body}}" };
}
