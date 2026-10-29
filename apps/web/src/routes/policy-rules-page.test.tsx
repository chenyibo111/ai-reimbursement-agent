import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PolicyRulesPage } from "./policy-rules-page";
import { reimbursementApi } from "../api/client";

vi.mock("../api/client", () => ({ reimbursementApi: { publishPolicy: vi.fn().mockResolvedValue({ id: "2026-Q4", status: "PUBLISHED" }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("publishes a blocking whole-claim limit in cents", async () => {
  const user = userEvent.setup();
  render(<PolicyRulesPage />);
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
  render(<PolicyRulesPage />);
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
  render(<PolicyRulesPage />);
  expect(screen.getByText("已发布版本不能覆盖；调整规则时请填写新的版本编号。")).toBeInTheDocument();
});
