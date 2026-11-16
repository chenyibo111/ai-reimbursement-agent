import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { reimbursementApi, ReimbursementApiError, type ConfigDraft, type ConfigHistory, type ConfigSnapshot, type NotificationConfig } from "../api/client";

const domain = "notification_templates";
const eventNames: Record<NotificationConfig["events"][number]["eventCode"], string> = {
  ReceiptExtractionCompleted: "票据识别完成",
  ReceiptReviewRequired: "进入人工复核",
  ReceiptReviewResolved: "人工复核处理完成",
  ClaimSubmitted: "报销单提交成功",
};
const defaultConfig: NotificationConfig = { events: Object.keys(eventNames).map((eventCode) => ({ eventCode: eventCode as NotificationConfig["events"][number]["eventCode"], channel: "FEISHU", enabled: true, template: "{{body}}" })) };
const sampleBody: Record<NotificationConfig["events"][number]["eventCode"], string> = {
  ReceiptExtractionCompleted: "票据识别完成。发票号码：示例号码。请在报销工作台核对。",
  ReceiptReviewRequired: "票据需要人工复核。请等待复核结果。",
  ReceiptReviewResolved: "票据复核已处理。请在报销工作台查看。",
  ClaimSubmitted: "报销单 BX-示例：已提交。",
};

