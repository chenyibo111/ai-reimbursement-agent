import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AuthSessionProvider, useAuthSession } from "./session";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("does not request an access token on the public logged-out page", async () => {
  window.history.pushState({}, "", "/logged-out");
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  await waitFor(() => expect(screen.getByText("loading")).toBeInTheDocument());
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not request an access token on the explicit login page", async () => {
  window.history.pushState({}, "", "/login?returnTo=%2Fclaims");
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  expect(fetcher).not.toHaveBeenCalled();
});

it("recovers an in-memory session after a reload only by calling the Auth BFF", async () => {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    accessToken: "short-lived-token",
    expiresAt,
    employee: { id: "employee-1", displayName: "测试员工", role: "EMPLOYEE" },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);

  const first = render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  await waitFor(() => expect(screen.getByText("authenticated")).toBeInTheDocument());
  first.unmount();
  render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

  expect(fetcher).toHaveBeenNthCalledWith(1, "/api/auth/access-token", { credentials: "same-origin" });
  expect(fetcher).toHaveBeenNthCalledWith(2, "/api/auth/access-token", { credentials: "same-origin" });
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

it("revalidates the SSO session when the workbench tab becomes visible", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: "short-lived-token",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      employee: { id: "employee-1", displayName: "测试员工", role: "EMPLOYEE" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 }));
  vi.stubGlobal("fetch", fetcher);

  render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  await waitFor(() => expect(screen.getByText("authenticated")).toBeInTheDocument());

  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(screen.getByText("unauthenticated")).toBeInTheDocument());
  expect(fetcher).toHaveBeenCalledTimes(2);
});

function Probe() {
  const { session } = useAuthSession();
  return <output>{session.status}</output>;
}
