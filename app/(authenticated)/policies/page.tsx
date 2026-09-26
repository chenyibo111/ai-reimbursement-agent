"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type CurrentPolicy = {
  title: string;
  version: number;
  effectiveFrom: string;
  rules: Array<{ code: string; name: string; type: string; severity: "BLOCKING" | "WARNING" }>;
};

export default function PoliciesPage() {
  const [policy, setPolicy] = useState<CurrentPolicy | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/policies/current");
      const payload = await response.json() as { policy?: CurrentPolicy | null; error?: string };
      if (!response.ok) throw new Error(payload.error || "无法读取当前政策。");
      setPolicy(payload.policy ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取当前政策。");
      setPolicy(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <main className="claims-page policy-page">
    <header className="claims-header"><Link href="/claims" className="brand">AI 报销 <span>Agent</span></Link><Link href="/claims" className="button-outline">我的报销单</Link></header>
    <section className="policy-hero">
      <p className="eyebrow">员工政策中心</p><h1>当前报销政策</h1><p>提交前检查只执行已发布的结构化规则；制度问答会在后续知识库同步后提供原文依据。</p>
    </section>
    {error ? <section className="empty-state" role="alert"><strong>暂时无法读取政策</strong><p>{error}</p><button type="button" className="button-outline" onClick={() => void load()}>重新加载</button></section> : policy === undefined ? <p role="status" className="policy-loading">正在读取当前政策…</p> : !policy ? <section className="empty-state"><h2>尚未发布可执行政策</h2><p>当前报销单仍会执行基础完整性和重复票据检查；请以公司正式制度为准。</p></section> : <section className="policy-card" aria-labelledby="policy-title">
      <div className="policy-card-heading"><div><p className="eyebrow">生效版本 V{policy.version}</p><h2 id="policy-title">{policy.title}</h2></div><span>生效于 {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(policy.effectiveFrom))}</span></div>
      <ul className="policy-rule-list">{policy.rules.map((rule) => <li key={rule.code}><strong>{rule.name}</strong><span className={rule.severity === "BLOCKING" ? "policy-severity-blocking" : "policy-severity-warning"}>{rule.severity === "BLOCKING" ? "阻断" : "预警"}</span><small>规则代码：{rule.code}</small></li>)}</ul>
    </section>}
  </main>;
}
