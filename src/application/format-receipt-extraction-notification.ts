const confidenceThreshold = 0.9;
const keyFields = ["invoiceNumber", "issuedOn", "totalAmountCents"] as const;

type KeyField = (typeof keyFields)[number];
type ExtractionField = { value: string | number | null; confidence: number; source?: unknown };

export function formatReceiptExtractionNotification(input: {
  publicAppUrl: string;
  claimId: string | null;
  jobStatus: "SUCCEEDED" | "REVIEW_REQUIRED" | "CLOSED";
  extractionPayload: unknown;
}): string {
  const workspace = input.claimId ? `${input.publicAppUrl}/claims/${encodeURIComponent(input.claimId)}` : `${input.publicAppUrl}/claims`;
  const fields = fieldsFrom(input.extractionPayload);
  if (input.jobStatus === "CLOSED" || !fields) {
    return `票据识别未完成。请在工作台补充信息或重新上传票据。\n\n报销工作台：${workspace}`;
  }

  const confirmed = keyFields.every((key) => isConfirmed(fields[key]));
  const lines = confirmed ? ["票据识别完成。"] : ["票据识别结果需要确认。"];
  for (const key of keyFields) lines.push(renderField(key, fields[key]));
  if (input.jobStatus === "REVIEW_REQUIRED") lines.push("该票据已转人工复核，请以确认后的结果为准。");
  lines.push(`报销工作台：${workspace}`);
  return lines.join("\n");
}

function fieldsFrom(payload: unknown): Partial<Record<KeyField, ExtractionField>> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fields: Partial<Record<KeyField, ExtractionField>> = {};
  for (const key of keyFields) {
    const candidate = (payload as Record<string, unknown>)[key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = (candidate as Record<string, unknown>).value;
    const confidence = (candidate as Record<string, unknown>).confidence;
    if ((typeof value !== "string" && typeof value !== "number" && value !== null) || typeof confidence !== "number") continue;
    fields[key] = { value, confidence };
  }
  return fields;
}

function isConfirmed(field: ExtractionField | undefined): field is ExtractionField & { value: string | number } {
  return Boolean(field && field.value !== null && field.value !== "" && field.confidence >= confidenceThreshold);
}

function renderField(key: KeyField, field: ExtractionField | undefined): string {
  const label = key === "invoiceNumber" ? "发票号码" : key === "issuedOn" ? "开票日期" : "价税合计";
  if (!isConfirmed(field)) {
    if (field?.value !== null && field?.value !== undefined && field.value !== "") return `${label}：待确认识别值 ${formatValue(key, field.value)}`;
    return `${label}：请补充或确认`;
  }
  return `${label}：${formatValue(key, field.value)}`;
}

function formatValue(key: KeyField, value: string | number): string {
  if (key !== "totalAmountCents") return String(value);
  const cents = typeof value === "number" ? value : Number(value);
  return Number.isFinite(cents) ? `¥${(cents / 100).toFixed(2)}` : String(value);
}
