"use client";

import { useState } from "react";

type Props = { claimId: string; onComplete: () => void };
type Turn = { author: "assistant" | "employee"; text: string };

export function ClaimChat({ claimId, onComplete }: Props) {
  const [turns, setTurns] = useState<Turn[]>([{ author: "assistant", text: "我会根据票据和规则提示下一项需要补充的信息。" }]);
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = message.trim();
    if (!content || isSending) return;
    setTurns((current) => [...current, { author: "employee", text: content }]);
    setMessage("");
    setIsSending(true);
    try {
      const response = await fetch(`/api/claims/${claimId}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: content }) });
      const result = await response.json() as { reply?: string; error?: string; clarifications?: Array<{ prompt: string }> };
      if (!response.ok) throw new Error(result.error || "暂时无法处理这条消息。");
      const clarification = result.clarifications?.[0]?.prompt;
      setTurns((current) => [...current, { author: "assistant", text: [result.reply, clarification].filter(Boolean).join("\n") || "已记录，我会继续检查报销单。" }]);
      onComplete();
    } catch (error) {
      setTurns((current) => [...current, { author: "assistant", text: error instanceof Error ? error.message : "暂时无法处理这条消息。" }]);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="chat-panel" aria-labelledby="claim-chat-title">
      <div className="section-heading"><div><p className="eyebrow">AI 澄清</p><h2 id="claim-chat-title">补充说明</h2></div></div>
      <div className="chat-log" aria-live="polite">
        {turns.map((turn, index) => <p className={turn.author === "assistant" ? "message-assistant" : "message-employee"} key={`${turn.author}-${index}`}>{turn.text}</p>)}
      </div>
      <form className="chat-form" noValidate onSubmit={send}>
        <label className="sr-only" htmlFor="agent-message">回复 AI</label>
        <input id="agent-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：本次为客户拜访" disabled={isSending} />
        <button className="button-primary" type="submit" disabled={!message.trim() || isSending}>{isSending ? "发送中…" : "发送"}</button>
      </form>
    </section>
  );
}
