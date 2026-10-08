import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("reimbursement migration routing", () => {
  it("publishes only React, Auth BFF, and Go API paths while rejecting internal provisioning", async () => {
    const nginx = await readFile(resolve(root, "infra/nginx/reimbursement-routes.conf"), "utf8");

    expect(nginx).toMatch(/location \^~ \/internal\/\s*\{\s*return 404;/);
    expect(nginx).toContain("location ^~ /api/auth/");
    expect(nginx).toContain("proxy_pass http://web:3000");
    expect(nginx).toContain("location ^~ /api/v1/");
    expect(nginx).toContain("proxy_pass http://reimbursement-api:8080");
    expect(nginx).toContain("location /");
    expect(nginx).toContain("proxy_pass http://reimbursement-web:8080");
  });

  it("keeps the Go API private and does not place secrets in public routing or operator guidance", async () => {
    const [compose, nginx, runbook] = await Promise.all([
      readFile(resolve(root, "docker-compose.yml"), "utf8"),
      readFile(resolve(root, "infra/nginx/reimbursement-routes.conf"), "utf8"),
      readFile(resolve(root, "docs/operations/unified-feishu-identity.md"), "utf8"),
    ]);

    const apiService = compose.slice(compose.indexOf("  reimbursement-api:"), compose.indexOf("  reimbursement-web:"));
    expect(apiService).toMatch(/expose:\s*\n\s*- "8080"/);
    expect(apiService).not.toContain("ports:");
    expect(`${nginx}\n${runbook}`).not.toMatch(/(?:REIMBURSEMENT_AUTH_HS256_SECRET|REIMBURSEMENT_AUTH_PROVISIONING_KEY)=\S+/);
  });
});
