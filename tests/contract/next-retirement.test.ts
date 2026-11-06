import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

it("has no Next application, package, configuration, or production build", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
  expect(existsSync(resolve(root, "app"))).toBe(false);
  expect(existsSync(resolve(root, "src/ui"))).toBe(false);
  expect(existsSync(resolve(root, "next.config.ts"))).toBe(false);
  expect(pkg.dependencies).not.toHaveProperty("next");
  expect(pkg.dependencies).not.toHaveProperty("react");
  expect(pkg.dependencies).not.toHaveProperty("react-dom");
  expect(pkg.devDependencies).not.toHaveProperty("eslint-config-next");
  expect(pkg.scripts).not.toHaveProperty("build");
  expect(read(".github/workflows/ci.yml")).not.toContain("next build");
  expect(read("Dockerfile")).not.toContain("legacy-web");
  expect(read("docker-compose.yml")).not.toMatch(/^  web:/m);
});
