export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogService = "web" | "job-worker" | "feishu-worker" | "agent-event-worker" | "ocr" | "alert-relay";

type LogValue = string | number | boolean | null;

export type LogFields = Partial<{
  requestId: string;
  jobId: string;
  jobKind: string;
  claimId: string;
  receiptId: string;
  policySourceId: string;
  attempt: number;
  count: number;
  durationMs: number;
  status: string | number;
  failureCode: string;
  traceId: string;
  spanId: string;
}> & Record<string, unknown>;

type LoggerOptions = {
  write?: (line: string) => void;
  now?: () => Date;
};

export type Logger = {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
};

const allowedFieldNames = new Set<keyof LogFields>([
  "requestId",
  "jobId",
  "jobKind",
  "claimId",
  "receiptId",
  "policySourceId",
  "attempt",
  "count",
  "durationMs",
  "status",
  "failureCode",
  "traceId",
  "spanId",
]);

function sanitizeFields(fields: LogFields | undefined): Record<string, LogValue> {
  if (!fields) return {};

  const safeEntries: Array<[string, LogValue]> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFieldNames.has(key as keyof LogFields) || value === undefined) continue;
    if (typeof value === "string") safeEntries.push([key, value.slice(0, 256)]);
    if (typeof value === "number" || typeof value === "boolean" || value === null) safeEntries.push([key, value]);
  }
  return Object.fromEntries(safeEntries);
}

export function createLogger(service: LogService, options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, event: string, message: string, fields?: LogFields) => {
    write(JSON.stringify({
      timestamp: now().toISOString(),
      level,
      service,
      event: event.slice(0, 128),
      message: message.slice(0, 512),
      ...sanitizeFields(fields),
    }));
  };

  return {
    debug: (event, message, fields) => log("debug", event, message, fields),
    info: (event, message, fields) => log("info", event, message, fields),
    warn: (event, message, fields) => log("warn", event, message, fields),
    error: (event, message, fields) => log("error", event, message, fields),
  };
}
