import { useMutation, useQueryClient } from "@tanstack/react-query";

import { reimbursementApi } from "../../api/client";
import { claimKeys } from "../claims/use-claim";

const acceptedTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);

export function useReceiptUpload(claimId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!acceptedTypes.has(file.type)) throw new Error("仅支持 JPG、PNG 或 PDF 格式的票据。");
      if (file.size <= 0 || file.size > 20 * 1024 * 1024) throw new Error("单个附件需大于 0 且不超过 20 MB。");
      const session = await reimbursementApi.createUploadSession(claimId, { filename: file.name, contentType: file.type, sizeBytes: file.size });
      const uploadResponse = await fetch(session.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!uploadResponse.ok) throw new Error("附件上传未完成，请检查网络后重试。");
      await reimbursementApi.finalizeReceipt(claimId, session.receiptId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: claimKeys.receipts(claimId) }),
  });
}
