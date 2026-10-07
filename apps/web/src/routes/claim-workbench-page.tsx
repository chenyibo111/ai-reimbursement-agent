import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { useClaim, useReceipts } from "../features/claims/use-claim";
import { useReceiptUpload } from "../features/receipts/use-receipt-upload";
import { useClaimSubmission, useClaimValidation, useSubmissionRequest } from "../features/submission/use-submission";

function statusText(status: string) {
  const labels: Record<string, string> = {
    UPLOAD_PENDING: "等待上传完成",
    READY_FOR_OCR: "OCR 处理中",
    EXTRACTED: "识别完成",
    REVIEW_REQUIRED: "需要人工复核",
    QUARANTINED: "文件待安全复核",
    DRAFT: "草稿",
    AWAITING_CONFIRMATION: "待确认",
    SUBMITTED: "已提交",
  };
  return labels[status] ?? status;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}

export function ClaimWorkbenchPage() {
  const { claimId = "" } = useParams();
  const location = useLocation();
  const claimQuery = useClaim(claimId);
  const receiptsQuery = useReceipts(claimId);
  const upload = useReceiptUpload(claimId);
  const validation = useClaimValidation(claimId);
  const confirmation = useSubmissionRequest(claimId);
  const submit = useClaimSubmission(claimId);
  const [notice, setNotice] = useState<string>((location.state as { notice?: string } | null)?.notice ?? "");

  const hasPendingReceipt = useMemo(() => receiptsQuery.data?.items.some((receipt) => receipt.status === "UPLOAD_PENDING" || receipt.status === "READY_FOR_OCR") ?? false, [receiptsQuery.data]);
  const hasBlockingIssue = validation.data?.issues.some((issue) => issue.severity === "BLOCKING") ?? false;
  const canRequestConfirmation = !hasPendingReceipt && validation.isSuccess && !hasBlockingIssue && Boolean(claimQuery.data);

  useEffect(() => {
    if (submit.isSuccess) setNotice("报销单已提交，系统已保存当前提交快照。");
  }, [submit.isSuccess]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setNotice("");
    upload.mutate(file, {
      onSuccess: () => setNotice("票据已接收，正在进入识别流程。"),
    });
    event.target.value = "";
  }

  if (claimQuery.isLoading) return <main className="page-shell"><p className="empty-state" role="status">正在打开报销工作台…</p></main>;
  if (claimQuery.isError || !claimQuery.data) return <main className="page-shell"><p className="field-error" role="alert">{errorMessage(claimQuery.error)}</p><Link to="/claims">返回报销单列表</Link></main>;
  const claim = claimQuery.data;

  return (
    <main className="page-shell" aria-labelledby="workbench-title">
      <header className="workbench-header">
        <Link className="back-link" to="/claims">← 返回我的报销单</Link>
        <div className="workbench-title-row">
          <div>
            <p className="eyebrow">报销工作台 · {statusText(claim.status)}</p>
            <h1 id="workbench-title">{claim.purpose || "未填写报销事由"}</h1>
          </div>
          <span className={`status-tag status-${claim.status.toLowerCase()}`}>{statusText(claim.status)}</span>
        </div>
      </header>

      <p className="inline-notice" role="status" aria-live="polite">{notice}</p>
      <div className="workbench-layout">
        <aside className="case-rail" aria-label="报销处理脉络">
          <p className="eyebrow">处理脉络</p>
          <ol>
            <li className="is-complete"><span>1</span><div><strong>草稿已建立</strong><small>版本 {claim.version}</small></div></li>
            <li className={receiptsQuery.data?.items.length ? "is-active" : ""}><span>2</span><div><strong>票据归档</strong><small>{receiptsQuery.data?.items.length ?? 0} 份附件</small></div></li>
            <li className={validation.isSuccess ? "is-active" : ""}><span>3</span><div><strong>提交前检查</strong><small>{validation.isSuccess ? "已更新" : "尚未检查"}</small></div></li>
            <li className={submit.isSuccess || claim.status === "SUBMITTED" ? "is-complete" : ""}><span>4</span><div><strong>确认提交</strong><small>{claim.status === "SUBMITTED" ? "已完成" : "等待确认"}</small></div></li>
          </ol>
        </aside>

        <div className="workbench-content">
          <section className="workbench-panel" aria-labelledby="receipts-heading">
            <div className="section-heading">
              <div><p className="eyebrow">附件</p><h2 id="receipts-heading">票据归档</h2></div>
              <label className={`secondary-action file-input ${upload.isPending ? "is-disabled" : ""}`}>
                <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleFileChange} disabled={upload.isPending || claim.status === "SUBMITTED"} />
                {upload.isPending ? "正在上传…" : "上传票据"}
              </label>
            </div>
            <p className="panel-copy">支持 JPG、PNG、PDF；单个文件最大 20 MB。文件会先进行安全检查，再进入 OCR。</p>
            {upload.isError && <p className="field-error" role="alert">{errorMessage(upload.error)}</p>}
            {receiptsQuery.isLoading && <p className="empty-state" role="status">正在读取附件…</p>}
            {receiptsQuery.data?.items.length === 0 && <p className="empty-state">还没有票据。上传后会在这里显示识别进度与结果。</p>}
            <ul className="receipt-list">
              {receiptsQuery.data?.items.map((receipt) => <li key={receipt.id} className="receipt-row">
                <div><strong>{receipt.filename}</strong><small>{receipt.invoiceNumber ? `发票号 ${receipt.invoiceNumber}` : "等待识别发票信息"}</small></div>
                <span className={`status-tag receipt-${receipt.status.toLowerCase()}`}>{statusText(receipt.status)}</span>
              </li>)}
            </ul>
          </section>

          <section className="workbench-panel" aria-labelledby="submission-heading">
            <div className="section-heading"><div><p className="eyebrow">提交</p><h2 id="submission-heading">提交前检查</h2></div></div>
            <p className="panel-copy">服务端会重新检查票据与当前政策。识别中的票据不能提交。</p>
            <button className="secondary-action" type="button" disabled={validation.isPending || claim.status === "SUBMITTED"} onClick={() => validation.mutate()}>{validation.isPending ? "正在检查…" : "检查提交条件"}</button>
            {validation.isError && <p className="field-error" role="alert">{errorMessage(validation.error)}</p>}
            {validation.data && <ul className="validation-list">{validation.data.issues.length === 0 ? <li className="validation-ok">检查通过，可以请求提交确认。</li> : validation.data.issues.map((issue) => <li key={issue.code} className={issue.severity === "BLOCKING" ? "validation-blocking" : "validation-warning"}>{issue.message}</li>)}</ul>}
            <div className="submission-actions">
              {!confirmation.data && <button className="primary-action" type="button" disabled={!canRequestConfirmation || confirmation.isPending || claim.status === "SUBMITTED"} onClick={() => confirmation.mutate(claim.version)}>{confirmation.isPending ? "正在生成确认…" : "请求提交确认"}</button>}
              <button className="primary-action" type="button" disabled={!confirmation.data || submit.isPending || claim.status === "SUBMITTED"} onClick={() => confirmation.data && submit.mutate(confirmation.data.confirmationToken)}>{submit.isPending ? "正在提交…" : "确认提交"}</button>
            </div>
            {confirmation.isError && <p className="field-error" role="alert">{errorMessage(confirmation.error)}</p>}
            {submit.isError && <p className="field-error" role="alert">{errorMessage(submit.error)}</p>}
          </section>
        </div>
      </div>
    </main>
  );
}
