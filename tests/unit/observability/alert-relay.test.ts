import { expect, it } from "vitest";

import { parseAlertmanagerWebhook, renderFeishuAlertCard } from "@/src/observability/alert-relay";

it("renders only approved firing fields and excludes sensitive labels", () => {
  const batch = parseAlertmanagerWebhook({
    status: "firing",
    alerts: [{
      status: "firing",
      labels: {
        alertname: "JobWorkerHeartbeatMissing",
        severity: "critical",
        service: "job-worker",
        claimId: "claim-secret",
        employeeId: "employee-secret",
      },
      annotations: {
        summary: "异步任务 Worker 已超过 5 分钟没有心跳",
        objectKey: "claims/private/receipt.png",
      },
      startsAt: "2026-10-06T00:00:00.000Z",
      endsAt: "0001-01-01T00:00:00Z",
    }],
  });

  expect(batch).not.toBeNull();

  const card = renderFeishuAlertCard(batch!);
  expect(card).toMatchObject({ msg_type: "interactive" });
  expect(JSON.stringify(card)).toContain("AI 报销系统告警");
  expect(JSON.stringify(card)).toContain("JobWorkerHeartbeatMissing");
  expect(JSON.stringify(card)).toContain("异步任务 Worker 已超过 5 分钟没有心跳");
  expect(JSON.stringify(card)).not.toContain("claim-secret");
  expect(JSON.stringify(card)).not.toContain("employee-secret");
  expect(JSON.stringify(card)).not.toContain("claims/private/receipt.png");
});

it("renders a recovery card for resolved alerts", () => {
  const batch = parseAlertmanagerWebhook({
    status: "resolved",
    alerts: [{
      status: "resolved",
      labels: {
        alertname: "OcrFailureRateHigh",
        severity: "warning",
        service: "ocr",
      },
      annotations: { summary: "OCR 十分钟失败率超过 20%" },
      startsAt: "2026-10-06T00:00:00.000Z",
      endsAt: "2026-10-06T00:05:00.000Z",
    }],
  });

  expect(JSON.stringify(renderFeishuAlertCard(batch!))).toContain("AI 报销系统告警已恢复");
});

it("labels each mixed alert item with its own status and matching time", () => {
  const batch = parseAlertmanagerWebhook({
    status: "firing",
    alerts: [
      {
        status: "firing",
        labels: { alertname: "JobWorkerHeartbeatMissing", severity: "critical", service: "job-worker" },
        annotations: { summary: "Worker 无心跳" },
        startsAt: "2026-10-06T00:00:00.000Z",
      },
      {
        status: "resolved",
        labels: { alertname: "OcrFailureRateHigh", severity: "warning", service: "ocr" },
        annotations: { summary: "OCR 已恢复" },
        startsAt: "2026-10-06T00:00:00.000Z",
        endsAt: "2026-10-06T00:05:00.000Z",
      },
    ],
  });

  const serialized = JSON.stringify(renderFeishuAlertCard(batch!));
  expect(serialized).toContain("状态：告警中");
  expect(serialized).toContain("状态：已恢复");
  expect(serialized).toContain("恢复时间：");
});

it("rejects an invalid Alertmanager webhook payload", () => {
  expect(parseAlertmanagerWebhook({ status: "firing", alerts: [] })).toBeNull();
  expect(parseAlertmanagerWebhook({ status: "unknown" })).toBeNull();
});
