import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import pg from "pg";

loadEnv({ path: resolve(".env.local"), quiet: true });

const { Client } = pg;
const root = resolve(".");
const suffix = `${process.pid}_${randomBytes(3).toString("hex")}`;
const prismaDatabase = `agent_p0_prisma_${suffix}`;
const goDatabase = `agent_p0_go_${suffix}`;
const containerName = `agent-p0-go-${suffix.replaceAll("_", "-")}`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required in .env.local");
  for (const name of ["REIMBURSEMENT_AGENT_SERVICE_KEY", "REIMBURSEMENT_AUTH_HS256_SECRET", "REIMBURSEMENT_AUTH_PROVISIONING_KEY"]) {
    if (!process.env[name]) throw new Error(`${name} is required in .env.local`);
  }
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.port !== "5433") {
    throw new Error("live integration requires the local PostgreSQL on port 5433");
  }
  const adminUrl = new URL(parsed);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  const created: string[] = [];
  let containerStarted = false;
  await admin.connect();
  try {
    for (const name of [prismaDatabase, goDatabase]) {
      await admin.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    const prismaUrl = new URL(parsed);
    prismaUrl.pathname = `/${prismaDatabase}`;
    const goHostUrl = new URL(parsed);
    goHostUrl.pathname = `/${goDatabase}`;
    const goInternalUrl = new URL(goHostUrl);
    goInternalUrl.hostname = "postgres";
    goInternalUrl.port = "5432";

    await run(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", "prisma.test.config.ts"], {
      ...process.env, TEST_DATABASE_URL: prismaUrl.toString(),
    }, "Prisma test migrations");
    const go = new Client({ connectionString: goHostUrl.toString() });
    await go.connect();
    try {
      const directory = resolve("services/reimbursement-api/db/migrations");
      const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
      for (const file of files) await go.query(await readFile(resolve(directory, file), "utf8"));
    } finally {
      await go.end();
    }

    const port = await unusedPort();
    await run("docker", ["compose", "--profile", "migration", "run", "-d", "--no-deps", "--name", containerName, "-p", `127.0.0.1:${port}:8080`, "-e", "REIMBURSEMENT_DATABASE_URL", "reimbursement-api"], {
      ...process.env, REIMBURSEMENT_DATABASE_URL: goInternalUrl.toString(),
    }, "isolated Go API");
    containerStarted = true;
    const apiUrl = `http://127.0.0.1:${port}`;
    await waitForHttp(apiUrl);
    await run(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "tests/integration/agent-live-go-feishu-flow.test.ts"], {
      ...process.env, TEST_DATABASE_URL: prismaUrl.toString(), TEST_AGENT_GO_API_URL: apiUrl,
    }, "Feishu to Go integration");
  } finally {
    let cleanupFailure: Error | undefined;
    if (containerStarted) {
      try { await run("docker", ["rm", "-f", containerName], process.env, "isolated Go API cleanup"); }
      catch (error) { cleanupFailure = error as Error; }
    }
    for (const name of created.reverse()) {
      if (!/^agent_p0_(prisma|go)_[a-z0-9_]+$/.test(name)) throw new Error("refusing to drop a database outside the isolated test names");
      try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      catch (error) { cleanupFailure ??= error as Error; }
    }
    await admin.end();
    if (cleanupFailure) throw cleanupFailure;
  }
  process.stdout.write("Agent live integration passed against two isolated databases; temporary resources removed.\n");
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, step: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", () => reject(new Error(`${step} could not start`)));
    child.on("close", (code) => {
      if (code === 0) {
        if (step === "Feishu to Go integration") process.stdout.write(output);
        resolveRun();
      } else {
        let safeOutput = output;
        for (const [name, value] of Object.entries(env)) {
          if (/(KEY|SECRET|PASSWORD|DATABASE_URL)/i.test(name) && value && value.length >= 8) safeOutput = safeOutput.replaceAll(value, "<redacted>");
        }
        reject(new Error(`${step} failed (exit ${code ?? "unknown"}): ${safeOutput.slice(-1_000)}`));
      }
    });
  });
}

function unusedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not reserve an HTTP port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(baseUrl: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 401 || response.status === 204) return;
    } catch { /* The container may still be starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("isolated Go API did not become reachable");
}

void main().catch((error) => {
  process.stderr.write(`Agent live integration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
