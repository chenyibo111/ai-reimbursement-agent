import { FormEvent, useEffect, useMemo, useState } from "react";

import type { Claim } from "../../api/generated/reimbursement";
import { formatCNYFromCent } from "./claim-display";
import { useUpdateClaim } from "./use-claim";

type AmountParseResult = { cents: number; error?: never } | { cents?: never; error: string };

export function parseCNYAmountToCent(value: string): AmountParseResult {
	const normalized = value.trim();
	if (!normalized) return { error: "请填写申请报销总额。" };
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
	if (!match) return { error: "请输入最多两位小数的非负数字金额。" };
	const fraction = (match[2] ?? "").padEnd(2, "0");
	const cents = BigInt(match[1]) * 100n + BigInt(fraction || "0");
	if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { error: "金额超出支持范围。" };
	return { cents: Number(cents) };
}

function formatAmountInput(value: number | null) {
	return value === null ? "" : (value / 100).toFixed(2);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "保存失败，请检查后重试。";
}

export function ClaimApplicationForm({ claim, recognizedAmountCent, onSaved }: { claim: Claim; recognizedAmountCent: number | null; onSaved?: (claim: Claim) => void }) {
	const mutation = useUpdateClaim(claim.id);
	const [amountText, setAmountText] = useState(() => formatAmountInput(claim.requestedAmountCent));
	const [remark, setRemark] = useState(claim.remark ?? "");
	const [amountError, setAmountError] = useState("");
	const [isEditing, setIsEditing] = useState(false);
	const isDraft = claim.status === "DRAFT";
	const difference = useMemo(() => claim.requestedAmountCent === null || recognizedAmountCent === null ? null : claim.requestedAmountCent - recognizedAmountCent, [claim.requestedAmountCent, recognizedAmountCent]);

	useEffect(() => {
		if (isEditing) return;
		setAmountText(formatAmountInput(claim.requestedAmountCent));
		setRemark(claim.remark ?? "");
		setAmountError("");
	}, [claim.id, claim.version, claim.requestedAmountCent, claim.remark, isEditing]);

	function markEdited() {
		setIsEditing(true);
	}

	function handleSave(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const parsed = parseCNYAmountToCent(amountText);
		if (parsed.error) {
			setAmountError(parsed.error);
			return;
		}
		setAmountError("");
		mutation.mutate({ version: claim.version, requestedAmountCent: parsed.cents, currency: "CNY", remark: remark.trim() || null }, {
			onSuccess: (updated) => {
				setAmountText(formatAmountInput(updated.requestedAmountCent));
				setRemark(updated.remark ?? "");
				setIsEditing(false);
				onSaved?.(updated);
			},
		});
	}

	function handleRestoreSuggestion() {
		setAmountError("");
		mutation.mutate({ version: claim.version, useOcrSuggestedAmount: true }, {
			onSuccess: (updated) => {
				setAmountText(formatAmountInput(updated.requestedAmountCent));
				setRemark(updated.remark ?? "");
				setIsEditing(false);
				onSaved?.(updated);
			},
		});
	}

	return (
		<section className="workbench-panel claim-application-panel" aria-labelledby="claim-application-heading">
			<div className="section-heading">
				<div><p className="eyebrow">申请信息</p><h2 id="claim-application-heading">申请报销信息</h2></div>
				<span className="status-tag">{claim.requestedAmountSource === "MANUAL" ? "手工填写" : "OCR 建议"}</span>
			</div>
			<p className="panel-copy">申请报销总额独立于票据识别金额保存；提交前会校验该金额已填写。</p>
			<form className="claim-application-form" noValidate onSubmit={handleSave}>
				<div className="application-form-grid">
					<div className="field-stack">
						<label htmlFor="requested-amount">申请报销总额</label>
						<div className="amount-input-wrap"><span aria-hidden="true">￥</span><input id="requested-amount" name="requestedAmount" inputMode="decimal" autoComplete="off" value={amountText} onChange={(event) => { markEdited(); setAmountText(event.target.value); setAmountError(""); }} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? "requested-amount-help requested-amount-error" : "requested-amount-help"} disabled={!isDraft || mutation.isPending} placeholder="例如 101.55" /></div>
						<p id="requested-amount-help" className="field-hint">最多两位小数，按人民币元填写。</p>
						{amountError && <p id="requested-amount-error" className="field-error" role="alert">{amountError}</p>}
					</div>
					<div className="field-stack">
						<label htmlFor="claim-currency">币种</label>
						<input id="claim-currency" value="CNY · 人民币" readOnly aria-readonly="true" />
						<p className="field-hint">当前仅支持人民币；多币种报销将在后续版本单独支持。</p>
					</div>
				</div>
				<div className="field-stack">
					<label htmlFor="claim-remark">备注 <span className="optional-label">（选填）</span></label>
					<textarea className="resize-none" id="claim-remark" name="remark" maxLength={1000} value={remark} onChange={(event) => { markEdited(); setRemark(event.target.value); }} disabled={!isDraft || mutation.isPending} aria-describedby="claim-remark-help" placeholder="例如：客户拜访交通费" />
					<p id="claim-remark-help" className="field-hint">{remark.length}/1000</p>
				</div>
				<div className="ocr-amount-context" aria-live="polite">
					<div><span>识别票据合计</span><strong>{recognizedAmountCent === null ? "尚无可用 OCR 金额" : formatCNYFromCent(recognizedAmountCent)}</strong></div>
					{difference !== null && difference !== 0 && <p>与识别票据合计相差 {formatCNYFromCent(Math.abs(difference))}</p>}
					{difference === 0 && <p>与识别票据合计一致</p>}
				</div>
				<div className="application-form-actions">
					{claim.requestedAmountSource === "MANUAL" && <button className="secondary-action" type="button" disabled={!isDraft || mutation.isPending} onClick={handleRestoreSuggestion}>恢复 OCR 建议金额</button>}
					<button className="primary-action" type="submit" disabled={!isDraft || mutation.isPending}>{mutation.isPending ? "正在保存…" : "保存申请信息"}</button>
				</div>
				{mutation.isError && <p className="field-error" role="alert">{errorMessage(mutation.error)}</p>}
			</form>
		</section>
	);
}
