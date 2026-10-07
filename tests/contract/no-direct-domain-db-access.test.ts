import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("React and Agent reimbursement boundary", () => {
  it("reserves reimbursement database access for the Go API and exposes an Agent port", () => {
    const compose = read("docker-compose.yml");
    const reimbursementApi = compose.slice(compose.indexOf("  reimbursement-api:"), compose.indexOf("\n  loki:"));

    expect(reimbursementApi).toContain("REIMBURSEMENT_DATABASE_URL");
    expect(reimbursementApi).not.toMatch(/\n\s+ports:/);
    expect(read("apps/web/package.json")).not.toContain("DATABASE_URL");
    expect(read("services/agent/package.json")).not.toContain("DATABASE_URL");

    const port = join(root, "services/agent/src/ports/reimbursement-port.ts");
    expect(existsSync(port)).toBe(true);
    expect(readFileSync(port, "utf8")).toContain("export interface ReimbursementPort");
  });
});
