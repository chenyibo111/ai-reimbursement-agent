import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { shouldRefreshClaimAfterReceiptTransition, useClaim, useDeleteReceipt, useReceipts } from "../features/claims/use-claim";
import { ClaimApplicationForm } from "../features/claims/claim-application-form";
import type { Receipt } from "../api/generated/reimbursement";
import { useReceiptUpload } from "../features/receipts/use-receipt-upload";
import { claimAmountSummary, formatCNYFromCent } from "../features/claims/claim-display";

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
  const deleteReceipt = useDeleteReceipt(claimId);
  const upload = useReceiptUpload(claimId);
  const [notice, setNotice] = useState<string>((location.state as { notice?: string } | null)?.notice ?? "");
  const [receiptToDelete, setReceiptToDelete] = useState<Receipt | null>(null);
  const wasReceiptPending = useRef(false);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const hasPendingReceipt = useMemo(() => receiptsQuery.data?.items.some((receipt) => receipt.status === "UPLOAD_PENDING" || receipt.status === "READY_FOR_OCR") ?? false, [receiptsQuery.data]);
	useEffect(() => {
		if (!hasPendingReceipt) return;
		const refresh = window.setInterval(() => { void claimQuery.refetch(); }, 3_000);
		return () => window.clearInterval(refresh);
	}, [claimQuery.refetch, hasPendingReceipt]);

  useEffect(() => {
    const shouldRefresh = shouldRefreshClaimAfterReceiptTransition(wasReceiptPending.current, hasPendingReceipt);
    wasReceiptPending.current = hasPendingReceipt;
    if (shouldRefresh) void claimQuery.refetch();
  }, [claimQuery.refetch, hasPendingReceipt]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setNotice("");
    upload.mutate(file, {
      onSuccess: () => setNotice("票据已接收，正在进入识别流程。"),
    });
    event.target.value = "";
  }

  function confirmDeleteReceipt() {
    if (!receiptToDelete) return;
    deleteReceipt.mutate(receiptToDelete.id, {
      onSuccess: () => {
        setNotice(`已删除附件：${receiptToDelete.filename}`);
        setReceiptToDelete(null);
      },
    });
  }

  function requestReceiptDeletion(receipt: Receipt, trigger: HTMLButtonElement) {
    deleteTriggerRef.current = trigger;
    setReceiptToDelete(receipt);
  }

  function cancelReceiptDeletion() {
    setReceiptToDelete(null);
    window.requestAnimationFrame(() => deleteTriggerRef.current?.focus());
  }

  if (claimQuery.isLoading) return <main className="page-shell"><p className="empty-state" role="status">正在打开报销工作台…</p></main>;
  if (claimQuery.isError || !claimQuery.data) return <main className="page-shell"><p className="field-error" role="alert">{errorMessage(claimQuery.error)}</p><Link to="/claims">返回报销单列表</Link></main>;
  const claim = claimQuery.data;

  return (
    <>
    <main className="page-shell" aria-labelledby="workbench-title" aria-hidden={receiptToDelete ? true : undefined} inert={receiptToDelete ? true : undefined}>
      <header className="workbench-header">
        <Link className="back-link" to="/claims">← 返回我的报销单</Link>
        <div className="workbench-title-row">
          <div>
            <p className="eyebrow">报销工作台 · {statusText(claim.status)}</p>
            <h1 id="workbench-title">{claim.purpose || "未填写报销事由"}</h1>
				<p className="claim-number">报销单号 <code>{claim.claimNumber}</code></p>
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
            <li className={claim.status === "SUBMITTED" ? "is-complete" : ""}><span>3</span><div><strong>提交报销单</strong><small>{claim.status === "SUBMITTED" ? "已完成" : "等待提交"}</small></div></li>
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
			<p className="receipt-summary" aria-live="polite">{claimAmountSummary(claim.totalAmountCent, claim.missingAmountReceiptCount)} · 票据 {claim.receiptCount} 份，已识别 {claim.recognizedReceiptCount} 份</p>
            {upload.isError && <p className="field-error" role="alert">{errorMessage(upload.error)}</p>}
            {receiptsQuery.isLoading && <p className="empty-state" role="status">正在读取附件…</p>}
            {receiptsQuery.data?.items.length === 0 && <p className="empty-state">还没有票据。上传后会在这里显示识别进度与结果。</p>}
            <ul className="receipt-list">
              {receiptsQuery.data?.items.map((receipt) => <li key={receipt.id} className="receipt-row">
						<div className="receipt-content">
							<strong>{receipt.filename}</strong>
							{receipt.status === "EXTRACTED" ? (
								<dl className="receipt-facts">
									<div><dt>发票号码</dt><dd>{receipt.invoiceNumber || "待补充"}</dd></div>
									<div><dt>开票日期</dt><dd>{receipt.invoiceDate || "待补充"}</dd></div>
									<div><dt>价税合计</dt><dd>{receipt.totalAmountCent === null ? "待补充" : formatCNYFromCent(receipt.totalAmountCent)}</dd></div>
									<div><dt>销售方</dt><dd>{receipt.sellerName || "待补充"}</dd></div>
									<div><dt>OCR 置信度</dt><dd>{Math.round(receipt.ocrConfidence * 100)}%</dd></div>
								</dl>
							) : <small>待 OCR 识别</small>}
						</div>
                <div className="receipt-actions">
                  <span className={`status-tag receipt-${receipt.status.toLowerCase()}`}>{statusText(receipt.status)}</span>
                  {claim.status === "DRAFT" ? <button className="danger-action" type="button" onClick={(event) => requestReceiptDeletion(receipt, event.currentTarget)} disabled={deleteReceipt.isPending}>删除附件</button> : null}
                </div>
              </li>)}
            </ul>
          </section>

				<ClaimApplicationForm claim={claim} recognizedAmountCent={claim.totalAmountCent} onSaved={() => setNotice("草稿已保存。")} onSubmitted={() => { setNotice("报销单已提交，系统已保存当前提交快照。"); void claimQuery.refetch(); }} />
        </div>
      </div>
    </main>
    {receiptToDelete ? <ReceiptDeleteDialog
      receipt={receiptToDelete}
      isDeleting={deleteReceipt.isPending}
      error={deleteReceipt.isError ? errorMessage(deleteReceipt.error) : ""}
      onCancel={cancelReceiptDeletion}
      onConfirm={confirmDeleteReceipt}
    /> : null}
    </>
  );
}

function ReceiptDeleteDialog({ receipt, isDeleting, error, onCancel, onConfirm }: {
  receipt: Receipt;
  isDeleting: boolean;
  error: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isDeleting) onCancel();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const buttons = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDeleting, onCancel]);

  return <div className="dialog-layer" role="presentation">
    <div className="dialog-backdrop" />
    <div ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-receipt-title" aria-describedby="delete-receipt-description">
      <p className="eyebrow">删除附件</p>
      <h2 id="delete-receipt-title">删除附件</h2>
      <p id="delete-receipt-description">“{receipt.filename}”将从这份草稿中删除，且无法恢复。</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button ref={cancelRef} className="secondary-action" type="button" onClick={onCancel} disabled={isDeleting}>取消</button>
        <button className="danger-action danger-action-solid" type="button" onClick={onConfirm} disabled={isDeleting}>{isDeleting ? "正在删除…" : "确认删除"}</button>
      </div>
    </div>
  </div>;
}
