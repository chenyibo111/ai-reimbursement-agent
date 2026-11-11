import { FormEvent, useEffect, useMemo, useState } from "react";

import { reimbursementApi, ReimbursementApiError } from "../../api/client";
import type { Claim, ClaimPatch, ExpenseItem, ExpenseItemPatch, ValidationIssue } from "../../api/generated/reimbursement";
import { formatCNYFromCent } from "./claim-display";
import { useUpdateClaim, useUpdateExpenseItem } from "./use-claim";

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

export function parseParticipants(value: string): string[] {
	return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
}

function formatAmountInput(value: number | null) {
	return value === null ? "" : (value / 100).toFixed(2);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "保存失败，请检查后重试。";
}

export function ClaimApplicationForm({ claim, recognizedAmountCent, onSaved, onSubmitted }: { claim: Claim; recognizedAmountCent: number | null; onSaved?: (claim: Claim) => void; onSubmitted?: (warnings: ValidationIssue[]) => void }) {
	const mutation = useUpdateClaim(claim.id);
	const [purpose, setPurpose] = useState(claim.purpose ?? "");
	const [expenseCategory, setExpenseCategory] = useState(claim.expenseCategory ?? "");
	const [projectCode, setProjectCode] = useState(claim.projectCode ?? "");
	const [participantsText, setParticipantsText] = useState((claim.participants ?? []).join("，"));
	const [amountText, setAmountText] = useState(() => formatAmountInput(claim.requestedAmountCent));
	const [remark, setRemark] = useState(claim.remark ?? "");
	const [amountError, setAmountError] = useState("");
	const [submissionIssues, setSubmissionIssues] = useState<ValidationIssue[]>([]);
	const [submissionError, setSubmissionError] = useState("");
	const [isSubmitting, setSubmitting] = useState(false);
	const [pendingConfirmation, setPendingConfirmation] = useState<{ token: string; version: number; amountCent: number | null; itemTotalCent: number; warnings: ValidationIssue[] } | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [showCorrections, setShowCorrections] = useState(false);
	const isDraft = claim.status === "DRAFT";
	const isItemized = claim.itemizationMode === "ITEMIZED";
	const categories = claim.expenseCategories ?? [];
	const difference = useMemo(() => claim.requestedAmountCent === null || recognizedAmountCent === null ? null : claim.requestedAmountCent - recognizedAmountCent, [claim.requestedAmountCent, recognizedAmountCent]);
	useEffect(() => {
		if (pendingConfirmation && claim.version > pendingConfirmation.version) setPendingConfirmation(null);
	}, [claim.version, pendingConfirmation]);

	useEffect(() => {
		if (isEditing) return;
		setPurpose(claim.purpose ?? "");
		setExpenseCategory(claim.expenseCategory ?? "");
		setProjectCode(claim.projectCode ?? "");
		setParticipantsText((claim.participants ?? []).join("，"));
		setAmountText(formatAmountInput(claim.requestedAmountCent));
		setRemark(claim.remark ?? "");
		setAmountError("");
	}, [claim.id, claim.version, claim.purpose, claim.expenseCategory, claim.projectCode, claim.participants, claim.requestedAmountCent, claim.remark, isEditing]);

	function markEdited() {
		setPendingConfirmation(null);
		setIsEditing(true);
	}

	function buildPatch(): ClaimPatch | null {
		const normalizedAmount = amountText.trim();
		const parsed = normalizedAmount ? parseCNYAmountToCent(normalizedAmount) : undefined;
		if (parsed?.error) {
			setAmountError(parsed.error);
			return null;
		}
		setAmountError("");
		return {
			version: claim.version,
			...(!isItemized || purpose.trim() !== (claim.purpose ?? "") ? { purpose: purpose.trim() } : {}),
			...(!isItemized ? { expenseCategory: expenseCategory.trim(), projectCode: projectCode.trim(), participants: parseParticipants(participantsText) } : {}),
			...(parsed && (!isItemized || parsed.cents !== claim.requestedAmountCent) ? { requestedAmountCent: parsed.cents } : {}),
			currency: "CNY",
			remark: remark.trim() || null,
		};
	}

	async function saveDraft() {
		const patch = buildPatch();
		if (!patch) return null;
		const updated = await mutation.mutateAsync(patch);
		setPurpose(updated.purpose ?? "");
		setExpenseCategory(updated.expenseCategory ?? "");
		setProjectCode(updated.projectCode ?? "");
		setParticipantsText((updated.participants ?? []).join("，"));
		setAmountText(formatAmountInput(updated.requestedAmountCent));
		setRemark(updated.remark ?? "");
		setIsEditing(false);
		onSaved?.(updated);
		return updated;
	}

	async function handleSave() {
		setPendingConfirmation(null);
		setSubmissionIssues([]);
		setSubmissionError("");
		try {
			await saveDraft();
		} catch {
			// The mutation exposes this recoverable failure next to the form.
		}
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pendingConfirmation) return;
		setSubmissionIssues([]);
		setSubmissionError("");
		setSubmitting(true);
		try {
			const updated = await saveDraft();
			if (!updated) return;
			const confirmation = await reimbursementApi.requestSubmission(claim.id, updated.version);
			const warnings = confirmation.warnings ?? [];
			setSubmissionIssues(warnings);
			if (isItemized) {
				setPendingConfirmation({ token: confirmation.confirmationToken, version: updated.version, amountCent: updated.requestedAmountCent, itemTotalCent: (updated.expenseItems ?? claim.expenseItems ?? []).reduce((sum, item) => sum + (item.amountCent ?? 0), 0), warnings });
				return;
			}
			await reimbursementApi.submit(claim.id, confirmation.confirmationToken);
			setSubmissionIssues([]);
			onSubmitted?.(warnings);
		} catch (error) {
			setSubmissionIssues([]);
			if (error instanceof ReimbursementApiError && error.code === "VALIDATION_BLOCKED") {
				const validation = await reimbursementApi.getValidation(claim.id).catch(() => null);
				if (validation) {
					setSubmissionIssues(validation.issues);
					return;
				}
			}
			setSubmissionError(errorMessage(error));
		} finally {
			setSubmitting(false);
		}
	}

	async function confirmSubmit() {
		if (!pendingConfirmation) return;
		setSubmitting(true);
		try {
			await reimbursementApi.submit(claim.id, pendingConfirmation.token);
			setSubmissionIssues([]);
			onSubmitted?.(pendingConfirmation.warnings);
			setPendingConfirmation(null);
		} catch (error) {
			setPendingConfirmation(null);
			setSubmissionError(errorMessage(error));
		} finally {
			setSubmitting(false);
		}
	}

	function handleRestoreSuggestion() {
		setPendingConfirmation(null);
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
			<p className="panel-copy">保存草稿时可暂不填写完整；提交时系统会自动核验报销事由、金额、票据和政策。</p>
			<form className="claim-application-form" noValidate onSubmit={handleSubmit}>
				<div className="field-stack">
					<label htmlFor="claim-purpose">报销事由 <span className="required-label">（提交必填）</span></label>
					<input id="claim-purpose" name="purpose" value={purpose} onChange={(event) => { markEdited(); setPurpose(event.target.value); }} disabled={!isDraft || mutation.isPending || isSubmitting} placeholder="例如：杭州客户拜访" />
					<p className="field-hint">简要说明这笔报销对应的业务事项。</p>
				</div>
				{isItemized && <div className="field-stack">
					<span>费用类别</span>
					<output className="claim-category-summary" aria-label="费用类别汇总">{categories.join("、") || "待分类"}</output>
					<p className="field-hint">按票据识别结果汇总；更正分类后会自动更新。</p>
				</div>}
				{!isItemized && <><div className="field-stack">
					<label htmlFor="claim-expense-category">费用类别</label>
					<input id="claim-expense-category" name="expenseCategory" value={expenseCategory} onChange={(event) => { markEdited(); setExpenseCategory(event.target.value); }} disabled={!isDraft || mutation.isPending || isSubmitting} placeholder="例如：住宿费" />
					<p className="field-hint">若公司政策设置了类别范围，提交前需填写允许的类别。</p>
				</div>
				<div className="application-form-grid">
					<div className="field-stack"><label htmlFor="claim-project-code">项目编码</label><input id="claim-project-code" name="projectCode" value={projectCode} onChange={(event) => { markEdited(); setProjectCode(event.target.value); }} disabled={!isDraft || mutation.isPending || isSubmitting} placeholder="有对应项目时填写" /><p className="field-hint">适用的费用类别可能要求填写项目编码。</p></div>
					<div className="field-stack"><label htmlFor="claim-participants">同行人</label><input id="claim-participants" name="participants" value={participantsText} onChange={(event) => { markEdited(); setParticipantsText(event.target.value); }} disabled={!isDraft || mutation.isPending || isSubmitting} placeholder="例如：张三，李四" /><p className="field-hint">多人之间用逗号分隔；适用类别可能要求填写。</p></div>
				</div></>}
				<div className="application-form-grid">
					<div className="field-stack">
						<label htmlFor="requested-amount">申请报销总额</label>
						<div className="amount-input-wrap"><span aria-hidden="true">￥</span><input id="requested-amount" name="requestedAmount" inputMode="decimal" autoComplete="off" value={amountText} onChange={(event) => { markEdited(); setAmountText(event.target.value); setAmountError(""); }} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? "requested-amount-help requested-amount-error" : "requested-amount-help"} disabled={!isDraft || mutation.isPending || isSubmitting} placeholder="请输入金额" /></div>
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
					<textarea className="resize-none" id="claim-remark" name="remark" maxLength={1000} value={remark} onChange={(event) => { markEdited(); setRemark(event.target.value); }} disabled={!isDraft || mutation.isPending || isSubmitting} aria-describedby="claim-remark-help" placeholder="例如：客户拜访交通费" />
					<p id="claim-remark-help" className="field-hint">{remark.length}/1000</p>
				</div>
				<div className="ocr-amount-context" aria-live="polite">
					<div><span>识别票据合计</span><strong>{recognizedAmountCent === null ? "尚无可用 OCR 金额" : formatCNYFromCent(recognizedAmountCent)}</strong></div>
					{recognizedAmountCent === null && claim.recognizedReceiptCount > 0 && <p>已识别票据尚未提取金额，请手工补充申请报销总额。</p>}
					{difference !== null && difference !== 0 && <p>与识别票据合计相差 {formatCNYFromCent(Math.abs(difference))}</p>}
					{difference === 0 && <p>与识别票据合计一致</p>}
				</div>
				<div className="application-form-actions">
					{claim.requestedAmountSource === "MANUAL" && <button className="secondary-action" type="button" disabled={!isDraft || mutation.isPending || isSubmitting} onClick={handleRestoreSuggestion}>恢复 OCR 建议金额</button>}
					<button className="secondary-action" type="button" disabled={!isDraft || mutation.isPending || isSubmitting} onClick={() => { void handleSave(); }}>{mutation.isPending ? "正在保存…" : "保存草稿"}</button>
					<button className="primary-action" type="submit" disabled={!isDraft || mutation.isPending || isSubmitting || Boolean(pendingConfirmation)}>{isSubmitting ? "正在提交…" : "提交报销单"}</button>
				</div>
				{pendingConfirmation && claim.version <= pendingConfirmation.version && <div className="submission-confirmation" role="alertdialog" aria-label="提交金额确认">
					<p>申请金额 {pendingConfirmation.amountCent === null ? "待填写" : formatCNYFromCent(pendingConfirmation.amountCent)}</p>
					<p>明细合计 {formatCNYFromCent(pendingConfirmation.itemTotalCent)}</p>
					<p>差额 {pendingConfirmation.amountCent === null ? "待确认" : formatCNYFromCent(Math.abs(pendingConfirmation.amountCent - pendingConfirmation.itemTotalCent))}</p>
					<button className="primary-action" type="button" disabled={isSubmitting} onClick={() => { void confirmSubmit(); }}>确认提交</button>
					<button className="secondary-action" type="button" disabled={isSubmitting} onClick={() => setPendingConfirmation(null)}>返回修改</button>
				</div>}
				{mutation.isError && <p className="field-error" role="alert">{errorMessage(mutation.error)}</p>}
				{submissionIssues.length > 0 && <ul className="validation-list" role="alert">{submissionIssues.map((issue) => <li key={issue.code} className={issue.severity === "BLOCKING" ? "validation-blocking" : "validation-warning"}>{issue.message}</li>)}</ul>}
				{submissionError && <p className="field-error" role="alert">{submissionError}</p>}
			</form>
			{isItemized && isDraft && (claim.expenseItems?.length ?? 0) > 0 && <div className="expense-corrections">
				<button className="secondary-action" type="button" aria-expanded={showCorrections} aria-controls="expense-correction-list" onClick={() => setShowCorrections((open) => !open)}>更正分类或补充信息</button>
				{showCorrections && <div id="expense-correction-list" className="expense-item-list">{claim.expenseItems?.map((item, index) => <ExpenseItemCorrectionForm key={item.id} claim={claim} item={item} index={index} />)}</div>}
			</div>}
		</section>
	);
}

