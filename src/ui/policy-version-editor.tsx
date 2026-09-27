"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type RuleType = "CLAIM_TOTAL_MAX" | "CATEGORY_ITEM_MAX" | "CATEGORY_ALLOWED" | "CATEGORY_REQUIRED_FIELD";
type Rule = { code: string; name: string; type: RuleType; severity: "BLOCKING" | "WARNING"; config: Record<string, unknown>; sortOrder: number };
type Policy = { id: string; title: string; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; version: number; effectiveFrom: string; rules: Rule[] };
type RuleFormState = { code: string; name: string; type: RuleType; severity: Rule["severity"]; amountYuan: string; category: string; categories: string; field: "participants" | "projectCode" };

const labels: Record<RuleType, string> = { CLAIM_TOTAL_MAX: "报销单总额上限", CATEGORY_ITEM_MAX: "费用类别单笔上限", CATEGORY_ALLOWED: "允许的费用类别", CATEGORY_REQUIRED_FIELD: "类别必填字段" };
const initialRule: RuleFormState = { code: "", name: "", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", amountYuan: "", category: "", categories: "", field: "participants" };

export function PolicyVersionEditor() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [title, setTitle] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [ruleForm, setRuleForm] = useState<RuleFormState>(initialRule);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const selected = useMemo(() => policies.find((item) => item.id === selectedId) ?? null, [policies, selectedId]);
  const editable = selected?.status === "DRAFT";

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/policies");
      const payload = await response.json() as { policies?: Policy[]; error?: string };
      if (response.status === 403) { setForbidden(true); return; }
      if (!response.ok) throw new Error(payload.error || "无法读取政策版本。");
      const next = payload.policies ?? [];
      setPolicies(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next.find((item) => item.status === "DRAFT")?.id ?? next[0]?.id ?? null);
      setForbidden(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取政策版本。"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setRules(selected?.rules ?? []); setConfirmPublish(false); }, [selected]);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || !effectiveFrom) { setError("请填写政策名称和生效日期。"); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, effectiveFrom }) });
      const payload = await response.json() as Policy & { error?: string };
      if (!response.ok) throw new Error(payload.error || "无法创建政策草稿。");
      setPolicies((current) => [payload, ...current]); setSelectedId(payload.id); setTitle(""); setEffectiveFrom(""); setNotice("已创建政策草稿。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建政策草稿。"); }
    finally { setSaving(false); }
  }

  function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rule = toRule(ruleForm, rules.length);
    if (!rule) { setError("请完整填写规则名称、代码和适用条件。金额请填写大于 0 的元数。"); return; }
    setRules((current) => [...current, rule]); setRuleForm({ ...initialRule, type: ruleForm.type }); setError(null);
  }

  async function saveRules() {
    if (!selected || !editable) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/admin/policies/${selected.id}/rules`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: selected.version, rules }) });
      const payload = await response.json() as Policy & { error?: string };
      if (!response.ok) throw new Error(response.status === 409 ? "草稿已被其他管理员更新，请刷新后再保存。" : payload.error || "无法保存规则。");
      replacePolicy(payload); setNotice("规则已保存。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存规则。"); }
    finally { setSaving(false); }
  }

  async function publish() {
    if (!selected || !editable) return;
    setPublishing(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/admin/policies/${selected.id}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: selected.version }) });
      const payload = await response.json() as Policy & { error?: string };
      if (!response.ok) throw new Error(response.status === 409 ? "草稿状态已变化，请刷新后再处理。" : payload.error || "无法发布政策。");
      replacePolicy(payload); setConfirmPublish(false); setNotice("政策已发布，后续报销校验将使用此版本。"); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法发布政策。"); }
    finally { setPublishing(false); }
  }

  function replacePolicy(policy: Policy) { setPolicies((current) => current.map((item) => item.id === policy.id ? policy : item)); }

  if (forbidden) return <ForbiddenPage />;

  return <main className="claims-page policy-page">
    <header className="claims-header"><Link href="/claims" className="brand">AI 报销 <span>Agent</span></Link><div className="policy-header-actions"><Link href="/admin/policy-sources" className="button-outline">知识来源</Link><Link href="/policies" className="button-outline">员工政策页</Link></div></header>
    <section className="policy-hero"><p className="eyebrow">政策管理员</p><h1>政策规则管理</h1><p>只允许发布受限的结构化规则。发布后不能直接修改，修改请创建新的草稿版本。</p></section>
    {error ? <p className="notice-error" role="alert">{error}</p> : null}{notice ? <p className="policy-status" role="status">{notice}</p> : null}
    <div className="policy-admin-grid">
      <aside className="policy-version-list" aria-label="政策版本列表"><div className="section-heading"><h2>版本</h2></div>{loading ? <p role="status">正在读取版本…</p> : policies.length ? <ul>{policies.map((policy) => <li key={policy.id}><button type="button" className={policy.id === selectedId ? "policy-version-active" : ""} onClick={() => setSelectedId(policy.id)}><strong>{policy.title}</strong><span>V{policy.version} · {statusLabel(policy.status)}</span></button></li>)}</ul> : <p>尚无政策版本，请先创建草稿。</p>}</aside>
      <div className="policy-workspace">
        <DraftForm title={title} effectiveFrom={effectiveFrom} saving={saving} onTitleChange={setTitle} onDateChange={setEffectiveFrom} onSubmit={createDraft} />
        {selected ? <>
          <section className="policy-editor" aria-labelledby="policy-editor-title"><div className="policy-card-heading"><div><p className="eyebrow">{statusLabel(selected.status)} · V{selected.version}</p><h2 id="policy-editor-title">{selected.title}</h2></div><span>生效于 {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(selected.effectiveFrom))}</span></div>
            {editable ? <><RuleForm value={ruleForm} onChange={setRuleForm} onSubmit={addRule} /><div className="policy-actions"><button type="button" className="button-outline" onClick={() => void saveRules()} disabled={saving} aria-busy={saving}>保存规则</button><button type="button" className="button-primary" onClick={() => setConfirmPublish(true)} disabled={saving || publishing} aria-expanded={confirmPublish}>发布此版本</button></div>{confirmPublish ? <PublishConfirmation title={selected.title} publishing={publishing} onCancel={() => setConfirmPublish(false)} onPublish={() => void publish()} /> : null}</> : <p className="policy-read-only">该版本已发布或已归档，规则只读。创建新草稿后再调整规则。</p>}
          </section>
          <RulesPreview rules={rules} editable={Boolean(editable)} onRemove={(index) => setRules((current) => current.filter((_, itemIndex) => itemIndex !== index))} />
        </> : null}
      </div>
    </div>
  </main>;
}

function DraftForm({ title, effectiveFrom, saving, onTitleChange, onDateChange, onSubmit }: { title: string; effectiveFrom: string; saving: boolean; onTitleChange(value: string): void; onDateChange(value: string): void; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  return <form className="policy-create-form" noValidate onSubmit={onSubmit}><div><p className="eyebrow">新建版本</p><h2>创建政策草稿</h2></div><label>政策名称<input value={title} onChange={(event) => onTitleChange(event.target.value)} placeholder="例如：2026 年差旅制度" /></label><label>生效日期<input type="date" value={effectiveFrom} onChange={(event) => onDateChange(event.target.value)} /></label><button type="submit" className="button-primary" disabled={saving} aria-busy={saving}>创建草稿</button></form>;
}

function RuleForm({ value, onChange, onSubmit }: { value: RuleFormState; onChange(value: RuleFormState): void; onSubmit(event: FormEvent<HTMLFormElement>): void }) {
  const set = (patch: Partial<RuleFormState>) => onChange({ ...value, ...patch });
  const needsAmount = value.type === "CLAIM_TOTAL_MAX" || value.type === "CATEGORY_ITEM_MAX";
  return <form className="policy-rule-form" noValidate onSubmit={onSubmit}><h3>添加规则</h3><label>规则类型<select value={value.type} onChange={(event) => set({ type: event.target.value as RuleType })}>{Object.entries(labels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label><label>规则名称<input value={value.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：差旅单笔上限" /></label><label>规则代码<input value={value.code} onChange={(event) => set({ code: event.target.value.toUpperCase().replace(/\s/g, "_") })} placeholder="例如：TRAVEL_ITEM_CAP" /></label><label>处理级别<select value={value.severity} onChange={(event) => set({ severity: event.target.value as Rule["severity"] })}><option value="BLOCKING">阻断提交</option><option value="WARNING">仅预警</option></select></label>{needsAmount ? <label>金额上限（元）<input inputMode="decimal" value={value.amountYuan} onChange={(event) => set({ amountYuan: event.target.value })} placeholder="例如：1000" /></label> : null}{value.type === "CATEGORY_ITEM_MAX" || value.type === "CATEGORY_REQUIRED_FIELD" ? <label>适用费用类别<input value={value.category} onChange={(event) => set({ category: event.target.value })} placeholder="例如：交通" /></label> : null}{value.type === "CATEGORY_ALLOWED" ? <label>允许的类别（用逗号分隔）<input value={value.categories} onChange={(event) => set({ categories: event.target.value })} placeholder="交通, 餐饮" /></label> : null}{value.type === "CATEGORY_REQUIRED_FIELD" ? <label>必填字段<select value={value.field} onChange={(event) => set({ field: event.target.value as RuleFormState["field"] })}><option value="participants">同行人</option><option value="projectCode">项目编码</option></select></label> : null}<button type="submit" className="button-outline">添加到草稿</button></form>;
}

function PublishConfirmation({ title, publishing, onCancel, onPublish }: { title: string; publishing: boolean; onCancel(): void; onPublish(): void }) {
  return <section className="policy-confirmation" aria-labelledby="publish-title"><h3 id="publish-title">确认发布“{title}”</h3><p>发布后规则不能原地修改，当前已发布版本将归档。请确认规则和生效日期无误。</p><div><button type="button" className="button-outline" onClick={onCancel} disabled={publishing}>继续编辑</button><button type="button" className="button-primary" onClick={onPublish} disabled={publishing} aria-busy={publishing}>确认发布</button></div></section>;
}

function RulesPreview({ rules, editable, onRemove }: { rules: Rule[]; editable: boolean; onRemove(index: number): void }) {
  return <section className="policy-rule-preview"><h3>当前规则</h3>{rules.length ? <ul>{rules.map((rule, index) => <li key={`${rule.code}-${index}`}><div><strong>{rule.name}</strong><span>{labels[rule.type]} · {rule.severity === "BLOCKING" ? "阻断" : "预警"}</span></div>{editable ? <button type="button" className="text-button" onClick={() => onRemove(index)} aria-label={`删除规则 ${rule.name}`}>删除</button> : null}</li>)}</ul> : <p>尚未添加规则。未包含规则的版本也可以发布，但不会产生额外政策校验。</p>}</section>;
}

function ForbiddenPage() {
  return <main className="claims-page policy-page"><header className="claims-header"><Link href="/claims" className="brand">AI 报销 <span>Agent</span></Link></header><section className="empty-state" role="alert"><h1>无权管理政策</h1><p>只有政策管理员可以创建、编辑和发布报销规则。</p><Link href="/policies">查看当前政策</Link></section></main>;
}

function toRule(input: RuleFormState, sortOrder: number): Rule | null {
  const code = input.code.trim(); const name = input.name.trim(); if (!code || !name) return null;
  if (input.type === "CLAIM_TOTAL_MAX") { const maxAmountCents = cents(input.amountYuan); return maxAmountCents ? { code, name, type: input.type, severity: input.severity, config: { maxAmountCents }, sortOrder } : null; }
  if (input.type === "CATEGORY_ITEM_MAX") { const maxAmountCents = cents(input.amountYuan); const category = input.category.trim(); return maxAmountCents && category ? { code, name, type: input.type, severity: input.severity, config: { category, maxAmountCents }, sortOrder } : null; }
  if (input.type === "CATEGORY_ALLOWED") { const categories = input.categories.split(",").map((item) => item.trim()).filter(Boolean); return categories.length ? { code, name, type: input.type, severity: input.severity, config: { categories }, sortOrder } : null; }
  const category = input.category.trim(); return category ? { code, name, type: input.type, severity: input.severity, config: { category, field: input.field }, sortOrder } : null;
}

function cents(value: string) { const amount = Number(value); return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null; }
function statusLabel(status: Policy["status"]) { return status === "DRAFT" ? "草稿" : status === "PUBLISHED" ? "已发布" : "已归档"; }
