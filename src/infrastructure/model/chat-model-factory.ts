import type { AppConfig } from "@/src/server/config";
import { FakeChatModel } from "@/src/infrastructure/model/fake-chat-model";
import { OpenAiCompatibleChatModel } from "@/src/infrastructure/model/openai-compatible-chat-model";

export function createChatModel(config: AppConfig) {
  if (config.modelProvider === "fixture") return new FakeChatModel();
  if (config.modelProvider === "openai-compatible" && config.model) {
    return new OpenAiCompatibleChatModel({
      baseUrl: config.model.baseUrl,
      model: config.model.name,
      apiKey: config.model.apiKey,
      timeoutMs: config.model.timeoutMs,
    });
  }
  throw new Error("AI model provider is not configured");
}
