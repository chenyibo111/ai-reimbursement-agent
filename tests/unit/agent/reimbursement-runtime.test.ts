import { describe, expect, it } from "vitest";

import { createAgentReimbursementRuntime } from "@/src/agent/reimbursement-runtime";

describe("createAgentReimbursementRuntime", () => {
  it("refuses to run without the Go API configuration", () => {
    expect(() => createAgentReimbursementRuntime({} as never, { NODE_ENV: "test" })).toThrow("REIMBURSEMENT_API_URL is required");
    expect(() => createAgentReimbursementRuntime({} as never, { NODE_ENV: "test", REIMBURSEMENT_API_URL: "http://localhost:8080" })).toThrow("REIMBURSEMENT_AGENT_SERVICE_KEY is required");
    expect(() => createAgentReimbursementRuntime({} as never, { NODE_ENV: "test", REIMBURSEMENT_API_URL: "http://localhost:8080", REIMBURSEMENT_AGENT_SERVICE_KEY: "service-key" })).toThrow("REIMBURSEMENT_AUTH_HS256_SECRET is required");
  });
});
