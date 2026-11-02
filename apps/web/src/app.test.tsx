import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { App } from "./app";

const mocks = vi.hoisted(() => ({ useAuthSession: vi.fn() }));
vi.mock("./auth/session", () => ({ useAuthSession: mocks.useAuthSession }));

it("holds protected routes behind a stable login verification status", () => {
  mocks.useAuthSession.mockReturnValue({ session: { status: "loading" } });

  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/claims"]}><App /></MemoryRouter></QueryClientProvider>);

  expect(screen.getByRole("status")).toHaveTextContent("正在验证登录状态");
  expect(screen.queryByRole("heading", { name: "我的凭证卷宗" })).not.toBeInTheDocument();
});

it("keeps the logged-out page available without starting another login", () => {
  window.history.pushState({}, "", "/logged-out");
  mocks.useAuthSession.mockReturnValue({ session: { status: "unauthenticated" }, loginUrl: "/api/auth/sso/login?returnTo=%2Fclaims" });
  try {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/logged-out"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole("heading", { name: "已退出所有项目" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "重新登录" })).toHaveAttribute("href", "/api/auth/sso/login?returnTo=%2Fclaims");
  } finally {
    window.history.pushState({}, "", "/");
  }
});
