import { Link } from "react-router-dom";

import type { ClaimStatus } from "../api/generated/reimbursement";
import { useClaims } from "../features/claims/use-claim";
import { claimAmountSummary } from "../features/claims/claim-display";

const statusLabel: Record<ClaimStatus, string> = {
  DRAFT: "草稿",
  PROCESSING: "处理中",
  NEEDS_INFORMATION: "待补充",
  AWAITING_CONFIRMATION: "待确认",
  SUBMITTED: "已提交",
};

export function ClaimListPage() {
  const claimsQuery = useClaims();

  return (
    <main className="page-shell" aria-labelledby="claims-page-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">员工报销</p>
          <h1 id="claims-page-title">我的凭证卷宗</h1>
          <p className="page-summary">每份草稿都保留票据处理、校验与提交的完整脉络。</p>
        </div>
        <Link className="primary-action new-claim-action" to="/claims/new">新建报销单</Link>
      </header>

      <section className="claim-list" aria-labelledby="claim-list-title">
        <div className="section-heading">
          <h2 id="claim-list-title">最近的报销单</h2>
          <span className="quiet-count">最多显示最近 50 条</span>
        </div>
        {claimsQuery.isLoading && <p className="empty-state" role="status">正在读取你的报销单…</p>}
        {claimsQuery.isError && <p className="field-error" role="alert">读取报销单失败，请稍后重试。</p>}
        {claimsQuery.data && claimsQuery.data.items.length === 0 && <p className="empty-state">尚无报销草稿。创建一份卷宗即可从上传票据开始。</p>}
        <div className="claim-grid">
          {claimsQuery.data?.items.map((claim) => (
            <Link className="claim-card" key={claim.id} to={`/claims/${claim.id}`}>
              <div className="claim-card-topline">
					<code className="claim-number">{claim.claimNumber}</code>
                <span className={`status-tag status-${claim.status.toLowerCase()}`}>{statusLabel[claim.status]}</span>
              </div>
              <strong>{claim.purpose || "未填写报销事由"}</strong>
				<div className="claim-card-summary">
					<span>{claimAmountSummary(claim.totalAmountCent, claim.missingAmountReceiptCount)}</span>
					<span>票据 {claim.receiptCount} 份，已识别 {claim.recognizedReceiptCount} 份</span>
				</div>
              <span className="card-meta">更新于 <time dateTime={claim.updatedAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(claim.updatedAt))}</time> · 版本 {claim.version}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
