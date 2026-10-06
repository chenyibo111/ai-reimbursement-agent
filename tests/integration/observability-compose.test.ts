import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("defines private Loki, Alloy and Grafana services for the observability profile", async () => {
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  for (const service of ["loki", "alloy", "grafana"]) {
    expect(compose).toMatch(new RegExp(`^  ${service}:\\r?\\n`, "m"));
    expect(compose).toMatch(new RegExp(`${service}:[\\s\\S]*?profiles:\\s*\\["observability"\\]`));
  }
  expect(compose).toMatch(/alloy:[\s\S]*?\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  expect(compose).not.toMatch(/loki:[\s\S]*?\n    ports:/);
  expect(compose).not.toMatch(/grafana:[\s\S]*?\n    ports:/);
});

it("keeps logs for 30 days and extracts only low-cardinality Loki labels", async () => {
  const [loki, alloy] = await Promise.all([
    readFile(new URL("../../observability/loki-config.yml", import.meta.url), "utf8"),
    readFile(new URL("../../observability/config.alloy", import.meta.url), "utf8"),
  ]);

  expect(loki).toContain("retention_period: 720h");
  expect(alloy).toMatch(/target_label\s+= "service"/);
  expect(alloy).toMatch(/target_label\s+= "environment"/);
  expect(alloy).toContain("values = { level = \"\", event = \"\", jobKind = \"\" }");
  expect(alloy).toMatch(/regex\s+= "\(web\|feishu-bot-worker\|job-worker\|ocr\|alloy\|loki\|alertmanager\|alert-relay\)"/);
  expect(alloy).not.toContain("jobId");
  expect(alloy).not.toContain("claimId");
});

it("provisions Grafana with the internal Loki datasource", async () => {
  const datasource = await readFile(new URL("../../observability/grafana/provisioning/datasources/loki.yml", import.meta.url), "utf8");

  expect(datasource).toContain("name: Loki");
  expect(datasource).toContain("url: http://loki:3100");
});
