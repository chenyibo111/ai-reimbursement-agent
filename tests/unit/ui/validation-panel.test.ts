import { expect, it } from "vitest";

import * as validationPanel from "@/src/ui/validation-panel";

const { validationMessage } = validationPanel;

it("explains every low-confidence validation code in employee language", () => {
  expect(validationMessage("CONFIRM_TOTAL_AMOUNT")).toBe("请确认低置信度的票据金额。");
  expect(validationMessage("CONFIRM_ISSUED_ON")).toBe("请确认低置信度的开票日期。");
  expect(validationMessage("CONFIRM_INVOICE_NUMBER")).toBe("请确认低置信度的票据号码。");
});

it("keeps policy results separate from base validation and retains their policy version", () => {
  const split = (validationPanel as typeof validationPanel & { splitValidationIssues?: (issues: Array<{ code: string; severity: "BLOCKING" | "WARNING"; message: string; policyVersionId?: string }>) => { base: unknown[]; policy: Array<{ policyVersionId?: string }> } }).splitValidationIssues;
  expect(split).toBeTypeOf("function");
  expect(split?.([
    { code: "PURPOSE_REQUIRED", severity: "BLOCKING", message: "请补充报销事由。" },
    { code: "POLICY_TOTAL", severity: "WARNING", message: "总额提醒", policyVersionId: "policy-v2" },
  ])).toEqual({
    base: [{ code: "PURPOSE_REQUIRED", severity: "BLOCKING", message: "请补充报销事由。" }],
    policy: [{ code: "POLICY_TOTAL", severity: "WARNING", message: "总额提醒", policyVersionId: "policy-v2" }],
  });
});
