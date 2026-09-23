"use client";

import { useState } from "react";

import { formatMoney, lowConfidenceField, type ClaimReceipt, type ConfirmableExpenseField, type ExpenseItem } from "@/src/ui/claim-types";

type Props = {
  items: ExpenseItem[];
  receipts: ClaimReceipt[];
  onConfirmField: (item: ExpenseItem, field: ConfirmableExpenseField, value: string | number) => Promise<boolean>;
};

type EditingField = { itemId: string; field: ConfirmableExpenseField } | null;

const labels: Record<ConfirmableExpenseField, string> = {
  invoiceNumber: "票据号码",
  issuedOn: "开票日期",
  totalAmountCents: "金额",
};

export function ExpenseTable({ items, receipts, onConfirmField }: Props) {
  const [editing, setEditing] = useState<EditingField>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function startEditing(item: ExpenseItem, field: ConfirmableExpenseField) {
    setEditing({ itemId: item.id, field });
    setError(null);
    setValue(initialValue(item, field));
  }

  async function save(item: ExpenseItem, field: ConfirmableExpenseField) {
    const fieldValue = normalizedValue(value, field);
    if (fieldValue === null) { setError(`请输入有效的${labels[field]}。`); return; }
    setError(null);
    const saved = await onConfirmField(item, field, fieldValue);
    if (saved) setEditing(null);
  }

  return (
    <section aria-labelledby="expense-table-title">
      <div className="section-heading"><div><p className="eyebrow">费用明细</p><h2 id="expense-table-title">已计入的费用</h2></div><span className="count-badge">{items.length} 笔</span></div>
      {items.length === 0 ? <div className="empty-state">上传并识别票据后，费用明细会出现在这里。</div> : (
        <div className="table-wrap"><table><thead><tr><th>票据号码</th><th>开票日期</th><th>金额</th><th>来源</th></tr></thead><tbody>
          {items.map((item) => {
            const receipt = receipts.find((candidate) => candidate.id === item.receiptId);
            return <tr key={item.id}>
              <EditableCell item={item} receipt={receipt} field="invoiceNumber" editing={editing} value={value} onChange={setValue} onEdit={startEditing} onSave={save} displayValue={item.invoiceNumber || "待识别"} />
              <EditableCell item={item} receipt={receipt} field="issuedOn" editing={editing} value={value} onChange={setValue} onEdit={startEditing} onSave={save} displayValue={item.issuedOn ? new Date(item.issuedOn).toLocaleDateString("zh-CN") : "待识别"} />
              <EditableCell item={item} receipt={receipt} field="totalAmountCents" editing={editing} value={value} onChange={setValue} onEdit={startEditing} onSave={save} displayValue={formatMoney(item.amountCents)} />
              <td>{hasUserConfirmedField(item) ? "员工确认" : "票据识别"}</td>
            </tr>;
          })}
        </tbody></table>{error ? <p role="alert" className="notice-error">{error}</p> : null}</div>
      )}
    </section>
  );
}

function EditableCell({ item, receipt, field, editing, value, onChange, onEdit, onSave, displayValue }: {
  item: ExpenseItem; receipt: ClaimReceipt | undefined; field: ConfirmableExpenseField; editing: EditingField; value: string; onChange: (value: string) => void; onEdit: (item: ExpenseItem, field: ConfirmableExpenseField) => void; onSave: (item: ExpenseItem, field: ConfirmableExpenseField) => Promise<void>; displayValue: string;
}) {
  const isEditing = editing?.itemId === item.id && editing.field === field;
  const needsConfirmation = lowConfidenceField(receipt, field);
  if (!isEditing) return <td>{displayValue} {needsConfirmation ? <button type="button" className="text-button" onClick={() => onEdit(item, field)}>确认{labels[field]}</button> : null}</td>;
  return <td><span className="inline-editor"><label className="sr-only" htmlFor={`${field}-${item.id}`}>确认{labels[field]}</label><input id={`${field}-${item.id}`} type={field === "issuedOn" ? "date" : "text"} inputMode={field === "totalAmountCents" ? "decimal" : undefined} value={value} onChange={(event) => onChange(event.target.value)} /><button type="button" onClick={() => void onSave(item, field)}>保存</button></span></td>;
}

function initialValue(item: ExpenseItem, field: ConfirmableExpenseField) {
  if (field === "totalAmountCents") return (item.amountCents / 100).toFixed(2);
  if (field === "issuedOn") return item.issuedOn?.slice(0, 10) ?? "";
  return item.invoiceNumber ?? "";
}

function normalizedValue(value: string, field: ConfirmableExpenseField): string | number | null {
  if (field === "totalAmountCents") {
    const cents = Math.round(Number(value) * 100);
    return Number.isFinite(cents) && cents > 0 ? cents : null;
  }
  return value.trim() ? value.trim() : null;
}

function hasUserConfirmedField(item: ExpenseItem) {
  return item.amountSource === "USER_ENTERED" || item.issuedOnSource === "USER_ENTERED" || item.invoiceSource === "USER_ENTERED";
}
