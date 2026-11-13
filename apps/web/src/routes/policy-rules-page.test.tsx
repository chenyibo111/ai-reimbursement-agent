import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PolicyRulesPage } from "./policy-rules-page";
import { reimbursementApi } from "../api/client";

vi.mock("../api/client", () => ({ reimbursementApi: {
  publishPolicy: vi.fn().mockResolvedValue({ id: "2026-Q4", status: "PUBLISHED" }),
  getExpenseCatalog: vi.fn().mockResolvedValue({ domain: "expense_catalog", version: 1, publishedAt: "2026-11-01T00:00:00Z", payload: { categories: [
    { code: "LOCAL_TRANSPORT", label: "市内交通费", aliases: [], enabled: true, sortOrder: 10 },
    { code: "DINING", label: "餐饮费", aliases: [], enabled: true, sortOrder: 20 },
  ] } }),
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("publishes a blocking whole-claim limit in cents", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><PolicyRulesPage /></MemoryRouter>);
  await user.type(screen.getByLabelText("版本编号"), "2026-Q4");
  await user.type(screen.getByLabelText("生效日期"), "2026-10-28");
  await user.click(screen.getByRole("button", { name: "添加规则" }));
  await user.type(screen.getByLabelText("编号"), "TOTAL_LIMIT");
  await user.type(screen.getByLabelText("名称"), "整单金额上限");
  await user.type(screen.getByLabelText("上限金额（元）"), "1000.50");
  await user.click(screen.getByRole("button", { name: "发布政策版本" }));
  await waitFor(() => expect(reimbursementApi.publishPolicy).toHaveBeenCalledWith("2026-Q4", "2026-10-28", [{ code: "TOTAL_LIMIT", name: "整单金额上限", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", config: { maxAmountCents: 100050 } }]));
});

it("refuses an amount whose cent value cannot be represented exactly", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><PolicyRulesPage /></MemoryRouter>);
  await user.type(screen.getByLabelText("版本编号"), "too-large");
  await user.type(screen.getByLabelText("生效日期"), "2026-10-28");
  await user.click(screen.getByRole("button", { name: "添加规则" }));
  await user.type(screen.getByLabelText("编号"), "TOTAL");
  await user.type(screen.getByLabelText("名称"), "总额");
  await user.type(screen.getByLabelText("上限金额（元）"), "900719925474100");
  await user.click(screen.getByRole("button", { name: "发布政策版本" }));
  expect(reimbursementApi.publishPolicy).not.toHaveBeenCalled();
});

it("explains that a published version identifier cannot be reused", () => {
  render(<MemoryRouter><PolicyRulesPage /></MemoryRouter>);
  expect(screen.getByText("已发布版本不能覆盖；调整规则时请填写新的版本编号。")).toBeInTheDocument();
});

it("publishes category rules with stable catalog codes", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><PolicyRulesPage /></MemoryRouter>);
  await user.type(screen.getByLabelText("版本编号"), "codes-v1");
  await user.type(screen.getByLabelText("生效日期"), "2026-11-13");
  await user.click(screen.getByRole("button", { name: "添加规则" }));
  await user.type(screen.getByLabelText("编号"), "ALLOW");
  await user.type(screen.getByLabelText("名称"), "允许类别");
  await user.selectOptions(screen.getByLabelText("校验方式"), "CATEGORY_ALLOWED");
  await user.click(await screen.findByRole("checkbox", { name: "餐饮费" }));
  await user.click(screen.getByRole("button", { name: "发布政策版本" }));
  await waitFor(() => expect(reimbursementApi.publishPolicy).toHaveBeenCalledWith("codes-v1", "2026-11-13", [{ code: "ALLOW", name: "允许类别", type: "CATEGORY_ALLOWED", severity: "BLOCKING", config: { categoryCodes: ["DINING"] } }]));
});
