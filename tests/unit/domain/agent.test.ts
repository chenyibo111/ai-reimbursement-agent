import { expect, it } from "vitest";

import { allowedAgentTools, isAllowedAgentTool } from "@/src/domain/agent";

it("exposes only read, validation, and field-update tools to the agent", () => {
  expect(allowedAgentTools).toEqual(["get_claim_summary", "update_claim_field", "validate_claim"]);
  expect(isAllowedAgentTool("submit_claim")).toBe(false);
});