export function AdminNotificationConfigPage({ isAdmin }: { isAdmin: boolean }) {
  const [active, setActive] = useState<ConfigSnapshot<NotificationConfig> | null>(null);
  const [draft, setDraft] = useState<ConfigDraft<NotificationConfig> | null>(null);
  const [history, setHistory] = useState<ConfigHistory[]>([]);
  const [config, setConfig] = useState<NotificationConfig>(defaultConfig);
  const [selected, setSelected] = useState<NotificationConfig["events"][number]["eventCode"]>("ReceiptExtractionCompleted");
  const [note, setNote] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [state, records] = await Promise.all([
      reimbursementApi.getAdminConfigDomain<NotificationConfig>(domain).catch((reason: unknown) => {
        if (reason instanceof ReimbursementApiError && reason.status === 404) return {} as { active?: ConfigSnapshot<NotificationConfig>; draft?: ConfigDraft<NotificationConfig> };
        throw reason;
      }),
      reimbursementApi.listConfigHistory(domain),
    ]);
    const unpublished = state.draft && state.draft.revision !== state.draft.publishedRevision ? state.draft : null;
    setActive(state.active ?? null); setDraft(state.draft ?? null); setHistory(records.items);
    setConfig(structuredClone(unpublished?.payload ?? state.active?.payload ?? defaultConfig));
    setNote(unpublished?.note ?? ""); setDirty(false); setPreview(false);
  }
  useEffect(() => { document.title = "通知配置 · 报销配置"; if (isAdmin) void load().catch((reason: unknown) => setError(message(reason))).finally(() => setLoading(false)); return () => { document.title = "AI 报销 Agent"; }; }, [isAdmin]);
  if (!isAdmin) return <main className="page-shell"><section className="workbench-panel"><h1>通知模板与事件开关</h1><p role="alert">当前账号没有配置管理权限。</p></section></main>;
  async function act(operation: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  function change(enabled: boolean, template: string) { setConfig((current) => ({ events: current.events.map((event) => event.eventCode === selected ? { ...event, enabled, template } : event) })); setDirty(true); setPreview(false); }
  const current = config.events.find((event) => event.eventCode === selected) ?? defaultConfig.events.find((event) => event.eventCode === selected)!;
  const templateSafe = current.template.length <= 400 && current.template.split("{{body}}").length === 2 && !/[{}]/.test(current.template.replace("{{body}}", "")) && !/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b)/i.test(current.template);
  const versions = [...new Set(history.map((item) => item.version).filter((version) => version > 0))].sort((a, b) => b - a);
  return <main className="page-shell admin-config-page">
    <div className="admin-config-links"><Link to="/admin/config">← 配置中心</Link></div>
    <section className="workbench-panel"><p className="eyebrow">业务运营配置</p><h1>通知模板与事件开关</h1><p className="panel-copy">这里只显示已接入的飞书事件。Web 页面提示由页面状态驱动，当前没有独立通知发送链路。</p>
      {loading ? <p role="status">正在读取通知配置…</p> : <>
        <p className="admin-config-version">当前发布版本：<strong>{active?.version ?? "尚未发布（沿用现有通知）"}</strong></p>
        <div className="field-stack"><label htmlFor="notification-event">通知事件</label><select id="notification-event" value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value as typeof selected); setPreview(false); }}>{Object.entries(eventNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></div>
        <div className="field-stack"><label><input type="checkbox" checked={current.enabled} disabled={busy} onChange={(event) => change(event.target.checked, current.template)} />启用飞书通知</label></div>
        <div className="field-stack"><label htmlFor="notification-template">飞书消息模板</label><textarea id="notification-template" rows={4} className="resize-none" value={current.template} disabled={busy} onChange={(event) => change(current.enabled, event.target.value)} /><p className="field-hint">必须包含一次 {"{{body}}"}；只允许该变量。不能写外链，最多 400 字。</p></div>
        <div className="admin-config-preview"><h2>文案预览</h2><p>{templateSafe ? current.template.replace("{{body}}", sampleBody[selected]) : "请修正模板后查看预览。"}</p><p className="field-hint">示例正文不包含真实票据内容；发送时使用后端生成的安全摘要。</p></div>
        <div className="field-stack"><label htmlFor="notification-note">变更说明</label><input id="notification-note" value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); setDirty(true); setPreview(false); }} /></div>
        <div className="admin-config-actions"><button className="secondary-action" type="button" disabled={busy || !dirty || !note.trim() || !templateSafe} onClick={() => void act(async () => { const saved = await reimbursementApi.saveConfigDomainDraft(domain, { expectedRevision: draft?.revision ?? 0, payload: config, note: note.trim() }); setDraft(saved); setDirty(false); setNotice(`草稿修订 ${saved.revision} 已保存。`); })}>保存草稿</button><button className="secondary-action" type="button" disabled={busy || dirty || !draft || draft.revision === draft.publishedRevision} onClick={() => void act(async () => { await reimbursementApi.previewConfigDomainDraft<NotificationConfig>(domain, draft!.revision); setPreview(true); })}>查看影响</button><button className="primary-action" type="button" disabled={busy || dirty || !preview} onClick={() => void act(async () => { await reimbursementApi.publishConfigDomainDraft<NotificationConfig>(domain, draft!.revision); await load(); setNotice("通知配置已发布，新通知使用此版本。"); })}>发布配置</button></div>
        {preview && <div role="status" className="admin-config-preview"><h2>影响预览</h2><p>新通知按当前事件开关与模板发送；已生成的通知继续使用原有文案。</p></div>}
        {error && <p role="alert" className="field-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      </>}
    </section>
    {!loading && <section className="workbench-panel"><h2>发布记录与回退</h2><div className="field-stack"><label htmlFor="notification-rollback-note">回退说明</label><input id="notification-rollback-note" value={rollbackNote} disabled={busy} onChange={(event) => setRollbackNote(event.target.value)} /></div>{versions.length ? <ul className="admin-history-list">{versions.map((version) => <li key={version}><span>版本 {version}{active?.version === version ? " · 当前使用" : ""}</span>{active?.version !== version && <button className="secondary-action" type="button" disabled={busy || !rollbackNote.trim()} onClick={() => void act(async () => { await reimbursementApi.activateConfigVersion(domain, { expectedActiveVersion: active?.version ?? 0, version, note: rollbackNote.trim() }); await load(); setRollbackNote(""); setNotice(`已启用版本 ${version}。`); })}>启用版本 {version}</button>}</li>)}</ul> : <p className="empty-state">尚无发布记录。</p>}</section>}
  </main>;
}

function message(reason: unknown): string { if (reason instanceof ReimbursementApiError && reason.status === 409) return "通知配置已被更新，请刷新后核对最新版本。"; return reason instanceof Error ? reason.message : "通知配置操作失败，请重试。"; }
