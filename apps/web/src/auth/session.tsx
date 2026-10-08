import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useRef, useState } from "react";

import { configureReimbursementApiTokenProvider, type TokenProvider } from "../api/client";

export type AuthenticatedEmployee = { id: string; displayName: string; role: "EMPLOYEE" | "FINANCE_REVIEWER" | "ADMIN" };
export type AuthSessionSnapshot =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }
  | { status: "authenticated"; accessToken: string; expiresAt: string; employee: AuthenticatedEmployee };

type AuthSessionResponse = { accessToken: string; expiresAt: string; employee: AuthenticatedEmployee };
type AuthSessionManagerDeps = { fetcher?: typeof fetch; now?: () => Date };

export class AuthSessionError extends Error {
  constructor(public readonly code: "UNAUTHENTICATED" | "SESSION_UNAVAILABLE", message: string) {
    super(message);
  }
}

export function createAuthSessionManager(deps: AuthSessionManagerDeps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? (() => new Date());
  let snapshot: AuthSessionSnapshot = { status: "loading" };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const setSnapshot = (next: AuthSessionSnapshot) => { snapshot = next; notify(); };

  async function refresh() {
    const response = await fetcher("/api/auth/access-token", { credentials: "same-origin" });
    if (response.status === 401) {
      setSnapshot({ status: "unauthenticated" });
      throw new AuthSessionError("UNAUTHENTICATED", "请先登录后再操作");
    }
    if (!response.ok) {
      setSnapshot({ status: "error", message: "登录状态暂时无法验证，请稍后重试。" });
      throw new AuthSessionError("SESSION_UNAVAILABLE", "登录状态暂时无法验证，请稍后重试。");
    }
    const payload = await response.json() as Partial<AuthSessionResponse>;
    if (!isSessionResponse(payload)) {
      setSnapshot({ status: "error", message: "登录状态返回异常，请稍后重试。" });
      throw new AuthSessionError("SESSION_UNAVAILABLE", "登录状态返回异常，请稍后重试。");
    }
    setSnapshot({ status: "authenticated", ...payload });
    return payload.accessToken;
  }

  return {
    async initialize() {
      try {
        return await refresh();
      } catch (error) {
        if (error instanceof AuthSessionError && error.code === "UNAUTHENTICATED") return null;
        throw error;
      }
    },
    refreshAccessToken: refresh,
    async refreshIfExpiring() {
      if (snapshot.status !== "authenticated") return snapshot.status === "unauthenticated" ? null : refresh();
      const remainingMs = Date.parse(snapshot.expiresAt) - now().getTime();
      return remainingMs <= 60_000 ? refresh() : snapshot.accessToken;
    },
    getAccessToken() { return snapshot.status === "authenticated" ? snapshot.accessToken : null; },
    snapshot() { return snapshot; },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async logout() {
      setSnapshot({ status: "unauthenticated" });
      await fetcher("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    },
  };
}

type AuthSessionManager = ReturnType<typeof createAuthSessionManager>;
type AuthSessionContextValue = { session: AuthSessionSnapshot; getAccessToken(): string | null; refreshAccessToken(): Promise<string>; logout(): Promise<void>; loginUrl: string };
const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

export function AuthSessionProvider({ children }: PropsWithChildren) {
  const managerRef = useRef<AuthSessionManager | null>(null);
  if (!managerRef.current) managerRef.current = createAuthSessionManager();
  const manager = managerRef.current;
  const [session, setSession] = useState<AuthSessionSnapshot>(manager.snapshot());

  useEffect(() => manager.subscribe(() => setSession(manager.snapshot())), [manager]);
  useEffect(() => { void manager.initialize().catch(() => undefined); }, [manager]);
  useEffect(() => { configureReimbursementApiTokenProvider(manager); }, [manager]);
  useEffect(() => {
    if (session.status !== "authenticated") return;
    const delay = Math.max(0, Date.parse(session.expiresAt) - Date.now() - 60_000);
    const timer = window.setTimeout(() => { void manager.refreshAccessToken().catch(() => undefined); }, delay);
    return () => window.clearTimeout(timer);
  }, [manager, session]);

  const value = useMemo<AuthSessionContextValue>(() => ({
    session,
    getAccessToken: manager.getAccessToken,
    refreshAccessToken: manager.refreshAccessToken,
    logout: manager.logout,
    loginUrl: createLoginUrl(),
  }), [manager, session]);

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession() {
  const value = useContext(AuthSessionContext);
  if (!value) throw new Error("useAuthSession must be used inside AuthSessionProvider");
  return value;
}

function createLoginUrl() {
  if (typeof window === "undefined") return "/api/auth/feishu/login?returnTo=%2Fclaims";
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `/api/auth/feishu/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function isSessionResponse(value: Partial<AuthSessionResponse>): value is AuthSessionResponse {
  return typeof value.accessToken === "string" && Boolean(value.accessToken)
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    && typeof value.employee?.id === "string" && Boolean(value.employee.id)
    && typeof value.employee.displayName === "string"
    && ["EMPLOYEE", "FINANCE_REVIEWER", "ADMIN"].includes(value.employee.role ?? "");
}

export type { TokenProvider };
