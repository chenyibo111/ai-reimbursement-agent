import { describe, expect, it } from "vitest";
import { formatPolicyContext } from "./policy-context";

describe("formatPolicyContext", () => {
  it("keeps policy context explanatory", () => expect(formatPolicyContext({ versionId: "v1", effectiveDate: "2026-10-01", summary: "住宿限额" })).toContain("仅用于解释"));
});
