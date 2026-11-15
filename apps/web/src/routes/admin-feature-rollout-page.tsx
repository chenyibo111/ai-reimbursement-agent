import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { reimbursementApi, ReimbursementApiError, type ConfigDraft, type ConfigHistory, type ConfigSnapshot, type FeatureRollout } from "../api/client";

const domain = "feature_rollout";
const initialRollout: FeatureRollout = { mode: "OFF" };

function parseEmployeeIDs(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map((id) => id.trim()).filter(Boolean))];
}

export function AdminFeatureRolloutPage({ isAdmin }: { isAdmin: boolean }) {
  const [active, setActive] = useState<ConfigSnapshot<FeatureRollout> | null>(null);
  const [draft, setDraft] = useState<ConfigDraft<FeatureRollout> | null>(null);
  const [history, setHistory] = useState<ConfigHistory[]>([]);
  const [rollout, setRollout] = useState<FeatureRollout>(initialRollout);
  const [employeeText, setEmployeeText] = useState("");
  const [note, setNote] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const [preview, setPreview] = useState<{ draft: ConfigDraft<FeatureRollout>; active?: ConfigSnapshot<FeatureRollout> } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeEmployeeCount, setActiveEmployeeCount] = useState<number | null>(null);

  async function load() {
    const [state, records, audience] = await Promise.all([
      reimbursementApi.getAdminConfigDomain<FeatureRollout>(domain).catch((reason: unknown) => {
        if (reason instanceof ReimbursementApiError && reason.status === 404) return {} as { active?: ConfigSnapshot<FeatureRollout>; draft?: ConfigDraft<FeatureRollout> };
        throw reason;
      }),
      reimbursementApi.listConfigHistory(domain),
      reimbursementApi.getFeatureRolloutAudience().catch(() => null),
    ]);
    const unpublished = state.draft && state.draft.revision !== state.draft.publishedRevision ? state.draft : null;
    const selected = structuredClone(unpublished?.payload ?? state.active?.payload ?? initialRollout);
    setActive(state.active ?? null);
    setDraft(state.draft ?? null);
    setHistory(records.items);
    setActiveEmployeeCount(audience?.activeEmployeeCount ?? null);
    setRollout(selected);
    setEmployeeText((selected.employeeIds ?? []).join("\n"));
    setNote(unpublished?.note ?? "");
    setDirty(false);
    setPreview(null);
  }

  useEffect(() => {
    document.title = "智能补单灰度 · 报销配置";
    if (isAdmin) void load().catch((reason: unknown) => setError(message(reason))).finally(() => setLoading(false));
    return () => { document.title = "AI 报销 Agent"; };
  }, [isAdmin]);

  if (!isAdmin) return <main className="page-shell"><section className="workbench-panel"><h1>智能补单灰度</h1><p role="alert">当前账号没有配置管理权限。</p><Link to="/claims">返回报销工作台</Link></section></main>;

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  function change(next: FeatureRollout) { setRollout(next); setDirty(true); setPreview(null); }
  const payload: FeatureRollout = rollout.mode === "EMPLOYEES" ? { mode: "EMPLOYEES", employeeIds: parseEmployeeIDs(employeeText) } : rollout.mode === "PERCENT" ? { mode: "PERCENT", percent: rollout.percent ?? 0, salt: rollout.salt ?? "" } : { mode: rollout.mode };
  const versions = [...new Set(history.map((entry) => entry.version).filter((version) => version > 0))].sort((a, b) => b - a);
  return <main className="page-shell admin-config-page">
    <div className="admin-config-links"><Link to="/admin/config">← 配置中心</Link></div>
    <section className="workbench-panel">
      <p className="eyebrow">业务运营配置</p><h1>智能补单灰度</h1>
      <p className="panel-copy">范围只决定新建草稿的模式。缩小或关闭灰度后，已有明细草稿仍可继续办理。</p>
      <p className="field-hint">当前环境：{window.location.hostname || "本地"}。测试与生产分别发布配置，不自动复制员工名单。</p>
      {loading ? <p role="status">正在读取灰度配置…</p> : <>
        <p className="admin-config-version">当前发布版本：<strong>{active?.version ?? "尚未发布（沿用服务启动名单）"}</strong></p>
        <div className="field-stack"><label htmlFor="rollout-mode">智能补单范围</label><select id="rollout-mode" value={rollout.mode} disabled={busy} onChange={(event) => change({ mode: event.target.value as FeatureRollout["mode"] })}><option value="OFF">关闭</option><option value="EMPLOYEES">指定员工</option><option value="DEPARTMENTS" disabled>指定部门（缺少可信部门目录）</option><option value="PERCENT">按比例放量</option><option value="ALL">全部员工</option></select></div>
        {rollout.mode === "EMPLOYEES" && <div className="field-stack"><label htmlFor="rollout-employees">员工 ID（每行一个）</label><textarea id="rollout-employees" className="resize-none" rows={5} value={employeeText} disabled={busy} onChange={(event) => { setEmployeeText(event.target.value); setDirty(true); setPreview(null); }} /><p className="field-hint">只接受当前环境已启用的员工 ID；保存时由服务端校验。</p></div>}
        {rollout.mode === "PERCENT" && <div className="admin-config-grid"><div className="field-stack"><label htmlFor="rollout-percent">放量比例（%）</label><input id="rollout-percent" type="number" min={0} max={100} value={rollout.percent ?? 0} disabled={busy} onChange={(event) => change({ ...rollout, percent: Number(event.target.value) })} /></div><div className="field-stack"><label htmlFor="rollout-salt">分组标识</label><input id="rollout-salt" value={rollout.salt ?? ""} disabled={busy} onChange={(event) => change({ ...rollout, salt: event.target.value })} /><p className="field-hint">同一标识下员工分组稳定；更换会重新分组。</p></div></div>}
        <div className="field-stack"><label htmlFor="rollout-note">变更说明</label><input id="rollout-note" value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); setDirty(true); setPreview(null); }} /></div>
        <div className="admin-config-actions"><button className="secondary-action" type="button" disabled={busy || !dirty || !note.trim()} onClick={() => void act(async () => { const saved = await reimbursementApi.saveConfigDomainDraft<FeatureRollout>(domain, { expectedRevision: draft?.revision ?? 0, payload, note: note.trim() }); setDraft(saved); setDirty(false); setNotice(`草稿修订 ${saved.revision} 已保存。`); })}>保存草稿</button><button className="secondary-action" type="button" disabled={busy || dirty || !draft || draft.revision === draft.publishedRevision} onClick={() => void act(async () => { setPreview(await reimbursementApi.previewConfigDomainDraft<FeatureRollout>(domain, draft!.revision)); })}>查看影响</button><button className="primary-action" type="button" disabled={busy || dirty || !preview} onClick={() => void act(async () => { await reimbursementApi.publishConfigDomainDraft<FeatureRollout>(domain, draft!.revision); await load(); setNotice("灰度配置已发布，仅影响新建草稿。"); })}>发布配置</button></div>
        {preview && <div className="admin-config-preview" role="status"><h2>影响预览</h2><p>发布后只影响新建草稿；已有草稿及已提交单据不变。</p><p>{preview.draft.payload.mode === "EMPLOYEES" ? `预计 ${preview.draft.payload.employeeIds?.length ?? 0} 名员工进入灰度。` : preview.draft.payload.mode === "PERCENT" ? activeEmployeeCount === null ? `预计 ${preview.draft.payload.percent ?? 0}% 员工进入灰度；当前无法估算人数。` : `预计约 ${Math.round(activeEmployeeCount * (preview.draft.payload.percent ?? 0) / 100)} 名员工（${preview.draft.payload.percent ?? 0}%）进入灰度；同一员工的分组保持稳定。` : preview.draft.payload.mode === "ALL" ? activeEmployeeCount === null ? "全部员工的新草稿进入灰度。" : `全部 ${activeEmployeeCount} 名员工的新草稿进入灰度。` : "全部员工的新草稿使用旧模式。"}</p></div>}
        {error && <p className="field-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      </>}
    </section>
    {!loading && <section className="workbench-panel"><h2>发布记录与回退</h2><div className="field-stack"><label htmlFor="rollout-rollback-note">回退说明</label><input id="rollout-rollback-note" value={rollbackNote} disabled={busy} onChange={(event) => setRollbackNote(event.target.value)} /></div>{versions.length ? <ul className="admin-history-list">{versions.map((version) => <li key={version}><span>版本 {version}{active?.version === version ? " · 当前使用" : ""}</span>{active?.version !== version && <button className="secondary-action" type="button" disabled={busy || !rollbackNote.trim()} onClick={() => void act(async () => { await reimbursementApi.activateConfigVersion(domain, { expectedActiveVersion: active?.version ?? 0, version, note: rollbackNote.trim() }); await load(); setRollbackNote(""); setNotice(`已启用版本 ${version}。`); })}>启用版本 {version}</button>}</li>)}</ul> : <p className="empty-state">尚无发布记录。</p>}</section>}
  </main>;
}

function message(reason: unknown): string {
  if (reason instanceof ReimbursementApiError && reason.status === 409) return "灰度配置已被更新，请刷新后核对最新版本。";
  if (reason instanceof ReimbursementApiError && reason.code === "INVALID_CONFIG") return "灰度范围无效。请检查员工 ID、比例和分组标识。";
  return reason instanceof Error ? reason.message : "灰度配置操作失败，请重试。";
}
