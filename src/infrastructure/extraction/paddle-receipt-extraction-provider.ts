import type { ReceiptExtraction } from "@/src/domain/receipt-extraction";
import type { ReceiptExtractionProvider } from "@/src/infrastructure/extraction/receipt-extraction-provider";

type OcrResult = { modelVersion: string; pages: Array<{ text: string; confidence: number }> };

export class PaddleReceiptExtractionProvider implements ReceiptExtractionProvider {
  constructor(private readonly ocr: { extract(input: { objectKey: string; mimeType: string }): Promise<OcrResult> }) {}

  async extract(input: { objectKey: string; mimeType: string }): Promise<ReceiptExtraction> {
    const result = await this.ocr.extract(input);
    const text = result.pages.map((page) => page.text).join("\n");
    const confidence = result.pages.length ? Math.min(...result.pages.map((page) => page.confidence)) : 0;
    const invoiceNumber = labeled(text, /发票(?:号码|号)[：:\s]*([A-Z0-9-]{6,})/i);
    const issuedOn = date(labeled(text, /开票日期[：:\s]*([0-9年月日./-]{8,})/));
    const total = money(labeled(text, /(?:价税合计(?:（小写）)?|合计金额|[（(]小写[）)])[：:\s￥¥]*([0-9,]+(?:\.\d{1,2})?)/));
    const tax = money(labeled(text, /(?:合计税额|税额)[：:\s￥¥]*([0-9,]+(?:\.\d{1,2})?)/));
    const seller = labeled(text, /销售方(?:名称)?[：:\s]*([^\n]{2,80})/);
    return {
      modelVersion: result.modelVersion,
      receiptType: /发票/.test(text) ? "INVOICE" : "OTHER_RECEIPT",
      invoiceNumber: field(invoiceNumber, confidence),
      issuedOn: field(issuedOn, confidence),
      totalAmountCents: field(total, confidence),
      taxAmountCents: field(tax, confidence),
      sellerName: field(seller, confidence),
    };
  }
}

function labeled(text: string, pattern: RegExp) { return pattern.exec(text)?.[1]?.trim() ?? null; }
function date(value: string | null) { if (!value) return null; const parts = value.replace(/[年月./]/g, "-").replace("日", "").split("-").filter(Boolean); return parts.length === 3 ? `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}` : null; }
function money(value: string | null) { if (!value) return null; const parsed = Number(value.replaceAll(",", "")); return Number.isFinite(parsed) ? Math.round(parsed * 100) : null; }
function field(value: string | number | null, confidence: number) { return { value, confidence: value === null ? 0 : confidence, source: "EXTRACTED" as const }; }
