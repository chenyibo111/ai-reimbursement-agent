"use client";

import { useState } from "react";

type UploadResult = { status: "EXTRACTED" | "SAVED_UNEXTRACTED"; filename: string };
type UploadInput = { claimId: string; file: File; fetchImpl?: typeof fetch; onComplete: () => void };

export async function uploadReceipt({ claimId, file, fetchImpl = fetch, onComplete }: UploadInput): Promise<UploadResult> {
  let receiptId: string | undefined;
  try {
    const form = new FormData();
    form.set("file", file);
    const uploadResponse = await fetchImpl(`/api/claims/${claimId}/receipts`, { method: "POST", body: form });
    const receipt = await uploadResponse.json() as { id?: string; error?: string };
    if (!uploadResponse.ok || !receipt.id) throw new Error(receipt.error || "上传失败，请重试。");
    receiptId = receipt.id;
    const extractResponse = await fetchImpl(`/api/claims/${claimId}/receipts/${receiptId}/extract`, { method: "POST" });
    if (!extractResponse.ok) { onComplete(); return { status: "SAVED_UNEXTRACTED", filename: file.name }; }
    onComplete();
    return { status: "EXTRACTED", filename: file.name };
  } catch (error) {
    if (receiptId) { onComplete(); return { status: "SAVED_UNEXTRACTED", filename: file.name }; }
    throw error;
  }
}

export function useReceiptUpload({ claimId, onComplete }: Pick<UploadInput, "claimId" | "onComplete">) {
  const [message, setMessage] = useState("支持 JPG、PNG、PDF，单个文件最多 20MB。");
  const [isUploading, setIsUploading] = useState(false);
  async function upload(file: File | undefined) {
    if (!file || isUploading) return;
    setIsUploading(true); setMessage(`正在安全检查并上传「${file.name}」…`);
    try {
      const result = await uploadReceipt({ claimId, file, onComplete });
      setMessage(result.status === "EXTRACTED" ? "票据已识别，已更新报销明细。" : "票据已保存，但暂未完成识别。可在下方重新识别。");
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败，请重试。");
      return undefined;
    } finally { setIsUploading(false); }
  }
  return { upload, message, isUploading };
}
