"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { formatMoney } from "@/src/ui/claim-types";

type ReviewRole = "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN";
export type ReviewAction = "CLAIM" | "CONFIRM" | "CORRECT_FIELDS" | "REQUEST_INFORMATION" | "CLOSE" | "RETRY";
export type ReviewCaseDto = {
  id: string;
  kind: "RECEIPT_OCR" | "POLICY_SYNC";
  status: "OPEN" | "CLAIMED" | "RESOLVED" | "CLOSED";
  reasonCode: string;
  assignedReviewer: { id: string; displayName: string } | null;
  claim: { id: string; purpose: string | null; version: number } | null;
  receipt: { id: string; originalFilename: string | null; status: string } | null;
  policySource: { id: string; title: string } | null;
  job: { id: string; kind: string; status: string; failureCode: string | null };
};
type Actor = { id: string; role: ReviewRole };

export function ReviewCenter() {
  const [reviews, setReviews] = useState<ReviewCaseDto[]>([]);
  const [actor, setActor] = useState<Actor | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<ReviewAction | null>(null);
  const [mode, setMode] = useState<"correction" | "request" | "close" | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/admin/reviews", { signal });
    const payload = await response.json() as { actor?: Actor; reviews?: ReviewCaseDto[] };
    if (!response.ok) throw new Error(response.status === 403 ? "你没有复核中心的访问权限。" : "暂时无法读取复核任务，请重新加载。");
    setActor(payload.actor ?? null);
    setReviews(payload.reviews ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((cause) => { if (cause.name !== "AbortError") setError(cause instanceof Error ? cause.message : "暂时无法读取复核任务，请重新加载。"); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  const selected = useMemo(() => reviews.find((review) => review.id === selectedId) ?? null, [reviews, selectedId]);

  async function mutate(review: ReviewCaseDto, action: ReviewAction, body?: Record<string, unknown>) {
    setBusyAction(action); setError(null); setNotice(null);
    try {
      const suffix = action === "CLAIM" ? "claim" : action === "RETRY" ? "retry" : "resolve";
      const response = await fetch(`/api/admin/reviews/${review.id}/${suffix}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(response.status === 409 ? "该任务状态已变化，请刷新后重试。" : response.status === 403 ? "你没有执行此操作的权限。" : "操作未完成，请稍后重试。");
      setMode(null); setMessage(""); setInvoiceNumber(""); setIssuedOn(""); setAmount("");
      setNotice(action === "CLAIM" ? "已领取复核任务。" : action === "RETRY" ? "已重新排队同步任务。" : "复核结果已保存。");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请稍后重试。");
    } finally {
      setBusyAction(null);
    }
  }

  function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.claim) return;
    const corrections: Record<string, unknown> = {};
    if (invoiceNumber.trim()) corrections.invoiceNumber = invoiceNumber.trim();
    if (issuedOn) corrections.issuedOn = issuedOn;
    if (amount.trim()) {
      const cents = Math.round(Number(amount) * 100);
      if (!Number.isFinite(cents) || cents < 0) { setError("请填写有效的含税金额。"); return; }
      corrections.totalAmountCents = cents;
    }
    if (Object.keys(corrections).length === 0) { setError("至少填写一个需要更正的字段。"); return; }
    void mutate(selected, "CORRECT_FIELDS", { action: "CORRECT_FIELDS", expectedVersion: selected.claim.version, corrections });
  }

  function submitMessage(event: FormEvent<HTMLFormElement>, action: "REQUEST_INFORMATION" | "CLOSE") {
    event.preventDefault();
    if (!selected || !message.trim()) { setError(action === "CLOSE" ? "请说明关闭原因。" : "请填写需要员工补充的内容。"); return; }
    void mutate(selected, action, { action, message: message.trim() });
  }

  return <main className="claims-page review-page">
    <header className="claims-header"><Link className="brand" href="/claims">AI 报销 <span>Agent</span></Link><Link className="button-outline" href="/claims">返回我的报销单</Link></header>
    <section className="review-hero"><p className="eyebrow">财务复核中心</p><h1>待办复核</h1><p>领取后再处理；所有更正都会保留在报销单审计记录中。</p></section>
    {error ? <div className="review-alert" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => { setLoading(true); void load().catch(() => setError("暂时无法读取复核任务，请稍后重试。")).finally(() => setLoading(false)); }}>重新加载</button></div> : null}
    {notice ? <p className="review-notice" role="status">{notice}</p> : null}
    {loading ? <section className="review-loading" role="status">正在读取复核任务…</section> : !actor ? null : <div className="review-layout">
      <section className="review-queue" aria-labelledby="review-queue-title"><div className="review-queue-heading"><div><h2 id="review-queue-title">任务队列</h2><p>{reviews.length} 项待处理或已处理任务</p></div><span className="count-badge">{actor.role === "ADMIN" ? "管理员" : "复核员"}</span></div>
        {reviews.length === 0 ? <div className="empty-state">暂无需要你处理的复核任务。系统会在票据或政策同步需要人工判断时显示在这里。</div> : <ul className="review-list">{reviews.map((review) => <li key={review.id}><button type="button" className={`review-row ${selectedId === review.id ? "review-row-active" : ""}`} onClick={() => { setSelectedId(review.id); setMode(null); setError(null); }} aria-pressed={selectedId === review.id}><span className={`review-kind review-kind-${review.kind.toLowerCase()}`}>{reviewKindLabel(review.kind)}</span><strong>{reviewTitle(review)}</strong><small>{reviewStatusLabel(review.status)}{review.assignedReviewer ? ` · ${review.assignedReviewer.displayName}` : ""}</small></button></li>)}</ul>}
      </section>
      <section className="review-detail" aria-live="polite">{selected ? <ReviewDetail review={selected} actor={actor} busyAction={busyAction} mode={mode} onMode={setMode} onAction={(action) => void mutate(selected, action, { action: "CONFIRM" })} onCorrection={submitCorrection} onMessage={submitMessage} invoiceNumber={invoiceNumber} setInvoiceNumber={setInvoiceNumber} issuedOn={issuedOn} setIssuedOn={setIssuedOn} amount={amount} setAmount={setAmount} message={message} setMessage={setMessage} /> : <div className="empty-state">从左侧选择一项任务，查看票据或政策来源，并执行复核操作。</div>}</section>
    </div>}
  </main>;
}

function ReviewDetail(props: { review: ReviewCaseDto; actor: Actor; busyAction: ReviewAction | null; mode: "correction" | "request" | "close" | null; onMode: (mode: "correction" | "request" | "close" | null) => void; onAction: (action: ReviewAction) => void; onCorrection: (event: FormEvent<HTMLFormElement>) => void; onMessage: (event: FormEvent<HTMLFormElement>, action: "REQUEST_INFORMATION" | "CLOSE") => void; invoiceNumber: string; setInvoiceNumber: (value: string) => void; issuedOn: string; setIssuedOn: (value: string) => void; amount: string; setAmount: (value: string) => void; message: string; setMessage: (value: string) => void }) {
  const { review, actor, busyAction, mode } = props;
  const actions = availableReviewActions(review, actor);
  const busy = busyAction !== null;
  return <><div className="review-detail-heading"><div><p className="eyebrow">{reviewKindLabel(review.kind)}</p><h2>{reviewTitle(review)}</h2><p>{review.status === "OPEN" ? "尚未领取" : reviewStatusLabel(review.status)}</p></div><span className="receipt-status receipt-status-pending">{reviewStatusLabel(review.status)}</span></div>
    <dl className="review-facts"><div><dt>处理对象</dt><dd>{review.receipt?.originalFilename || review.policySource?.title || "关联对象"}</dd></div><div><dt>报销事由</dt><dd>{review.claim?.purpose || "未填写"}</dd></div><div><dt>人工处理</dt><dd>{review.assignedReviewer?.displayName || "待领取"}</dd></div></dl>
    {review.claim ? <Link className="button-outline review-claim-link" href={`/claims/${review.claim.id}`}>查看报销工作台</Link> : null}
    <div className="review-actions">{actions.includes("CLAIM") ? <button type="button" className="button-primary" onClick={() => props.onAction("CLAIM")} disabled={busy} aria-busy={busyAction === "CLAIM"}>{busyAction === "CLAIM" ? "正在领取…" : "领取任务"}</button> : null}{actions.includes("RETRY") ? <button type="button" className="button-primary" onClick={() => props.onAction("RETRY")} disabled={busy} aria-busy={busyAction === "RETRY"}>{busyAction === "RETRY" ? "正在重新排队…" : "重新同步"}</button> : null}{actions.includes("CONFIRM") ? <button type="button" className="button-primary" onClick={() => props.onAction("CONFIRM")} disabled={busy} aria-busy={busyAction === "CONFIRM"}>{busyAction === "CONFIRM" ? "正在保存…" : "确认识别结果"}</button> : null}{actions.includes("CORRECT_FIELDS") ? <button type="button" className="button-outline" onClick={() => props.onMode(mode === "correction" ? null : "correction")} disabled={busy}>更正票据字段</button> : null}{actions.includes("REQUEST_INFORMATION") ? <button type="button" className="button-outline" onClick={() => props.onMode(mode === "request" ? null : "request")} disabled={busy}>要求补充信息</button> : null}{actions.includes("CLOSE") ? <button type="button" className="button-outline" onClick={() => props.onMode(mode === "close" ? null : "close")} disabled={busy}>关闭任务</button> : null}</div>
    {mode === "correction" ? <form className="review-form" noValidate onSubmit={props.onCorrection}><h3>更正票据字段</h3><p>更正会以当前报销单版本保存；若员工刚修改了单据，系统会要求刷新后重试。</p><label>发票号码<input value={props.invoiceNumber} onChange={(event) => props.setInvoiceNumber(event.target.value)} /></label><label>开票日期<input type="date" value={props.issuedOn} onChange={(event) => props.setIssuedOn(event.target.value)} /></label><label>价税合计（元）<input inputMode="decimal" value={props.amount} onChange={(event) => props.setAmount(event.target.value)} /></label><button className="button-primary" disabled={busy} aria-busy={busyAction === "CORRECT_FIELDS"}>{busyAction === "CORRECT_FIELDS" ? "正在保存…" : "保存更正"}</button></form> : null}
    {mode === "request" ? <form className="review-form" noValidate onSubmit={(event) => props.onMessage(event, "REQUEST_INFORMATION")}><h3>需要员工补充什么？</h3><label>补充说明<textarea className="resize-none" value={props.message} onChange={(event) => props.setMessage(event.target.value)} rows={3} placeholder="例如：请确认此次住宿对应的出差事由。" /></label><button className="button-primary" disabled={busy} aria-busy={busyAction === "REQUEST_INFORMATION"}>{busyAction === "REQUEST_INFORMATION" ? "正在发送…" : "创建补充项"}</button></form> : null}
    {mode === "close" ? <form className="review-form" noValidate onSubmit={(event) => props.onMessage(event, "CLOSE")}><h3>关闭任务</h3><label>关闭原因<textarea className="resize-none" value={props.message} onChange={(event) => props.setMessage(event.target.value)} rows={3} placeholder="说明为何无需继续处理。" /></label><button className="button-outline" disabled={busy} aria-busy={busyAction === "CLOSE"}>{busyAction === "CLOSE" ? "正在关闭…" : "确认关闭"}</button></form> : null}
  </>;
}

export function availableReviewActions(review: ReviewCaseDto, actor: Actor): ReviewAction[] {
  const manages = review.kind === "RECEIPT_OCR" ? actor.role === "FINANCE_REVIEWER" || actor.role === "ADMIN" : actor.role === "ADMIN";
  if (!manages || review.status === "RESOLVED" || review.status === "CLOSED") return [];
  const actions: ReviewAction[] = [];
  if (review.kind === "POLICY_SYNC") {
    if (actor.role === "ADMIN" && (review.status === "OPEN" || review.status === "CLAIMED")) actions.push("RETRY");
    if (review.status === "OPEN") actions.push("CLAIM");
    if (review.status === "CLAIMED" && (review.assignedReviewer?.id === actor.id || actor.role === "ADMIN")) actions.push("CLOSE");
    return actions;
  }
  if (review.status === "OPEN") actions.push("CLAIM");
  if (review.status === "CLAIMED" && (review.assignedReviewer?.id === actor.id || actor.role === "ADMIN")) actions.push("CONFIRM", "CORRECT_FIELDS", "REQUEST_INFORMATION", "CLOSE");
  return actions;
}

export function reviewStatusLabel(status: ReviewCaseDto["status"]) {
  return ({ OPEN: "等待领取", CLAIMED: "复核处理中", RESOLVED: "已解决", CLOSED: "已关闭" } as const)[status];
}

export function employeeReceiptTaskLabel(status: string) {
  return ({ PENDING: "正在排队识别", EXTRACTING: "正在识别票据信息", REVIEW_REQUIRED: "正在进行人工核验", SUCCEEDED: "已完成识别", FAILED: "识别失败" } as Record<string, string>)[status] ?? "正在处理票据";
}

function reviewKindLabel(kind: ReviewCaseDto["kind"]) { return kind === "RECEIPT_OCR" ? "票据识别" : "政策同步"; }
function reviewTitle(review: ReviewCaseDto) { return review.receipt?.originalFilename || review.policySource?.title || `${reviewKindLabel(review.kind)}任务`; }
