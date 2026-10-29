import { useState, type FormEvent } from "react";
import { reimbursementApi, type PublishedPolicyRule } from "../api/client";

type Draft = { key: string; code: string; name: string; type: PublishedPolicyRule["type"]; severity: PublishedPolicyRule["severity"]; amount: string; categories: string; category: string; field: "participants" | "projectCode" };
const blank = (): Draft => ({ key: crypto.randomUUID(), code: "", name: "", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", amount: "", categories: "", category: "", field: "projectCode" });

function asRule(draft: Draft): PublishedPolicyRule {
  const code = draft.code.trim(), name = draft.name.trim();
  if (!code || !name) throw new Error("每条规则都需要编号和名称。");
  if (draft.type === "CLAIM_TOTAL_MAX") {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(draft.amount.trim());
    if (!match) throw new Error(`${name}：请输入大于 0 的金额，最多两位小数。`);
    const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
    if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name}：金额超出支持范围。`);
    return { code, name, type: draft.type, severity: draft.severity, config: { maxAmountCents: Number(cents) } };
  }
  if (draft.type === "CATEGORY_ALLOWED") {
    const categories = draft.categories.split(/[,，、]/).map((value) => value.trim()).filter(Boolean);
    if (!categories.length) throw new Error(`${name}：请填写允许的费用类别。`);
    return { code, name, type: draft.type, severity: draft.severity, config: { categories } };
  }
  if (!draft.category.trim()) throw new Error(`${name}：请填写适用类别。`);
  return { code, name, type: draft.type, severity: draft.severity, config: { category: draft.category.trim(), field: draft.field } };
}

export function PolicyRulesPage() {
  const [id, setId] = useState(""), [date, setDate] = useState("");
  const [rules, setRules] = useState<Draft[]>([]);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const update = (key: string, patch: Partial<Draft>) => { setRules((current) => current.map((rule) => rule.key === key ? { ...rule, ...patch } : rule)); setNotice(""); };
  async function publish(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    try {
      const payload = rules.map(asRule);
      if (new Set(payload.map((rule) => rule.code)).size !== payload.length) throw new Error("规则编号不能重复。");
      setSaving(true);
      await reimbursementApi.publishPolicy(id.trim(), date, payload);
      setNotice(`版本 ${id.trim()} 已发布，包含 ${payload.length} 条自动校验规则。修改时请创建新版本。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "发布失败，请检查规则。"); }
    finally { setSaving(false); }
  }
  return <main className="page-shell" aria-labelledby="policy-title">
    <header className="page-header"><div><p className="eyebrow">财务管理</p><h1 id="policy-title">政策版本</h1><p className="page-summary">版本生效后，报销系统将在预校验和最终提交时执行这些规则。</p></div></header>
    <section className="workbench-panel policy-publish-panel" aria-labelledby="publish-title">
      <h2 id="publish-title">发布可执行规则</h2>
      <p className="field-hint">飞书文档用于制度问答。发布前请对照制度原文核对规则；文档更新不会自动修改这些规则。城市住宿档位、单笔费用上限暂缺对应单据字段，需人工核对。</p>
      <form onSubmit={(event) => void publish(event)}>
        <div className="policy-version-fields">
          <div className="field-stack"><label htmlFor="policy-id">版本编号</label><input id="policy-id" value={id} onChange={(event) => { setId(event.target.value); setNotice(""); }} required maxLength={80} placeholder="例如：2026-Q4" aria-describedby="policy-id-hint" disabled={saving} /><p id="policy-id-hint" className="field-hint">已发布版本不能覆盖；调整规则时请填写新的版本编号。</p></div>
          <div className="field-stack"><label htmlFor="policy-date">生效日期</label><input id="policy-date" type="date" value={date} onChange={(event) => { setDate(event.target.value); setNotice(""); }} required disabled={saving} /></div>
        </div>
        <div className="policy-rules-heading"><h3>自动校验规则 <span className="policy-rule-count">{rules.length} 条</span></h3><button type="button" className="secondary-action" onClick={() => setRules((current) => [...current, blank()])} disabled={saving}>添加规则</button></div>
        {rules.length === 0 && <p className="policy-empty-rule">当前没有自动规则。发布后只执行基础提交校验；文档中的限额不会自动阻断。</p>}
        <div className="policy-rules-list">{rules.map((rule, index) => <fieldset className="policy-rule-card" key={rule.key} disabled={saving}>
          <legend>规则 {index + 1}</legend><div className="policy-rule-grid">
            <div className="field-stack"><label htmlFor={`code-${rule.key}`}>编号</label><input id={`code-${rule.key}`} value={rule.code} onChange={(event) => update(rule.key, { code: event.target.value })} required placeholder="例如：TOTAL_LIMIT" /></div>
            <div className="field-stack"><label htmlFor={`name-${rule.key}`}>名称</label><input id={`name-${rule.key}`} value={rule.name} onChange={(event) => update(rule.key, { name: event.target.value })} required placeholder="例如：整单金额上限" /></div>
            <div className="field-stack"><label htmlFor={`type-${rule.key}`}>校验方式</label><select id={`type-${rule.key}`} value={rule.type} onChange={(event) => update(rule.key, { type: event.target.value as Draft["type"] })}><option value="CLAIM_TOTAL_MAX">整单金额上限</option><option value="CATEGORY_ALLOWED">允许的费用类别</option><option value="CATEGORY_REQUIRED_FIELD">类别必填信息</option></select></div>
            <div className="field-stack"><label htmlFor={`severity-${rule.key}`}>处理方式</label><select id={`severity-${rule.key}`} value={rule.severity} onChange={(event) => update(rule.key, { severity: event.target.value as Draft["severity"] })}><option value="BLOCKING">阻断提交</option><option value="WARNING">仅提示</option></select></div>
            {rule.type === "CLAIM_TOTAL_MAX" && <div className="field-stack"><label htmlFor={`amount-${rule.key}`}>上限金额（元）</label><input id={`amount-${rule.key}`} inputMode="decimal" value={rule.amount} onChange={(event) => update(rule.key, { amount: event.target.value })} required placeholder="例如：1000.00" /></div>}
            {rule.type === "CATEGORY_ALLOWED" && <div className="field-stack"><label htmlFor={`categories-${rule.key}`}>允许的类别</label><input id={`categories-${rule.key}`} value={rule.categories} onChange={(event) => update(rule.key, { categories: event.target.value })} required placeholder="交通费，住宿费" /></div>}
            {rule.type === "CATEGORY_REQUIRED_FIELD" && <><div className="field-stack"><label htmlFor={`category-${rule.key}`}>适用类别</label><input id={`category-${rule.key}`} value={rule.category} onChange={(event) => update(rule.key, { category: event.target.value })} required placeholder="例如：住宿费" /></div><div className="field-stack"><label htmlFor={`field-${rule.key}`}>必填信息</label><select id={`field-${rule.key}`} value={rule.field} onChange={(event) => update(rule.key, { field: event.target.value as Draft["field"] })}><option value="projectCode">项目编码</option><option value="participants">同行人</option></select></div></>}
          </div><button type="button" className="text-action policy-remove-rule" onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))}>移除规则 {index + 1}</button>
        </fieldset>)}</div>
        {notice && <p className="inline-notice" role="status">{notice}</p>}{error && <p className="field-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="primary-action" type="submit" disabled={saving}>{saving ? "正在发布…" : "发布政策版本"}</button></div>
      </form>
    </section>
  </main>;
}
