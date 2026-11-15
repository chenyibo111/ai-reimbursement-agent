import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { reimbursementApi, ReimbursementApiError, type ConfigDraft, type ConfigHistory, type ConfigSnapshot, type ExpenseCatalog } from "../api/client";

type Tab = "dictionary" | "mapping" | "history";
const domain = "expense_catalog";
const receiptTypeLabels: Record<string, string> = { TAXI: "打车", DINING: "餐饮", LODGING: "住宿", TRANSPORT: "交通", OTHER: "其他" };
const tabs: readonly [Tab, string][] = [["dictionary", "业务字典"], ["mapping", "智能补单"], ["history", "发布记录"]];

export function AdminConfigPage({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>("dictionary");
  const [catalog, setCatalog] = useState<ExpenseCatalog | null>(null);
  const [active, setActive] = useState<ConfigSnapshot<ExpenseCatalog> | null>(null);
  const [draft, setDraft] = useState<ConfigDraft<ExpenseCatalog> | null>(null);
  const [history, setHistory] = useState<ConfigHistory[]>([]);
  const [preview, setPreview] = useState<{ draft: ConfigDraft<ExpenseCatalog>; active?: ConfigSnapshot<ExpenseCatalog> } | null>(null);
  const [note, setNote] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(preserveEdits = false) {
    const [state, records] = await Promise.all([reimbursementApi.getAdminConfig(), reimbursementApi.listConfigHistory(domain)]);
    setActive(state.active ?? null);
    setDraft(state.draft ?? null);
    setHistory(records.items);
    if (!preserveEdits) {
      const unpublished = state.draft && state.draft.publishedRevision !== state.draft.revision ? state.draft : null;
      setCatalog(structuredClone(unpublished?.payload ?? state.active?.payload ?? { categories: [], mappings: [] }));
      setNote(unpublished?.note ?? "");
      setDirty(false);
      setConflicted(false);
      setPreview(null);
    }
  }

  useEffect(() => {
    document.title = "报销配置 · AI 报销 Agent";
    return () => { document.title = "AI 报销 Agent"; };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    Promise.all([reimbursementApi.getAdminConfig(), reimbursementApi.listConfigHistory(domain)])
      .then(([state, records]) => {
        if (cancelled) return;
        setActive(state.active ?? null);
        setDraft(state.draft ?? null);
        setHistory(records.items);
        const unpublished = state.draft && state.draft.publishedRevision !== state.draft.revision ? state.draft : null;
        setCatalog(structuredClone(unpublished?.payload ?? state.active?.payload ?? { categories: [], mappings: [] }));
        setNote(unpublished?.note ?? "");
      })
      .catch((reason: unknown) => { if (!cancelled) setError(configError(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  if (!isAdmin) return <main className="page-shell"><section className="workbench-panel"><h1>配置管理</h1><p className="field-error" role="alert">当前账号没有配置管理权限。</p><Link to="/claims">返回报销工作台</Link></section></main>;

  function change(next: ExpenseCatalog) {
    setCatalog(next);
    setDirty(true);
    setPreview(null);
    setNotice("");
  }
  function updateCategory(index: number, patch: Partial<ExpenseCatalog["categories"][number]>) {
    if (!catalog) return;
    change({ ...catalog, categories: catalog.categories.map((item, position) => position === index ? { ...item, ...patch } : item) });
  }
  function updateMapping(index: number, patch: Partial<ExpenseCatalog["mappings"][number]>) {
    if (!catalog) return;
    change({ ...catalog, mappings: catalog.mappings.map((item, position) => position === index ? { ...item, ...patch } : item) });
  }
  async function act(name: string, operation: () => Promise<void>) {
    setBusy(name); setError(""); setNotice("");
    try { await operation(); }
    catch (reason) {
      if (reason instanceof ReimbursementApiError && reason.status === 409) {
        await load(true).catch(() => undefined);
        setConflicted(true);
        setError("配置已被其他管理员更新。当前编辑仍在本页，请载入最新版本并核对后重试。");
      } else setError(configError(reason));
    }
    finally { setBusy(""); }
  }
  async function save() {
    if (!catalog || !note.trim()) { setError("请填写变更说明并核对配置内容。"); return; }
    await act("save", async () => {
      const saved = await reimbursementApi.saveConfigDraft(domain, { expectedRevision: draft?.revision ?? 0, payload: catalog, note: note.trim() });
      setDraft(saved); setDirty(false); setPreview(null); setNotice(`草稿修订 ${saved.revision} 已保存。`);
    });
  }
  async function inspect() {
    if (!draft || dirty) return;
    await act("preview", async () => {
      const result = await reimbursementApi.previewConfigDraft(domain, draft.revision);
      setPreview(result); setNotice("影响预览已更新。发布后只影响新的票据识别，历史记录保留原值。");
    });
  }
  async function publish() {
    if (!draft || !preview || preview.draft.revision !== draft.revision || dirty) return;
    await act("publish", async () => {
      await reimbursementApi.publishConfigDraft(domain, draft.revision);
      await load();
      setNotice("配置已发布；新的票据识别将使用当前版本。");
    });
  }
  async function rollback(version: number) {
    if (!active || !rollbackNote.trim()) { setError("请填写回退说明。"); return; }
    await act("rollback", async () => {
      await reimbursementApi.activateConfigVersion(domain, { expectedActiveVersion: active.version, version, note: rollbackNote.trim() });
      await load();
      setRollbackNote("");
      setNotice(`已启用版本 ${version}。新识别使用该版本，历史结果不变。`);
    });
  }

  const versions = [...new Set(history.map((entry) => entry.version).filter((version) => version > 0))].sort((a, b) => b - a);
  const draftIsPublished = Boolean(draft && draft.publishedRevision === draft.revision);
  const changes = preview ? catalogDifferences(preview.active?.payload, preview.draft.payload) : [];
  return <main className="page-shell admin-config-page" aria-labelledby="admin-config-title">
    <header className="page-header"><div><p className="eyebrow">财务管理 · 配置中心</p><h1 id="admin-config-title">报销配置</h1><p className="page-summary">维护费用类别与票据默认值；已发布版本供新票据识别使用。</p></div><Link className="secondary-action" to="/admin/policies">可执行规则</Link></header>
    <nav className="admin-config-links" aria-label="相关管理"><Link to="/admin/policies">政策规则</Link><Link to="/admin/policy-sources">政策知识来源</Link></nav>
    <div className="admin-config-tabs" role="tablist" aria-label="配置中心栏目">
      {tabs.map(([value, label], index) => <button key={value} id={`config-tab-${value}`} type="button" role="tab" aria-controls={`config-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={tab === value ? "is-active" : ""} onClick={() => setTab(value)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        setTab(tabs[next][0]);
        document.getElementById(`config-tab-${tabs[next][0]}`)?.focus();
      }}>{label}</button>)}
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    {loading ? <p className="empty-state" role="status">正在读取配置…</p> : !catalog ? <div className="workbench-panel"><p>配置暂时无法读取。</p><button className="secondary-action" type="button" onClick={() => { setLoading(true); void load().then(() => setError("")).catch((reason: unknown) => setError(configError(reason))).finally(() => setLoading(false)); }}>重新加载</button></div> : <>
      <div className="admin-config-version"><strong>当前发布版本 {active?.version ?? "未发布"}</strong><span>{draft && !draftIsPublished ? `草稿修订 ${draft.revision}` : "尚无待发布草稿"}</span>{dirty && <span>有未保存修改</span>}</div>
      {tab === "dictionary" && <section id="config-panel-dictionary" className="workbench-panel" role="tabpanel" aria-labelledby="config-tab-dictionary"><div className="section-heading"><div><h2>费用类别</h2><p className="field-hint">编码用于稳定关联历史报销单；已有编码不可修改。</p></div><button className="secondary-action" type="button" onClick={() => change({ ...catalog, categories: [...catalog.categories, { code: "", label: "", aliases: [], enabled: true, sortOrder: Math.max(0, ...catalog.categories.map((item) => item.sortOrder)) + 10 }] })}>新增类别</button></div>
        <div className="admin-category-list">{catalog.categories.map((category, index) => <fieldset className="admin-category-card" key={`${category.code}-${index}`} disabled={Boolean(busy)}><legend>类别 {index + 1}</legend><div className="admin-config-grid"><div className="field-stack"><label htmlFor={`category-code-${index}`}>类别编码</label><input id={`category-code-${index}`} value={category.code} readOnly={active?.payload.categories.some((item) => item.code === category.code) ?? false} onChange={(event) => updateCategory(index, { code: event.target.value.toUpperCase() })} placeholder="例如：PARKING" /></div><div className="field-stack"><label htmlFor={`category-label-${index}`}>显示名称</label><input id={`category-label-${index}`} value={category.label} onChange={(event) => updateCategory(index, { label: event.target.value })} placeholder="例如：停车费" /></div><div className="field-stack"><label htmlFor={`category-aliases-${index}`}>别名</label><input id={`category-aliases-${index}`} value={category.aliases.join("、")} onChange={(event) => updateCategory(index, { aliases: event.target.value.split(/[,，、]/).map((value) => value.trim()).filter(Boolean) })} placeholder="用顿号分隔" /></div><div className="field-stack"><label htmlFor={`category-order-${index}`}>排序</label><input id={`category-order-${index}`} type="number" value={category.sortOrder} onChange={(event) => updateCategory(index, { sortOrder: Number(event.target.value) })} /></div></div><div className="admin-category-footer"><label><input type="checkbox" checked={category.enabled} onChange={(event) => updateCategory(index, { enabled: event.target.checked })} /> 启用类别</label>{!active?.payload.categories.some((item) => item.code === category.code) && <button className="text-action" type="button" onClick={() => change({ ...catalog, categories: catalog.categories.filter((_, position) => position !== index) })}>移除新类别</button>}</div></fieldset>)}</div>
      </section>}
      {tab === "mapping" && <section id="config-panel-mapping" className="workbench-panel" role="tabpanel" aria-labelledby="config-tab-mapping"><h2>票据默认值</h2><p className="panel-copy">识别出的票据类型决定初始费用类别和通用事由；员工可在报销单上调整最终类别。</p><div className="admin-mapping-list">{catalog.mappings.map((mapping, index) => <div className="admin-mapping-row" key={mapping.receiptType}><strong>{receiptTypeLabels[mapping.receiptType] ?? mapping.receiptType}</strong><div className="field-stack"><label htmlFor={`mapping-category-${index}`}>默认费用类别</label><select id={`mapping-category-${index}`} value={mapping.categoryCode} onChange={(event) => updateMapping(index, { categoryCode: event.target.value })} disabled={Boolean(busy)}>{catalog.categories.filter((item) => item.enabled || item.code === mapping.categoryCode).map((item) => <option key={item.code} value={item.code}>{item.label || item.code}{item.enabled ? "" : "（已停用）"}</option>)}</select></div><div className="field-stack"><label htmlFor={`mapping-purpose-${index}`}>通用事由</label><input id={`mapping-purpose-${index}`} value={mapping.purposeTemplate} onChange={(event) => updateMapping(index, { purposeTemplate: event.target.value })} disabled={Boolean(busy)} /></div></div>)}</div></section>}
      {tab !== "history" && <section className="workbench-panel admin-config-publish" aria-labelledby="config-publish-title"><h2 id="config-publish-title">保存与发布</h2><div className="field-stack"><label htmlFor="config-note">变更说明</label><input id="config-note" value={note} onChange={(event) => { setNote(event.target.value); setDirty(true); setPreview(null); }} disabled={Boolean(busy)} placeholder="说明本次调整原因" /></div><div className="admin-config-actions"><button className="secondary-action" type="button" onClick={() => void save()} disabled={Boolean(busy) || conflicted}>保存草稿</button><button className="secondary-action" type="button" onClick={() => void inspect()} disabled={Boolean(busy) || dirty || !draft || draftIsPublished || conflicted}>查看影响</button><button className="primary-action" type="button" onClick={() => void publish()} disabled={Boolean(busy) || dirty || !preview || conflicted}>发布配置</button></div>{conflicted && <button className="text-action" type="button" onClick={() => void load().then(() => setError(""))}>载入最新版本</button>}{preview && <div className="admin-config-preview" aria-live="polite"><h3>字段差异与影响</h3><p>新票据识别使用修订 {preview.draft.revision}；已保存的识别结果和提交快照保持原值。</p>{changes.length ? <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul> : <p>与当前发布版本没有字段差异。</p>}</div>}</section>}
      {tab === "history" && <section id="config-panel-history" className="workbench-panel" role="tabpanel" aria-labelledby="config-tab-history"><h2>版本记录</h2><p className="panel-copy">回退会切换新识别使用的版本，已有报销单与票据识别结果不变。</p><div className="field-stack"><label htmlFor="rollback-note">回退说明</label><input id="rollback-note" value={rollbackNote} onChange={(event) => setRollbackNote(event.target.value)} disabled={Boolean(busy)} placeholder="说明回退原因" /></div>{versions.length ? <ul className="admin-history-list">{versions.map((version) => <li key={version}><div><strong>版本 {version}</strong><span>{version === active?.version ? "当前使用" : "历史版本"}</span></div>{version !== active?.version && <button className="secondary-action" type="button" disabled={Boolean(busy)} onClick={() => void rollback(version)}>启用版本 {version}</button>}</li>)}</ul> : <p className="empty-state">尚无发布记录。</p>}</section>}
    </>}
  </main>;
}

function catalogDifferences(before: ExpenseCatalog | undefined, after: ExpenseCatalog): string[] {
  if (!before) return ["首次发布费用类别与票据映射。"];
  const changes: string[] = [];
  for (const category of after.categories) {
    const old = before.categories.find((item) => item.code === category.code);
    if (!old) { changes.push(`新增类别 ${category.label || category.code}`); continue; }
    if (old.label !== category.label) changes.push(`${category.code} 名称：${old.label} → ${category.label}`);
    if (old.enabled !== category.enabled) changes.push(`${category.code} 状态：${old.enabled ? "启用" : "停用"} → ${category.enabled ? "启用" : "停用"}`);
    if (old.aliases.join("、") !== category.aliases.join("、")) changes.push(`${category.code} 别名：${old.aliases.join("、") || "无"} → ${category.aliases.join("、") || "无"}`);
    if (old.sortOrder !== category.sortOrder) changes.push(`${category.code} 排序：${old.sortOrder} → ${category.sortOrder}`);
  }
  for (const category of before.categories) if (!after.categories.some((item) => item.code === category.code)) changes.push(`移除类别 ${category.label}`);
  for (const mapping of after.mappings) {
    const old = before.mappings.find((item) => item.receiptType === mapping.receiptType);
    if (!old || old.categoryCode !== mapping.categoryCode) changes.push(`${receiptTypeLabels[mapping.receiptType] ?? mapping.receiptType} 默认类别：${old?.categoryCode ?? "无"} → ${mapping.categoryCode}`);
    if (!old || old.purposeTemplate !== mapping.purposeTemplate) changes.push(`${receiptTypeLabels[mapping.receiptType] ?? mapping.receiptType} 通用事由：${old?.purposeTemplate ?? "无"} → ${mapping.purposeTemplate}`);
  }
  return changes;
}

function configError(error: unknown): string {
  if (error instanceof ReimbursementApiError && error.status === 403) return "当前账号没有配置管理权限。";
  if (error instanceof ReimbursementApiError && error.code === "INVALID_CONFIG") return "配置内容不符合校验规则，请检查类别、映射和当前政策引用。";
  return error instanceof Error ? error.message : "配置操作未完成，请稍后重试。";
}
