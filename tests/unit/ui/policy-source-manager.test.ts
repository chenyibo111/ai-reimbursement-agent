import { expect, it } from "vitest";

import { policyFailureLabel, policySyncNotice } from "@/src/ui/policy-source-manager";

it("describes an accepted policy sync as queued instead of completed", () => {
  expect(policySyncNotice({ jobStatus: "PENDING" })).toBe("同步任务已加入队列，完成后会更新来源状态。");
});

it("shows a chunk count only for a completed policy sync response", () => {
  expect(policySyncNotice({ status: "SYNCED", chunkCount: 52 })).toBe("同步完成：52 个切片。");
});

it("turns a source failure code into an actionable policy sync message", () => {
  expect(policyFailureLabel("EMBEDDING_UNAVAILABLE")).toBe("向量化服务不可用，请检查知识库服务是否已启动");
  expect(policyFailureLabel("DOCUMENT_UNAUTHORIZED")).toBe("飞书应用无权读取此文档，请将文档授权给应用");
});
