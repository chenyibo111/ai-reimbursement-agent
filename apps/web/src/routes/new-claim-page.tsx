import { FormEvent, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { reimbursementApi } from "../api/client";
import { parseCNYAmountToCent } from "../features/claims/claim-application-form";
import { claimKeys } from "../features/claims/use-claim";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "保存失败，请检查后重试。";
}

export function NewClaimPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [purpose, setPurpose] = useState("");
  const [amountText, setAmountText] = useState("");
  const [remark, setRemark] = useState("");
  const [amountError, setAmountError] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setSaving] = useState(false);

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAmount = amountText.trim();
    const parsed = normalizedAmount ? parseCNYAmountToCent(normalizedAmount) : undefined;
    if (parsed?.error) {
      setAmountError(parsed.error);
      return;
    }
    setAmountError("");
    setError("");
    setSaving(true);
    let createdClaimId: string | undefined;
    try {
      const created = await reimbursementApi.createClaim(purpose.trim());
      createdClaimId = created.id;
      const updated = await reimbursementApi.updateClaim(created.id, {
        version: created.version,
        ...(parsed ? { requestedAmountCent: parsed.cents } : {}),
        currency: "CNY",
        remark: remark.trim() || null,
      });
      await queryClient.invalidateQueries({ queryKey: claimKeys.all });
      navigate(`/claims/${created.id}`, { replace: true, state: { notice: `草稿 ${updated.claimNumber} 已保存。请上传票据后提交报销单。` } });
    } catch (saveError) {
      if (createdClaimId) {
        await queryClient.invalidateQueries({ queryKey: claimKeys.all });
        navigate(`/claims/${createdClaimId}`, {
          replace: true,
          state: { notice: "草稿已创建，但申请信息未完全保存。请补充后重新保存。" },
        });
        return;
      }
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page-shell" aria-labelledby="new-claim-title">
      <header className="workbench-header">
        <Link className="back-link" to="/claims">← 返回我的报销单</Link>
        <p className="eyebrow">新建报销单</p>
        <h1 id="new-claim-title">填写报销申请</h1>
        <p className="page-summary">填写后选择“保存草稿”才会创建报销单；保存完成即可上传票据，并在同一页面提交。</p>
      </header>
      <section className="workbench-panel claim-application-panel" aria-labelledby="new-claim-form-title">
        <div className="section-heading"><div><p className="eyebrow">申请信息</p><h2 id="new-claim-form-title">报销申请信息</h2></div><span className="status-tag">尚未保存</span></div>
        <form className="claim-application-form" noValidate onSubmit={saveDraft}>
          <div className="field-stack">
            <label htmlFor="new-claim-purpose">报销事由 <span className="required-label">（提交必填）</span></label>
            <input id="new-claim-purpose" name="purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} disabled={isSaving} placeholder="例如：杭州客户拜访" autoFocus />
            <p className="field-hint">简要说明这笔报销对应的业务事项。</p>
          </div>
          <div className="application-form-grid">
            <div className="field-stack">
              <label htmlFor="new-requested-amount">申请报销总额</label>
              <div className="amount-input-wrap"><span aria-hidden="true">￥</span><input id="new-requested-amount" name="requestedAmount" inputMode="decimal" autoComplete="off" value={amountText} onChange={(event) => { setAmountText(event.target.value); setAmountError(""); }} disabled={isSaving} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? "new-requested-amount-help new-requested-amount-error" : "new-requested-amount-help"} placeholder="请输入金额" /></div>
              <p id="new-requested-amount-help" className="field-hint">可在保存后根据 OCR 结果调整。</p>
              {amountError && <p id="new-requested-amount-error" className="field-error" role="alert">{amountError}</p>}
            </div>
            <div className="field-stack"><label htmlFor="new-claim-currency">币种</label><input id="new-claim-currency" value="CNY · 人民币" readOnly aria-readonly="true" /><p className="field-hint">当前仅支持人民币。</p></div>
          </div>
          <div className="field-stack"><label htmlFor="new-claim-remark">备注 <span className="optional-label">（选填）</span></label><textarea className="resize-none" id="new-claim-remark" name="remark" maxLength={1000} value={remark} onChange={(event) => setRemark(event.target.value)} disabled={isSaving} aria-describedby="new-claim-remark-help" placeholder="例如：客户拜访交通费" /><p id="new-claim-remark-help" className="field-hint">{remark.length}/1000</p></div>
          <p className="field-hint">票据需归属已保存的报销单，因此保存草稿后才可上传。</p>
          <div className="application-form-actions"><Link className="secondary-action new-claim-cancel" to="/claims">取消</Link><button className="primary-action" type="submit" disabled={isSaving}>{isSaving ? "正在保存…" : "保存草稿"}</button></div>
          {error && <p className="field-error" role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
