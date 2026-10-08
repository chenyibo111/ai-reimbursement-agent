import { FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { reimbursementApi } from "../api/client";
import type { ClaimStatus } from "../api/generated/reimbursement";
import { claimKeys, useClaims } from "../features/claims/use-claim";
import { claimAmountSummary } from "../features/claims/claim-display";

const statusLabel: Record<ClaimStatus, string> = {
  DRAFT: "草稿",
  PROCESSING: "处理中",
  NEEDS_INFORMATION: "待补充",
  AWAITING_CONFIRMATION: "待确认",
  SUBMITTED: "已提交",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}

export function ClaimListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const claimsQuery = useClaims();
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [formError, setFormError] = useState("");
  const createClaim = useMutation({
    mutationFn: reimbursementApi.createClaim,
    onSuccess: async (claim) => {
      await queryClient.invalidateQueries({ queryKey: claimKeys.all });
      navigate(`/claims/${claim.id}`, { state: { notice: "草稿已创建。请上传票据并完成提交前检查。" } });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = purpose.trim();
    if (!value) {
      setFormError("请填写报销事由。");
      return;
    }
    setFormError("");
    createClaim.mutate(value);
  }

  return (
    <main className="page-shell" aria-labelledby="claims-page-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">员工报销</p>
          <h1 id="claims-page-title">我的凭证卷宗</h1>
          <p className="page-summary">每份草稿都保留票据处理、校验与提交的完整脉络。</p>
        </div>
        <button className="primary-action" type="button" onClick={() => setCreateOpen(true)}>新建报销草稿</button>
      </header>

      <p className="sr-only" role="status" aria-live="polite">{createClaim.isPending ? "正在创建草稿" : ""}</p>

      {isCreateOpen && (
        <section className="create-panel" aria-labelledby="create-claim-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">新卷宗</p>
              <h2 id="create-claim-title">新建报销草稿</h2>
            </div>
            <button className="text-action" type="button" onClick={() => setCreateOpen(false)}>取消</button>
          </div>
          <form noValidate onSubmit={submit}>
            <label htmlFor="claim-purpose">报销事由</label>
            <input
              id="claim-purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              aria-describedby={formError ? "claim-purpose-error" : undefined}
              placeholder="例如：杭州客户拜访"
              autoFocus
            />
            {(formError || createClaim.isError) && <p id="claim-purpose-error" className="field-error" role="alert">{formError || errorMessage(createClaim.error)}</p>}
            <div className="form-actions">
              <button className="primary-action" type="submit" disabled={createClaim.isPending}>{createClaim.isPending ? "正在创建…" : "创建并进入工作台"}</button>
            </div>
          </form>
        </section>
      )}

      <section className="claim-list" aria-labelledby="claim-list-title">
        <div className="section-heading">
          <h2 id="claim-list-title">最近的报销单</h2>
          <span className="quiet-count">最多显示最近 50 条</span>
        </div>
        {claimsQuery.isLoading && <p className="empty-state" role="status">正在读取你的报销单…</p>}
        {claimsQuery.isError && <p className="field-error" role="alert">{errorMessage(claimsQuery.error)}</p>}
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
