"use client";

import { useRef, useState } from "react";

import type { AgentProposal } from "@/src/ui/claim-types";
import { useReceiptUpload } from "@/src/ui/use-receipt-upload";

type Props = { claimId: string; version: number; proposals: AgentProposal[]; onComplete: () => void };
type Turn = { author: "assistant" | "employee"; text: string };
const labels: Record<AgentProposal["field"], string> = { purpose: "报销事由", invoiceNumber: "发票号码", issuedOn: "开票日期", totalAmountCents: "价税合计" };

export function ClaimChat({ claimId, version, proposals, onComplete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [turns, setTurns] = useState<Turn[]>([{ author: "assistant", text: "我会根据票据和规则提示下一项需要补充的信息。" }]);
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const { upload, message: uploadMessage, isUploading } = useReceiptUpload({ claimId, onComplete: () => { onComplete(); setTurns((items) => [...items, { author: "assistant", text: "附件已处理完成，请在票据区域查看识别结果。" }]); } });

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const content = message.trim(); if (!content || isSending) return;
    setTurns((current) => [...current, { author: "employee", text: content }]); setMessage(""); setIsSending(true);
    try { const response = await fetch(`/api/claims/${claimId}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: content }) }); const result = await response.json() as { reply?: string; error?: string; clarifications?: Array<{ prompt: string }> }; if (!response.ok) throw new Error(result.error || "暂时无法处理这条消息。"); setTurns((current) => [...current, { author: "assistant", text: [result.reply, result.clarifications?.[0]?.prompt].filter(Boolean).join("\n") || "已记录，我会继续检查报销单。" }]); onComplete(); }
    catch (error) { setTurns((current) => [...current, { author: "assistant", text: error instanceof Error ? error.message : "暂时无法处理这条消息。" }]); }
    finally { setIsSending(false); }
  }

  async function resolve(proposal: AgentProposal, action: "accept" | "reject") {
    setResolving(proposal.id);
    try { const response = await fetch(`/api/claims/${claimId}/agent-proposals/${proposal.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: version }) }); const payload = await response.json() as { error?: string }; if (!response.ok) throw new Error(response.status === 409 ? "草稿已更新，请刷新后重新确认建议。" : payload.error || "无法处理该建议。"); onComplete(); }
    catch (error) { setTurns((items) => [...items, { author: "assistant", text: error instanceof Error ? error.message : "无法处理该建议。" }]); }
    finally { setResolving(null); }
  }

  return <section className="chat-panel" aria-labelledby="claim-chat-title">
    <div className="section-heading"><div><p className="eyebrow">AI 澄清</p><h2 id="claim-chat-title">补充说明</h2></div></div>
    <div className="chat-log" aria-live="polite">{turns.map((turn, index) => <p className={turn.author === "assistant" ? "message-assistant" : "message-employee"} key={`${turn.author}-${index}`}>{turn.text}</p>)}</div>
    {proposals.length ? <ul className="agent-proposals" aria-label="AI 字段建议">{proposals.map((proposal) => <li key={proposal.id}><strong>{labels[proposal.field]}：{proposal.displayValue}</strong><p>{proposal.reason}</p>{proposal.status === "PENDING" ? <div><button className="button-primary" type="button" disabled={resolving !== null} onClick={() => void resolve(proposal, "accept")}>{resolving === proposal.id ? "处理中…" : "接受并写入"}</button><button className="button-outline" type="button" disabled={resolving !== null} onClick={() => void resolve(proposal, "reject")}>忽略</button></div> : <span className="receipt-status">{proposal.status === "ACCEPTED" ? "已接受" : proposal.status === "REJECTED" ? "已忽略" : "已过期"}</span>}</li>)}</ul> : null}
    <div className="chat-attachment"><input ref={inputRef} className="sr-only" type="file" accept="image/jpeg,image/png,application/pdf" aria-label="在对话中上传票据" onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} /><button className="button-outline" type="button" onClick={() => inputRef.current?.click()} disabled={isUploading}>{isUploading ? "附件处理中…" : "上传附件"}</button><span role="status">{uploadMessage}</span></div>
    <form className="chat-form" noValidate onSubmit={send}><label className="sr-only" htmlFor="agent-message">回复 AI</label><input id="agent-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：本次为客户拜访" disabled={isSending} /><button className="button-primary" type="submit" disabled={!message.trim() || isSending}>{isSending ? "发送中…" : "发送"}</button></form>
  </section>;
}
