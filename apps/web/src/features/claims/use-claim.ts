import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { reimbursementApi } from "../../api/client";
import type { ClaimPatch } from "../../api/generated/reimbursement";

export const claimKeys = {
  all: ["claims"] as const,
  detail: (claimId: string) => [...claimKeys.all, claimId] as const,
  receipts: (claimId: string) => [...claimKeys.detail(claimId), "receipts"] as const,
  validation: (claimId: string) => [...claimKeys.detail(claimId), "validation"] as const,
};

export function shouldRefreshClaimAfterReceiptTransition(wasPending: boolean, isPending: boolean) {
  return wasPending && !isPending;
}

export function useClaims() {
  return useQuery({ queryKey: claimKeys.all, queryFn: reimbursementApi.listClaims });
}

export function useClaim(claimId: string) {
  return useQuery({ queryKey: claimKeys.detail(claimId), queryFn: () => reimbursementApi.getClaim(claimId), enabled: Boolean(claimId) });
}

export function useUpdateClaim(claimId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: ClaimPatch) => reimbursementApi.updateClaim(claimId, patch),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: claimKeys.detail(claimId) }),
				queryClient.invalidateQueries({ queryKey: claimKeys.all }),
				queryClient.invalidateQueries({ queryKey: claimKeys.validation(claimId) }),
			]);
		},
	});
}

export function useReceipts(claimId: string) {
  return useQuery({ queryKey: claimKeys.receipts(claimId), queryFn: () => reimbursementApi.listReceipts(claimId), enabled: Boolean(claimId), refetchInterval: (query) =>
    query.state.data?.items.some((receipt) => receipt.status === "UPLOAD_PENDING" || receipt.status === "READY_FOR_OCR") ? 3_000 : false,
  });
}

export function useDeleteReceipt(claimId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (receiptId: string) => reimbursementApi.deleteReceipt(claimId, receiptId),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: claimKeys.detail(claimId) }),
				queryClient.invalidateQueries({ queryKey: claimKeys.receipts(claimId) }),
				queryClient.invalidateQueries({ queryKey: claimKeys.validation(claimId) }),
				queryClient.invalidateQueries({ queryKey: claimKeys.all }),
			]);
		},
	});
}
