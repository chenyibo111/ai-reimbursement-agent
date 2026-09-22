import { expect, it } from "vitest";

import { transitionClaim } from "@/src/domain/claim";
import { assertClaimOwner } from "@/src/server/authorization";

it("rejects awaiting confirmation when a draft has no purpose", () => {
  expect(() => transitionClaim({ status: "DRAFT", purpose: null }, "AWAITING_CONFIRMATION")).toThrow(
    "purpose is required",
  );
});

it("rejects an actor who does not own the claim", () => {
  expect(() => assertClaimOwner("employee-a", { employeeId: "employee-b" })).toThrow("forbidden");
});

it("rejects every transition from a submitted claim", () => {
  expect(() => transitionClaim({ status: "SUBMITTED", purpose: "客户拜访" }, "DRAFT")).toThrow(
    "submitted claims are immutable",
  );
});
