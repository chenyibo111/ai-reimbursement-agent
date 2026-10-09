import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("reimbursement migration routing", () => {
  it("publishes only React, Auth BFF, and Go API paths while rejecting internal provisioning", async () => {
    const nginx = await readFile(resolve(root, "infra/nginx/reimbursement-routes.conf"), "utf8");

    expect(nginx).toMatch(/location \^~ \/internal\/\s*\{\s*return 404;/);
    expect(nginx).toContain("location ^~ /api/auth/");
    expect(nginx).toContain("resolver 127.0.0.11 valid=10s ipv6=off;");
    expect(nginx).toContain("proxy_pass http://$auth_bff_upstream");
    expect(nginx).toContain("proxy_set_header Host $http_host;");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Host $http_host;");
    expect(nginx).toContain("proxy_set_header X-Forwarded-Port $server_port;");
    expect(nginx).toContain("location ^~ /api/v1/");
    expect(nginx).toContain("proxy_pass http://$reimbursement_api_upstream");
    expect(nginx).toContain("location /");
    expect(nginx).toContain("proxy_pass http://$reimbursement_web_upstream");
  });

  it("keeps the Go API private and does not place secrets in public routing or operator guidance", async () => {
    const [compose, nginx, runbook] = await Promise.all([
      readFile(resolve(root, "docker-compose.yml"), "utf8"),
      readFile(resolve(root, "infra/nginx/reimbursement-routes.conf"), "utf8"),
      readFile(resolve(root, "docs/operations/unified-feishu-identity.md"), "utf8"),
    ]);

    const apiService = compose.slice(compose.indexOf("  reimbursement-api:"), compose.indexOf("  reimbursement-web:"));
    const authBffService = compose.slice(compose.indexOf("  web:"), compose.indexOf("  feishu-bot-worker:"));
    expect(apiService).toMatch(/expose:\s*\n\s*- "8080"/);
    expect(apiService).not.toContain("ports:");
    expect(authBffService).toContain('"127.0.0.1:3000:3000"');
    expect(`${nginx}\n${runbook}`).not.toMatch(/(?:REIMBURSEMENT_AUTH_HS256_SECRET|REIMBURSEMENT_AUTH_PROVISIONING_KEY)=\S+/);
  });
});
