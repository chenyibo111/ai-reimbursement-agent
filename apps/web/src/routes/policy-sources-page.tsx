import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { reimbursementApi, ReimbursementApiError, type PolicySource, type PolicySourceJob } from "../api/client";

const sourceKey = ["policy-sources"] as const;
const activeStatuses = new Set(["PENDING", "RUNNING", "RETRY_WAIT"]);

export function PolicySourcesPage() {
  const queryClient = useQueryClient();
  const sources = useQuery({ queryKey: sourceKey, queryFn: reimbursementApi.listPolicySources, retry: false });
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const add = useMutation({ mutationFn: (input: { title: string; url: string }) => reimbursementApi.createPolicySource(input), onSuccess: async () => { setTitle(""); setUrl(""); setNotice("来源已添加，请手动同步。"); await queryClient.invalidateQueries({ queryKey: sourceKey }); } });

  const pendingJobs = (sources.data?.sources ?? []).filter((source) => source.lastJob && activeStatuses.has(source.lastJob.status)).map((source) => `${source.id}:${source.lastJob!.jobId}`).join("|");
  useEffect(() => {
    if (!pendingJobs) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (++attempts > 30) { window.clearInterval(timer); setNotice("同步仍在处理中。稍后可刷新状态。"); return; }
      void Promise.all(pendingJobs.split("|").map(async (entry) => {
        const [sourceId, jobId] = entry.split(":");
        const job = await reimbursementApi.getPolicySourceJob(sourceId, jobId);
        if (!activeStatuses.has(job.status)) await queryClient.invalidateQueries({ queryKey: sourceKey });
      })).catch((error: unknown) => { window.clearInterval(timer); setActionError(errorMessage(error)); });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pendingJobs, queryClient]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setActionError(""); setNotice("");
    if (!title.trim() || !url.trim()) { setActionError("请填写来源标题和飞书链接。"); return; }
    try { await add.mutateAsync({ title: title.trim(), url: url.trim() }); }
    catch (error) { setActionError(errorMessage(error)); }
  }

  async function changeEnabled(source: PolicySource) {
    setBusyId(source.id); setActionError(""); setNotice("");
    try {
      await reimbursementApi.setPolicySourceEnabled(source.id, !source.enabled);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
      setNotice(source.enabled ? "来源已停用，不再参与制度问答。" : "来源已启用，可手动同步。");
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusyId(null); }
  }

  async function sync(source: PolicySource) {
    setBusyId(source.id); setActionError(""); setNotice("");
    try {
      await reimbursementApi.syncPolicySource(source.id);
      await queryClient.invalidateQueries({ queryKey: sourceKey });
      setNotice("同步任务已加入队列，完成后会更新来源状态。");
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusyId(null); }
  }

  return <main className="page-shell" aria-labelledby="policy-sources-title">
    <header className="page-header"><div><p className="eyebrow">政策管理员</p><h1 id="policy-sources-title">政策知识来源</h1><p className="page-summary">仅登记已获授权的飞书文档或 Wiki 页面；系统不会搜索或枚举飞书空间。</p></div><Link className="secondary-action" to="/admin/policies">可执行规则</Link></header>
    {actionError && <p className="field-error" role="alert">{actionError}</p>}{notice && <p className="inline-notice" role="status">{notice}</p>}
    <section className="workbench-panel policy-sources-panel" aria-labelledby="source-create-title"><h2 id="source-create-title">添加来源</h2><form className="policy-source-form" noValidate onSubmit={(event) => void create(event)}><div className="field-stack"><label htmlFor="source-title">来源标题</label><input id="source-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required disabled={add.isPending} /></div><div className="field-stack"><label htmlFor="source-url">飞书链接</label><input id="source-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://xxx.feishu.cn/docx/..." required disabled={add.isPending} /></div><button className="primary-action" type="submit" disabled={add.isPending}>{add.isPending ? "正在添加…" : "添加来源"}</button></form></section>
    <section className="workbench-panel policy-sources-panel" aria-labelledby="source-list-title"><div className="section-heading"><h2 id="source-list-title">已登记来源</h2><button className="secondary-action" type="button" onClick={() => void sources.refetch()} disabled={sources.isFetching}>刷新状态</button></div>
      {sources.isLoading ? <p className="empty-state" role="status">正在读取政策来源…</p> : sources.error ? <div role="alert" className="field-error"><p>{errorMessage(sources.error)}</p><button className="secondary-action" type="button" onClick={() => void sources.refetch()}>重试</button></div> : sources.data?.sources.length ? <ul className="policy-source-list">{sources.data.sources.map((source) => <li key={source.id} className="policy-source-card"><div className="policy-source-main"><strong>{source.title}</strong><p className="card-meta">{source.type === "FEISHU_WIKI" ? "飞书知识库" : "飞书文档"} · {source.enabled ? "已启用" : "已停用"} · {source.lastSuccessfulSyncAt ? `上次成功同步 ${formatDate(source.lastSuccessfulSyncAt)}` : "尚未成功同步"}</p><p>{indexLabel(source)}</p>{source.lastJob && <p>{jobLabel(source.lastJob)}</p>}{source.lastFailureCode && <p className="field-error">最近同步失败：{failureLabel(source.lastFailureCode)}。已保留上一次成功内容。</p>}<a className="review-claim-link" href={source.canonicalUrl} target="_blank" rel="noopener noreferrer">打开原文</a></div><div className="policy-source-actions"><button className="secondary-action" type="button" disabled={busyId === source.id} onClick={() => void changeEnabled(source)}>{source.enabled ? "停用来源" : "重新启用"}</button><button className="secondary-action" type="button" disabled={busyId === source.id || !source.enabled || Boolean(source.lastJob && activeStatuses.has(source.lastJob.status))} onClick={() => void sync(source)}>{busyId === source.id ? "处理中…" : "立即同步"}</button></div></li>)}</ul> : <p className="empty-state">尚未登记政策来源。添加授权文档后，员工才能获得带原文引用的制度答复。</p>}
    </section>
  </main>;
}

