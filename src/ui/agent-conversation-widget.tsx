"use client";

import { useRef, useState } from "react";

import type { AgentConversationIntake, AgentConversationMessage, ConversationCitation } from "@/src/ui/use-agent-conversation";
import { useAgentConversation } from "@/src/ui/use-agent-conversation";

export function AgentConversationWidget() {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const { state, error, isLoading, isSending, refresh, send, upload } = useAgentConversation();
  const intake = state?.intake;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = message.trim();
    if (!value || isSending) return;
    setMessage("");
    try { await send(value); } catch { setMessage(value); }
  }

  async function selectFile(file: File | undefined) {
    if (!file || isSending) return;
    try { await upload(file); } catch { /* The hook exposes the actionable error in the panel. */ }
  }

  async function sendShortcut(value: "开始报销" | "确认提交") {
    if (isSending) return;
    try { await send(value); } catch { /* The hook exposes the actionable error in the panel. */ }
  }

  return <aside className={`agent-widget${isOpen ? " agent-widget-open" : ""}`} aria-label="报销助理">
    {isOpen ? <section id="agent-conversation-panel" className="agent-widget-panel" aria-labelledby="agent-widget-title">
      <header className="agent-widget-header">
        <div><p className="eyebrow">独立会话</p><h2 id="agent-widget-title">报销助理</h2><p>问制度、上传票据或开始报销。</p></div>
        <button className="agent-widget-close" type="button" onClick={() => setIsOpen(false)} aria-label="收起报销助理">×</button>
      </header>
      {intake ? <IntakeStatus intake={intake} /> : <p className="agent-widget-context">这是你的私有会话；它不会修改当前手动创建的草稿。</p>}
      <div className="agent-widget-log" aria-live="polite" aria-busy={isLoading}>
        {isLoading ? <p className="agent-widget-muted" role="status">正在读取已保存的对话…</p> : null}
        {!isLoading && !state?.messages.length ? <p className="agent-widget-muted">你可以先问报销制度，或点击“开始报销”。</p> : null}
        {state?.messages.map((item) => <ConversationMessage key={item.id} message={item} />)}
      </div>
      {error ? <div className="agent-widget-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => void refresh()} disabled={isSending}>重新加载</button></div> : null}
      <input ref={fileInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,application/pdf" aria-label="上传报销票据" onChange={(event) => { void selectFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      <div className="agent-widget-actions">
        <button type="button" className="button-outline" onClick={() => void sendShortcut("开始报销")} disabled={isSending || intake?.status === "READY_TO_SUBMIT"}>开始报销</button>
        <button type="button" className="button-outline" onClick={() => fileInputRef.current?.click()} disabled={isSending}>上传票据</button>
        {intake?.status === "READY_TO_SUBMIT" ? <button type="button" className="button-primary" onClick={() => void sendShortcut("确认提交")} disabled={isSending} aria-busy={isSending}>确认提交</button> : null}
      </div>
      <form className="agent-widget-form" noValidate onSubmit={submit}>
        <label className="sr-only" htmlFor="agent-conversation-message">向报销助理发送消息</label>
        <input ref={inputRef} id="agent-conversation-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：住宿报销上限是多少？" disabled={isSending} maxLength={2000} />
        <button className="button-primary" type="submit" disabled={!message.trim() || isSending} aria-busy={isSending}>{isSending ? "发送中…" : "发送"}</button>
      </form>
    </section> : null}
    <button className="agent-widget-trigger" type="button" onClick={() => { setIsOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }} aria-expanded={isOpen} aria-controls="agent-conversation-panel">
      <span className="agent-widget-trigger-mark" aria-hidden="true">AI</span><span>报销助理</span>
      {intake && intake.status !== "SUBMITTED" ? <span className="agent-widget-trigger-state">办理中</span> : null}
    </button>
  </aside>;
}

function IntakeStatus({ intake }: { intake: AgentConversationIntake }) {
  const labels: Record<string, string> = { COLLECTING: "正在补齐信息", READY_TO_SUBMIT: "等待确认提交", SUBMITTED: "已提交", ABANDONED: "已结束" };
  const preview = intake.submissionPreview;
  return <div className="agent-widget-intake">
    <strong>{labels[intake.status] ?? "办理中"}</strong>
    {intake.pendingFields.length ? <span>待补：{intake.pendingFields.join("、")}</span> : <span>信息已齐全</span>}
    {intake.status === "READY_TO_SUBMIT" && preview ? <div className="agent-widget-submission-preview" aria-label="提交前摘要">
      <span>事由：{preview.purpose || "未填写"}</span>
      <span>金额：{formatCny(preview.totalAmountCents)}</span>
      <span>票据：{preview.receiptCount ?? "—"} 张</span>
      {preview.issueCount > 0 ? <span>提示：{preview.issueCount} 项</span> : null}
    </div> : null}
  </div>;
}

function formatCny(amountCents: number | null): string {
  if (amountCents === null) return "—";
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(amountCents / 100);
}

function ConversationMessage({ message }: { message: AgentConversationMessage }) {
  return <article className={`agent-widget-message agent-widget-message-${message.role.toLowerCase()}`}>
    <p><span className="agent-widget-message-source">{message.role === "USER" ? (message.channel === "FEISHU" ? "飞书" : "你") : "报销助理"}</span>{message.text}</p>
    {message.citations?.map((citation) => <CitationCard key={citation.id} citation={citation} />)}
  </article>;
}

function CitationCard({ citation }: { citation: ConversationCitation }) {
  const section = citation.headingPath.filter(Boolean).join(" · ");
  return <details className="agent-widget-citation">
    <summary>依据：{citation.title}{section ? ` · ${section}` : ""}</summary>
    <p>{citation.excerpt}</p>
    <a href={citation.url} target="_blank" rel="noreferrer">查看制度原文</a>
  </details>;
}
