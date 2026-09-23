import type { ChatModel } from "@/src/infrastructure/model/chat-model";

export class FakeChatModel implements ChatModel {
  async decide(): Promise<unknown> {
    return { reply: "我会根据报销单中的待确认项协助你补充信息。", toolCalls: [{ name: "validate_claim", args: {} }] };
  }
}
