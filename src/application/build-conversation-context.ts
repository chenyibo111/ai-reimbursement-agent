import {
  isConversationCollectedFieldName,
  type AgentMessageChannel,
  type AgentMessageRole,
  type ConversationCollectedFieldName,
  type ReimbursementIntakeStatus,
} from "@/src/domain/agent-conversation";

export type ConversationContext = {
  summary: { text: string; throughSequence: number };
  messages: Array<{ sequence: number; role: AgentMessageRole; channel: AgentMessageChannel; text: string }>;
  intake: { status: ReimbursementIntakeStatus; collectedFields: Record<string, unknown>; pendingFields: string[] } | null;
  policyCitations: Array<{ title: string; headingPath: string[]; excerpt: string; score: number }>;
  allowedFields: ConversationCollectedFieldName[];
};

type ConversationContextInput = {
  conversation: { summary: string; summaryThroughSequence: number };
  messages: Array<{ sequence: number; role: AgentMessageRole; channel: AgentMessageChannel; text: string }>;
  intake: { status: ReimbursementIntakeStatus; claimId: string | null; collectedFields: unknown; pendingFields: string[] } | null;
  policyCitations: Array<{ title: string; headingPath: string[]; excerpt: string; score: number; url?: string }>;
  budgets?: Partial<ConversationContextBudgets>;
};

export type ConversationContextBudgets = {
  summaryChars: number;
  messageChars: number;
  intakeChars: number;
  policyChars: number;
};

const defaultBudgets: ConversationContextBudgets = {
  summaryChars: 6_000,
  messageChars: 12_000,
  intakeChars: 6_000,
  policyChars: 10_000,
};

export function buildConversationContext(input: ConversationContextInput): ConversationContext {
  const budgets = { ...defaultBudgets, ...input.budgets };
  const intake = toSafeIntake(input.intake, budgets.intakeChars);
  return {
    summary: {
      text: clamp(input.conversation.summary, budgets.summaryChars),
      throughSequence: Math.max(0, input.conversation.summaryThroughSequence),
    },
    messages: selectNewestMessages(input.messages, budgets.messageChars),
    intake,
    policyCitations: selectPolicyCitations(input.policyCitations, budgets.policyChars),
    allowedFields: intake?.pendingFields.filter(isConversationCollectedFieldName) ?? [],
  };
}

function selectNewestMessages(
  messages: ConversationContextInput["messages"],
  budget: number,
): ConversationContext["messages"] {
  let remaining = positiveBudget(budget);
  const selected: ConversationContext["messages"] = [];
  for (const message of [...messages].sort((left, right) => right.sequence - left.sequence)) {
    const text = message.text.trim();
    if (!text || text.length > remaining) continue;
    selected.push({ sequence: message.sequence, role: message.role, channel: message.channel, text });
    remaining -= text.length;
    if (remaining === 0) break;
  }
  return selected;
}

function toSafeIntake(input: ConversationContextInput["intake"], budget: number): ConversationContext["intake"] {
  if (!input) return null;
  const collectedFields = toBoundedObject(input.collectedFields, budget);
  return { status: input.status, collectedFields, pendingFields: input.pendingFields.map((field) => clamp(field, 80)).filter(Boolean) };
}

function selectPolicyCitations(
  citations: ConversationContextInput["policyCitations"],
  budget: number,
): ConversationContext["policyCitations"] {
  let remaining = positiveBudget(budget);
  const safe: ConversationContext["policyCitations"] = [];
  for (const citation of citations.slice(0, 5)) {
    const title = clamp(citation.title, Math.min(200, remaining));
    const headingPath = citation.headingPath.map((heading) => clamp(heading, 160)).filter(Boolean);
    const used = title.length + headingPath.join("/").length;
    const excerpt = clamp(citation.excerpt, remaining - used);
    if (!title || !excerpt) continue;
    safe.push({ title, headingPath, excerpt, score: citation.score });
    remaining -= used + excerpt.length;
    if (remaining === 0) break;
  }
  return safe;
}

function toBoundedObject(value: unknown, budget: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  let remaining = positiveBudget(budget);
  for (const [key, fieldValue] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (remaining <= key.length) break;
    const serialized = JSON.stringify(fieldValue);
    if (!serialized) continue;
    const bounded = clamp(serialized, remaining - key.length);
    if (!bounded) break;
    try {
      output[key] = JSON.parse(bounded);
    } catch {
      output[key] = bounded;
    }
    remaining -= key.length + bounded.length;
  }
  return output;
}

function positiveBudget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clamp(value: string, limit: number): string {
  return value.trim().slice(0, positiveBudget(limit));
}
