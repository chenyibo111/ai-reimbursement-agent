import { z } from "zod";

const alertStatusSchema = z.enum(["firing", "resolved"]);

const alertmanagerWebhookSchema = z.object({
  status: alertStatusSchema,
  alerts: z.array(z.object({
    status: alertStatusSchema,
    labels: z.object({
      alertname: z.string().min(1),
      severity: z.string().min(1),
      service: z.string().min(1),
    }).passthrough(),
    annotations: z.object({
      summary: z.string().min(1),
    }).passthrough(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
  })).min(1),
}).passthrough();

export type AlertStatus = z.infer<typeof alertStatusSchema>;

export type AlertItem = {
  status: AlertStatus;
  alertName: string;
  severity: string;
  service: string;
  summary: string;
  startsAt: string;
  endsAt?: string;
};

export type AlertBatch = {
  status: AlertStatus;
  alerts: AlertItem[];
};

export type FeishuCard = {
  msg_type: "interactive";
  card: {
    header: {
      title: { tag: "plain_text"; content: string };
      template: "red" | "green";
    };
    elements: Array<Record<string, unknown>>;
  };
};

function safeText(value: string, maximumLength = 256): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maximumLength);
}

export function parseAlertmanagerWebhook(value: unknown): AlertBatch | null {
  const result = alertmanagerWebhookSchema.safeParse(value);
  if (!result.success) return null;

  return {
    status: result.data.status,
    alerts: result.data.alerts.map((alert) => ({
      status: alert.status,
      alertName: safeText(alert.labels.alertname),
      severity: safeText(alert.labels.severity, 64),
      service: safeText(alert.labels.service, 64),
      summary: safeText(alert.annotations.summary),
      startsAt: alert.startsAt,
      ...(alert.endsAt ? { endsAt: alert.endsAt } : {}),
    })),
  };
}

function alertTime(alert: AlertItem): string {
  const reference = alert.status === "resolved" && alert.endsAt ? alert.endsAt : alert.startsAt;
  return new Date(reference).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

export function renderFeishuAlertCard(batch: AlertBatch): FeishuCard {
  const resolved = batch.status === "resolved";
  const title = resolved ? "AI 报销系统告警已恢复" : "AI 报销系统告警";

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: title },
        template: resolved ? "green" : "red",
      },
      elements: [
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: `**状态**\n${resolved ? "已恢复" : "告警中"}` } },
            { is_short: true, text: { tag: "lark_md", content: `**告警数量**\n${batch.alerts.length}` } },
          ],
        },
        ...batch.alerts.map((alert) => {
          const itemResolved = alert.status === "resolved";
          return {
            tag: "div",
            text: {
              tag: "plain_text",
              content: `${alert.alertName}\n状态：${itemResolved ? "已恢复" : "告警中"}\n服务：${alert.service}\n级别：${alert.severity}\n${alert.summary}\n${itemResolved ? "恢复时间" : "触发时间"}：${alertTime(alert)}`,
            },
          };
        }),
      ],
    },
  };
}