function ExpenseItemCorrectionForm({ claim, item, index }: { claim: Claim; item: ExpenseItem; index: number }) {
	const mutation = useUpdateExpenseItem(claim.id);
	const [category, setCategory] = useState(item.expenseCategory);
	const [purpose, setPurpose] = useState(item.purpose);
	const [projectCode, setProjectCode] = useState(item.projectCode);
	const [participants, setParticipants] = useState((item.participants ?? []).join("，"));
	const [isEditing, setIsEditing] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		if (isEditing) return;
		setCategory(item.expenseCategory);
		setPurpose(item.purpose);
		setProjectCode(item.projectCode);
		setParticipants((item.participants ?? []).join("，"));
	}, [item.expenseCategory, item.purpose, item.projectCode, item.participants, isEditing]);
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); setNotice(""); setError("");
		const patch: ExpenseItemPatch = { version: claim.version };
		if (category.trim() !== item.expenseCategory) patch.expenseCategory = category.trim();
		if (purpose.trim() !== item.purpose) patch.purpose = purpose.trim();
		if (projectCode.trim() !== item.projectCode) patch.projectCode = projectCode.trim();
		const people = parseParticipants(participants);
		if (people.join("\u0000") !== (item.participants ?? []).join("\u0000")) patch.participants = people;
		if (Object.keys(patch).length === 1) { setNotice("没有需要保存的修改。"); return; }
		try { await mutation.mutateAsync({ itemId: item.id, patch }); setIsEditing(false); setNotice("明细已保存。"); }
		catch (cause) { setError(errorMessage(cause)); }
	}
	const label = `第 ${index + 1} 条`;
	return <form className="expense-item-card" onSubmit={(event) => { void save(event); }} noValidate>
		<strong>{label} · 票据分类与补充信息</strong>
		<div className="application-form-grid">
			<div className="field-stack"><label htmlFor={`item-category-${item.id}`}>{label}费用类别</label><input id={`item-category-${item.id}`} value={category} onChange={(event) => { setIsEditing(true); setCategory(event.target.value); }} disabled={mutation.isPending} /></div>
			<div className="field-stack"><label htmlFor={`item-purpose-${item.id}`}>{label}通用事由</label><input id={`item-purpose-${item.id}`} value={purpose} onChange={(event) => { setIsEditing(true); setPurpose(event.target.value); }} disabled={mutation.isPending} /></div>
		</div>
		<div className="application-form-grid">
			<div className="field-stack"><label htmlFor={`item-project-${item.id}`}>{label}项目编码</label><input id={`item-project-${item.id}`} value={projectCode} onChange={(event) => { setIsEditing(true); setProjectCode(event.target.value); }} disabled={mutation.isPending} /></div>
			<div className="field-stack"><label htmlFor={`item-participants-${item.id}`}>{label}同行人</label><input id={`item-participants-${item.id}`} value={participants} onChange={(event) => { setIsEditing(true); setParticipants(event.target.value); }} disabled={mutation.isPending} /></div>
		</div>
		{error && <p className="field-error" role="alert">{error}</p>}
		{notice && <p role="status">{notice}</p>}
		<button className="secondary-action" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "正在保存…" : `保存${label}明细`}</button>
	</form>;
}
