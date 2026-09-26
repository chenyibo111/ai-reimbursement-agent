import packageJson from "../../../package.json" with { type: "json" };
import { expect, test } from "vitest";

test("loads .env.local before starting the Feishu worker", () => {
  expect(packageJson.scripts["feishu:worker"]).toContain("--env-file=.env.local");
});
