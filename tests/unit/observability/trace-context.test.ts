import { expect, it } from "vitest";

import { traceContextFromHeaders } from "@/src/observability/trace-context";

it("extracts only a well-formed W3C trace context for safe log correlation", () => {
  expect(traceContextFromHeaders(new Headers({
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  }))).toEqual({
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
  });
  expect(traceContextFromHeaders(new Headers({ traceparent: "not-a-trace" }))).toEqual({});
});
