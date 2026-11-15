import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { reimbursementApi, ReimbursementApiError, type ConfigDraft, type ConfigHistory, type ConfigSnapshot, type FormOptions } from "../api/client";

const domain = "form_options";
const fields = [
  ["purpose", "报销事由"], ["expenseCategory", "费用类别"], ["projectCode", "项目编码"],
  ["participants", "同行人"], ["requestedAmountCent", "申请报销总额"], ["currency", "币种"], ["remark", "备注"],
] as const;
const initialOptions: FormOptions = { categoryHelpText: "", projectCodeMode: "FREE_TEXT", projectCodes: [], fieldOrder: fields.map(([id]) => id) };

export function AdminFormOptionsPage({ isAdmin }: { isAdmin: boolean }) {
  const [active, setActive] = useState<ConfigSnapshot<FormOptions> | null>(null);
  const [draft, setDraft] = useState<ConfigDraft<FormOptions> | null>(null);
  const [options, setOptions] = useState<FormOptions>(initialOptions);
  const [history, setHistory] = useState<ConfigHistory[]>([]);
  const [note, setNote] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const [preview, setPreview] = useState<{ draft: ConfigDraft<FormOptions>; active?: ConfigSnapshot<FormOptions> } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [state, records] = await Promise.all([
      reimbursementApi.getAdminConfigDomain<FormOptions>(domain).catch((reason: unknown) => {
        if (reason instanceof ReimbursementApiError && reason.status === 404) return {} as { active?: ConfigSnapshot<FormOptions>; draft?: ConfigDraft<FormOptions> };
        throw reason;
      }),
      reimbursementApi.listConfigHistory(domain),
    ]);
    const unpublished = state.draft && state.draft.revision !== state.draft.publishedRevision ? state.draft : null;
    setActive(state.active ?? null);
    setDraft(state.draft ?? null);
    setOptions(structuredClone(unpublished?.payload ?? state.active?.payload ?? initialOptions));
    setNote(unpublished?.note ?? "");
    setHistory(records.items);
    setDirty(false);
    setPreview(null);
  }

  useEffect(() => {
    document.title = "表单选项 · 报销配置";
    if (isAdmin) void load().catch((reason: unknown) => setError(message(reason))).finally(() => setLoading(false));
    return () => { document.title = "AI 报销 Agent"; };
  }, [isAdmin]);

  if (!isAdmin) return <main className="page-shell"><section className="workbench-panel"><h1>表单选项</h1><p role="alert">当前账号没有配置管理权限。</p><Link to="/claims">返回报销工作台</Link></section></main>;

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  function moveField(index: number, direction: -1 | 1) {
    const order = [...(options.fieldOrder.length ? options.fieldOrder : initialOptions.fieldOrder)];
    const other = index + direction;
    if (other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other], order[index]];
    setOptions({ ...options, fieldOrder: order }); setDirty(true); setPreview(null);
  }

  const order = options.fieldOrder.length ? options.fieldOrder : initialOptions.fieldOrder;
  const versions = [...new Set(history.map((entry) => entry.version).filter((version) => version > 0))].sort((a, b) => b - a);
  return <main className="page-shell admin-config-page">
    <div className="admin-config-links"><Link to="/admin/config">← 配置中心</Link></div>
    <section className="workbench-panel">
      <p className="eyebrow">业务运营配置</p><h1>表单选项与提示语</h1>
      <p className="panel-copy">仅调整现有字段的展示。发布后新打开的表单使用新配置，已有草稿内容不会被改写。</p>
      {loading ? <p role="status">正在读取配置…</p> : <>
        <p className="admin-config-version">当前版本：<strong>{active?.version ?? "尚未发布"}</strong></p>
        <div className="field-stack"><label htmlFor="form-category-help">费用类别提示语</label><input id="form-category-help" value={options.categoryHelpText} maxLength={200} disabled={busy} onChange={(event) => { setOptions({ ...options, categoryHelpText: event.target.value }); setDirty(true); setPreview(null); }} /></div>
        <p className="field-hint">项目编码目前按自由输入处理；接入可信项目主数据后才能改为项目列表。</p>
        <fieldset className="field-stack"><legend>字段展示顺序</legend><ol className="admin-history-list">{order.map((id, index) => <li key={id}><span>{fields.find(([field]) => field === id)?.[1] ?? id}</span><div><button className="secondary-action" type="button" disabled={busy || index === 0} onClick={() => moveField(index, -1)} aria-label={`上移${fields.find(([field]) => field === id)?.[1] ?? id}`}>上移</button><button className="secondary-action" type="button" disabled={busy || index === order.length - 1} onClick={() => moveField(index, 1)} aria-label={`下移${fields.find(([field]) => field === id)?.[1] ?? id}`}>下移</button></div></li>)}</ol></fieldset>
        <div className="field-stack"><label htmlFor="form-options-note">变更说明</label><input id="form-options-note" value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); setDirty(true); setPreview(null); }} /></div>
        <div className="admin-config-actions"><button className="secondary-action" type="button" disabled={busy || !dirty || !note.trim()} onClick={() => void act(async () => { const saved = await reimbursementApi.saveConfigDomainDraft<FormOptions>(domain, { expectedRevision: draft?.revision ?? 0, payload: { ...options, projectCodeMode: "FREE_TEXT", projectCodes: [] }, note: note.trim() }); setDraft(saved); setDirty(false); setNotice(`草稿修订 ${saved.revision} 已保存。`); })}>保存草稿</button><button className="secondary-action" type="button" disabled={busy || dirty || !draft || draft.revision === draft.publishedRevision} onClick={() => void act(async () => { const result = await reimbursementApi.previewConfigDomainDraft<FormOptions>(domain, draft!.revision); setPreview(result); setNotice("影响预览已更新。"); })}>查看影响</button><button className="primary-action" type="button" disabled={busy || !preview || dirty} onClick={() => void act(async () => { await reimbursementApi.publishConfigDomainDraft<FormOptions>(domain, draft!.revision); await load(); setNotice("表单配置已发布。"); })}>发布配置</button></div>
        {preview && <div className="admin-config-preview" role="status"><h2>影响预览</h2><p>新打开的表单将使用修订 {preview.draft.revision}；历史草稿和已提交单据不变。</p><ul>{preview.active?.payload.categoryHelpText !== preview.draft.payload.categoryHelpText && <li>费用类别提示语：{preview.active?.payload.categoryHelpText || "默认提示"} → {preview.draft.payload.categoryHelpText || "默认提示"}</li>}{(preview.active?.payload.fieldOrder ?? initialOptions.fieldOrder).join(",") !== (preview.draft.payload.fieldOrder.length ? preview.draft.payload.fieldOrder : initialOptions.fieldOrder).join(",") && <li>字段展示顺序将调整。</li>}</ul></div>}
        {error && <p className="field-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      </>}
    </section>
    {!loading && <section className="workbench-panel"><h2>发布记录与回退</h2><div className="field-stack"><label htmlFor="form-options-rollback-note">回退说明</label><input id="form-options-rollback-note" value={rollbackNote} disabled={busy} onChange={(event) => setRollbackNote(event.target.value)} /></div>{versions.length ? <ul className="admin-history-list">{versions.map((version) => <li key={version}><span>版本 {version}{active?.version === version ? " · 当前使用" : ""}</span>{active?.version !== version && <button className="secondary-action" type="button" disabled={busy || !rollbackNote.trim()} onClick={() => void act(async () => { await reimbursementApi.activateConfigVersion(domain, { expectedActiveVersion: active?.version ?? 0, version, note: rollbackNote.trim() }); await load(); setRollbackNote(""); setNotice(`已启用版本 ${version}。`); })}>启用版本 {version}</button>}</li>)}</ul> : <p className="empty-state">尚无发布记录。</p>}</section>}
  </main>;
}

function message(reason: unknown): string {
  if (reason instanceof ReimbursementApiError && reason.status === 409) return "配置已更新，请刷新并核对最新版本后重试。";
  return reason instanceof Error ? reason.message : "配置操作失败，请重试。";
}
