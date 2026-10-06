import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

function serviceBlock(compose: string, service: string): string {
  const match = compose.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:|^secrets:|(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`service ${service} is missing`);
  return match[1];
}

it("wires private Alertmanager and alert relay services to the observability profile", async () => {
  const [compose, loki, alertmanager] = await Promise.all([
    readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../../observability/loki-config.yml", import.meta.url), "utf8"),
    readFile(new URL("../../observability/alertmanager.yml", import.meta.url), "utf8"),
  ]);

  const alertmanagerService = serviceBlock(compose, "alertmanager");
  const relayService = serviceBlock(compose, "alert-relay");
  expect(alertmanagerService).toContain('profiles: ["observability"]');
  expect(relayService).toContain('profiles: ["observability"]');
  expect(alertmanagerService).toMatch(/^    expose:\r?\n      - "9093"/m);
  expect(relayService).toMatch(/^    expose:\r?\n      - "8082"/m);
  expect(alertmanagerService).not.toMatch(/^    ports:/m);
  expect(relayService).not.toMatch(/^    ports:/m);
  expect(relayService).toContain("npm run alert:relay:container");
  expect(relayService).toContain("app_env");

  expect(loki).toContain("alertmanager_url: http://alertmanager:9093");
  expect(alertmanager).toContain("group_wait: 30s");
  expect(alertmanager).toContain("group_interval: 5m");
  expect(alertmanager).toContain("repeat_interval: 4h");
  expect(alertmanager).toContain("url: http://alert-relay:8082/alertmanager");
  expect(alertmanager).toContain("send_resolved: true");
  expect(alertmanager).toContain("source_matchers:");
  expect(alertmanager).toContain('severity="critical"');
});
