export function assertClaimOwner(actorId: string, claim: { employeeId: string }) {
  if (actorId !== claim.employeeId) {
    throw new Error("forbidden");
  }
}
