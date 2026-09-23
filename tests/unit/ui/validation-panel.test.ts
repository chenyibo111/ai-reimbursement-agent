import { expect, it } from "vitest";

import { validationMessage } from "@/src/ui/validation-panel";

it("explains every low-confidence validation code in employee language", () => {
  expect(validationMessage("CONFIRM_TOTAL_AMOUNT")).toBe("请确认低置信度的票据金额。");
  expect(validationMessage("CONFIRM_ISSUED_ON")).toBe("请确认低置信度的开票日期。");
  expect(validationMessage("CONFIRM_INVOICE_NUMBER")).toBe("请确认低置信度的票据号码。");
});
