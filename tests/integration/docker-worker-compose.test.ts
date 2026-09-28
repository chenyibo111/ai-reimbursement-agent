import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("runs the durable job worker with the same secret and dependencies as the web service", async () => {
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  expect(compose).toMatch(/^  job-worker:\n/m);
  expect(compose).toMatch(/job-worker:[\s\S]*?command: npm run job:worker/);
  expect(compose).toMatch(/job-worker:[\s\S]*?secrets:\n      - app_env/);
  expect(compose).toMatch(/job-worker:[\s\S]*?postgres:\n        condition: service_healthy/);
});
