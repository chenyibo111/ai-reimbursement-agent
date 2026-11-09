import { FormEvent, useEffect, useState } from "react";

import type { Claim, ExpenseItem, ExpenseItemPatch, Receipt } from "../../api/generated/reimbursement";
import { formatCNYFromCent } from "./claim-display";
import { parseCNYAmountToCent, parseParticipants } from "./claim-application-form";
import { useUpdateExpenseItem } from "./use-claim";

function typeLabel(type: string) {
	return ({ TAXI: "打车", DINING: "餐饮", LODGING: "住宿", TRANSPORT: "交通" } as Record<string, string>)[type] ?? (type || "待分类");
}

function sourceLabel(source: string) {
	return ({ OCR: "票据识别", MODEL: "AI 建议", MANUAL: "人工填写" } as Record<string, string>)[source] ?? "待补充";
}

export function ExpenseItemsPanel({ claim, receipts = [] }: { claim: Claim; receipts?: Receipt[] }) {
	const items = claim.expenseItems ?? [];
	const amount = claim.expenseItemTotalAmountCent ?? (items.length > 0 && items.every((item) => item.amountCent !== null) ? items.reduce((sum, item) => sum + (item.amountCent ?? 0), 0) : null);
	return <section className="workbench-panel" aria-labelledby="expense-items-heading">
		<div className="section-heading"><div><p className="eyebrow">逐票核对</p><h2 id="expense-items-heading">费用明细</h2></div><span className="status-tag">{items.length} 条</span></div>
		<p className="panel-copy">每张票据对应一条明细。请逐条核对类别、金额和事由，票据无法证明的信息保持空白。</p>
		{items.length === 0 ? <p className="empty-state">还没有费用明细。票据识别完成后会显示在这里。</p> : <>
			<p className="receipt-summary">明细合计 {amount === null ? "待补充" : formatCNYFromCent(amount)} · 类别：{claim.expenseCategories?.join("、") || "待补充"}</p>
			<div className="expense-item-list">{items.map((item, index) => <ExpenseItemEditor key={item.id} claim={claim} item={item} index={index} filename={receipts.find((receipt) => receipt.id === item.receiptId)?.filename ?? `票据 ${index + 1}`} />)}</div>
		</>}
	</section>;
}

function ExpenseItemEditor({ claim, item, index, filename }: { claim: Claim; item: ExpenseItem; index: number; filename: string }) {
	const mutation = useUpdateExpenseItem(claim.id);
	const [category, setCategory] = useState(item.expenseCategory);
	const [purpose, setPurpose] = useState(item.purpose);
	const [amount, setAmount] = useState(item.amountCent === null ? "" : (item.amountCent / 100).toFixed(2));
	const [projectCode, setProjectCode] = useState(item.projectCode);
	const [participants, setParticipants] = useState(item.participants.join("，"));
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [isEditing, setIsEditing] = useState(false);
	useEffect(() => {
		if (isEditing) return;
		setCategory(item.expenseCategory); setPurpose(item.purpose);
		setAmount(item.amountCent === null ? "" : (item.amountCent / 100).toFixed(2));
		setProjectCode(item.projectCode); setParticipants(item.participants.join("，"));
	}, [item.expenseCategory, item.purpose, item.amountCent, item.projectCode, item.participants, isEditing]);
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); setError(""); setNotice("");
		const patch: ExpenseItemPatch = { version: claim.version };
		if (category.trim() !== item.expenseCategory) patch.expenseCategory = category.trim();
		if (purpose.trim() !== item.purpose) patch.purpose = purpose.trim();
		if (projectCode.trim() !== item.projectCode) patch.projectCode = projectCode.trim();
		const people = parseParticipants(participants);
		if (people.join("\u0000") !== item.participants.join("\u0000")) patch.participants = people;
		if (amount.trim()) {
			const parsed = parseCNYAmountToCent(amount);
			if (parsed.error) { setError(parsed.error); return; }
			if (parsed.cents !== item.amountCent) patch.amountCent = parsed.cents;
		} else if (item.amountCent !== null) { setError("请填写明细金额，暂不能清空已有金额。"); return; }
		if (Object.keys(patch).length === 1) { setNotice("没有需要保存的修改。"); return; }
		try { await mutation.mutateAsync({ itemId: item.id, patch }); setIsEditing(false); setNotice("明细已保存。"); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
	}
	const label = `第 ${index + 1} 条`;
	return <form className="expense-item-card" onSubmit={(event) => { void save(event); }} noValidate>
		<div className="expense-item-heading"><strong>{label} · {filename}</strong><span className="status-tag">{typeLabel(item.receiptType)}</span></div>
		<div className="application-form-grid">
			<div className="field-stack"><label htmlFor={`item-category-${item.id}`}>{label}费用类别</label><input id={`item-category-${item.id}`} value={category} onChange={(event) => { setIsEditing(true); setCategory(event.target.value); }} disabled={claim.status !== "DRAFT" || mutation.isPending} /><small>{sourceLabel(item.categorySource)}</small></div>
			<div className="field-stack"><label htmlFor={`item-amount-${item.id}`}>{label}金额</label><input id={`item-amount-${item.id}`} value={amount} inputMode="decimal" onChange={(event) => { setIsEditing(true); setAmount(event.target.value); }} disabled={claim.status !== "DRAFT" || mutation.isPending} /><small>{sourceLabel(item.amountSource)}</small></div>
		</div>
		<div className="field-stack"><label htmlFor={`item-purpose-${item.id}`}>{label}事由</label><input id={`item-purpose-${item.id}`} value={purpose} onChange={(event) => { setIsEditing(true); setPurpose(event.target.value); }} disabled={claim.status !== "DRAFT" || mutation.isPending} /><small>{sourceLabel(item.purposeSource)}</small></div>
		<div className="application-form-grid">
			<div className="field-stack"><label htmlFor={`item-project-${item.id}`}>{label}项目编码</label><input id={`item-project-${item.id}`} value={projectCode} onChange={(event) => { setIsEditing(true); setProjectCode(event.target.value); }} disabled={claim.status !== "DRAFT" || mutation.isPending} /></div>
			<div className="field-stack"><label htmlFor={`item-participants-${item.id}`}>{label}同行人</label><input id={`item-participants-${item.id}`} value={participants} onChange={(event) => { setIsEditing(true); setParticipants(event.target.value); }} disabled={claim.status !== "DRAFT" || mutation.isPending} /></div>
		</div>
		{error && <p className="field-error" role="alert">{error}</p>}
		{notice && <p role="status">{notice}</p>}
		{claim.status === "DRAFT" && <button className="secondary-action" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "正在保存…" : `保存${label}明细`}</button>}
	</form>;
}
