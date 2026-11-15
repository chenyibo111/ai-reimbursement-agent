import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { reimbursementApi, ReimbursementApiError, type ConfigDraft, type ConfigHistory, type ConfigSnapshot, type ReceiptReviewConfig, type ReceiptReviewImpact } from "../api/client";

const domain = "receipt_review";
const defaultConfig: ReceiptReviewConfig = { lowOcrConfidenceThreshold: 0.7, reasonLabels: {} };
const reasonNames: Record<string, string> = {
  OCR_LOW_CONFIDENCE: "OCR 置信度较低",
  OCR_RETRY_EXHAUSTED: "OCR 多次失败",
  DUPLICATE_CONTENT: "重复上传票据",
  DUPLICATE_SUBMITTED_INVOICE: "已提交发票重复",
  LEGACY_REVIEW_REQUIRED: "历史票据待复核",
};

export function AdminReviewConfigPage({ isAdmin, actorID }: { isAdmin: boolean; actorID: string }) {
  const [active, setActive] = useState<ConfigSnapshot<ReceiptReviewConfig> | null>(null);
  const [draft, setDraft] = useState<ConfigDraft<ReceiptReviewConfig> | null>(null);
  const [history, setHistory] = useState<ConfigHistory[]>([]);
  const [config, setConfig] = useState<ReceiptReviewConfig>(defaultConfig);
  const [note, setNote] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const [preview, setPreview] = useState<ReceiptReviewImpact | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [state, records] = await Promise.all([
      reimbursementApi.getAdminConfigDomain<ReceiptReviewConfig>(domain).catch((reason: unknown) => {
        if (reason instanceof ReimbursementApiError && reason.status === 404) return {} as { active?: ConfigSnapshot<ReceiptReviewConfig>; draft?: ConfigDraft<ReceiptReviewConfig> };
        throw reason;
      }),
      reimbursementApi.listConfigHistory(domain),
    ]);
    const unpublished = state.draft && state.draft.revision !== state.draft.publishedRevision ? state.draft : null;
    setActive(state.active ?? null);
    setDraft(state.draft ?? null);
    setHistory(records.items);
    setConfig(structuredClone(unpublished?.payload ?? state.active?.payload ?? defaultConfig));
    setNote(unpublished?.note ?? "");
    setPreview(null);
    setDirty(false);
  }

  useEffect(() => {
    document.title = "票据复核配置 · 报销配置";
    if (isAdmin) void load().catch((reason: unknown) => setError(message(reason))).finally(() => setLoading(false));
    return () => { document.title = "AI 报销 Agent"; };
  }, [isAdmin]);

  if (!isAdmin) return <main className="page-shell"><section className="workbench-panel"><h1>票据复核配置</h1><p role="alert">当前账号没有配置管理权限。</p><Link to="/claims">返回报销工作台</Link></section></main>;

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  function change(next: ReceiptReviewConfig) { setConfig(next); setDirty(true); setPreview(null); }
  const versions = [...new Set(history.map((entry) => entry.version).filter((version) => version > 0))].sort((a, b) => b - a);
  const unpublished = draft && draft.revision !== draft.publishedRevision;

  return <main className="page-shell admin-config-page">
    <div className="admin-config-links"><Link to="/admin/config">← 配置中心</Link></div>
    <section className="workbench-panel">
      <p className="eyebrow">业务运营配置</p><h1>票据复核配置</h1>
      <p className="panel-copy">阈值只用于新识别的票据。已识别票据、复核案件和提交判定保留原状态。</p>
      {loading ? <p role="status">正在读取复核配置…</p> : <>
        <p className="admin-config-version">当前发布版本：<strong>{active?.version ?? "尚未发布（使用默认阈值 0.70）"}</strong></p>
        <div className="field-stack"><label htmlFor="review-threshold">OCR 低置信度复核阈值</label><input id="review-threshold" type="number" min="0.7" max="0.95" step="0.01" value={config.lowOcrConfidenceThreshold} disabled={busy} onChange={(event) => change({ ...config, lowOcrConfidenceThreshold: Number(event.target.value) })} /><p className="field-hint">允许范围 0.70–0.95。低于阈值的票据进入人工复核；重复票和文件安全检查不受影响。</p></div>
        <fieldset className="review-correction-fields"><legend>复核原因显示文案</legend><p className="field-hint">仅修改显示名称，原因编码和处理流程保持不变。</p>{Object.entries(reasonNames).map(([code, name]) => <div className="field-stack" key={code}><label htmlFor={`reason-${code}`}>{name}</label><input id={`reason-${code}`} maxLength={100} value={config.reasonLabels?.[code] ?? ""} placeholder="留空使用默认文案" disabled={busy} onChange={(event) => { const reasonLabels = { ...config.reasonLabels }; if (event.target.value) reasonLabels[code] = event.target.value; else delete reasonLabels[code]; change({ ...config, reasonLabels }); }} /></div>)}</fieldset>
        <div className="field-stack"><label htmlFor="review-note">变更说明</label><input id="review-note" value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); setDirty(true); setPreview(null); }} /></div>
        <div className="admin-config-actions">
          <button className="secondary-action" type="button" disabled={busy || !dirty || !note.trim() || config.lowOcrConfidenceThreshold < 0.7 || config.lowOcrConfidenceThreshold > 0.95} onClick={() => void act(async () => { const saved = await reimbursementApi.saveConfigDomainDraft(domain, { expectedRevision: draft?.revision ?? 0, payload: config, note: note.trim() }); setDraft(saved); setDirty(false); setNotice(`草稿修订 ${saved.revision} 已保存。`); })}>保存草稿</button>
          <button className="secondary-action" type="button" disabled={busy || dirty || !unpublished} onClick={() => void act(async () => { const result = await reimbursementApi.previewReceiptReviewConfig(draft!.revision); setPreview(result.impact); setNotice("样本影响预览已更新。"); })}>查看影响</button>
          <button className="secondary-action" type="button" disabled={busy || dirty || !unpublished || !preview || draft?.authorId === actorID || Boolean(draft?.approvedBy)} onClick={() => void act(async () => { const approved = await reimbursementApi.approveConfigDomainDraft<ReceiptReviewConfig>(domain, draft!.revision); setDraft(approved); setNotice("草稿已复核，可以发布。"); })}>复核草稿</button>
          <button className="primary-action" type="button" disabled={busy || dirty || !unpublished || !preview || !draft?.approvedBy} onClick={() => void act(async () => { await reimbursementApi.publishConfigDomainDraft<ReceiptReviewConfig>(domain, draft!.revision); await load(); setNotice("复核配置已发布，仅影响新识别的票据。"); })}>发布配置</button>
        </div>
        {unpublished && !draft?.approvedBy && <p className="field-hint">需由另一位管理员复核草稿后发布。当前草稿作者：{draft?.authorId}。</p>}
        {preview && <div className="admin-config-preview" role="status"><h2>影响预览</h2><p>近 {preview.recentSampleCount} 张票据样本；预计新增 {preview.newReviewCount} 张复核票据，减少 {preview.reducedReviewCount} 张。</p><p>此估算只基于近期 OCR 置信度，发布后只影响新识别的票据。</p></div>}
        {error && <p className="field-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      </>}
    </section>
    {!loading && <section className="workbench-panel"><h2>发布记录与回退</h2><div className="field-stack"><label htmlFor="review-rollback-note">回退说明</label><input id="review-rollback-note" value={rollbackNote} disabled={busy} onChange={(event) => setRollbackNote(event.target.value)} /></div>{versions.length ? <ul className="admin-history-list">{versions.map((version) => <li key={version}><span>版本 {version}{active?.version === version ? " · 当前使用" : ""}</span>{active?.version !== version && <button className="secondary-action" type="button" disabled={busy || !rollbackNote.trim()} onClick={() => void act(async () => { await reimbursementApi.activateConfigVersion(domain, { expectedActiveVersion: active?.version ?? 0, version, note: rollbackNote.trim() }); await load(); setRollbackNote(""); setNotice(`已启用版本 ${version}。`); })}>启用版本 {version}</button>}</li>)}</ul> : <p className="empty-state">尚无发布记录。</p>}</section>}
  </main>;
}

function message(reason: unknown): string {
  if (reason instanceof ReimbursementApiError && reason.status === 409) return "复核配置已被更新，请刷新后核对最新版本。";
  if (reason instanceof ReimbursementApiError && reason.code === "INVALID_CONFIG") return "复核配置无效。请检查阈值与原因文案。";
  return reason instanceof Error ? reason.message : "复核配置操作失败，请重试。";
}
