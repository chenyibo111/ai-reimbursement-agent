"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatMoney } from "@/src/ui/claim-types";

type ClaimListItem = { id: string; status: string; purpose: string | null; updatedAt: string; totalAmountCents: number; submissionNumber: string | null; submittedAt: string | null };

export default function ClaimsPage() {
  const [items, setItems] = useState<ClaimListItem[]>([]);
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ status });
    if (query.trim()) params.set("query", query.trim());
    void fetch(`/api/claims?${params}`, { signal: controller.signal }).then(async (response) => {
      const payload = await response.json() as { items?: ClaimListItem[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "无法读取报销单。");
      setItems(payload.items ?? []); setError(null);
    }).catch((cause) => { if (cause.name !== "AbortError") setError(cause instanceof Error ? cause.message : "无法读取报销单。"); });
    return () => controller.abort();
  }, [status, query]);

  return <main className="claims-page"><header className="claims-header"><Link href="/claims" className="brand">AI 报销 <span>Agent</span></Link><Link href="/claims/new" className="button-primary">发起报销</Link></header><section><p className="eyebrow">个人单据库</p><h1>我的报销单</h1><div className="claims-filters"><label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部</option><option value="DRAFT">草稿</option><option value="SUBMITTED">已提交</option></select></label><label>编号或事由<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号或事由" /></label></div>{error ? <p role="alert" className="notice-error">{error}</p> : null}{items.length ? <div className="table-wrap"><table><thead><tr><th>状态</th><th>报销事由</th><th>金额</th><th>报销单号</th><th>更新时间</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.status === "SUBMITTED" ? "已提交" : "草稿"}</td><td><Link href={item.status === "SUBMITTED" ? `/claims/${item.id}/detail` : `/claims/${item.id}`}>{item.purpose || "未填写报销事由"}</Link></td><td>{formatMoney(item.totalAmountCents)}</td><td>{item.submissionNumber || "—"}</td><td>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(item.updatedAt))}</td></tr>)}</tbody></table></div> : <div className="empty-state">暂无符合条件的报销单。<Link href="/claims/new">发起第一份报销</Link></div>}</section></main>;
}
