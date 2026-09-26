"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ClaimChat } from "@/src/ui/claim-chat";
import { type ClaimSummary, type ConfirmableExpenseField, type ExpenseItem, formatMoney, hasBlockingValidation, type ValidationIssue } from "@/src/ui/claim-types";
import { ExpenseTable } from "@/src/ui/expense-table";
import { ReceiptUpload } from "@/src/ui/receipt-upload";
import { SubmissionSummary } from "@/src/ui/submission-summary";
import { ValidationPanel } from "@/src/ui/validation-panel";
import styles from "./page.module.css";

type Preview = { token: string; purpose: string; totalAmountCents: number; receiptCount: number; issues: ValidationIssue[] };

export default function ClaimPage({ params }: { params: Promise<{ claimId: string }> }) {
  const router = useRouter();
  const [claimId, setClaimId] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimSummary | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [submittedNumber, setSubmittedNumber] = useState<string | null>(null);
  const [purposeDraft, setPurposeDraft] = useState("");
  const [isSavingPurpose, setIsSavingPurpose] = useState(false);
  const [purposeStatus, setPurposeStatus] = useState<string | null>(null);

  useEffect(() => { void params.then(({ claimId: id }) => setClaimId(id)); }, [params]);

  const refresh = useCallback(async (mode: "full" | "background" = "full") => {
    if (!claimId) return;
    if (mode === "full") setIsLoading(true);
    setError(null);
    try {
      const [claimResponse, validationResponse] = await Promise.all([fetch(`/api/claims/${claimId}`), fetch(`/api/claims/${claimId}/validate`)]);
      const claimPayload = await claimResponse.json() as ClaimSummary & { error?: string };
      const validationPayload = await validationResponse.json() as { issues?: ValidationIssue[]; error?: string };
      if (!claimResponse.ok) throw new Error(claimPayload.error || "无法读取当前报销草稿。");
      setClaim(claimPayload);
      setPurposeDraft(claimPayload.purpose ?? "");
      setIssues(validationResponse.ok ? validationPayload.issues ?? [] : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取当前报销草稿。"); }
    finally { if (mode === "full") setIsLoading(false); }
  }, [claimId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function savePurpose() {
    if (!claim) return;
    const purpose = purposeDraft.trim();
    if (!purpose) { setError("请填写报销事由后再保存。"); return; }
    setIsSavingPurpose(true); setError(null); setPurposeStatus(null);
    try {
      const response = await fetch(`/api/claims/${claim.id}/fields`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ field: "purpose", value: purpose, expectedVersion: claim.version }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "无法保存报销事由。");
      setPurposeStatus("报销事由已保存。");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存报销事由。"); }
    finally { setIsSavingPurpose(false); }
  }

  async function confirmField(item: ExpenseItem, field: ConfirmableExpenseField, value: string | number) {
    if (!claim) return false;
    const response = await fetch(`/api/claims/${claim.id}/fields`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ field, value, expenseItemId: item.id, expectedVersion: claim.version }) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setError(payload.error || "无法保存字段确认。"); return false; }
    await refresh();
    return true;
  }

  async function requestPreview() {
    if (!claim) return;
    setIsPreviewing(true); setError(null);
    try { const response = await fetch(`/api/claims/${claim.id}/submission-request`, { method: "POST" }); const payload = await response.json() as Preview & { error?: string }; if (!response.ok) { if (payload.issues) setIssues(payload.issues); throw new Error(payload.error || "无法生成确认摘要。"); } setPreview(payload); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法生成确认摘要。"); }
    finally { setIsPreviewing(false); }
  }

  async function submit(token: string) {
    if (!claim) return;
    setError(null);
    try { const response = await fetch(`/api/claims/${claim.id}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationToken: token }) }); const payload = await response.json() as { submissionNumber?: string; error?: string; issues?: ValidationIssue[] }; if (!response.ok || !payload.submissionNumber) { if (payload.issues) setIssues(payload.issues); throw new Error(payload.error || "提交失败，请重新生成确认摘要。"); } setSubmittedNumber(payload.submissionNumber); router.replace(`/claims/${claim.id}/detail`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "提交失败，请重新生成确认摘要。"); }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/claims">AI 报销 <span>Agent</span></Link>
        <span className={styles.draftMark}>{claim?.status === "SUBMITTED" ? "已提交" : "报销草稿"}</span>
      </header>
      {isLoading ? <div className={styles.loading} role="status">正在读取报销草稿…</div> : !claim ? <div className={styles.error} role="alert"><h1>暂时无法打开报销草稿</h1><p>{error || "当前草稿不可用。"}</p><button type="button" className="button-outline" onClick={() => void refresh()}>重新加载</button></div> : <div className={styles.layout}>
        <aside className={styles.rail}><p className="eyebrow">处理脉络</p><strong>{formatMoney(claim.totalAmountCents)}</strong><span>当前报销合计</span><ol><li className={styles.done}>建立草稿</li><li className={claim.receipts.length ? styles.done : ""}>上传票据</li><li className={issues.length ? styles.current : ""}>补齐信息</li><li className={claim.status === "SUBMITTED" ? styles.done : ""}>确认提交</li></ol></aside>
        <div className={styles.workspace}>
          <div className={styles.titleRow}><div><p className="eyebrow">草稿 #{claim.id.slice(-6).toUpperCase()}</p><h1>报销工作台</h1><p>金额、票据和提交状态均以服务端校验结果为准。</p></div></div>
          {error ? <p className="notice-error" role="alert">{error}</p> : null}
          <form className={styles.purposePanel} noValidate onSubmit={(event) => { event.preventDefault(); void savePurpose(); }}>
            <div><p className="eyebrow">报销说明</p><label htmlFor="workspace-purpose">报销事由</label><p className={styles.help}>说明本次支出的业务背景，提交前必须补齐。</p></div>
            <textarea id="workspace-purpose" className="resize-none" value={purposeDraft} onChange={(event) => setPurposeDraft(event.target.value)} rows={3} disabled={claim.status === "SUBMITTED"} placeholder="例如：客户拜访交通与餐饮" />
            <div className={styles.purposeActions}><button type="submit" className="button-outline" disabled={isSavingPurpose || claim.status === "SUBMITTED"} aria-busy={isSavingPurpose}>保存报销事由</button>{purposeStatus ? <p role="status" className={styles.saved}>{purposeStatus}</p> : null}</div>
          </form>
          <div className={styles.grid}><div className={styles.mainColumn}><ReceiptUpload claimId={claim.id} receipts={claim.receipts} onComplete={() => void refresh("background")} /><ExpenseTable items={claim.expenseItems} receipts={claim.receipts} onConfirmField={confirmField} /></div><div className={styles.sideColumn}><ValidationPanel issues={issues} /><ClaimChat claimId={claim.id} version={claim.version} proposals={claim.agentProposals} onComplete={() => void refresh("background")} /><SubmissionSummary preview={preview} isLoading={isPreviewing} hasBlockingValidation={hasBlockingValidation(issues)} onRequest={() => void requestPreview()} onSubmit={(token) => void submit(token)} submittedNumber={submittedNumber} /></div></div>
        </div>
      </div>}
    </main>
  );
}
