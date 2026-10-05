import { expect, it } from "vitest";

import { withRequestContext } from "@/src/observability/request-context";

it("preserves a caller request ID and returns it on the HTTP response", async () => {
  const response = await withRequestContext(
    new Request("http://localhost/api/claims", { headers: { "x-request-id": "request-correlation-123" } }),
    async (context) => Response.json({ requestId: context.requestId }),
  );

  expect(response.headers.get("x-request-id")).toBe("request-correlation-123");
  await expect(response.json()).resolves.toEqual({ requestId: "request-correlation-123" });
});

it("creates a safe request ID when the caller does not provide one", async () => {
  const response = await withRequestContext(
    new Request("http://localhost/api/claims"),
    async (context) => Response.json({ requestId: context.requestId }),
  );

  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
});
