import { describe, expect, it } from "vitest";

import { parseAgentProposal } from "@/src/domain/agent-proposal";

describe("parseAgentProposal", () => {
  it("accepts the four permitted target and field combinations", () => {
    expect(parseAgentProposal({ target: "claim", field: "purpose", value: "客户拜访交通与餐饮", reason: "补齐必填事由" })).toMatchObject({ target: "claim", field: "purpose", value: "客户拜访交通与餐饮" });
    expect(parseAgentProposal({ target: "expense-1", field: "invoiceNumber", value: "NO-001", reason: "OCR 置信度较低" })).toMatchObject({ target: "expense-1", field: "invoiceNumber", value: "NO-001" });
    expect(parseAgentProposal({ target: "expense-2", field: "issuedOn", value: "2026-09-24", reason: "需要确认日期" })).toMatchObject({ target: "expense-2", field: "issuedOn", value: "2026-09-24" });
    expect(parseAgentProposal({ target: "expense-3", field: "totalAmountCents", value: 12345, reason: "需要确认金额" })).toMatchObject({ target: "expense-3", field: "totalAmountCents", value: 12345 });
  });

  it.each([
    { target: "expense-0", field: "invoiceNumber", value: "NO-001", reason: "invalid target" },
    { target: "claim", field: "employeeName", value: "张三", reason: "invalid field" },
    { target: "expense-1", field: "totalAmountCents", value: 12.5, reason: "invalid amount" },
    { target: "expense-1", field: "issuedOn", value: "2026-02-30", reason: "invalid date" },
    { target: "claim", field: "invoiceNumber", value: "NO-001", reason: "invalid scope" },
  ])("rejects invalid proposal %#", (input) => {
    expect(() => parseAgentProposal(input)).toThrow();
  });
});
