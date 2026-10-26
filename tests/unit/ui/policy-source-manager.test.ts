import { expect, it } from "vitest";

import { policyFailureLabel, policySyncNotice, policySourceIndexLabel } from "@/src/ui/policy-source-manager";

it("describes an accepted policy sync as queued instead of completed", () => {
  expect(policySyncNotice({ jobStatus: "PENDING" })).toBe("同步任务已加入队列，完成后会更新来源状态。");
});

it("shows a chunk count only for a completed policy sync response", () => {
  expect(policySyncNotice({ status: "SYNCED", chunkCount: 52 })).toBe("同步完成：52 个切片。");
});

it("turns a source failure code into an actionable policy sync message", () => {
  expect(policyFailureLabel("EMBEDDING_UNAVAILABLE")).toBe("向量化服务不可用，请检查知识库服务是否已启动");
  expect(policyFailureLabel("DOCUMENT_UNAUTHORIZED")).toBe("飞书应用无权读取此文档，请将文档授权给应用");
  expect(policyFailureLabel("DOCUMENT_UNSUPPORTED_SHEET")).toContain("嵌入电子表格");
});

it("labels active section and chunk counts without claiming a queued sync is complete", () => {
  expect(policySourceIndexLabel({ sectionCount: null, chunkCount: null })).toBe("尚无可检索内容");
  expect(policySourceIndexLabel({ sectionCount: 4, chunkCount: 12 })).toBe("当前索引：4 个章节 · 12 个检索片");
  expect(policySourceIndexLabel({ sectionCount: 0, chunkCount: 12 })).toBe("旧版索引：12 个检索片；重新同步后可按章节检索");
});
