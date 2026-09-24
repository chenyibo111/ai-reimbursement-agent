"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@/src/ui/claim-types";

export default function SubmissionDetailPage({ params }: { params: Promise<{ claimId: string }> }) {
  const [detail, setDetail] = useState<{ submissionNumber: string; submittedAt: string; purpose?: string; totalAmountCents?: number; expenseItems?: Array<{ invoiceNumber?: string; amountCents?: number; issuedOn?: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void params.then(async ({ claimId }) => { const response = await fetch(`/api/claims/${claimId}/detail`); const payload = await response.json(); if (!response.ok) { setError(payload.error || "无法读取报销单。"); return; } setDetail(payload); }); }, [params]);
  return <main className="claims-page"><header className="claims-header"><Link href="/claims" className="brand">AI 报销 <span>Agent</span></Link><Link href="/claims" className="button-outline">返回列表</Link></header>{error ? <p role="alert" className="notice-error">{error}</p> : !detail ? <p role="status">正在读取报销单…</p> : <section className="submitted"><p className="eyebrow">不可变提交快照</p><h1>报销单 {detail.submissionNumber}</h1><p>提交时间：{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(detail.submittedAt))}</p><dl><div><dt>报销事由</dt><dd>{detail.purpose || "—"}</dd></div><div><dt>报销合计</dt><dd>{formatMoney(detail.totalAmountCents ?? 0)}</dd></div></dl><div className="table-wrap"><table><thead><tr><th>发票号码</th><th>开票日期</th><th>金额</th></tr></thead><tbody>{detail.expenseItems?.map((item, index) => <tr key={index}><td>{item.invoiceNumber || "待补充"}</td><td>{item.issuedOn || "待补充"}</td><td>{formatMoney(item.amountCents ?? 0)}</td></tr>)}</tbody></table></div></section>}</main>;
}
