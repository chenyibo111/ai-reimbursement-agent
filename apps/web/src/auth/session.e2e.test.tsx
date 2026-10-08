import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AuthSessionProvider, useAuthSession } from "./session";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
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

function Probe() {
  const { session } = useAuthSession();
  return <output>{session.status}</output>;
}
