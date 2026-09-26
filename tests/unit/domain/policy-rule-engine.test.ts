import { expect, it } from "vitest";

import { evaluatePolicyRules } from "@/src/domain/policy-rule-engine";

it("reports blocking and warning rule results without treating amounts at their limits as violations", () => {
  const issues = evaluatePolicyRules({
    policyVersionId: "policy-2026",
    claim: {
      totalAmountCents: 100_000,
      expenseItems: [
        { id: "expense-1", amountCents: 100_000, expenseCategory: "交通", participants: null, projectCode: null },
        { id: "expense-2", amountCents: 2_000, expenseCategory: "餐饮", participants: null, projectCode: null },
      ],
    },
    rules: [
      { code: "TOTAL", name: "总额上限", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", config: { maxAmountCents: 100_000 }, sortOrder: 0 },
      { code: "TRAFFIC", name: "交通单笔上限", type: "CATEGORY_ITEM_MAX", severity: "BLOCKING", config: { category: "交通", maxAmountCents: 100_000 }, sortOrder: 1 },
      { code: "CATEGORY", name: "费用类别", type: "CATEGORY_ALLOWED", severity: "WARNING", config: { categories: ["交通"] }, sortOrder: 2 },
      { code: "MEAL_PARTICIPANTS", name: "餐饮同行人", type: "CATEGORY_REQUIRED_FIELD", severity: "BLOCKING", config: { category: "餐饮", field: "participants" }, sortOrder: 3 },
    ],
  });

  expect(issues).toEqual([
    expect.objectContaining({ code: "POLICY_CATEGORY", severity: "WARNING", policyVersionId: "policy-2026" }),
    expect.objectContaining({ code: "POLICY_MEAL_PARTICIPANTS", severity: "BLOCKING", policyVersionId: "policy-2026" }),
  ]);
});

it("rejects malformed persisted rule configuration instead of evaluating it", () => {
  expect(() => evaluatePolicyRules({
    policyVersionId: "policy-2026",
    claim: { totalAmountCents: 0, expenseItems: [] },
    rules: [{ code: "BAD", name: "错误规则", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", config: { maxAmountCents: -1 }, sortOrder: 0 }],
  })).toThrow("invalid policy rule configuration");
});
