import { expect, it } from "vitest";

import { loadConfig } from "@/src/server/config";

it("rejects production mode without a receipt extraction provider", () => {
  expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
    "RECEIPT_EXTRACTION_PROVIDER is required in production",
  );
});

it("rejects production mode without a model provider", () => {
  expect(() =>
    loadConfig({
      NODE_ENV: "production",
      RECEIPT_EXTRACTION_PROVIDER: "fixture",
    }),
  ).toThrow("MODEL_PROVIDER is required in production");
});
