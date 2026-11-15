import { useEffect } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";

import { ClaimWorkbenchPage } from "./routes/claim-workbench-page";
import { AdminConfigPage } from "./routes/admin-config-page";
import { ClaimListPage } from "./routes/claims-list-page";
import { NewClaimPage } from "./routes/new-claim-page";
import { PolicyRulesPage } from "./routes/policy-rules-page";
import { PolicySourcesPage } from "./routes/policy-sources-page";
import { ReviewCenterPage } from "./routes/review-center-page";
import { useAuthSession } from "./auth/session";

export function App() {
  const { session, silentLoginUrl, refreshAccessToken, logout } = useAuthSession();
  const loggedOut = window.location.pathname === "/logged-out";
  const loginRequired = window.location.pathname === "/login";

  useEffect(() => {
    if (!loggedOut && !loginRequired && session.status === "unauthenticated") window.location.assign(silentLoginUrl);
  }, [loggedOut, loginRequired, silentLoginUrl, session.status]);

  if (loggedOut) {
    return <main className="page-shell"><section className="workbench-panel" aria-labelledby="logged-out-title"><h1 id="logged-out-title">已退出所有项目</h1><p className="page-summary">当前登录已结束。需要继续使用报销工作台时，请重新登录。</p><a className="secondary-action" href="/api/auth/sso/login?returnTo=%2Fclaims">重新登录</a></section></main>;
  }

  if (loginRequired) {
    const returnTo = new URLSearchParams(window.location.search).get("returnTo") || "/claims";
    return <main className="page-shell"><section className="workbench-panel" aria-labelledby="login-title"><h1 id="login-title">登录报销工作台</h1><p className="page-summary">当前没有可复用的统一登录会话。请确认要使用的飞书账号后登录。</p><a className="primary-action new-claim-action" href={`/api/auth/sso/login?returnTo=${encodeURIComponent(returnTo)}`}>使用飞书登录</a></section></main>;
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

  return <>
    <header className="session-bar">
      <div className="session-bar-inner">
        <Link to="/claims">报销工作台</Link>
        {session.employee.role === "ADMIN" && <Link to="/admin/config">配置中心</Link>}
        <div className="session-actions">
          <span>{session.employee.displayName}</span>
          <button className="secondary-action" type="button" onClick={() => { void logout(); }}>退出登录</button>
        </div>
      </div>
    </header>
    <Routes>
      <Route path="/claims" element={<ClaimListPage />} />
      <Route path="/claims/new" element={<NewClaimPage />} />
      <Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} />
      <Route path="/admin/policies" element={<PolicyRulesPage />} />
      <Route path="/admin/config" element={<AdminConfigPage isAdmin={session.employee.role === "ADMIN"} />} />
      <Route path="/admin/policy-sources" element={<PolicySourcesPage />} />
      <Route path="/admin/reviews" element={<ReviewCenterPage />} />
      <Route path="/policies" element={<RetiredPage title="旧政策页面已停用" description="政策问答已转到飞书机器人。报销单和政策规则仍可在当前工作台查看。" />} />
      <Route path="/claims/:claimId/detail" element={<RetiredClaimDetailPage />} />
      <Route path="*" element={<Navigate to="/claims" replace />} />
    </Routes>
  </>;
}

function RetiredPage({ title, description }: { title: string; description: string }) {
  return <main className="page-shell"><section className="workbench-panel"><h1>{title}</h1><p className="page-summary">{description}</p><Link className="secondary-action" to="/claims">返回报销单列表</Link></section></main>;
}

function RetiredClaimDetailPage() {
  const { claimId } = useParams();
  return <main className="page-shell"><section className="workbench-panel"><h1>报销单详情地址已更新</h1><p className="page-summary">请使用当前工作台查看这张报销单。</p><Link className="secondary-action" to={`/claims/${encodeURIComponent(claimId ?? "")}`}>打开当前报销单</Link></section></main>;
}
