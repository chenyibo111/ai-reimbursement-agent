/** Agent policy context is explanatory only. Financial decisions remain in Go validation. */
export type PublishedPolicySummary = { versionId: string; effectiveDate: string; summary: string };

export function formatPolicyContext(policy: PublishedPolicySummary | null) {
  if (!policy) return "当前没有可引用的已发布政策；请以财务最终校验结果为准。";
  return `当前生效政策：${policy.versionId}（${policy.effectiveDate} 起）。${policy.summary}。该内容仅用于解释，提交仍以报销服务校验为准。`;
}
