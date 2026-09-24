import type { ChatModel } from "@/src/infrastructure/model/chat-model";

export class FakeChatModel implements ChatModel {
  async decide(input: Parameters<ChatModel["decide"]>[0]): Promise<unknown> {
    const summary = input.summary as { allowedTargets?: Array<{ target?: unknown; fields?: unknown }> };
    const canSuggestPurpose = summary.allowedTargets?.some((target) => target.target === "claim" && Array.isArray(target.fields) && target.fields.includes("purpose"));
    if (canSuggestPurpose && input.message.trim()) {
      return { reply: "我建议将这段说明作为报销事由，请确认后写入草稿。", proposals: [{ target: "claim", field: "purpose", value: input.message.trim(), reason: "补齐提交前必填的报销事由" }] };
    }
    return { reply: "我会根据报销单中的待确认项协助你补充信息。", proposals: [] };
  }
}
