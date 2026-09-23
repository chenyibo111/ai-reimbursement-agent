"use client";

import { formatMoney, type ValidationIssue } from "@/src/ui/claim-types";

type Preview = { token: string; purpose: string; totalAmountCents: number; receiptCount: number; issues: ValidationIssue[] };
type Props = { preview: Preview | null; isLoading: boolean; onRequest: () => void; onSubmit: (token: string) => void; submittedNumber: string | null };

export function SubmissionSummary({ preview, isLoading, onRequest, onSubmit, submittedNumber }: Props) {
  if (submittedNumber) return <section className="submitted" aria-live="polite"><p className="eyebrow">报销单已提交</p><h2>已生成报销单</h2><p>编号 <strong>{submittedNumber}</strong></p></section>;
  const hasBlocking = preview?.issues.some((issue) => issue.severity === "BLOCKING");
  return <section className="submission" aria-labelledby="submission-title"><p className="eyebrow">最后一步</p><h2 id="submission-title">确认报销单</h2>{preview ? <><dl><div><dt>报销事由</dt><dd>{preview.purpose}</dd></div><div><dt>票据数量</dt><dd>{preview.receiptCount} 张</dd></div><div><dt>报销合计</dt><dd>{formatMoney(preview.totalAmountCents)}</dd></div></dl>{hasBlocking ? <p className="notice-error">仍有阻断项，暂不能提交。</p> : <button type="button" className="button-primary" onClick={() => onSubmit(preview.token)}>确认并提交</button>}</> : <><p>系统会基于最新草稿生成不可变确认摘要。</p><button type="button" className="button-primary" onClick={onRequest} disabled={isLoading}>{isLoading ? "生成中…" : "生成确认摘要"}</button></>}</section>;
}
