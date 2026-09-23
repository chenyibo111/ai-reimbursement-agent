"use client";

import { useRef, useState } from "react";

type Props = { claimId: string; onComplete: () => void };

export function ReceiptUpload({ claimId, onComplete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("支持 JPG、PNG、PDF，单个文件最多 20MB。");
  const [isUploading, setIsUploading] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) return;
    setIsUploading(true);
    setMessage(`正在安全检查并上传「${file.name}」…`);
    try {
      const form = new FormData();
      form.set("file", file);
      const uploadResponse = await fetch(`/api/claims/${claimId}/receipts`, { method: "POST", body: form });
      const receipt = await uploadResponse.json() as { id?: string; error?: string };
      if (!uploadResponse.ok || !receipt.id) throw new Error(receipt.error || "上传失败，请重试。");
      setMessage("票据已保存，正在读取关键信息…");
      const extractResponse = await fetch(`/api/claims/${claimId}/receipts/${receipt.id}/extract`, { method: "POST" });
      const extraction = await extractResponse.json() as { error?: string };
      if (!extractResponse.ok) throw new Error(extraction.error || "票据识别失败，请重试。");
      setMessage("票据已识别，已更新报销明细。");
      onComplete();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败，请重试。");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section aria-labelledby="receipt-upload-title">
      <div className="section-heading"><div><p className="eyebrow">票据</p><h2 id="receipt-upload-title">上传票据</h2></div></div>
      <div className="upload-zone">
        <input ref={inputRef} id="receipt-file" className="sr-only" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => void upload(event.target.files?.[0])} />
        <p><strong>将发票或报销凭证放在这里</strong><br />系统会先完成安全检查，再提取金额、日期和票据号码。</p>
        <button type="button" className="button-outline" onClick={() => inputRef.current?.click()} disabled={isUploading}>{isUploading ? "处理中…" : "选择票据文件"}</button>
        <p role="status" className={message.includes("失败") ? "notice-error" : "hint"}>{message}</p>
      </div>
    </section>
  );
}
