import { useMutation, useQueryClient } from "@tanstack/react-query";

import { reimbursementApi } from "../../api/client";
import { claimKeys } from "../claims/use-claim";

export function useClaimValidation(claimId: string) {
  return useMutation({ mutationFn: () => reimbursementApi.getValidation(claimId) });
}

export function useSubmissionRequest(claimId: string) {
  return useMutation({ mutationFn: (version: number) => reimbursementApi.requestSubmission(claimId, version) });
}

export function useClaimSubmission(claimId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (confirmationToken: string) => reimbursementApi.submit(claimId, confirmationToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: claimKeys.detail(claimId) }),
  });
}
