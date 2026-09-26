import { z } from "zod";

type PolicyRuleInput = {
  code: string;
  name: string;
  type: "CLAIM_TOTAL_MAX" | "CATEGORY_ITEM_MAX" | "CATEGORY_ALLOWED" | "CATEGORY_REQUIRED_FIELD";
  severity: "BLOCKING" | "WARNING";
  config: unknown;
  sortOrder: number;
};

type PolicyClaimInput = {
  totalAmountCents: number;
  expenseItems: Array<{ id: string; amountCents: number; expenseCategory: string | null; participants: string | null; projectCode: string | null }>;
};

export type PolicyValidationIssue = {
  code: string;
  severity: "BLOCKING" | "WARNING";
  message: string;
  policyVersionId: string;
  ruleCode: string;
};

const configs = {
  CLAIM_TOTAL_MAX: z.object({ maxAmountCents: z.number().int().positive() }).strict(),
  CATEGORY_ITEM_MAX: z.object({ category: z.string().trim().min(1), maxAmountCents: z.number().int().positive() }).strict(),
  CATEGORY_ALLOWED: z.object({ categories: z.array(z.string().trim().min(1)).min(1) }).strict(),
  CATEGORY_REQUIRED_FIELD: z.object({ category: z.string().trim().min(1), field: z.enum(["participants", "projectCode"]) }).strict(),
};

export function evaluatePolicyRules(input: { policyVersionId: string; rules: PolicyRuleInput[]; claim: PolicyClaimInput }): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  for (const rule of [...input.rules].sort((left, right) => left.sortOrder - right.sortOrder)) {
    if (rule.type === "CLAIM_TOTAL_MAX") {
      const config = parseConfig(configs.CLAIM_TOTAL_MAX, rule.config);
      if (input.claim.totalAmountCents > config.maxAmountCents) issues.push(issue(input.policyVersionId, rule, `${rule.name}：报销总额超过上限。`));
    } else if (rule.type === "CATEGORY_ITEM_MAX") {
      const config = parseConfig(configs.CATEGORY_ITEM_MAX, rule.config);
      for (const item of input.claim.expenseItems) {
        if (categoryOf(item) === config.category && item.amountCents > config.maxAmountCents) issues.push(issue(input.policyVersionId, rule, `${rule.name}：${config.category}单笔金额超过上限。`));
      }
    } else if (rule.type === "CATEGORY_ALLOWED") {
      const config = parseConfig(configs.CATEGORY_ALLOWED, rule.config);
      for (const item of input.claim.expenseItems) {
        const category = categoryOf(item);
        if (category && !config.categories.includes(category)) issues.push(issue(input.policyVersionId, rule, `${rule.name}：${category}不在允许范围内。`));
      }
    } else {
      const config = parseConfig(configs.CATEGORY_REQUIRED_FIELD, rule.config);
      for (const item of input.claim.expenseItems) {
        if (categoryOf(item) === config.category && !item[config.field]?.trim()) issues.push(issue(input.policyVersionId, rule, `${rule.name}：请补充${config.field === "participants" ? "同行人" : "项目编码"}。`));
      }
    }
  }
  return issues;
}

function parseConfig<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("invalid policy rule configuration");
  return result.data;
}

function categoryOf(item: PolicyClaimInput["expenseItems"][number]) {
  return item.expenseCategory?.trim() || null;
}

function issue(policyVersionId: string, rule: PolicyRuleInput, message: string): PolicyValidationIssue {
  return { code: `POLICY_${rule.code}`, severity: rule.severity, message, policyVersionId, ruleCode: rule.code };
}
