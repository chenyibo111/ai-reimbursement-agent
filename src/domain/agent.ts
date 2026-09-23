export const allowedAgentTools = ["get_claim_summary", "update_claim_field", "validate_claim"] as const;
export type AllowedAgentTool = (typeof allowedAgentTools)[number];

export function isAllowedAgentTool(value: unknown): value is AllowedAgentTool {
  return typeof value === "string" && (allowedAgentTools as readonly string[]).includes(value);
}
