import type { Claim, ExpenseItem, Receipt } from "../../api/generated/reimbursement";
import { formatCNYFromCent } from "./claim-display";

function typeLabel(type: string) {
	return ({ TAXI: "打车", DINING: "餐饮", LODGING: "住宿", TRANSPORT: "交通", OTHER: "其他" } as Record<string, string>)[type] ?? (type || "待分类");
}

function classificationLabel(status?: ExpenseItem["classificationStatus"]) {
	return ({ CLASSIFIED: "已分类", UNKNOWN: "类型无法判断，请核对申请信息", FAILED: "AI 分类失败，请核对申请信息", CATEGORY_UNMAPPED: "类别不在当前规则中，请核对申请信息", PENDING: "等待分类" } as const)[status ?? "PENDING"];
}

export function ExpenseItemsPanel({ claim, receipts = [] }: { claim: Claim; receipts?: Receipt[] }) {
	const items = claim.expenseItems ?? [];
	const amount = claim.expenseItemTotalAmountCent ?? (items.length > 0 && items.every((item) => item.amountCent !== null) ? items.reduce((sum, item) => sum + (item.amountCent ?? 0), 0) : null);
	return <section className="workbench-panel" aria-labelledby="expense-items-heading">
		<div className="section-heading"><div><p className="eyebrow">逐票核对</p><h2 id="expense-items-heading">费用明细</h2></div><span className="status-tag">{items.length} 条</span></div>
		<p className="panel-copy">这里展示票据识别结果。费用类别和报销事由在下方申请报销信息中汇总。</p>
		{items.length === 0 ? <p className="empty-state">还没有费用明细。票据识别完成后会显示在这里。</p> : <>
			<p className="receipt-summary">明细合计 {amount === null ? "待补充" : formatCNYFromCent(amount)}</p>
			<div className="expense-item-list">{items.map((item, index) => <article className="expense-item-card" key={item.id}>
				<div className="expense-item-heading"><strong>第 {index + 1} 条 · {receipts.find((receipt) => receipt.id === item.receiptId)?.filename ?? `票据 ${index + 1}`}</strong><span className="status-tag">{typeLabel(item.receiptType)}</span></div>
				<dl className="receipt-facts"><div><dt>明细金额</dt><dd>{item.amountCent === null ? "待补充" : formatCNYFromCent(item.amountCent)}</dd></div><div><dt>分类状态</dt><dd>{classificationLabel(item.classificationStatus)}</dd></div></dl>
			</article>)}</div>
		</>}
	</section>;
}
