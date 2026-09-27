export const agentConversationKinds = ["PRIVATE", "GROUP"] as const;
export type AgentConversationKind = (typeof agentConversationKinds)[number];

export const agentMessageRoles = ["USER", "ASSISTANT", "SYSTEM"] as const;
export type AgentMessageRole = (typeof agentMessageRoles)[number];

export const agentMessageChannels = ["WEB", "FEISHU"] as const;
export type AgentMessageChannel = (typeof agentMessageChannels)[number];

export const reimbursementIntakeStatuses = ["COLLECTING", "READY_TO_SUBMIT", "SUBMITTED", "ABANDONED"] as const;
export type ReimbursementIntakeStatus = (typeof reimbursementIntakeStatuses)[number];

export const activeReimbursementIntakeStatuses = ["COLLECTING", "READY_TO_SUBMIT"] as const satisfies readonly ReimbursementIntakeStatus[];

export const privateConversationScopeKey = "private";

export const conversationCollectedFieldNames = ["purpose", "expenseCategory", "participants", "projectCode"] as const;
export type ConversationCollectedFieldName = (typeof conversationCollectedFieldNames)[number];

export function isConversationCollectedFieldName(value: string): value is ConversationCollectedFieldName {
  return (conversationCollectedFieldNames as readonly string[]).includes(value);
}

export function isActiveReimbursementIntake(status: ReimbursementIntakeStatus): boolean {
  return activeReimbursementIntakeStatuses.includes(status as (typeof activeReimbursementIntakeStatuses)[number]);
}
