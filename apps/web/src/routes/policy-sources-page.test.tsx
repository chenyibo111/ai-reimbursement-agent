import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { PolicySourcesPage } from "./policy-sources-page";
import { reimbursementApi, ReimbursementApiError } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client")>();
  return { ...original, reimbursementApi: {
    listPolicySources: vi.fn(), createPolicySource: vi.fn(), setPolicySourceEnabled: vi.fn(),
    syncPolicySource: vi.fn(), getPolicySourceJob: vi.fn(),
  } };
});

const source = { id: "source-1", type: "FEISHU_DOCX" as const, title: "费用制度", canonicalUrl: "https://example.feishu.cn/docx/abc", enabled: true, lastSuccessfulSyncAt: null, lastFailureCode: null, sectionCount: null, chunkCount: null, lastJob: null, createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z" };
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><PolicySourcesPage /></MemoryRouter></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it("shows loading, empty state, and allows adding an authorized Docx source", async () => {
  const user = userEvent.setup();
  vi.mocked(reimbursementApi.listPolicySources).mockResolvedValueOnce({ sources: [] }).mockResolvedValue({ sources: [source] });
  vi.mocked(reimbursementApi.createPolicySource).mockResolvedValue(source);
  mount();
  expect(screen.getByText("正在读取政策来源…")).toBeInTheDocument();
  expect(await screen.findByText(/尚未登记政策来源/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("来源标题"), "费用制度");
  await user.type(screen.getByLabelText("飞书链接"), source.canonicalUrl);
  await user.click(screen.getByRole("button", { name: "添加来源" }));
  await waitFor(() => expect(reimbursementApi.createPolicySource).toHaveBeenCalledWith({ title: "费用制度", url: source.canonicalUrl }));
  expect(await screen.findByText("费用制度")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "打开原文" })).toHaveAttribute("rel", "noopener noreferrer");
});

it("disables an existing source and preserves the last indexed snapshot on failed sync", async () => {
  const user = userEvent.setup();
  vi.mocked(reimbursementApi.listPolicySources).mockResolvedValue({ sources: [{ ...source, sectionCount: 3, chunkCount: 8, lastFailureCode: "EMBEDDING_UNAVAILABLE" }] });
  vi.mocked(reimbursementApi.setPolicySourceEnabled).mockResolvedValue({ ...source, enabled: false, sectionCount: 3, chunkCount: 8 });
  mount();
  expect(await screen.findByText("当前索引：3 个章节 · 8 个检索片")).toBeInTheDocument();
  expect(screen.getByText(/向量化服务不可用/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "停用来源" }));
  await waitFor(() => expect(reimbursementApi.setPolicySourceEnabled).toHaveBeenCalledWith("source-1", false));
});

it("restores a completed unchanged job without rendering undefined chunks", async () => {
  vi.mocked(reimbursementApi.listPolicySources).mockResolvedValue({ sources: [{ ...source, lastJob: { jobId: "job-1", status: "SUCCEEDED", failureCode: null, resultKind: "UNCHANGED" } }] });
  mount();
  expect(await screen.findByText(/原文未变化/)).toBeInTheDocument();
  expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
});

it("treats sync as queued and polls the persisted job before showing new index counts", async () => {
  const user = userEvent.setup();
  vi.mocked(reimbursementApi.listPolicySources)
    .mockResolvedValueOnce({ sources: [source] })
    .mockResolvedValueOnce({ sources: [{ ...source, lastJob: { jobId: "job-1", status: "PENDING", failureCode: null, resultKind: null } }] })
    .mockResolvedValue({ sources: [{ ...source, sectionCount: 2, chunkCount: 5, lastJob: { jobId: "job-1", status: "SUCCEEDED", failureCode: null, resultKind: "SYNCED" } }] });
  vi.mocked(reimbursementApi.syncPolicySource).mockResolvedValue({ sourceId: source.id, jobId: "job-1", jobStatus: "PENDING" });
  vi.mocked(reimbursementApi.getPolicySourceJob).mockResolvedValue({ jobId: "job-1", status: "SUCCEEDED", failureCode: null, resultKind: "SYNCED" });
  mount();
  await screen.findByText("费用制度");
  await user.click(screen.getByRole("button", { name: "立即同步" }));
  expect(await screen.findByText("同步任务处理中")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "立即同步" })).toBeDisabled();
  await waitFor(() => expect(reimbursementApi.getPolicySourceJob).toHaveBeenCalledWith("source-1", "job-1"), { timeout: 4500 });
  expect(await screen.findByText("当前索引：2 个章节 · 5 个检索片")).toBeInTheDocument();
});

it.each([403, 503])("shows a recoverable %i read error", async (status) => {
  vi.mocked(reimbursementApi.listPolicySources).mockRejectedValue(new ReimbursementApiError("REQUEST_FAILED", "服务暂不可用", status));
  mount();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
});
