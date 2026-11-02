import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { ClaimWorkbenchPage } from "./routes/claim-workbench-page";
import { ClaimListPage } from "./routes/claims-list-page";
import { NewClaimPage } from "./routes/new-claim-page";
import { PolicyRulesPage } from "./routes/policy-rules-page";
import { ReviewCenterPage } from "./routes/review-center-page";
import { useAuthSession } from "./auth/session";

export function App() {
  const { session, loginUrl, refreshAccessToken } = useAuthSession();
  const loggedOut = window.location.pathname === "/logged-out";

  useEffect(() => {
    if (!loggedOut && session.status === "unauthenticated") window.location.assign(loginUrl);
  }, [loggedOut, loginUrl, session.status]);

  if (loggedOut) {
    return <main className="page-shell"><section className="workbench-panel" aria-labelledby="logged-out-title"><h1 id="logged-out-title">已退出所有项目</h1><p className="page-summary">当前登录已结束。需要继续使用报销工作台时，请重新登录。</p><a className="secondary-action" href="/api/auth/sso/login?returnTo=%2Fclaims">重新登录</a></section></main>;
  }

  if (session.status === "loading") {
    return <main className="page-shell"><p className="empty-state" role="status">正在验证登录状态…</p></main>;
  }
  if (session.status === "unauthenticated") {
    return <main className="page-shell"><p className="empty-state" role="status">正在前往统一登录…</p></main>;
  }
  if (session.status === "logging-out") {
    return <main className="page-shell"><p className="empty-state" role="status">正在退出所有项目…</p></main>;
  }
  if (session.status === "error") {
    return <main className="page-shell"><section className="workbench-panel" aria-labelledby="session-error-title"><h1 id="session-error-title">暂时无法验证登录状态</h1><p className="page-summary">{session.message}</p><button className="secondary-action" type="button" onClick={() => { void refreshAccessToken().catch(() => undefined); }}>重新验证</button></section></main>;
  }

  return <Routes>
    <Route path="/claims" element={<ClaimListPage />} />
    <Route path="/claims/new" element={<NewClaimPage />} />
    <Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} />
    <Route path="/admin/policies" element={<PolicyRulesPage />} />
    <Route path="/admin/reviews" element={<ReviewCenterPage />} />
    <Route path="*" element={<Navigate to="/claims" replace />} />
  </Routes>;
}
