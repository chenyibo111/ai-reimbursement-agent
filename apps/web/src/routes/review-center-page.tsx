import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { reimbursementApi, ReimbursementApiError } from "../api/client";
import type { ReviewCase, ReviewCaseAction } from "../api/generated/reimbursement";

const reviewKey = ["review-cases"] as const;
const reviewReasons: Record<string, { title: string; description: string }> = {
  OCR_LOW_CONFIDENCE: { title: "票据识别结果待确认", description: "识别结果置信度较低，请核对发票号码、日期和金额。" },
  OCR_RETRY_EXHAUSTED: { title: "OCR 多次识别失败", description: "系统多次尝试仍未取得可靠信息，请核对原票或要求员工重新上传。" },
  DUPLICATE_CONTENT: { title: "检测到重复上传票据", description: "该票据内容与已有附件相同，请确认是否为重复报销。" },
  DUPLICATE_SUBMITTED_INVOICE: { title: "发票已用于已提交报销", description: "发票号码已关联已提交单据，请核对是否重复报销。" },
  LEGACY_REVIEW_REQUIRED: { title: "历史票据待人工核验", description: "该票据在迁移前已进入人工核验状态。" },
};

export function ReviewCenterPage() {
  const queryClient = useQueryClient();
  const [selectedID, setSelectedID] = useState("");
  const [action, setAction] = useState<ReviewCaseAction>("CONFIRM");
  const [resolution, setResolution] = useState("");
  const [correction, setCorrection] = useState({ invoiceNumber: "", invoiceDate: "", totalAmountCent: "", sellerName: "" });
	const [previewPopupError, setPreviewPopupError] = useState("");
  const reviews = useQuery({ queryKey: reviewKey, queryFn: reimbursementApi.listReviews });
  const detail = useQuery({ queryKey: [...reviewKey, selectedID], queryFn: () => reimbursementApi.getReview(selectedID), enabled: Boolean(selectedID) });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: reviewKey }); if (selectedID) await queryClient.invalidateQueries({ queryKey: [...reviewKey, selectedID] }); };
  const claim = useMutation({ mutationFn: () => reimbursementApi.claimReview(selectedID, detail.data!.version), onSuccess: refresh });
  const resolve = useMutation({ mutationFn: () => reimbursementApi.resolveReview(selectedID, { expectedVersion: detail.data!.version, action, resolution, ...(action === "CORRECT_FIELDS" ? { invoiceNumber: correction.invoiceNumber.trim(), invoiceDate: correction.invoiceDate, totalAmountCent: Number(correction.totalAmountCent), sellerName: correction.sellerName.trim() } : {}) }), onSuccess: async () => { setResolution(""); setCorrection({ invoiceNumber: "", invoiceDate: "", totalAmountCent: "", sellerName: "" }); await refresh(); } });
	const preview = useMutation({ mutationFn: (reviewID: string) => reimbursementApi.getReviewReceiptPreview(reviewID) });

  useEffect(() => { if (!selectedID && reviews.data?.items[0]) setSelectedID(reviews.data.items[0].id); }, [reviews.data, selectedID]);
  const message = previewPopupError || errorMessage(reviews.error ?? detail.error ?? claim.error ?? resolve.error ?? preview.error);
  const selected = detail.data;
  const canResolve = selected?.status === "CLAIMED";

  const correctionValid = action !== "CORRECT_FIELDS" || (correction.invoiceNumber.trim() && correction.invoiceDate && correction.totalAmountCent !== "" && Number.isInteger(Number(correction.totalAmountCent)) && Number(correction.totalAmountCent) >= 0);
  function submit(event: FormEvent) { event.preventDefault(); if (resolution.trim() && correctionValid) resolve.mutate(); }
	function openReceiptPreview() {
		if (!selected) return;
		setPreviewPopupError("");
		const previewTab = window.open("about:blank", "_blank");
		if (!previewTab) {
			setPreviewPopupError("浏览器阻止了原票预览窗口，请允许弹窗后重试。");
			return;
		}
		previewTab.opener = null;
		preview.mutate(selected.id, {
			onSuccess: ({ url }) => previewTab.location.replace(url),
			onError: () => previewTab.close(),
		});
	}

  return <main className="page-shell">
    <header className="page-header"><div><p className="eyebrow">财务复核中心</p><h1>票据复核队列</h1><p className="page-summary">领取后处理。每次处理会保留票据与案件的审计痕迹。</p></div></header>
    <p className="inline-notice" role="status">{resolve.isSuccess ? "处理已保存，队列已刷新。" : message}</p>
    <section className="review-layout" aria-label="票据复核工作区">
      <aside className="review-list-panel"><div className="section-heading"><h2>待办案件</h2><span className="quiet-count">{reviews.data?.items.length ?? 0} 项</span></div>
        {reviews.isLoading ? <p className="empty-state">正在加载复核队列…</p> : reviews.data?.items.length ? <ol className="review-list">{reviews.data.items.map(item => <li key={item.id}><button type="button" className={item.id === selectedID ? "review-list-item is-selected" : "review-list-item"} onClick={() => { setSelectedID(item.id); setResolution(""); }}><span className={`status-tag review-${item.status.toLowerCase()}`}>{statusText(item.status)}</span><strong>{reviewReason(item.reasonCode).title}</strong><small>{claimLabel(item)}</small></button></li>)}</ol> : <p className="empty-state">当前没有需要处理的票据复核案件。</p>}</aside>
      <section className="workbench-panel review-detail-panel" aria-live="polite">
        {detail.isLoading ? <p className="empty-state">正在读取案件详情…</p> : selected ? <><div className="section-heading"><div><p className="eyebrow">票据人工复核</p><h2>{selected.claimNumber || "关联报销单"}</h2></div><span className="status-tag">{statusText(selected.status)}</span></div>
          <dl className="review-facts"><div><dt>异常原因</dt><dd><strong>{reviewReason(selected.reasonCode).title}</strong><span className="review-fact-note">{reviewReason(selected.reasonCode).description}</span></dd></div><div><dt>关联报销单</dt><dd>{selected.claimNumber ? <Link className="review-claim-link" to={`/claims/${encodeURIComponent(selected.claimId)}`}>{selected.claimNumber}</Link> : <span>关联报销单暂不可用</span>}<span className="review-fact-note">{selected.claimPurpose || "未填写报销事由"}</span></dd></div><div><dt>领取人</dt><dd>{selected.assignedToDisplayName || "尚未领取"}</dd></div><div><dt>处理状态</dt><dd>{statusText(selected.status)}</dd></div></dl>
          <div className="review-actions"><button className="secondary-action" type="button" disabled={preview.isPending} onClick={openReceiptPreview}>{preview.isPending ? "正在打开原票…" : "查看原票"}</button>{selected.status === "OPEN" ? <button className="primary-action" type="button" disabled={claim.isPending} onClick={() => claim.mutate()}>{claim.isPending ? "领取中…" : "领取案件"}</button> : null}</div>
          {canResolve ? <form className="review-resolution-form" noValidate onSubmit={submit}><label htmlFor="review-action">处理方式</label><select id="review-action" value={action} onChange={event => setAction(event.target.value as ReviewCaseAction)}><option value="CONFIRM">确认识别结果</option><option value="CORRECT_FIELDS">更正识别字段</option><option value="REQUEST_REUPLOAD">要求重新上传</option><option value="CLOSE_INVALID">关闭无效票据</option></select>{action === "CORRECT_FIELDS" ? <fieldset className="review-correction-fields"><legend>更正后的票据字段</legend><label htmlFor="review-invoice-number">发票号码</label><input id="review-invoice-number" value={correction.invoiceNumber} onChange={event => setCorrection(current => ({ ...current, invoiceNumber: event.target.value }))} required /><label htmlFor="review-invoice-date">开票日期</label><input id="review-invoice-date" type="date" value={correction.invoiceDate} onChange={event => setCorrection(current => ({ ...current, invoiceDate: event.target.value }))} required /><label htmlFor="review-total-amount">价税合计（分）</label><input id="review-total-amount" inputMode="numeric" min="0" step="1" type="number" value={correction.totalAmountCent} onChange={event => setCorrection(current => ({ ...current, totalAmountCent: event.target.value }))} required /><label htmlFor="review-seller-name">销售方</label><input id="review-seller-name" value={correction.sellerName} onChange={event => setCorrection(current => ({ ...current, sellerName: event.target.value }))} /></fieldset> : null}<label htmlFor="review-resolution">处理说明</label><textarea id="review-resolution" className="resize-none" value={resolution} onChange={event => setResolution(event.target.value)} aria-invalid={Boolean(resolve.error)} aria-describedby={resolve.error ? "review-error" : undefined} placeholder="说明本次复核结论" required /><p id="review-error" className="field-error">{resolve.error ? errorMessage(resolve.error) : ""}</p><div className="form-actions"><button className="primary-action" type="submit" disabled={resolve.isPending || !resolution.trim() || !correctionValid}>{resolve.isPending ? "保存中…" : "保存处理结果"}</button></div></form> : null}
        </> : <p className="empty-state">从左侧选择一个案件以查看详情。</p>}
      </section>
    </section>
  </main>;
}

function statusText(status: string) { return ({ OPEN: "待领取", CLAIMED: "处理中", RESOLVED: "已解决", CLOSED: "已关闭" } as Record<string, string>)[status] ?? status; }
function reviewReason(reasonCode: string) { return reviewReasons[reasonCode] ?? { title: "票据需要人工核验", description: "系统发现票据异常，请核对原票和识别结果。" }; }
function claimLabel(reviewCase: ReviewCase) { return [reviewCase.claimNumber || "关联报销单", reviewCase.claimPurpose].filter(Boolean).join(" · "); }
function errorMessage(error: unknown) { if (!error) return ""; if (error instanceof ReimbursementApiError && error.status === 403) return "当前账号没有财务复核权限。"; if (error instanceof ReimbursementApiError && (error.code === "DUPLICATE_SUBMITTED_INVOICE" || error.code === "RECEIPT_PREVIEW_UNAVAILABLE")) return error.message; if (error instanceof ReimbursementApiError && error.status === 409) return "案件已被其他操作更新，请刷新后重试。"; return error instanceof Error ? error.message : "操作未完成，请稍后重试。"; }
