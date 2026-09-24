"use client";

import { useRef, useState } from "react";

import { extractedReceiptField, formatMoney, receiptDisplayName, receiptStatusLabel, type ClaimReceipt } from "@/src/ui/claim-types";
import { useReceiptUpload } from "@/src/ui/use-receipt-upload";

type Props = { claimId: string; receipts: ClaimReceipt[]; onComplete: () => void };
type ReceiptField = "invoiceNumber" | "issuedOn" | "totalAmountCents";

export function ReceiptUpload({ claimId, receipts, onComplete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { upload, message, isUploading } = useReceiptUpload({ claimId, onComplete });
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retryExtraction(receiptId: string) {
    setRetryingId(receiptId);
    setRetryError(null);
    try {
      const response = await fetch(`/api/claims/${claimId}/receipts/${receiptId}/extract`, { method: "POST" });
      if (!response.ok) throw new Error("recognition failed");
      onComplete();
    } catch {
      setRetryError("重新识别暂未完成，请稍后再试。");
      onComplete();
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <section aria-labelledby="receipt-upload-title">
      <div className="section-heading"><div><p className="eyebrow">票据</p><h2 id="receipt-upload-title">上传票据</h2></div></div>
      <div className="upload-zone">
        <input ref={inputRef} id="receipt-file" className="sr-only" type="file" aria-label="上传票据" accept="image/jpeg,image/png,application/pdf" onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        <p><strong>将发票或报销凭证放在这里</strong><br />系统会先完成安全检查，再提取金额、日期和票据号码。</p>
        <button type="button" className="button-outline" onClick={() => inputRef.current?.click()} disabled={isUploading}>{isUploading ? "处理中…" : "选择票据文件"}</button>
        <p role="status" className={message.includes("失败") ? "notice-error" : "hint"}>{message}</p>
      </div>
      {receipts.length ? <ul className="receipt-list" aria-label="已上传票据">
        {receipts.map((receipt) => <li className="receipt-card" key={receipt.id}>
          <div className="receipt-card-header">
            <div><strong>{receiptDisplayName(receipt)}</strong><span className="receipt-id">票据 #{receipt.id.slice(-6).toUpperCase()}</span></div>
            <span className={`receipt-status receipt-status-${receipt.status.toLowerCase()}`}>{receiptStatusLabel(receipt.status)}</span>
          </div>
          <dl className="receipt-fields">
            <ReceiptFieldValue label="发票号码" receipt={receipt} field="invoiceNumber" />
            <ReceiptFieldValue label="开票日期" receipt={receipt} field="issuedOn" />
            <ReceiptFieldValue label="价税合计" receipt={receipt} field="totalAmountCents" />
          </dl>
          {receipt.status === "FAILED" ? <div className="receipt-actions"><p className="notice-error">识别失败，票据已保留。</p><button type="button" className="button-outline" onClick={() => void retryExtraction(receipt.id)} disabled={isUploading || retryingId !== null} aria-busy={retryingId === receipt.id}>{retryingId === receipt.id ? "重新识别中…" : "重新识别"}</button></div> : null}
        </li>)}
      </ul> : null}
      {retryError ? <p className="notice-error" role="alert">{retryError}</p> : null}
    </section>
  );
}

function ReceiptFieldValue({ label, receipt, field }: { label: string; receipt: ClaimReceipt; field: ReceiptField }) {
  const extracted = extractedReceiptField(receipt, field);
  const value = extracted ? field === "totalAmountCents" && typeof extracted.value === "number" ? formatMoney(extracted.value) : String(extracted.value) : "待补齐";
  const confidence = extracted?.confidence;
  return <div><dt>{label}</dt><dd>{value}{confidence === null || confidence === undefined ? null : <span>置信度 {Math.round(confidence * 100)}%</span>}</dd></div>;
}
