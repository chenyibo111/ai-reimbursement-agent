import { expect, it } from "vitest";
import { renderConfiguredNotification, selectNotificationTemplate } from "@/src/application/render-configured-notification";

it("renders only the approved body variable and rejects links and unsafe placeholders", () => {
  expect(renderConfiguredNotification("提醒：{{body}}", { body: "票据识别完成。" })).toBe("提醒：票据识别完成。");
  for (const template of ["{{invoiceFullText}}", "https://external.example/{{body}}", "external.example {{body}}", "{{body}} {{unknown}}", "缺少正文"]) {
    expect(() => renderConfiguredNotification(template, { body: "安全正文" })).toThrow();
  }
  expect(() => renderConfiguredNotification("{{body}}", { body: "x".repeat(4001) })).toThrow();
});

it("selects only connected Feishu events and defaults unpublished config to legacy delivery", () => {
  expect(selectNotificationTemplate(null, "ClaimSubmitted")).toEqual({ enabled: true, version: 0, template: "{{body}}" });
  expect(selectNotificationTemplate({ version: 3, payload: { events: [{ eventCode: "ClaimSubmitted", channel: "FEISHU", enabled: false, template: "{{body}}" }] } }, "ClaimSubmitted")).toEqual({ enabled: false, version: 3, template: "{{body}}" });
  expect(() => selectNotificationTemplate(null, "UnknownEvent")).toThrow();
});
