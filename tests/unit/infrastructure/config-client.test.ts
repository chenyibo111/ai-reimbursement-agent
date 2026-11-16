import { expect, it, vi } from "vitest";
import { createNotificationConfigClient } from "@/src/infrastructure/reimbursement/config-client";

it("reads the published template config with service identity and validates the response", async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ version: 4, payload: { events: [{ eventCode: "ClaimSubmitted", channel: "FEISHU", enabled: true, template: "{{body}}" }] } }), { status: 200 }));
  const client = createNotificationConfigClient({ baseUrl: "http://reimbursement:8080/", serviceKey: "private-key", fetch: fetcher });
  await expect(client.getActive()).resolves.toMatchObject({ version: 4 });
  await expect(client.getVersion(4)).resolves.toMatchObject({ version: 4 });
  expect(fetcher).toHaveBeenCalledWith("http://reimbursement:8080/internal/v1/config/notification_templates/active", expect.objectContaining({ headers: { "X-Auth-Provisioning-Key": "private-key" } }));
  expect(fetcher).toHaveBeenCalledWith("http://reimbursement:8080/internal/v1/config/notification_templates/versions/4", expect.any(Object));
});

it("treats unpublished config as legacy and rejects malformed or unavailable snapshots", async () => {
  const client = (status: number, body: unknown) => createNotificationConfigClient({ baseUrl: "http://reimbursement", serviceKey: "key", fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })) });
  await expect(client(404, {}).getActive()).resolves.toBeNull();
  await expect(client(200, { version: 1, payload: { events: [{ eventCode: "Unknown", channel: "FEISHU", enabled: true, template: "{{body}}" }] } }).getActive()).rejects.toThrow();
  await expect(client(503, {}).getActive()).rejects.toThrow();
});
