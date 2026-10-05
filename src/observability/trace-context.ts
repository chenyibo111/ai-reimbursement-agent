export type TraceLogContext = Partial<{
  traceId: string;
  spanId: string;
}>;

const traceparentPattern = /^\d{2}-([a-f0-9]{32})-([a-f0-9]{16})-\d{2}$/i;

export function traceContextFromHeaders(headers: Headers): TraceLogContext {
  const traceparent = headers.get("traceparent");
  const match = traceparent?.match(traceparentPattern);
  if (!match) return {};
  return { traceId: match[1]?.toLowerCase(), spanId: match[2]?.toLowerCase() };
}
