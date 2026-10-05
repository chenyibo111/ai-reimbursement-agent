import { spawn } from "node:child_process";

import { config } from "dotenv";

const envResult = config({ path: "/run/secrets/app_env", override: true, quiet: true });
if (envResult.error) throw envResult.error;

function rewriteUrl(name, hostname, port) {
  const value = process.env[name];
  if (!value) return;

  const url = new URL(value);
  url.hostname = hostname;
  url.port = port;
  process.env[name] = url.toString();
}

rewriteUrl("DATABASE_URL", "postgres", "5432");
rewriteUrl("S3_ENDPOINT", "minio", "9000");
rewriteUrl("OCR_SERVICE_URL", "ocr", "8000");
rewriteUrl("EMBEDDING_BASE_URL", "embedding-service", "8080");
process.env.CLAMAV_HOST = "clamav";
process.env.CLAMAV_PORT = "3310";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A container command is required");

const child = spawn(command, args, { env: process.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code) => process.exit(code ?? 1));
