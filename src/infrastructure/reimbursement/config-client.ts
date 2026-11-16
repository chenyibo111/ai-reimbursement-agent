import { assertSafeNotificationTemplate, connectedNotificationEvents, type NotificationConfigSnapshot, type NotificationTemplateConfig } from "@/src/application/render-configured-notification";

export function createNotificationConfigClient(config: { baseUrl: string; serviceKey: string; fetch?: typeof fetch }) {
  const fetcher = config.fetch ?? fetch;
  async function read(path: string): Promise<NotificationConfigSnapshot | null> {
      const response = await fetcher(`${config.baseUrl.replace(/\/$/, "")}/internal/v1/config/notification_templates/${path}`, {
        headers: { "X-Auth-Provisioning-Key": config.serviceKey },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("notification config unavailable");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !Number.isSafeInteger((data as { version?: unknown }).version) || (data as { version: number }).version < 1) throw new Error("invalid notification config version");
      const payload = (data as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as { events?: unknown }).events)) throw new Error("invalid notification config payload");
      const events = (payload as NotificationTemplateConfig).events;
      const seen = new Set<string>();
      if (events.length === 0 || events.length > connectedNotificationEvents.length) throw new Error("invalid notification event count");
      for (const event of events) {
        if (!event || !connectedNotificationEvents.includes(event.eventCode) || event.channel !== "FEISHU" || typeof event.enabled !== "boolean" || typeof event.template !== "string" || seen.has(event.eventCode)) throw new Error("invalid notification event");
        assertSafeNotificationTemplate(event.template);
        seen.add(event.eventCode);
      }
      return { version: (data as { version: number }).version, payload: { events } };
  }
  return {
    getActive: () => read("active"),
    async getVersion(version: number): Promise<NotificationConfigSnapshot> {
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("invalid notification config version");
      const snapshot = await read(`versions/${version}`);
      if (!snapshot || snapshot.version !== version) throw new Error("notification config version unavailable");
      return snapshot;
    },
  };
}
