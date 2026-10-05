import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("runs the durable job worker with the same secret and dependencies as the web service", async () => {
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  expect(compose).toMatch(/^  job-worker:\r?\n/m);
  expect(compose).toMatch(/job-worker:[\s\S]*?command: npm run job:worker:container/);
  expect(compose).toMatch(/job-worker:[\s\S]*?secrets:\r?\n      - app_env/);
  expect(compose).toMatch(/job-worker:[\s\S]*?postgres:\r?\n        condition: service_healthy/);
});

it("starts the container worker from its injected environment instead of a local env file", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(packageJson.scripts["job:worker:container"]).toBe("tsx src/worker/job-worker.ts");
});

it("starts the container Feishu worker from its injected environment instead of a local env file", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  expect(packageJson.scripts["feishu:worker:container"]).toBe("tsx src/worker/feishu-bot.ts");
  expect(compose).toMatch(/feishu-bot-worker:[\s\S]*?command: npm run feishu:worker:container/);
});

it("keeps the TypeScript path configuration in the worker runtime image", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");

  expect(dockerfile).toContain("COPY --from=build /app/tsconfig.json ./tsconfig.json");
});

it("rewrites host-only service addresses for the Compose network at runtime", async () => {
  const runtime = await readFile(new URL("../../scripts/docker-runtime.mjs", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  expect(runtime).toContain('rewriteUrl("DATABASE_URL", "postgres", "5432")');
  expect(runtime).toContain('rewriteUrl("S3_ENDPOINT", "minio", "9000")');
  expect(runtime).toContain('rewriteUrl("OCR_SERVICE_URL", "ocr", "8000")');
  expect(runtime).toContain('rewriteUrl("EMBEDDING_BASE_URL", "embedding-service", "8080")');
  expect(runtime).toContain('process.env.CLAMAV_HOST = "clamav"');
  expect(dockerfile).toContain("COPY --from=build /app/scripts ./scripts");
  expect(compose).toContain('entrypoint: ["node", "/app/scripts/docker-runtime.mjs"]');
});

it("uses a health-check command that exists in the pinned MinIO image", async () => {
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  expect(compose).toContain("curl -fsS http://127.0.0.1:9000/minio/health/live");
  expect(compose).not.toContain("wget -q -O /dev/null http://127.0.0.1:9000/minio/health/live");
});

it("falls back to application S3 credentials when MinIO root credentials are absent", async () => {
  const compose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  expect(compose).toContain('MINIO_ROOT_USER=\\"$${MINIO_ROOT_USER:-$${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}}\\"');
  expect(compose).toContain('MINIO_ROOT_PASSWORD=\\"$${MINIO_ROOT_PASSWORD:-$${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}}\\"');
});
