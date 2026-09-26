"use client";

import type { ValidationIssue } from "@/src/ui/claim-types";

const labels: Record<string, string> = {
  PURPOSE_REQUIRED: "请补充报销事由。",
  EXPENSE_REQUIRED: "请至少上传并识别一张可计入的票据。",
  CONFIRM_TOTAL_AMOUNT: "请确认低置信度的票据金额。",
  CONFIRM_ISSUED_ON: "请确认低置信度的开票日期。",
  CONFIRM_INVOICE_NUMBER: "请确认低置信度的票据号码。",
  DUPLICATE_RECEIPT: "发现重复票据，请处理后再提交。",
};

export function validationMessage(code: string) {
  return labels[code] || code;
}

export function splitValidationIssues(issues: ValidationIssue[]) {
  return {
    base: issues.filter((issue) => !issue.policyVersionId),
    policy: issues.filter((issue) => Boolean(issue.policyVersionId)),
  };
}

export function ValidationPanel({ issues, policyVersionLabel }: { issues: ValidationIssue[]; policyVersionLabel?: string | null }) {
  const blocking = issues.filter((issue) => issue.severity === "BLOCKING");
  const { base, policy } = splitValidationIssues(issues);
  return <section className={blocking.length ? "validation-blocking" : "validation-clear"} aria-labelledby="validation-title">
    <p className="eyebrow">提交前检查</p><h2 id="validation-title">{blocking.length ? `还有 ${blocking.length} 项需要处理` : "可以生成确认摘要"}</h2>
    {issues.length ? <>{base.length ? <div className="validation-group"><h3>基础校验</h3><ul>{base.map((issue) => <li key={`${issue.code}-${issue.message}`}>{issue.message || validationMessage(issue.code)}</li>)}</ul></div> : null}{policy.length ? <div className="validation-group"><h3>政策规则</h3><ul>{policy.map((issue) => <li key={`${issue.code}-${issue.message}`}><strong>{issue.message || validationMessage(issue.code)}</strong><span>{issue.severity === "BLOCKING" ? "阻断" : "预警"} · 政策版本 {policyVersionLabel || issue.policyVersionId}</span></li>)}</ul></div> : null}</> : <p>当前没有发现阻断项。生成摘要后，请再次核对金额和事由。</p>}
  </section>;
}