function indexLabel(source: PolicySource): string {
  if (source.chunkCount == null || source.sectionCount == null) return "尚无可检索内容";
  if (source.sectionCount === 0 && source.chunkCount > 0) return `旧版索引：${source.chunkCount} 个检索片；重新同步后可按章节检索`;
  return `当前索引：${source.sectionCount} 个章节 · ${source.chunkCount} 个检索片`;
}
function jobLabel(job: PolicySourceJob | null): string {
  if (!job) return "";
  if (activeStatuses.has(job.status)) return "同步任务处理中";
  if (job.status === "SUCCEEDED") return job.resultKind === "UNCHANGED" ? "原文未变化，继续使用现有政策快照。" : "同步完成，当前索引已更新。";
  if (job.status === "REVIEW_REQUIRED" || job.status === "FAILED" || job.status === "CLOSED") return `同步失败：${failureLabel(job.failureCode)}。`;
  return "";
}
function failureLabel(code: string | null): string {
  const labels: Record<string, string> = {
    EMBEDDING_UNAVAILABLE: "向量化服务不可用，请检查知识库服务是否已启动",
    DOCUMENT_UNAUTHORIZED: "飞书应用无权读取此文档，请将文档授权给应用",
    DOCUMENT_RESOURCE_NOT_FOUND: "未找到飞书文档，请检查链接是否正确",
    DOCUMENT_UNSUPPORTED_SHEET: "文档含嵌入电子表格，请将条款转为文档正文或表格后重试",
    DOCUMENT_INVALID_RESPONSE: "飞书文档结构无法完整读取，请检查文档内容和授权",
  };
  return code ? labels[code] ?? "请检查服务日志并重试" : "原因待确认，请检查任务日志";
}
function errorMessage(error: unknown): string {
  if (error instanceof ReimbursementApiError && error.status === 403) return "当前账号没有政策管理权限。";
  if (error instanceof ReimbursementApiError && error.status === 401) return "登录已失效，请重新登录后重试。";
  if (error instanceof ReimbursementApiError && error.status === 503) return "政策管理服务暂不可用，请稍后重试。";
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
