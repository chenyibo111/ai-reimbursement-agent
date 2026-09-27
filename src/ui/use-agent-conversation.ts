"use client";

import { useCallback, useEffect, useState } from "react";

export type ConversationCitation = { id: string; title: string; url: string; excerpt: string; headingPath: string[]; score: number };
export type AgentConversationMessage = { id: string; sequence: number; role: "USER" | "ASSISTANT" | "SYSTEM"; channel: "WEB" | "FEISHU"; text: string; citations: ConversationCitation[] | null; result: Record<string, unknown> | null; createdAt: string };
export type AgentConversationIntake = { id: string; status: "COLLECTING" | "READY_TO_SUBMIT" | "SUBMITTED" | "ABANDONED"; claimId: string | null; pendingFields: string[]; collectedFields?: Record<string, unknown> };
export type AgentConversationState = {
  conversation: { id: string; kind: "PRIVATE"; lastActiveAt: string };
  messages: AgentConversationMessage[];
  intake: AgentConversationIntake | null;
};
export type AgentConversationTurn = { reply: string; citations: ConversationCitation[]; intake: AgentConversationIntake | null; submissionNumber?: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadAgentConversation(fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<AgentConversationState> {
  const response = await fetchImpl("/api/conversations/private", { signal });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, "无法读取报销助理会话。"));
  return normalizeConversation(payload);
}

export async function sendAgentConversationMessage(input: { message: string; fetchImpl?: FetchLike }): Promise<AgentConversationTurn> {
  const message = input.message.trim();
  if (!message) throw new Error("请输入消息。");
  const response = await (input.fetchImpl ?? fetch)("/api/conversations/private/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, "暂时无法发送消息。"));
  return normalizeTurn(payload);
}

export async function uploadAgentConversationAttachment(input: { file: File; fetchImpl?: FetchLike }): Promise<AgentConversationTurn> {
  const form = new FormData();
  form.set("file", input.file);
  const response = await (input.fetchImpl ?? fetch)("/api/conversations/private/attachments", { method: "POST", body: form });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(payload, "暂时无法上传票据。"));
  return normalizeTurn(payload);
}

export function useAgentConversation() {
  const [state, setState] = useState<AgentConversationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const next = await loadAgentConversation(fetch, signal);
      setState(next);
      setError(null);
      return next;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return null;
      setError(cause instanceof Error ? cause.message : "无法读取报销助理会话。");
      return null;
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const send = useCallback(async (message: string) => {
    setIsSending(true);
    try {
      const turn = await sendAgentConversationMessage({ message });
      await refresh();
      return turn;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "暂时无法发送消息。";
      setError(message);
      throw cause;
    } finally {
      setIsSending(false);
    }
  }, [refresh]);

  const upload = useCallback(async (file: File) => {
    setIsSending(true);
    try {
      const turn = await uploadAgentConversationAttachment({ file });
      await refresh();
      return turn;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "暂时无法上传票据。";
      setError(message);
      throw cause;
    } finally {
      setIsSending(false);
    }
  }, [refresh]);

  return { state, error, isLoading, isSending, refresh, send, upload };
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return {}; }
}

function errorMessage(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
}

function normalizeConversation(value: unknown): AgentConversationState {
  if (!value || typeof value !== "object") throw new Error("会话数据格式无效。");
  const payload = value as { conversation?: unknown; messages?: unknown; intake?: unknown };
  const conversation = payload.conversation as { id?: unknown; kind?: unknown; lastActiveAt?: unknown };
  if (!conversation || typeof conversation.id !== "string" || conversation.kind !== "PRIVATE" || typeof conversation.lastActiveAt !== "string") throw new Error("会话数据格式无效。");
  return {
    conversation: { id: conversation.id, kind: "PRIVATE", lastActiveAt: conversation.lastActiveAt },
    messages: Array.isArray(payload.messages) ? payload.messages.map(normalizeMessage).filter((message): message is AgentConversationMessage => message !== null) : [],
    intake: normalizeIntake(payload.intake),
  };
}

function normalizeTurn(value: unknown): AgentConversationTurn {
  if (!value || typeof value !== "object") throw new Error("会话响应格式无效。");
  const payload = value as { reply?: unknown; citations?: unknown; intake?: unknown; submissionNumber?: unknown };
  if (typeof payload.reply !== "string") throw new Error("会话响应格式无效。");
  return {
    reply: payload.reply,
    citations: Array.isArray(payload.citations) ? payload.citations.map(normalizeCitation).filter((citation): citation is ConversationCitation => citation !== null) : [],
    intake: normalizeIntake(payload.intake),
    ...(typeof payload.submissionNumber === "string" ? { submissionNumber: payload.submissionNumber } : {}),
  };
}

function normalizeMessage(value: unknown): AgentConversationMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || typeof message.sequence !== "number" || !isRole(message.role) || !isChannel(message.channel) || typeof message.text !== "string" || typeof message.createdAt !== "string") return null;
  return {
    id: message.id,
    sequence: message.sequence,
    role: message.role,
    channel: message.channel,
    text: message.text,
    citations: Array.isArray(message.citations) ? message.citations.map(normalizeCitation).filter((citation): citation is ConversationCitation => citation !== null) : null,
    result: isRecord(message.result) ? message.result : null,
    createdAt: message.createdAt,
  };
}

function normalizeIntake(value: unknown): AgentConversationIntake | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isIntakeStatus(value.status) || (typeof value.claimId !== "string" && value.claimId !== null) || !Array.isArray(value.pendingFields) || !value.pendingFields.every((field) => typeof field === "string")) return null;
  return { id: value.id, status: value.status, claimId: value.claimId, pendingFields: value.pendingFields, ...(isRecord(value.collectedFields) ? { collectedFields: value.collectedFields } : {}) };
}

function normalizeCitation(value: unknown): ConversationCitation | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.url !== "string" || typeof value.excerpt !== "string" || !Array.isArray(value.headingPath) || !value.headingPath.every((item) => typeof item === "string") || typeof value.score !== "number") return null;
  return { id: value.id, title: value.title, url: value.url, excerpt: value.excerpt, headingPath: value.headingPath, score: value.score };
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isRole(value: unknown): value is AgentConversationMessage["role"] { return value === "USER" || value === "ASSISTANT" || value === "SYSTEM"; }
function isChannel(value: unknown): value is AgentConversationMessage["channel"] { return value === "WEB" || value === "FEISHU"; }
function isIntakeStatus(value: unknown): value is AgentConversationIntake["status"] { return value === "COLLECTING" || value === "READY_TO_SUBMIT" || value === "SUBMITTED" || value === "ABANDONED"; }
