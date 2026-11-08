import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "./app";

const mocks = vi.hoisted(() => ({ useAuthSession: vi.fn() }));
vi.mock("./auth/session", () => ({ useAuthSession: mocks.useAuthSession }));
afterEach(() => cleanup());

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

it("shows an explicit login action when silent SSO cannot reuse a session", () => {
  window.history.pushState({}, "", "/login?returnTo=%2Fadmin%2Fpolicy-sources");
  mocks.useAuthSession.mockReturnValue({ session: { status: "loading" } });
  try {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole("heading", { name: "登录报销工作台" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用飞书登录" })).toHaveAttribute("href", "/api/auth/sso/login?returnTo=%2Fadmin%2Fpolicy-sources");
  } finally {
    window.history.pushState({}, "", "/");
  }
});

it("starts a silent authorization when the app has no local session", () => {
	window.history.pushState({}, "", "/claims");
	mocks.useAuthSession.mockReturnValue({ session: { status: "unauthenticated" }, loginUrl: "/api/auth/sso/login?returnTo=%2Fclaims", silentLoginUrl: "/api/auth/sso/silent?returnTo=%2Fclaims" });
	const assign = vi.fn();
	const originalLocation = window.location;
	Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, pathname: "/claims", assign } });
	try {
		render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/claims"]}><App /></MemoryRouter></QueryClientProvider>);
		expect(assign).toHaveBeenCalledWith("/api/auth/sso/silent?returnTo=%2Fclaims");
	} finally {
		Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
		window.history.pushState({}, "", "/");
	}
});

it("explains that the former policy page was retired instead of silently opening claims", () => {
  mocks.useAuthSession.mockReturnValue({ session: { status: "authenticated", employee: { displayName: "测试员工" } } });
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/policies"]}><App /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole("heading", { name: "旧政策页面已停用" })).toBeInTheDocument();
});

it("lets an authenticated employee exit SSO from the workbench", () => {
  const logout = vi.fn();
  mocks.useAuthSession.mockReturnValue({ session: { status: "authenticated", employee: { displayName: "陈亦博" } }, logout });
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/policies"]}><App /></MemoryRouter></QueryClientProvider>);

  expect(screen.getByText("陈亦博")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  expect(logout).toHaveBeenCalledOnce();
});

it("offers the canonical claim link for a retired detail URL", () => {
  mocks.useAuthSession.mockReturnValue({ session: { status: "authenticated", employee: { displayName: "测试员工" } } });
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/claims/claim-123/detail"]}><App /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole("link", { name: "打开当前报销单" })).toHaveAttribute("href", "/claims/claim-123");
});
