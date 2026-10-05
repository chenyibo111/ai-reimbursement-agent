"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";

type Source = { id: string; title: string; canonicalUrl: string; type: "FEISHU_DOCX" | "FEISHU_WIKI"; enabled: boolean; lastSuccessfulSyncAt: string | null; lastFailureCode: string | null };

export function PolicySourceManager() {
  const [sources, setSources] = useState<Source[]>([]);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const load = useCallback(async () => { const response = await fetch("/api/admin/policy-sources"); const payload = await response.json(); if (response.ok) setSources(payload.sources ?? []); else setError(payload.error ?? "无法读取来源"); }, []);
  useEffect(() => { void load(); }, [load]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice(""); setIsAdding(true);
    try { const response = await fetch("/api/admin/policy-sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, url }) }); const payload = await response.json(); if (!response.ok) { setError(payload.error ?? "无法添加来源"); return; } setTitle(""); setUrl(""); setNotice("来源已添加，请手动同步。"); await load(); } finally { setIsAdding(false); }
  }

  async function updateEnabled(source: Source) {
    setError(""); setNotice(""); setBusyId(source.id);
    try { const response = await fetch(`/api/admin/policy-sources/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !source.enabled }) }); const payload = await response.json(); if (!response.ok) { setError(payload.error ?? "无法更新来源状态"); return; } setSources((items) => items.map((item) => item.id === source.id ? payload : item)); setNotice(source.enabled ? "来源已停用，不会参与政策问答。" : "来源已启用，可再次手动同步。"); } finally { setBusyId(null); }
  }

  async function sync(source: Source) {
    setError(""); setNotice(""); setBusyId(source.id);
    try { const response = await fetch(`/api/admin/policy-sources/${source.id}/sync`, { method: "POST" }); const payload = await response.json() as Record<string, unknown>; if (!response.ok) { setError(typeof payload.error === "string" ? payload.error : "同步失败；保留上一次成功的政策快照。"); return; } setNotice(policySyncNotice(payload)); await load(); } finally { setBusyId(null); }
  }

  return <main className="claims-page policy-page">
    <header className="claims-header"><Link className="brand" href="/claims">AI 报销 <span>Agent</span></Link><Link className="button-outline" href="/admin/policies">规则管理</Link></header>
    <section className="policy-hero"><p className="eyebrow">政策管理员</p><h1>政策知识来源</h1><p>仅添加已获授权的飞书文档或 Wiki 页面；系统不会搜索或枚举飞书空间。</p></section>
    {error ? <p role="alert" className="notice-error">{error}</p> : null}{notice ? <p role="status" className="policy-status">{notice}</p> : null}
    <form className="policy-create-form" noValidate onSubmit={add}><label>来源标题<input value={title} onChange={(event) => setTitle(event.target.value)} required disabled={isAdding} /></label><label>飞书链接<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://xxx.feishu.cn/docx/..." required disabled={isAdding} /></label><button className="button-primary" disabled={isAdding}>{isAdding ? "正在添加…" : "添加来源"}</button></form>
    <section className="policy-rule-preview" aria-labelledby="policy-source-list-title"><h2 id="policy-source-list-title">已登记来源</h2>{sources.length === 0 ? <p>尚未登记政策来源。添加授权文档后，员工才能获得带原文引用的制度答复。</p> : <ul>{sources.map((source) => { const busy = busyId === source.id; return <li key={source.id}><div><strong>{source.title}</strong><span>{sourceTypeLabel(source.type)} · {source.enabled ? "已启用" : "已停用"} · {source.lastSuccessfulSyncAt ? `上次同步 ${formatDate(source.lastSuccessfulSyncAt)}` : "尚未同步"}</span><a href={source.canonicalUrl} target="_blank" rel="noreferrer">打开原文</a>{source.lastFailureCode ? <p>最近同步失败：{policyFailureLabel(source.lastFailureCode)}。已保留上一次成功内容。</p> : null}</div><div className="policy-source-actions"><button className="button-outline" type="button" onClick={() => void updateEnabled(source)} disabled={busy}>{source.enabled ? "停用来源" : "重新启用"}</button><button className="button-outline" type="button" onClick={() => void sync(source)} disabled={busy || !source.enabled}>{busy ? "处理中…" : "立即同步"}</button></div></li>; })}</ul>}</section>
  </main>;
}

function sourceTypeLabel(type: Source["type"]): string { return type === "FEISHU_WIKI" ? "飞书知识库" : "飞书文档"; }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

export function policySyncNotice(payload: Record<string, unknown>): string {
  if (typeof payload.jobStatus === "string") return "同步任务已加入队列，完成后会更新来源状态。";
  if (payload.status === "UNCHANGED") return "原文未变化，继续使用现有政策快照。";
  if (payload.status === "SYNCED" && typeof payload.chunkCount === "number") return `同步完成：${payload.chunkCount} 个切片。`;
  return "同步请求已受理，完成后会更新来源状态。";
}

export function policyFailureLabel(code: string): string {
  if (code === "EMBEDDING_UNAVAILABLE") return "向量化服务不可用，请检查知识库服务是否已启动";
  if (code === "DOCUMENT_UNAUTHORIZED") return "飞书应用无权读取此文档，请将文档授权给应用";
  if (code === "DOCUMENT_RESOURCE_NOT_FOUND") return "未找到飞书文档，请检查链接是否正确";
  if (code === "DOCUMENT_INVALID_RESPONSE") return "飞书文档访问被拒绝或返回异常，请检查应用权限和文档授权";
  return code;
}
